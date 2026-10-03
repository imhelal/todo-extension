import assert from 'node:assert/strict';
import * as T from '../extension/src/lib/tasks.js';
import * as time from '../extension/src/lib/time.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
};

// Fixed reference point: Wed 2026-09-09 10:00 local.
const NOW = new Date(2026, 8, 9, 10, 0, 0).getTime();

check('quick-add parses tags, context and due', () => {
  const p = T.parseQuickAdd('Call supplier @business #urgent !tomorrow', { now: NOW });
  assert.equal(p.title, 'Call supplier');
  assert.equal(p.context, 'business');
  assert.deepEqual(p.tags, ['urgent']);
  assert.equal(new Date(p.due).getDate(), 10);
  assert.equal(new Date(p.due).getHours(), 9);
});

check('quick-add falls back to the active context', () => {
  const p = T.parseQuickAdd('Ship order', { defaultContext: 'freelance', now: NOW });
  assert.equal(p.context, 'freelance');
  assert.equal(p.contextExplicit, false);
});

check('@fre prefix-matches freelance', () => {
  assert.equal(T.parseQuickAdd('Fix bug @fre', { now: NOW }).context, 'freelance');
});

check('unknown ! token stays in the title', () => {
  const p = T.parseQuickAdd('Say !hello there', { now: NOW });
  assert.equal(p.title, 'Say !hello there');
  assert.equal(p.due, null);
});

check('!fri resolves to the coming Friday', () => {
  const due = T.parseDueToken('fri', NOW);
  assert.equal(new Date(due).getDay(), 5);
  assert.equal(new Date(due).getDate(), 11);
});

check('!wed on a Wednesday means next week', () => {
  const due = T.parseDueToken('wed', NOW);
  assert.equal(new Date(due).getDate(), 16);
});

check('a clock time that has passed rolls to tomorrow', () => {
  const due = T.parseDueToken('09:30', NOW);
  assert.equal(new Date(due).getDate(), 10);
  assert.equal(T.parseDueToken('14:30', NOW) - NOW, 4.5 * 60 * 60 * 1000);
});

check('!2w is fourteen days out', () => {
  assert.equal(time.daysBetween(NOW, T.parseDueToken('2w', NOW)), 14);
});

check('empty title yields no task', () => {
  assert.equal(T.taskFromQuickAdd('  #tag @business  ', { now: NOW }), null);
});

check('recurrence advances from the due date, not completion time', () => {
  const due = new Date(2026, 8, 7, 9, 0).getTime();      // Mon
  const task = T.makeTask({ title: 'Invoice', due, recur: { every: 'week', interval: 1 } });
  const { task: done, next } = T.complete(task, NOW);    // completed 2 days late
  assert.equal(done.done, true);
  assert.equal(new Date(next.due).getDay(), 1, 'stays on Monday');
  assert.equal(new Date(next.due).getDate(), 14);
  assert.equal(new Date(next.due).getHours(), 9);
});

check('a long-neglected daily task skips to the next future occurrence', () => {
  const due = new Date(2026, 7, 1, 9, 0).getTime();      // 39 days earlier
  const task = T.makeTask({ title: 'Check orders', due, recur: { every: 'day', interval: 1 } });
  const { next } = T.complete(task, NOW);
  assert.ok(next.due > NOW, 'next occurrence is in the future');
  // Today's 09:00 slot has already passed at 10:00, so the next one is tomorrow.
  assert.equal(time.daysBetween(NOW, next.due), 1);
  assert.equal(new Date(next.due).getHours(), 9, 'time of day is preserved');
});

check('completing resets subtasks on the new instance', () => {
  const task = T.makeTask({
    title: 'Weekly report',
    due: NOW,
    recur: { every: 'week', interval: 1 },
    subtasks: [T.makeSubtask('draft'), { ...T.makeSubtask('send'), done: true }],
  });
  const { next } = T.complete(task, NOW);
  assert.deepEqual(next.subtasks.map((s) => s.done), [false, false]);
});

check('non-recurring completion produces no follow-up', () => {
  const { next } = T.complete(T.makeTask({ title: 'One off' }), NOW);
  assert.equal(next, null);
});

check('grouping sorts into overdue / today / upcoming / none', () => {
  const list = [
    T.makeTask({ title: 'late', due: NOW - 3 * time.DAY }),
    T.makeTask({ title: 'later today', due: NOW + 2 * time.HOUR }),
    T.makeTask({ title: 'next week', due: NOW + 7 * time.DAY }),
    T.makeTask({ title: 'someday' }),
    T.makeTask({ title: 'finished', done: true, completedAt: NOW }),
  ];
  const { sections, completed } = T.groupForDisplay(list, NOW);
  const byKey = Object.fromEntries(sections.map((s) => [s.key, s.tasks.map((t) => t.title)]));
  assert.deepEqual(byKey.overdue, ['late']);
  assert.deepEqual(byKey.today, ['later today']);
  assert.deepEqual(byKey.upcoming, ['next week']);
  assert.deepEqual(byKey.none, ['someday']);
  assert.deepEqual(completed.map((t) => t.title), ['finished']);
});

check('badge counts overdue plus due-today only', () => {
  const list = [
    T.makeTask({ title: 'a', due: NOW - time.HOUR }),
    T.makeTask({ title: 'b', due: NOW + time.HOUR }),
    T.makeTask({ title: 'c', due: NOW + 5 * time.DAY }),
    T.makeTask({ title: 'd', due: NOW - time.HOUR, done: true }),
  ];
  assert.equal(T.dueSoon(list, NOW).length, 2);
  assert.equal(T.overdue(list, NOW).length, 1);
});

check('nudge names the context that has gone quiet', () => {
  const list = [
    T.makeTask({ title: 'shop', context: 'business' }),
    T.makeTask({ title: 'client a', context: 'freelance' }),
    T.makeTask({ title: 'client b', context: 'freelance' }),
  ];
  const settings = {
    staleContextDays: 2,
    lastTouched: { business: NOW, freelance: NOW - 3 * time.DAY },
  };
  const n = T.buildNudge(list, settings, NOW);
  assert.equal(n.stale, 'freelance');
  assert.match(n.title, /Freelance has been quiet for 3 days/);
  assert.match(n.message, /2 still open/);
});

check('nudge carries one list row per active context', () => {
  const list = [
    T.makeTask({ title: 'shop', context: 'business', due: NOW - time.HOUR }),
    T.makeTask({ title: 'shop 2', context: 'business', due: NOW + time.HOUR }),
    T.makeTask({ title: 'client', context: 'freelance' }),
  ];
  const settings = {
    staleContextDays: 2,
    lastTouched: { business: NOW, freelance: NOW - 4 * time.DAY },
  };
  const n = T.buildNudge(list, settings, NOW);
  assert.deepEqual(n.items.map((i) => i.title), ['Business', 'Freelance']);
  assert.match(n.items[0].message, /2 open · 1 overdue · 1 due today/);
  assert.match(n.items[1].message, /quiet 4 days/);
});

check('a context with nothing open is left out of the nudge rows', () => {
  const list = [T.makeTask({ title: 'only shop', context: 'business' })];
  const n = T.buildNudge(list, { staleContextDays: 2, lastTouched: { business: NOW } }, NOW);
  assert.deepEqual(n.items.map((i) => i.title), ['Business']);
});

check('nudge is silent when there is nothing open', () => {
  const list = [T.makeTask({ title: 'x', done: true, completedAt: NOW })];
  assert.equal(T.buildNudge(list, { lastTouched: {} }, NOW), null);
});

check('nudge summarises both sides when neither is stale', () => {
  const list = [
    T.makeTask({ title: 'shop', context: 'business', due: NOW - time.HOUR }),
    T.makeTask({ title: 'client', context: 'freelance' }),
  ];
  const n = T.buildNudge(list, { staleContextDays: 2, lastTouched: { business: NOW, freelance: NOW } }, NOW);
  assert.equal(n.stale, null);
  assert.match(n.message, /Business 1 open · 1 overdue/);
  assert.match(n.message, /Freelance 1 open/);
});

check('quiet hours wrap past midnight', () => {
  const q = { start: 22, end: 8 };
  assert.equal(time.inQuietHours(q, new Date(2026, 8, 9, 23, 0).getTime()), true);
  assert.equal(time.inQuietHours(q, new Date(2026, 8, 9, 3, 0).getTime()), true);
  assert.equal(time.inQuietHours(q, new Date(2026, 8, 9, 8, 0).getTime()), false);
  assert.equal(time.inQuietHours(q, new Date(2026, 8, 9, 14, 0).getTime()), false);
  assert.equal(time.inQuietHours({ start: 9, end: 17 }, new Date(2026, 8, 9, 12, 0).getTime()), true);
});

check('search matches title, notes and tags', () => {
  const list = [
    T.makeTask({ title: 'Restock the shelves' }),
    T.makeTask({ title: 'Landing page', notes: 'waiting on copy' }),
    T.makeTask({ title: 'Invoice', tags: ['acme'] }),
  ];
  assert.equal(T.search(list, 'shelves').length, 1);
  assert.equal(T.search(list, 'copy').length, 1);
  assert.equal(T.search(list, 'acme').length, 1);
  assert.equal(T.search(list, '').length, 3);
});

check('relative due reads naturally', () => {
  assert.equal(time.relativeDue(NOW + 30 * time.MINUTE, NOW), 'in 30m');
  assert.equal(time.relativeDue(NOW - 2 * time.HOUR, NOW), '2h ago');
  assert.equal(time.dueState(null, NOW), 'none');
  assert.equal(time.dueState(NOW + 30 * time.MINUTE, NOW), 'today');
});

// --- priority ------------------------------------------------------------------

check('!! flags a task as priority and leaves the title clean', () => {
  const p = T.parseQuickAdd('Fix checkout bug !! @fre !tomorrow', { now: NOW });
  assert.equal(p.title, 'Fix checkout bug');
  assert.equal(p.priority, true);
  assert.equal(p.context, 'freelance');
  assert.ok(p.due, 'a due token still works alongside it');
  assert.equal(T.taskFromQuickAdd('Call back !!', { now: NOW }).priority, true);
  assert.equal(T.parseQuickAdd('Wow!! that', { now: NOW }).title, 'Wow!! that', 'only a bare !! counts');
});

check('flagged tasks get their own section at the top, whatever their date', () => {
  const list = [
    T.makeTask({ title: 'late', due: NOW - time.DAY }),
    T.makeTask({ title: 'urgent someday', priority: true }),
    T.makeTask({ title: 'urgent tomorrow', priority: true, due: NOW + time.DAY }),
    T.makeTask({ title: 'flagged but done', priority: true, done: true, completedAt: NOW }),
  ];
  const { sections, completed } = T.groupForDisplay(list, NOW);
  assert.equal(sections[0].key, 'priority');
  assert.deepEqual(sections[0].tasks.map((t) => t.title), ['urgent tomorrow', 'urgent someday']);
  assert.deepEqual(sections.find((s) => s.key === 'overdue').tasks.map((t) => t.title), ['late']);
  assert.deepEqual(completed.map((t) => t.title), ['flagged but done']);
});

check('a recurring flagged task stays flagged', () => {
  const task = T.makeTask({ title: 'Payroll', priority: true, due: NOW, recur: { every: 'week', interval: 1 } });
  assert.equal(T.complete(task, NOW).next.priority, true);
});

// --- the morning brief ---------------------------------------------------------

const B = await import('../extension/src/lib/brief.js');
const P = await import('../extension/src/lib/projects.js');

check('the brief is due at its time today, or tomorrow once that has passed', () => {
  const at = (h, m = 0) => new Date(2026, 8, 9, h, m).getTime();
  assert.equal(B.nextBriefAt({ briefAt: 11 * 60 }, NOW), at(11));
  assert.equal(B.nextBriefAt({ briefAt: 9 * 60 }, NOW), new Date(2026, 8, 10, 9, 0).getTime());
  assert.equal(B.nextBriefAt({ briefAt: 10 * 60 }, NOW), new Date(2026, 8, 10, 10, 0).getTime(), 'exactly now counts as passed');
});

check('a missed brief is caught up for four hours, then let go', () => {
  const s = { briefEnabled: true, briefAt: 9 * 60, lastBriefOn: '' };
  assert.equal(B.briefMissed(s, NOW), true, 'an hour late: send it');
  assert.equal(B.briefMissed(s, new Date(2026, 8, 9, 14, 0).getTime()), false, 'five hours late: skip');
  assert.equal(B.briefMissed(s, new Date(2026, 8, 9, 8, 0).getTime()), false, 'not yet time');
  assert.equal(B.briefMissed({ ...s, lastBriefOn: time.dayKey(NOW) }, NOW), false, 'already sent today');
  assert.equal(B.briefMissed({ ...s, briefEnabled: false }, NOW), false);
});

check('the brief is null on a day with nothing overdue, due or flagged', () => {
  const list = [T.makeTask({ title: 'someday' }), T.makeTask({ title: 'next week', due: NOW + 7 * time.DAY })];
  assert.equal(B.buildBrief(list, [], { lastTouched: {} }, NOW), null);
});

check('the brief covers late, flagged, each stream, sites and a quiet stream', () => {
  const site = P.makeProject({ name: 'Acme Bakery' });
  const list = [
    T.makeTask({ title: 'Reconcile payouts', context: 'business', due: NOW - 2 * time.HOUR }),
    T.makeTask({ title: 'Send the proposal', context: 'freelance', priority: true }),
    T.makeTask({ title: 'Restock tape', context: 'business', due: NOW + 2 * time.HOUR }),
    T.makeTask({ title: 'Dentist', context: 'personal', due: NOW + 5 * time.HOUR }),
    P.makeMaintenanceTask(site, NOW + time.HOUR),
  ];
  const settings = {
    staleContextDays: 2,
    lastTouched: { business: NOW, freelance: NOW, personal: NOW - 4 * time.DAY },
  };
  const b = B.buildBrief(list, [site], settings, NOW);

  assert.equal(b.title, 'Good morning · 3 due today');
  assert.equal(b.message, '1 overdue · 1 priority · 1 site');
  assert.deepEqual(b.counts, { overdue: 1, today: 3, priority: 1, sites: 1 });
  assert.deepEqual(b.items.map((i) => i.title), ['Overdue', 'Priority', 'Business', 'Personal', 'Sites']);
  assert.equal(b.items[4].message, '1 due · Acme Bakery');
  assert.equal(b.items.length, 5, 'capped at what a list notification shows');
  assert.equal(b.quiet, 'personal');
  assert.deepEqual(b.focus.map((t) => t.title), ['Send the proposal', 'Reconcile payouts', 'Monthly maintenance'],
    'flagged first, then late, then today by time');
});

check('the greeting follows the clock', () => {
  assert.equal(B.greeting(new Date(2026, 8, 9, 7).getTime()), 'Good morning');
  assert.equal(B.greeting(new Date(2026, 8, 9, 13).getTime()), 'Good afternoon');
  assert.equal(B.greeting(new Date(2026, 8, 9, 19).getTime()), 'Good evening');
});

console.log(`\n${pass} checks passed`);
