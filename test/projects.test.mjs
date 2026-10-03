// The rules behind client projects: when a maintenance run falls, keeping one
// scheduled per site, recognising a site from the tab's address, logging a
// finished run, time against a retainer, and the month-end report.
import assert from 'node:assert/strict';
import * as P from '../extension/src/lib/projects.js';
import * as T from '../extension/src/lib/tasks.js';
import * as time from '../extension/src/lib/time.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + (e.stack || e.message)); process.exitCode = 1; }
};

// Fixed reference point: Wed 2026-09-09 10:00 local.
const NOW = new Date(2026, 8, 9, 10, 0, 0).getTime();
const at = (m, d, h = 10) => new Date(2026, m, d, h, 0, 0).getTime();

const acme = (fields = {}) => P.makeProject({
  name: 'Acme Bakery',
  url: 'https://www.acmebakery.com/',
  ...fields,
  maintenance: { enabled: true, day: 15, checklist: ['Backup', 'Updates', 'Uptime'], ...(fields.maintenance || {}) },
});

// --- addresses ---------------------------------------------------------------

check('hostnames ignore scheme, www and path', () => {
  assert.equal(P.hostnameOf('https://www.Acme.com/shop?x=1'), 'acme.com');
  assert.equal(P.hostnameOf('acme.com/wp-admin'), 'acme.com');
  assert.equal(P.hostnameOf('chrome://extensions'), '', 'browser pages are never a client site');
  assert.equal(P.hostnameOf(''), '');
});

check('a link without a scheme opens over https; non-web links are refused', () => {
  assert.equal(P.hrefOf('acme.com'), 'https://acme.com');
  assert.equal(P.hrefOf('http://acme.com'), 'http://acme.com');
  assert.equal(P.hrefOf('javascript:alert(1)'), null);
});

check('the active tab is matched to its site, subdomains included', () => {
  const a = acme();
  const b = P.makeProject({ name: 'Shop', url: 'shop.acmebakery.com' });
  assert.equal(P.matchProjectByUrl([a, b], 'https://acmebakery.com/about').id, a.id);
  assert.equal(P.matchProjectByUrl([a, b], 'https://shop.acmebakery.com/cart').id, b.id, 'most specific wins');
  assert.equal(P.matchProjectByUrl([a], 'https://cdn.acmebakery.com/x.js').id, a.id);
  assert.equal(P.matchProjectByUrl([a], 'https://notacmebakery.com'), null);
});

check('admin and hosting links match only when they point at one site', () => {
  const host = 'https://my.hosting.example/panel';
  const a = acme({ links: [P.makeLink('Hosting', host)] });
  const b = P.makeProject({ name: 'Other', url: 'other.com', links: [P.makeLink('Hosting', host)] });
  assert.equal(P.matchProjectByUrl([a], host).id, a.id);
  assert.equal(P.matchProjectByUrl([a, b], host), null, 'a shared dashboard is ambiguous');
});

// --- scheduling --------------------------------------------------------------------

check('the first run falls this month when its day is still ahead', () => {
  const due = P.nextMaintenanceDue(acme(), NOW); // the 15th, it is the 9th
  assert.equal(due, at(8, 15));
});

check('a site added after its day starts next month, not overdue', () => {
  const due = P.nextMaintenanceDue(acme({ maintenance: { day: 3 } }), NOW);
  assert.equal(due, at(9, 3));
});

check('a month already logged schedules the next one', () => {
  const project = acme({ log: [{ id: 'l1', taskId: 'x', period: '2026-09', at: NOW, items: [], skipped: [] }] });
  assert.equal(P.nextMaintenanceDue(project, NOW), at(9, 15));
});

check('sync schedules a missing run, with the checklist as its steps', () => {
  const project = acme();
  const { upserts, removals } = P.syncMaintenance([project], [], NOW);
  assert.equal(removals.length, 0);
  assert.equal(upserts.length, 1);
  const run = upserts[0];
  assert.equal(run.kind, 'maint');
  assert.equal(run.projectId, project.id);
  assert.equal(run.context, 'freelance');
  assert.deepEqual(run.subtasks.map((s) => s.title), ['Backup', 'Updates', 'Uptime']);
  assert.deepEqual(run.recur, { every: 'month', interval: 1 });
});

check('sync leaves a scheduled site alone and collapses duplicates', () => {
  const project = acme();
  const a = P.makeMaintenanceTask(project, at(8, 15));
  const b = P.makeMaintenanceTask(project, at(9, 15));
  const { upserts, removals } = P.syncMaintenance([project], [a, b], NOW);
  assert.equal(upserts.length, 0);
  assert.deepEqual(removals, [b.id], 'the later duplicate goes');
});

check('a paused site has its run withdrawn, so it stops reminding', () => {
  const project = acme({ status: 'paused' });
  const run = P.makeMaintenanceTask(project, at(8, 15));
  assert.deepEqual(P.syncMaintenance([project], [run], NOW).removals, [run.id]);
});

check('a run whose project is gone is cleaned up', () => {
  const run = P.makeMaintenanceTask(acme(), at(8, 15));
  assert.deepEqual(P.syncMaintenance([], [run], NOW).removals, [run.id]);
});

check('changing the day moves this month\'s run within the month', () => {
  const before = acme();
  const after = { ...before, maintenance: { ...before.maintenance, day: 20 } };
  const run = P.makeMaintenanceTask(before, at(8, 15));
  const moved = P.reconcileMaintenance(run, before, after);
  assert.equal(moved.due, at(8, 20));
  assert.equal(moved.remindAt, at(8, 20));
});

check('editing the checklist keeps ticks and one-off steps', () => {
  const before = acme();
  const after = { ...before, maintenance: { ...before.maintenance, checklist: ['Backup', 'Uptime', 'Speed test'] } };
  const run = P.makeMaintenanceTask(before, at(8, 15));
  run.subtasks[0].done = true; // Backup ticked
  run.subtasks.push(T.makeSubtask('Renew the SSL cert')); // one-off for this month
  const next = P.reconcileMaintenance(run, before, after);
  assert.deepEqual(next.subtasks.map((s) => s.title), ['Backup', 'Uptime', 'Speed test', 'Renew the SSL cert']);
  assert.equal(next.subtasks[0].done, true, 'the tick survived');
});

// --- the month at a glance ----------------------------------------------------------

check('month status reads due, overdue, done, later and off', () => {
  const project = acme();
  const run = P.makeMaintenanceTask(project, at(8, 15));
  assert.equal(P.monthStatus(project, [run], NOW).state, 'due');
  assert.equal(P.monthStatus(project, [run], at(8, 16)).state, 'overdue');
  const nextMonth = P.makeMaintenanceTask(project, at(9, 15));
  assert.equal(P.monthStatus(project, [nextMonth], NOW).state, 'later');
  const logged = { ...project, log: [{ id: 'l', taskId: run.id, period: '2026-09', at: NOW, items: [], skipped: [] }] };
  assert.equal(P.monthStatus(logged, [nextMonth], NOW).state, 'done');
  assert.equal(P.monthStatus({ ...project, status: 'paused' }, [], NOW).state, 'off');
});

check('the overview counts only sites with a run this month', () => {
  const a = acme({ name: 'A' });
  const b = acme({ name: 'B' });
  const c = acme({ name: 'C' });
  const tasks = [
    P.makeMaintenanceTask(a, at(8, 1)), // overdue
    P.makeMaintenanceTask(b, at(8, 20)), // due
    P.makeMaintenanceTask(c, at(9, 1)), // starts next month
  ];
  const o = P.monthOverview([a, b, c], tasks, NOW);
  assert.equal(o.total, 2);
  assert.equal(o.overdue, 1);
  assert.equal(o.due, 1);
  assert.equal(o.later, 1);
  assert.equal(o.month, 'September');
});

check('projects sort by what needs attention first', () => {
  const late = acme({ name: 'Zed' });
  const soon = acme({ name: 'Alpha' });
  const tasks = [P.makeMaintenanceTask(late, at(8, 1)), P.makeMaintenanceTask(soon, at(8, 20))];
  assert.deepEqual(P.sortProjects([soon, late], tasks, NOW).map((p) => p.name), ['Zed', 'Alpha']);
});

// --- completing a run -------------------------------------------------------------

check('completing a run ticks its steps, logs it, and rolls to next month', () => {
  const project = acme();
  const run = P.makeMaintenanceTask(project, at(8, 15));
  const done = P.completeTask(run, project, NOW);
  assert.ok(done.task.done);
  assert.ok(done.task.subtasks.every((s) => s.done), 'ticked off from the list means done');
  assert.equal(done.project.log.length, 1);
  assert.equal(done.project.log[0].period, '2026-09');
  assert.deepEqual(done.project.log[0].items, ['Backup', 'Updates', 'Uptime']);
  assert.equal(done.next.kind, 'maint');
  assert.equal(done.next.projectId, project.id);
  assert.equal(done.next.due, at(9, 15));
  assert.equal(done.next.spawnedFrom, run.id);
});

check('a new site maintained straight away counts for this month', () => {
  // Added on the 9th with day 3: first run is scheduled for 3 October...
  const project = acme({ maintenance: { day: 3 } });
  const run = P.makeMaintenanceTask(project, P.nextMaintenanceDue(project, NOW));
  assert.equal(run.due, at(9, 3));
  // ...but the work is done today, so September is the month it covers.
  const done = P.completeTask(run, project, NOW);
  assert.equal(done.project.log[0].period, '2026-09');
  assert.equal(done.next.due, at(9, 3), 'October is still scheduled');
});

check('a run done early for next month, with this month done, counts for next month', () => {
  const project = acme({
    log: [{ id: 'l', taskId: 'old', period: '2026-09', at: at(8, 2), items: [], skipped: [] }],
  });
  const run = P.makeMaintenanceTask(project, at(9, 15));
  const done = P.completeTask(run, project, NOW);
  assert.equal(done.project.log[0].period, '2026-10');
  assert.equal(done.next.due, at(10, 15));
});

check('a late run counts for the month it was due, and this month stays due', () => {
  const project = acme({ maintenance: { day: 1 } });
  const run = P.makeMaintenanceTask(project, at(7, 1)); // August, done 9 September
  const done = P.completeTask(run, project, NOW);
  assert.equal(done.project.log[0].period, '2026-08');
  assert.equal(done.next.due, at(8, 1), 'September\'s run is next — already due');
});

check('a site months behind resumes from this month, without a backlog of runs', () => {
  const project = acme();
  const run = P.makeMaintenanceTask(project, at(2, 15)); // March
  const done = P.completeTask(run, project, NOW);
  assert.equal(done.project.log[0].period, '2026-03');
  assert.equal(done.next.due, at(8, 15), 'straight to September, not April');
});

check('"complete as is" records the steps that were skipped', () => {
  const project = acme();
  const run = P.makeMaintenanceTask(project, at(8, 15));
  run.subtasks[0].done = true;
  const done = P.completeTask(run, project, NOW, { asIs: true });
  assert.deepEqual(done.project.log[0].items, ['Backup']);
  assert.deepEqual(done.project.log[0].skipped, ['Updates', 'Uptime']);
});

check('reopening takes back next month\'s run and the history entry', () => {
  const project = acme();
  const run = P.makeMaintenanceTask(project, at(8, 15));
  const done = P.completeTask(run, project, NOW);
  const undo = P.reopenTask(done.task, [done.task, done.next], done.project);
  assert.equal(undo.task.done, false);
  assert.deepEqual(undo.remove, [done.next.id]);
  assert.equal(undo.project.log.length, 0);
});

check('reopening any recurring task takes back the copy it spawned', () => {
  const weekly = T.makeTask({ title: 'Invoice', due: NOW, recur: { every: 'week', interval: 1 } });
  const { task, next } = T.complete(weekly, NOW);
  assert.deepEqual(P.reopenTask(task, [task, next], null).remove, [next.id]);
});

// --- time ---------------------------------------------------------------------------

check('time adds up by month', () => {
  let project = acme();
  project = P.addTime(project, 90, { at: at(8, 2) });
  project = P.addTime(project, 30, { at: at(8, 20) });
  project = P.addTime(project, 45, { at: at(7, 28) });
  assert.equal(P.minutesIn(project, '2026-09'), 120);
  assert.equal(P.minutesIn(project, '2026-08'), 45);
  const half = project.time.find((e) => e.minutes === 30);
  const removed = P.removeTime(project, half.id);
  assert.equal(P.minutesIn(removed, '2026-09'), 90);
});

check('typed durations read the way people type them', () => {
  assert.equal(time.parseDuration('45'), 45);
  assert.equal(time.parseDuration('45m'), 45);
  assert.equal(time.parseDuration('1.5h'), 90);
  assert.equal(time.parseDuration('1h 30m'), 90);
  assert.equal(time.parseDuration('2h'), 120);
  assert.equal(time.parseDuration('soon'), null);
  assert.equal(time.formatMinutes(95), '1h 35m');
  assert.equal(time.formatElapsed(3725000), '1:02:05');
});

// --- the report ---------------------------------------------------------------------

check('the report covers the run, the work done and the time used', () => {
  let project = acme({ retainerHours: 5 });
  const run = P.makeMaintenanceTask(project, at(8, 15));
  const done = P.completeTask(run, project, at(8, 14));
  project = P.addTime(done.project, 150, { at: at(8, 14) });
  const feature = T.makeTask({
    title: 'Add a wishlist', projectId: project.id, kind: 'feature', done: true, completedAt: at(8, 3),
  });
  const fix = T.makeTask({
    title: 'Fix contact form spam', projectId: project.id, done: true, completedAt: at(8, 5),
  });
  const other = T.makeTask({ title: 'Someone else', done: true, completedAt: at(8, 5) });

  const text = P.buildReport(project, [done.task, feature, fix, other], '2026-09');
  assert.match(text, /^Acme Bakery — website care report, September 2026/);
  assert.match(text, /https:\/\/www\.acmebakery\.com\//);
  assert.match(text, /Monthly maintenance — completed/);
  assert.match(text, /✓ Backup/);
  assert.match(text, /New features\n {2}✓ Add a wishlist/);
  assert.match(text, /Updates and fixes\n {2}✓ Fix contact form spam/);
  assert.match(text, /Time: 2\.5 hours of 5 included/);
  assert.doesNotMatch(text, /Someone else/, 'only this client\'s work');
});

// --- quick add and the task list -----------------------------------------------------

check('+token files a task under a project and its stream', () => {
  const project = acme();
  const p = T.parseQuickAdd('Fix footer +acme !fri', { now: NOW, projects: [project] });
  assert.equal(p.title, 'Fix footer');
  assert.equal(p.projectId, project.id);
  assert.equal(p.context, 'freelance');
  assert.equal(p.projectExplicit, true);
});

check('+token matches by site address too', () => {
  const project = P.makeProject({ name: 'Bakery', url: 'acmebakery.com' });
  assert.equal(T.parseQuickAdd('x +acmeb', { projects: [project] }).projectId, project.id);
});

check('an unknown +token stays in the title', () => {
  assert.equal(T.parseQuickAdd('Plan +1 more', { projects: [acme()] }).title, 'Plan +1 more');
});

check('the site you are on is the default project', () => {
  const project = acme();
  const p = T.parseQuickAdd('Fix footer', { projects: [project], defaultProjectId: project.id });
  assert.equal(p.projectId, project.id);
  assert.equal(p.projectExplicit, false);
});

check('…unless the task is sent to another stream', () => {
  const project = acme();
  const p = T.parseQuickAdd('Buy milk @personal', { projects: [project], defaultProjectId: project.id });
  assert.equal(p.projectId, null);
  assert.equal(p.context, 'personal');
});

check('@per prefix-matches personal', () => {
  assert.equal(T.parseQuickAdd('Dentist @per').context, 'personal');
});

check('runs further out than three days stay off the list and the balance bar', () => {
  const project = acme();
  const far = P.makeMaintenanceTask(project, NOW + 10 * time.DAY);
  const near = P.makeMaintenanceTask(project, NOW + time.DAY);
  assert.equal(T.isSurfaced(far, NOW), false);
  assert.equal(T.isSurfaced(near, NOW), true);
  const summary = T.contextSummary([far], { lastTouched: {} }, NOW);
  assert.equal(summary.find((s) => s.context === 'freelance').open, 0);
});

check('search finds a client\'s tasks by the client\'s name', () => {
  const project = acme();
  const task = T.makeTask({ title: 'Swap the hero image', projectId: project.id });
  const found = T.search([task, T.makeTask({ title: 'other' })], 'bakery', () => project.name);
  assert.deepEqual(found.map((t) => t.title), ['Swap the hero image']);
});

check('the nudge adds a maintenance row only while sites are waiting', () => {
  const tasks = [T.makeTask({ title: 'shop', context: 'business' })];
  const settings = { staleContextDays: 2, lastTouched: { business: NOW } };
  const waiting = T.buildNudge(tasks, settings, NOW, {
    maintenance: { total: 4, done: 1, overdue: 1, month: 'September' },
  });
  const row = waiting.items.find((i) => i.title === 'Maintenance');
  assert.equal(row.message, '3 of 4 sites left for September · 1 overdue');
  const finished = T.buildNudge(tasks, settings, NOW, {
    maintenance: { total: 4, done: 4, overdue: 0, month: 'September' },
  });
  assert.equal(finished.items.find((i) => i.title === 'Maintenance'), undefined);
});

console.log(`\n${pass} checks passed`);
