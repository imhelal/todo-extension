// The only module that touches the extension's data in chrome.storage.
//
// Data lives in chrome.storage.local. It used to live in sync, but sync caps
// the whole extension at 100 KB, and a client list with monthly checklists,
// time logs and maintenance history outgrows that within months — at which
// point every save fails. Local has no practical ceiling (the manifest asks
// for unlimitedStorage). The trade is that data no longer follows you to a
// second computer; Export / Import in Settings covers that.
//
// Layout: one key per collection — `tasks` and `projects` as id → record maps,
// plus `settings` and `timer`. Writes are debounced and limited to the keys
// that changed. Each write is stamped with this instance's id so its own
// onChanged echo is ignored, and a change from another surface is merged
// record by record, so an unsaved edit here is not lost to a save over there.

const FLUSH_DELAY = 400; // ms
const DAY = 24 * 60 * 60 * 1000;
// Long enough that last month's client report can still see what was done.
const COMPLETED_TTL = 62 * DAY;
const SCHEMA = 2;
const INSTANCE = Math.random().toString(36).slice(2, 10);
const KEYS = ['tasks', 'projects', 'settings', 'timer'];

export const DEFAULT_SETTINGS = {
  nudgeEnabled: true,
  nudgeIntervalHours: 2,
  quietHours: { start: 22, end: 8 },
  staleContextDays: 2,
  lastTouched: { business: 0, freelance: 0, personal: 0 },
  theme: 'system',
  defaultChecklist: null, // null → the built-in list in projects.js
  lastBackupAt: 0,
  briefEnabled: true,
  briefAt: 9 * 60, // minutes after midnight
  lastBriefOn: '', // 'YYYY-MM-DD' of the last brief sent, so it goes once a day
};

let cache = null;   // { tasks: Map, projects: Map, settings, timer }
let hydrating = null;
// Record-level dirt, so a remote change can be merged under unsaved local edits.
let dirty = freshDirt();
let flushTimer = null;
const listeners = new Set();
let writeError = null;

function freshDirt() {
  return {
    tasks: new Set(),
    projects: new Set(),
    removedTasks: new Set(),
    removedProjects: new Set(),
    settings: false,
    timer: false,
  };
}

const isDirty = () =>
  dirty.tasks.size || dirty.projects.size || dirty.removedTasks.size
  || dirty.removedProjects.size || dirty.settings || dirty.timer;

function emit(type) {
  for (const fn of listeners) {
    try {
      fn(type);
    } catch (err) {
      console.error('[store] listener failed', err);
    }
  }
}

/** Subscribe to store changes. Returns an unsubscribe function. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function mergeSettings(saved) {
  const s = saved || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    lastTouched: { ...DEFAULT_SETTINGS.lastTouched, ...(s.lastTouched || {}) },
  };
}

/**
 * First run of version 2: carry tasks and settings over from sync storage.
 * The sync copy is left where it is — nothing reads it again, and it is a
 * free fallback if anything about the move goes wrong.
 */
async function migrateFromSync() {
  let old = {};
  try {
    old = (await chrome.storage.sync?.get(null)) || {};
  } catch {
    old = {};
  }
  const tasks = {};
  for (const [key, value] of Object.entries(old)) {
    if (key.startsWith('bucket_')) Object.assign(tasks, value || {});
  }
  const data = { schema: SCHEMA, tasks, projects: {}, settings: old.settings || {}, timer: null };
  await chrome.storage.local.set(data);
  return data;
}

async function hydrate() {
  let raw = await chrome.storage.local.get(['schema', ...KEYS]);
  if (!raw.schema) raw = await migrateFromSync();

  cache = {
    tasks: new Map(Object.entries(raw.tasks || {})),
    projects: new Map(Object.entries(raw.projects || {})),
    settings: mergeSettings(raw.settings),
    timer: raw.timer || null,
  };
  return cache;
}

async function ready() {
  if (cache) return cache;
  if (!hydrating) hydrating = hydrate().finally(() => { hydrating = null; });
  return hydrating;
}

/** Hydrate once. Later calls reuse the cache. */
export async function init() {
  await ready();
  return cache;
}

/**
 * Force a re-read, discarding the cache. The onChanged listener covers the
 * normal case; this is for when storage changed somewhere this module cannot
 * observe.
 */
export async function reload() {
  dirty = freshDirt();
  return hydrate();
}

// --- reads -----------------------------------------------------------------

export async function getAll() {
  const c = await ready();
  return [...c.tasks.values()];
}

export async function get(id) {
  const c = await ready();
  return c.tasks.get(id) || null;
}

export async function getProjects() {
  const c = await ready();
  return [...c.projects.values()];
}

export async function getProject(id) {
  const c = await ready();
  return c.projects.get(id) || null;
}

export async function getSettings() {
  const c = await ready();
  return c.settings;
}

export async function getTimer() {
  const c = await ready();
  return c.timer;
}

/** Last write error, if the most recent flush failed. */
export function getWriteError() {
  return writeError;
}

// --- writes ----------------------------------------------------------------

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flush(); }, FLUSH_DELAY);
}

export async function upsert(task) {
  const c = await ready();
  c.tasks.set(task.id, task);
  dirty.tasks.add(task.id);
  dirty.removedTasks.delete(task.id);
  scheduleFlush();
  emit('local');
  return task;
}

export async function upsertMany(tasks) {
  for (const task of tasks) await upsert(task);
}

export async function remove(id) {
  const c = await ready();
  c.tasks.delete(id);
  dirty.tasks.delete(id);
  dirty.removedTasks.add(id);
  scheduleFlush();
  emit('local');
}

export async function upsertProject(project) {
  const c = await ready();
  c.projects.set(project.id, project);
  dirty.projects.add(project.id);
  dirty.removedProjects.delete(project.id);
  scheduleFlush();
  emit('local');
  return project;
}

export async function removeProject(id) {
  const c = await ready();
  c.projects.delete(id);
  dirty.projects.delete(id);
  dirty.removedProjects.add(id);
  scheduleFlush();
  emit('local');
}

export async function setSettings(patch) {
  const c = await ready();
  c.settings = { ...c.settings, ...patch };
  dirty.settings = true;
  scheduleFlush();
  emit('local');
  return c.settings;
}

/** Record that a context was worked in — drives the balance nudge. */
export async function touchContext(context) {
  const c = await ready();
  return setSettings({ lastTouched: { ...c.settings.lastTouched, [context]: Date.now() } });
}

/** The running timer, `{ projectId, startedAt }`, or null to stop it. */
export async function setTimer(timer) {
  const c = await ready();
  c.timer = timer;
  dirty.timer = true;
  scheduleFlush();
  emit('local');
  return timer;
}

/**
 * Write pending changes now. Called on a debounce, and directly before the
 * service worker finishes handling an event (it may be killed right after).
 */
export async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!cache || !isDirty()) return;

  const attempted = dirty;
  dirty = freshDirt();

  const payload = { rev: { by: INSTANCE, at: Date.now() } };
  if (attempted.tasks.size || attempted.removedTasks.size) {
    payload.tasks = Object.fromEntries(cache.tasks);
  }
  if (attempted.projects.size || attempted.removedProjects.size) {
    payload.projects = Object.fromEntries(cache.projects);
  }
  if (attempted.settings) payload.settings = cache.settings;
  if (attempted.timer) payload.timer = cache.timer;

  try {
    await chrome.storage.local.set(payload);
    writeError = null;
  } catch (err) {
    // Put the work back on the queue. The in-memory cache is still correct, so
    // a later flush can still land it.
    for (const key of ['tasks', 'projects', 'removedTasks', 'removedProjects']) {
      for (const id of attempted[key]) dirty[key].add(id);
    }
    dirty.settings ||= attempted.settings;
    dirty.timer ||= attempted.timer;
    writeError = String(err && err.message ? err.message : err);
    console.error('[store] write failed', err);
    emit('error');
  }
}

/** Drop completed tasks past their keep-by date so storage does not creep up. */
export async function purgeOldCompleted(now = Date.now()) {
  const c = await ready();
  let removed = 0;
  for (const task of [...c.tasks.values()]) {
    if (task.done && task.completedAt && now - task.completedAt > COMPLETED_TTL) {
      await remove(task.id);
      removed += 1;
    }
  }
  if (removed) await flush();
  return removed;
}

// --- export / import -------------------------------------------------------

export async function exportJSON() {
  const c = await ready();
  const json = JSON.stringify(
    {
      version: 2,
      exportedAt: Date.now(),
      settings: c.settings,
      tasks: [...c.tasks.values()],
      projects: [...c.projects.values()],
    },
    null,
    2,
  );
  await setSettings({ lastBackupAt: Date.now() });
  await flush();
  return json;
}

/**
 * Merge an export back in. Existing ids are overwritten by the imported copy.
 * Version 1 files (tasks only, from before projects existed) import as-is.
 */
export async function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.tasks)) throw new Error('Not a Dual backup file');
  const c = await ready();
  for (const task of data.tasks) {
    if (task && task.id) await upsert(task);
  }
  for (const project of Array.isArray(data.projects) ? data.projects : []) {
    if (project && project.id) await upsertProject(project);
  }
  if (data.settings) {
    await setSettings({
      ...mergeSettings(data.settings),
      lastTouched: c.settings.lastTouched,
      lastBackupAt: c.settings.lastBackupAt,
    });
  }
  await flush();
  return { tasks: data.tasks.length, projects: (data.projects || []).length };
}

// --- cross-surface sync ----------------------------------------------------
// Fires when another surface (popup, panel, worker) writes. The incoming maps
// become the cache, with this surface's unsaved edits laid back over the top.

function mergeCollection(incoming, local, changed, removed) {
  const merged = new Map(Object.entries(incoming || {}));
  for (const id of changed) if (local.has(id)) merged.set(id, local.get(id));
  for (const id of removed) merged.delete(id);
  return merged;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !cache) return;
  if (changes.rev && changes.rev.newValue && changes.rev.newValue.by === INSTANCE) return;
  if (!KEYS.some((key) => key in changes)) return;

  if (changes.tasks) {
    cache.tasks = mergeCollection(changes.tasks.newValue, cache.tasks, dirty.tasks, dirty.removedTasks);
  }
  if (changes.projects) {
    cache.projects = mergeCollection(
      changes.projects.newValue, cache.projects, dirty.projects, dirty.removedProjects,
    );
  }
  if (changes.settings && !dirty.settings) cache.settings = mergeSettings(changes.settings.newValue);
  if (changes.timer && !dirty.timer) cache.timer = changes.timer.newValue || null;
  emit('remote');
});
