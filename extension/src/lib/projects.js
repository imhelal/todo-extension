// Pure project logic: client sites on a monthly maintenance cycle, the time
// logged against them, and the report that goes to the client at month end.
// No chrome.* access, so the worker and both UI surfaces share every rule.
//
// A project's maintenance run is an ordinary task (kind 'maint') that repeats
// monthly with the checklist as its steps. That buys reminders, the badge,
// snooze and recurrence for free; what this module adds is the bookkeeping
// around it — keeping one run scheduled per active site, and writing each
// finished run into the project's history so reports survive the task purge.

import { complete, makeSubtask, makeTask, reopen, spawnedBy, uid } from './tasks.js';
import { monthKey, monthLabel, monthStart, shiftMonth, shortDate } from './time.js';

export const DEFAULT_CHECKLIST = [
  'Full backup — files and database',
  'Update core, plugins and themes',
  'Check uptime and SSL certificate',
  'Run a security scan',
  'Test forms and checkout',
  'Check page speed',
  'Fix broken links and 404s',
  'Review analytics and Search Console',
];

export const PLATFORMS = ['WordPress', 'WooCommerce', 'Shopify', 'Webflow', 'Laravel', 'Next.js', 'Custom'];

/** Maintenance reminders land mid-morning on the chosen day. */
const MAINT_HOUR = 10;
/** Two years of monthly runs; older history is not worth the storage. */
const LOG_LIMIT = 24;
const TIME_LIMIT = 400;

export function makeProject(fields = {}) {
  const now = Date.now();
  return {
    id: 'p_' + uid(),
    name: '',
    client: '',
    url: '',
    platform: '',
    context: 'freelance',
    status: 'active', // 'active' | 'paused'
    maintenance: { enabled: true, day: 1, checklist: [...DEFAULT_CHECKLIST] },
    retainerHours: null,
    links: [], // [{ id, label, url }]
    notes: '',
    log: [], // finished maintenance runs, newest first
    time: [], // [{ id, at, minutes, note }], newest first
    createdAt: now,
    order: now,
    ...fields,
  };
}

export function makeLink(label, url) {
  return { id: 'k_' + uid(), label: label.trim(), url: url.trim() };
}

// --- addresses -----------------------------------------------------------------

/** 'https://www.Acme.com/shop' → 'acme.com'. Only web addresses count. */
export function hostnameOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https?:/i.test(raw)) return '';
  try {
    return new URL(hasScheme ? raw : 'https://' + raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** A typed address made safe to open: scheme added, anything non-web refused. */
export function hrefOf(url) {
  const raw = String(url || '').trim();
  if (!raw || !hostnameOf(raw)) return null;
  return /^https?:/i.test(raw) ? raw : 'https://' + raw;
}

/**
 * The project whose site the browser is on. The site address wins, most
 * specific first; a project's other links (admin, hosting) only count when
 * they point at exactly one project, since hosting dashboards are shared.
 */
export function matchProjectByUrl(projects, url) {
  const host = hostnameOf(url);
  if (!host) return null;
  const hits = (h) => Boolean(h) && (host === h || host.endsWith('.' + h));

  const bySite = projects
    .filter((p) => hits(hostnameOf(p.url)))
    .sort((a, b) => hostnameOf(b.url).length - hostnameOf(a.url).length);
  if (bySite.length) return bySite[0];

  const byLink = projects.filter((p) => (p.links || []).some((l) => hits(hostnameOf(l.url))));
  return byLink.length === 1 ? byLink[0] : null;
}

export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '·';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

/** A stable hue per project, so each client keeps its colour everywhere. */
export function hueOf(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// --- the maintenance schedule ---------------------------------------------------

export function isScheduled(project) {
  return project.status === 'active' && Boolean(project.maintenance?.enabled);
}

/** The run's due time in a given month: the chosen day, mid-morning. */
export function maintenanceDueIn(key, day) {
  const d = new Date(monthStart(key));
  d.setDate(Math.min(Math.max(1, Number(day) || 1), 28));
  d.setHours(MAINT_HOUR, 0, 0, 0);
  return d.getTime();
}

export function loggedFor(project, key) {
  return (project.log || []).find((e) => e.period === key) || null;
}

/**
 * When the next run should fall: this month's date if it is still ahead and
 * the month is not already logged, otherwise next month's. A site added after
 * its day has passed starts next month instead of arriving already overdue —
 * onboarding twenty sites should not light the badge up red.
 */
export function nextMaintenanceDue(project, now = Date.now()) {
  const day = project.maintenance.day;
  let key = monthKey(now);
  if (loggedFor(project, key) || maintenanceDueIn(key, day) <= now) key = shiftMonth(key, 1);
  while (loggedFor(project, key)) key = shiftMonth(key, 1);
  return maintenanceDueIn(key, day);
}

/**
 * Which month a finished run counts for. On time or late, it was that
 * month's run. Early, it counts for the first month not yet done, starting
 * with this one — so a site added on the 20th and maintained the same day is
 * done for this month, not credited to next month while this one sits empty.
 */
export function runPeriod(project, task, now = Date.now()) {
  const dueKey = monthKey(task.due ?? now);
  if (task.due == null || now >= task.due) return dueKey;
  let key = monthKey(now);
  while (key < dueKey && loggedFor(project, key)) key = shiftMonth(key, 1);
  return key;
}

/**
 * When the run after a finished one falls: the next month not yet done. A
 * site that fell more than a month behind resumes from this month rather than
 * queuing up a run for every month it missed.
 */
export function followingDue(project, period, now = Date.now()) {
  const thisKey = monthKey(now);
  let key = shiftMonth(period, 1);
  if (key < thisKey) key = thisKey;
  while (loggedFor(project, key)) key = shiftMonth(key, 1);
  return maintenanceDueIn(key, project.maintenance.day);
}

export function makeMaintenanceTask(project, due) {
  return makeTask({
    title: 'Monthly maintenance',
    context: project.context,
    projectId: project.id,
    kind: 'maint',
    subtasks: project.maintenance.checklist.map((title) => makeSubtask(title)),
    due,
    remindAt: due,
    recur: { every: 'month', interval: 1 },
  });
}

/** Open maintenance runs for a project, soonest first. Normally exactly one. */
export function openMaintenance(tasks, projectId) {
  return tasks
    .filter((t) => t.kind === 'maint' && t.projectId === projectId && !t.done)
    .sort((a, b) => (a.due || 0) - (b.due || 0));
}

/**
 * Bring every project's maintenance run in line with its settings: schedule
 * the missing ones, withdraw them from paused projects (no reminders for a
 * site you are not looking after), and collapse duplicates that two surfaces
 * created at once. Returns the writes to make and applies none of them.
 */
export function syncMaintenance(projects, tasks, now = Date.now()) {
  const upserts = [];
  const removals = [];
  const known = new Set(projects.map((p) => p.id));

  for (const project of projects) {
    const open = openMaintenance(tasks, project.id);
    if (!isScheduled(project)) {
      removals.push(...open.map((t) => t.id));
    } else if (!open.length) {
      upserts.push(makeMaintenanceTask(project, nextMaintenanceDue(project, now)));
    } else {
      removals.push(...open.slice(1).map((t) => t.id));
    }
  }

  // A run whose project was deleted would otherwise remind forever.
  for (const task of tasks) {
    if (task.kind === 'maint' && !task.done && task.projectId && !known.has(task.projectId)) {
      removals.push(task.id);
    }
  }

  return { upserts, removals };
}

/**
 * Carry a project edit onto its open run. A new day moves the due date within
 * the same month. Steps added to or removed from the template are added or
 * removed here, in template order — ticks already made, and one-off steps
 * added to just this month's run, are left alone.
 */
export function reconcileMaintenance(task, before, after) {
  const next = { ...task, context: after.context };

  if (before.maintenance.day !== after.maintenance.day && task.due) {
    const due = maintenanceDueIn(monthKey(task.due), after.maintenance.day);
    next.due = due;
    next.remindAt = due;
  }

  const oldList = before.maintenance.checklist;
  const newList = after.maintenance.checklist;
  const removed = new Set(oldList.filter((t) => !newList.includes(t)));
  const added = new Set(newList.filter((t) => !oldList.includes(t)));
  const byTitle = new Map(task.subtasks.map((s) => [s.title, s]));

  const ordered = [];
  for (const title of newList) {
    if (byTitle.has(title)) ordered.push(byTitle.get(title));
    else if (added.has(title)) ordered.push(makeSubtask(title));
  }
  const oneOffs = task.subtasks.filter((s) => !newList.includes(s.title) && !removed.has(s.title));
  next.subtasks = [...ordered, ...oneOffs];
  return next;
}

export function checklistProgress(task) {
  if (!task) return { done: 0, total: 0 };
  return { done: task.subtasks.filter((s) => s.done).length, total: task.subtasks.length };
}

/**
 * Where a project stands for the current month:
 *   done     this month's run is logged
 *   overdue  the open run is past due
 *   due      the open run falls later this month
 *   later    nothing due this month (a site that starts next month)
 *   off      paused, or maintenance switched off
 */
export function monthStatus(project, tasks, now = Date.now()) {
  if (!isScheduled(project)) return { state: 'off', task: null, entry: null };
  const key = monthKey(now);
  const entry = loggedFor(project, key);
  const task = openMaintenance(tasks, project.id)[0] || null;
  if (entry) return { state: 'done', task, entry };
  if (!task || task.due == null) return { state: 'later', task, entry: null };
  if (task.due < now) return { state: 'overdue', task, entry: null };
  if (monthKey(task.due) === key) return { state: 'due', task, entry: null };
  return { state: 'later', task, entry: null };
}

/** This month across every site: how many are done, waiting and late. */
export function monthOverview(projects, tasks, now = Date.now()) {
  const key = monthKey(now);
  const counts = { done: 0, due: 0, overdue: 0, later: 0 };
  for (const project of projects) {
    const { state } = monthStatus(project, tasks, now);
    if (state in counts) counts[state] += 1;
  }
  return {
    key,
    month: monthLabel(key, { short: true }),
    ...counts,
    total: counts.done + counts.due + counts.overdue,
  };
}

const STATUS_RANK = { overdue: 0, due: 1, later: 2, done: 3, off: 4 };

/** Sites needing attention first, then by when the next run falls. */
export function sortProjects(projects, tasks, now = Date.now()) {
  return projects
    .map((project) => ({ project, status: monthStatus(project, tasks, now) }))
    .sort((a, b) => {
      const rank = STATUS_RANK[a.status.state] - STATUS_RANK[b.status.state];
      if (rank) return rank;
      const ad = a.status.task?.due ?? Infinity;
      const bd = b.status.task?.due ?? Infinity;
      if (ad !== bd) return ad - bd;
      return a.project.name.localeCompare(b.project.name);
    })
    .map(({ project }) => project);
}

// --- completing ------------------------------------------------------------------

/**
 * Complete any task, with what that means for its project: a finished
 * maintenance run is written into the project's history before recurrence
 * rolls it to next month. Returns the writes; the caller persists them.
 *
 * Ticking a run off from the list or a notification means "done", so its
 * steps are ticked too — otherwise the client report would list nothing.
 * `asIs` keeps the steps exactly as they are, for a month where some were
 * deliberately skipped.
 */
export function completeTask(task, project, now = Date.now(), { asIs = false } = {}) {
  const isRun = task.kind === 'maint' && project;
  const ready = isRun && !asIs
    ? { ...task, subtasks: task.subtasks.map((s) => ({ ...s, done: true })) }
    : task;
  const { task: done, next } = complete(ready, now);
  if (!isRun) return { task: done, next, project: null };

  // A run's follow-up is placed by the calendar of months done, not by plain
  // recurrence, so an early or late run never skips or doubles a month.
  const period = runPeriod(project, task, now);
  const logged = logMaintenance(project, done, now, period);
  const due = followingDue(logged, period, now);
  return { task: done, next: next && { ...next, due, remindAt: due }, project: logged };
}

/** The reverse: reopen, take back the follow-up it spawned, unlog the run. */
export function reopenTask(task, tasks, project) {
  return {
    task: reopen(task),
    remove: spawnedBy(tasks, task).map((t) => t.id),
    project: task.kind === 'maint' && project ? unlogMaintenance(project, task.id) : null,
  };
}

export function logMaintenance(project, task, now = Date.now(), period = monthKey(task.due || now)) {
  const entry = {
    id: 'l_' + uid(),
    taskId: task.id,
    period,
    at: now,
    items: task.subtasks.filter((s) => s.done).map((s) => s.title),
    skipped: task.subtasks.filter((s) => !s.done).map((s) => s.title),
  };
  const log = [entry, ...(project.log || []).filter((e) => e.taskId !== task.id)]
    .sort((a, b) => b.at - a.at)
    .slice(0, LOG_LIMIT);
  return { ...project, log };
}

export function unlogMaintenance(project, taskId) {
  return { ...project, log: (project.log || []).filter((e) => e.taskId !== taskId) };
}

// --- time ------------------------------------------------------------------------

export function addTime(project, minutes, { at = Date.now(), note = '' } = {}) {
  const entry = { id: 'm_' + uid(), at, minutes: Math.max(1, Math.round(minutes)), note };
  return { ...project, time: [entry, ...(project.time || [])].slice(0, TIME_LIMIT) };
}

export function removeTime(project, id) {
  return { ...project, time: (project.time || []).filter((e) => e.id !== id) };
}

export function minutesIn(project, key) {
  return (project.time || [])
    .filter((e) => monthKey(e.at) === key)
    .reduce((sum, e) => sum + e.minutes, 0);
}

/** 270 → '4.5' — hours the way an invoice wants them. */
export function hoursText(minutes) {
  const h = Math.round((minutes / 60) * 100) / 100;
  return String(h);
}

// --- the client report -----------------------------------------------------------

/**
 * A plain-text summary of a month's work on one site, ready to paste into an
 * email. Plain text on purpose: it survives every mail client and invoice
 * tool, where markdown or HTML would arrive as clutter.
 */
export function buildReport(project, tasks, key) {
  const lines = [`${project.name} — website care report, ${monthLabel(key)}`];
  const href = hrefOf(project.url);
  if (href) lines.push(href);

  const block = (title, rows) => {
    if (!rows.length) return;
    lines.push('', title, ...rows);
  };

  const entry = loggedFor(project, key);
  if (entry) {
    block(
      `Monthly maintenance — completed ${shortDate(entry.at)}`,
      entry.items.length ? entry.items.map((item) => `  ✓ ${item}`) : ['  ✓ Completed'],
    );
  } else if (isScheduled(project)) {
    const open = openMaintenance(tasks, project.id)[0];
    if (open && monthKey(open.due) === key) {
      block('Monthly maintenance', [`  Scheduled for ${shortDate(open.due)}`]);
    }
  }

  const mine = tasks.filter((t) => t.projectId === project.id && t.kind !== 'maint');
  const doneIn = (t) => t.done && t.completedAt && monthKey(t.completedAt) === key;
  const line = (t) => `  ✓ ${t.title} (${shortDate(t.completedAt)})`;

  block('New features', mine.filter((t) => t.kind === 'feature' && doneIn(t)).map(line));
  block('Updates and fixes', mine.filter((t) => t.kind !== 'feature' && doneIn(t)).map(line));
  // Work still open is only news for the current month.
  if (key === monthKey()) {
    block('In progress', mine.filter((t) => !t.done).map((t) => `  • ${t.title}`));
  }

  const minutes = minutesIn(project, key);
  if (minutes || project.retainerHours) {
    const used = `${hoursText(minutes)} hours`;
    lines.push('', project.retainerHours ? `Time: ${used} of ${project.retainerHours} included` : `Time: ${used}`);
  }

  return lines.join('\n');
}
