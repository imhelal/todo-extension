// Pure task logic. No chrome.* access — the service worker and both UI
// surfaces call into here so behaviour is identical wherever it happens.

import { DAY, advance, dueState, startOfDay } from './time.js';

export const CONTEXTS = ['business', 'freelance', 'personal'];

export const CONTEXT_LABEL = {
  business: 'Business',
  freelance: 'Freelance',
  personal: 'Personal',
};

/** Task kinds. 'maint' is the monthly maintenance run a project creates itself. */
export const KINDS = ['task', 'feature', 'maint'];

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14);
}

export function makeTask(fields = {}) {
  const now = Date.now();
  return {
    id: 't_' + uid(),
    title: '',
    context: 'business',
    projectId: null,
    kind: 'task',
    priority: false,
    tags: [],
    notes: '',
    subtasks: [],
    due: null,
    remindAt: null,
    recur: null,
    done: false,
    completedAt: null,
    createdAt: now,
    order: now,
    ...fields,
  };
}

export function makeSubtask(title) {
  return {
    id: 's_' + Math.random().toString(36).slice(2, 10),
    title,
    done: false,
  };
}

// --- quick-add parsing -----------------------------------------------------

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Default reminder time for a bare day reference like `!tomorrow`. */
const DEFAULT_DUE_HOUR = 9;

function atHour(ts, hour) {
  const d = new Date(ts);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * Resolve a `!token` into a timestamp, or null if it is not a date we know.
 * Supported: today, tomorrow, tonight, weekday names, `3d`, `2w`, `18:30`.
 */
export function parseDueToken(token, now = Date.now()) {
  const t = token.toLowerCase();

  if (t === 'today') return atHour(now, DEFAULT_DUE_HOUR) > now ? atHour(now, DEFAULT_DUE_HOUR) : atHour(now, 18);
  if (t === 'tonight') return atHour(now, 20);
  if (t === 'tomorrow' || t === 'tmr') return atHour(now + DAY, DEFAULT_DUE_HOUR);

  const clock = t.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    // A time that has already passed today means the next occurrence.
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const offset = t.match(/^(\d+)([dw])$/);
  if (offset) {
    const days = Number(offset[1]) * (offset[2] === 'w' ? 7 : 1);
    return atHour(now + days * DAY, DEFAULT_DUE_HOUR);
  }

  const weekday = WEEKDAYS.indexOf(t.slice(0, 3));
  if (weekday !== -1) {
    const today = new Date(now).getDay();
    let delta = (weekday - today + 7) % 7;
    if (delta === 0) delta = 7; // `!mon` on a Monday means next Monday
    return atHour(now + delta * DAY, DEFAULT_DUE_HOUR);
  }

  return null;
}

const squash = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve a `+token` to a project by name or site address, so `+acme` and
 * `+acmebakery` both land on "Acme Bakery". Paused projects still match: work
 * gets logged against them, it just is not scheduled.
 */
export function matchProjectToken(projects, token) {
  const t = squash(token);
  if (!t) return null;
  const host = (p) => squash(String(p.url || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, ''));
  return (
    projects.find((p) => squash(p.name) === t)
    || projects.find((p) => squash(p.name).startsWith(t))
    || projects.find((p) => host(p).startsWith(t))
    || null
  );
}

/**
 * Parse the quick-add input. Recognises `#tag`, `@context`, `!due`,
 * `+project` and `!!` (priority), and returns both the parsed fields and what
 * was consumed, so the UI can show a preview of how the line was understood.
 *
 * `defaultProjectId` is the client site the browser is currently on. It
 * applies unless the line names another project, or sends the task to a
 * different stream than that project lives in.
 */
export function parseQuickAdd(
  input,
  { defaultContext = 'business', now = Date.now(), projects = [], defaultProjectId = null } = {},
) {
  const tags = [];
  let context = null;
  let due = null;
  let dueToken = null;
  let project = null;
  let priority = false;

  const words = input.split(/\s+/).filter(Boolean);
  const kept = [];

  for (const word of words) {
    if (word === '!!') {
      priority = true;
      continue;
    }
    if (word.length > 1 && word[0] === '#') {
      tags.push(word.slice(1).toLowerCase());
      continue;
    }
    if (word.length > 1 && word[0] === '@') {
      const value = word.slice(1).toLowerCase();
      const match = CONTEXTS.find((c) => c.startsWith(value));
      if (match) {
        context = match;
        continue;
      }
    }
    if (word.length > 1 && word[0] === '!') {
      const parsed = parseDueToken(word.slice(1), now);
      if (parsed) {
        due = parsed;
        dueToken = word.slice(1).toLowerCase();
        continue;
      }
    }
    if (word.length > 1 && word[0] === '+') {
      const match = matchProjectToken(projects, word.slice(1));
      if (match) {
        project = match;
        continue;
      }
    }
    kept.push(word);
  }

  const projectExplicit = Boolean(project);
  if (!project && defaultProjectId) {
    const fallback = projects.find((p) => p.id === defaultProjectId) || null;
    if (fallback && (!context || context === fallback.context)) project = fallback;
  }

  return {
    title: kept.join(' ').trim(),
    // A named project pulls the task into its stream unless @context says otherwise.
    context: context || (project ? project.context : defaultContext),
    contextExplicit: Boolean(context),
    tags: [...new Set(tags)],
    due,
    dueToken,
    projectId: project ? project.id : null,
    projectName: project ? project.name : null,
    projectExplicit,
    priority,
  };
}

export function taskFromQuickAdd(input, options) {
  const parsed = parseQuickAdd(input, options);
  if (!parsed.title) return null;
  return makeTask({
    title: parsed.title,
    context: parsed.context,
    projectId: parsed.projectId,
    priority: parsed.priority,
    tags: parsed.tags,
    due: parsed.due,
    remindAt: parsed.due,
  });
}

// --- state transitions -----------------------------------------------------

/**
 * Complete a task. Returns `{ task, next }` where `next` is the freshly
 * created following instance for a recurring task, or null.
 *
 * Recurrence advances from the ORIGINAL due date, not from completion time, so
 * a weekly Monday task stays on Monday even when ticked off late.
 */
export function complete(task, now = Date.now()) {
  const completed = { ...task, done: true, completedAt: now };
  if (!task.recur) return { task: completed, next: null };

  const { every, interval = 1 } = task.recur;
  const anchor = task.due || now;
  let due = advance(anchor, every, interval);
  // If the task was completed long after it was due, skip forward to the first
  // occurrence still in the future rather than firing a burst of past-due ones.
  let guard = 0;
  while (due <= now && guard < 500) {
    due = advance(due, every, interval);
    guard += 1;
  }

  const next = makeTask({
    title: task.title,
    context: task.context,
    projectId: task.projectId || null,
    kind: task.kind || 'task',
    priority: Boolean(task.priority),
    tags: [...task.tags],
    notes: task.notes,
    subtasks: task.subtasks.map((s) => ({ ...s, done: false })),
    due,
    remindAt: due,
    recur: { ...task.recur },
    order: task.order,
    // Remembered so reopening this one can take back the instance it spawned,
    // rather than leaving two copies of the same recurring task open.
    spawnedFrom: task.id,
  });

  return { task: completed, next };
}

export function reopen(task) {
  return { ...task, done: false, completedAt: null };
}

/** The open follow-up a recurring task created when it was completed, if any. */
export function spawnedBy(tasks, task) {
  return tasks.filter((t) => t.spawnedFrom === task.id && !t.done);
}

export function snooze(task, ms, now = Date.now()) {
  return { ...task, remindAt: now + ms };
}

// --- querying --------------------------------------------------------------

export function openTasks(tasks) {
  return tasks.filter((t) => !t.done);
}

export function byContext(tasks, context) {
  return context === 'all' ? tasks : tasks.filter((t) => t.context === context);
}

/** `projectName(id)` lets a search for a client's name find that client's tasks. */
export function search(tasks, query, projectName = () => '') {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.notes.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.includes(q)) ||
      (t.projectId && String(projectName(t.projectId) || '').toLowerCase().includes(q)),
  );
}

/**
 * Whether a task belongs in the everyday list. A maintenance run is scheduled a
 * month ahead for every site, so it only surfaces once it is close; until then
 * it lives on the Projects view, and a dozen of them do not swamp the list or
 * tip the balance bar.
 */
export const MAINT_LEAD = 3 * DAY;

export function isSurfaced(task, now = Date.now()) {
  if (task.kind !== 'maint' || task.done) return true;
  return task.due != null && task.due <= now + MAINT_LEAD;
}

/** Open, flagged tasks, soonest due first. */
export function prioritised(tasks) {
  return openTasks(tasks)
    .filter((t) => t.priority)
    .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.order - b.order);
}

/** Tasks that should show a badge: open and due today or already overdue. */
export function dueSoon(tasks, now = Date.now()) {
  return openTasks(tasks).filter((t) => {
    const state = dueState(t.due, now);
    return state === 'overdue' || state === 'today';
  });
}

export function overdue(tasks, now = Date.now()) {
  return openTasks(tasks).filter((t) => dueState(t.due, now) === 'overdue');
}

/** Open tasks whose reminder time has arrived. */
export function dueForReminder(tasks, now = Date.now()) {
  return tasks.filter((t) => !t.done && t.remindAt && t.remindAt <= now);
}

const SECTION_ORDER = ['priority', 'overdue', 'today', 'upcoming', 'none'];

export const SECTION_LABEL = {
  priority: 'Priority',
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  none: 'No date',
};

/**
 * Group open tasks into display sections, each sorted by due date then manual
 * order. Flagged tasks are lifted into their own Priority section at the top,
 * whatever their date — their due pill still says when, in red if late.
 * Completed tasks are returned separately, newest first.
 */
export function groupForDisplay(tasks, now = Date.now()) {
  const sections = { priority: [], overdue: [], today: [], upcoming: [], none: [] };
  const completed = [];

  for (const task of tasks) {
    if (task.done) completed.push(task);
    else if (task.priority) sections.priority.push(task);
    else sections[dueState(task.due, now)].push(task);
  }

  for (const key of SECTION_ORDER) {
    sections[key].sort((a, b) => {
      if (a.due && b.due && a.due !== b.due) return a.due - b.due;
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      return a.order - b.order;
    });
  }
  completed.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  return {
    sections: SECTION_ORDER.map((key) => ({ key, label: SECTION_LABEL[key], tasks: sections[key] })),
    completed,
  };
}

/** Every tag in use, most common first — powers the filter chips. */
export function allTags(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    for (const tag of task.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
}

// --- balance / nudge summary ----------------------------------------------

/**
 * Per-context snapshot used by the badge and the balance nudge.
 * `staleDays` is how long since a context was last worked in; null when never.
 */
export function contextSummary(tasks, settings, now = Date.now()) {
  const surfaced = tasks.filter((t) => isSurfaced(t, now));
  return CONTEXTS.map((context) => {
    const mine = byContext(surfaced, context);
    const open = openTasks(mine);
    const touched = (settings.lastTouched || {})[context] || 0;
    return {
      context,
      label: CONTEXT_LABEL[context],
      open: open.length,
      overdue: overdue(mine, now).length,
      dueToday: open.filter((t) => dueState(t.due, now) === 'today').length,
      staleDays: touched ? Math.floor((startOfDay(now) - startOfDay(touched)) / DAY) : null,
    };
  });
}

/**
 * Build the balance-nudge message, or null when there is nothing worth saying.
 * A nudge that fires with nothing to do is how people learn to ignore nudges.
 *
 * `maintenance` is this month's site overview (see projects.monthOverview);
 * when sites are still waiting it adds a row, so client upkeep stays in view
 * alongside the streams.
 */
export function buildNudge(tasks, settings, now = Date.now(), { maintenance = null } = {}) {
  const summary = contextSummary(tasks, settings, now);
  const totalOpen = summary.reduce((sum, s) => sum + s.open, 0);
  if (!totalOpen) return null;

  const threshold = settings.staleContextDays ?? 2;
  const stale = summary
    .filter((s) => s.open > 0 && s.staleDays !== null && s.staleDays >= threshold)
    .sort((a, b) => b.staleDays - a.staleDays)[0];

  const active = summary.filter((s) => s.open > 0);

  const line = active
    .map((s) => `${s.label} ${s.open} open${s.overdue ? ` · ${s.overdue} overdue` : ''}`)
    .join('  —  ');

  // One row per stream, for a list-style notification.
  const items = active.map((s) => {
    const bits = [`${s.open} open`];
    if (s.overdue) bits.push(`${s.overdue} overdue`);
    if (s.dueToday) bits.push(`${s.dueToday} due today`);
    if (s.staleDays !== null && s.staleDays >= threshold) {
      bits.push(s.staleDays === 1 ? 'quiet 1 day' : `quiet ${s.staleDays} days`);
    }
    return { title: s.label, message: bits.join(' · ') };
  });

  if (maintenance && maintenance.total > maintenance.done) {
    const left = maintenance.total - maintenance.done;
    const bits = [`${left} of ${maintenance.total} sites left for ${maintenance.month}`];
    if (maintenance.overdue) bits.push(`${maintenance.overdue} overdue`);
    items.push({ title: 'Maintenance', message: bits.join(' · ') });
  }

  if (stale) {
    const days = stale.staleDays === 1 ? '1 day' : `${stale.staleDays} days`;
    return {
      title: `${stale.label} has been quiet for ${days}`,
      message: `${stale.open} still open there.`,
      items,
      stale: stale.context,
    };
  }

  return { title: 'Where things stand', message: line, items, stale: null };
}
