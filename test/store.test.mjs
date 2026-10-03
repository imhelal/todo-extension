// Exercises store.js against a stubbed chrome.storage: the one-time move out
// of sync storage, round trips for tasks and projects, merging a change made
// on another surface under an unsaved local edit, backups, and write failures.
import assert from 'node:assert/strict';

const local = new Map();
const sync = new Map();
const listeners = [];
let failWrites = false;

const mapApi = (m, area) => ({
  async get(keys) {
    if (keys == null) return Object.fromEntries(m);
    const out = {};
    for (const k of [].concat(keys)) if (m.has(k)) out[k] = structuredClone(m.get(k));
    return out;
  },
  async set(items) {
    if (failWrites) throw new Error('QUOTA_BYTES quota exceeded');
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: m.get(k), newValue: structuredClone(v) };
      m.set(k, structuredClone(v));
    }
    for (const fn of listeners) fn(changes, area);
  },
  async remove(keys) {
    for (const k of [].concat(keys)) m.delete(k);
  },
});

globalThis.chrome = {
  storage: {
    local: mapApi(local, 'local'),
    sync: mapApi(sync, 'sync'),
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
};

// What version 1 left behind in sync storage.
const legacyTask = {
  id: 't_legacy',
  title: 'Restock the shelves',
  context: 'business',
  tags: ['shop'],
  notes: '',
  subtasks: [],
  due: null,
  remindAt: null,
  recur: null,
  done: false,
  completedAt: null,
  createdAt: 1,
  order: 1,
};
sync.set('bucket_0', { [legacyTask.id]: legacyTask });
sync.set('settings', { nudgeIntervalHours: 4, lastTouched: { business: 5, freelance: 6 } });

const store = await import('../extension/src/lib/store.js');
const T = await import('../extension/src/lib/tasks.js');
const P = await import('../extension/src/lib/projects.js');

let pass = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + (e.stack || e.message)); process.exitCode = 1; }
};

/** Pretend another surface (the popup, the worker) wrote these keys. */
function writeFromElsewhere(items) {
  const changes = {};
  for (const [k, v] of Object.entries(items)) {
    changes[k] = { oldValue: local.get(k), newValue: structuredClone(v) };
    local.set(k, structuredClone(v));
  }
  changes.rev = { newValue: { by: 'another-surface', at: Date.now() } };
  for (const fn of listeners) fn(changes, 'local');
}

await check('the first run moves tasks and settings over from sync storage', async () => {
  await store.init();
  const task = await store.get('t_legacy');
  assert.equal(task.title, 'Restock the shelves');
  const settings = await store.getSettings();
  assert.equal(settings.nudgeIntervalHours, 4, 'saved settings carried over');
  assert.equal(settings.lastTouched.business, 5);
  assert.equal(settings.lastTouched.personal, 0, 'the new stream gets a default');
  assert.equal(local.get('schema'), 2, 'migration is recorded, so it runs once');
  assert.ok(sync.has('bucket_0'), 'the sync copy is left alone as a fallback');
});

await check('a task round-trips through local storage', async () => {
  const task = T.makeTask({ title: 'Call the courier', context: 'personal' });
  await store.upsert(task);
  await store.flush();
  assert.equal(local.get('tasks')[task.id].title, 'Call the courier');
  await store.reload();
  assert.equal((await store.get(task.id)).context, 'personal');
});

await check('a project round-trips, and removing it removes it', async () => {
  const project = P.makeProject({ name: 'Acme Bakery', url: 'acmebakery.com' });
  await store.upsertProject(project);
  await store.flush();
  assert.equal(local.get('projects')[project.id].name, 'Acme Bakery');
  await store.reload();
  assert.equal((await store.getProject(project.id)).url, 'acmebakery.com');

  await store.removeProject(project.id);
  await store.flush();
  assert.equal(local.get('projects')[project.id], undefined);
});

await check('only the collections that changed are written', async () => {
  const before = local.get('projects');
  await store.upsert(T.makeTask({ title: 'only tasks change' }));
  await store.flush();
  assert.equal(local.get('projects'), before, 'the projects key was not rewritten');
});

await check('there is no size ceiling: 2,000 tasks and 60 sites save in one go', async () => {
  for (let i = 0; i < 2000; i += 1) {
    await store.upsert(T.makeTask({
      title: `Follow up with client about the revised homepage copy #${i}`,
      notes: 'Waiting on their reply before the next milestone can start.',
      tags: ['client-' + (i % 7)],
    }));
  }
  for (let i = 0; i < 60; i += 1) {
    await store.upsertProject(P.makeProject({ name: `Site ${i}`, url: `site${i}.com` }));
  }
  await store.flush();
  assert.equal(store.getWriteError(), null);
  assert.ok((await store.getAll()).length >= 2000);
  assert.ok((await store.getProjects()).length >= 60);
});

await check('a change from another surface is picked up', async () => {
  const task = T.makeTask({ title: 'added in the side panel' });
  writeFromElsewhere({ tasks: { ...local.get('tasks'), [task.id]: task } });
  assert.equal((await store.get(task.id)).title, 'added in the side panel');
});

await check('an unsaved edit here survives a save from another surface', async () => {
  const mine = T.makeTask({ title: 'typed in the popup' });
  await store.upsert(mine); // not flushed yet

  const theirs = T.makeTask({ title: 'saved by the worker' });
  writeFromElsewhere({ tasks: { ...local.get('tasks'), [theirs.id]: theirs } });

  assert.ok(await store.get(mine.id), 'the local edit is still there');
  assert.ok(await store.get(theirs.id), 'and so is the other surface\'s');
  await store.flush();
  assert.ok(local.get('tasks')[mine.id] && local.get('tasks')[theirs.id], 'both land on disk');
});

await check('a delete here is not undone by a save from another surface', async () => {
  const doomed = T.makeTask({ title: 'delete me' });
  await store.upsert(doomed);
  await store.flush();
  await store.remove(doomed.id); // not flushed yet
  writeFromElsewhere({ tasks: { ...local.get('tasks') } }); // still contains it
  assert.equal(await store.get(doomed.id), null);
});

await check('this surface ignores the echo of its own writes', async () => {
  let remote = 0;
  const off = store.onChange((type) => { if (type === 'remote') remote += 1; });
  await store.upsert(T.makeTask({ title: 'echo test' }));
  await store.flush();
  off();
  assert.equal(remote, 0);
});

await check('settings persist and merge over defaults', async () => {
  await store.setSettings({ nudgeIntervalHours: 6 });
  await store.flush();
  await store.reload();
  const s = await store.getSettings();
  assert.equal(s.nudgeIntervalHours, 6);
  assert.equal(s.quietHours.start, 22, 'untouched defaults survive');
});

await check('touchContext records only the named stream', async () => {
  const before = (await store.getSettings()).lastTouched;
  await store.touchContext('personal');
  const after = (await store.getSettings()).lastTouched;
  assert.ok(after.personal > 0);
  assert.equal(after.business, before.business);
});

await check('the timer persists across surfaces', async () => {
  await store.setTimer({ projectId: 'p_1', startedAt: 123 });
  await store.flush();
  await store.reload();
  assert.deepEqual(await store.getTimer(), { projectId: 'p_1', startedAt: 123 });
  await store.setTimer(null);
  await store.flush();
});

await check('purge keeps two months of completed tasks, for reports', async () => {
  const day = 864e5;
  const old = T.makeTask({ title: 'ancient', done: true, completedAt: Date.now() - 70 * day });
  const lastMonth = T.makeTask({ title: 'last month', done: true, completedAt: Date.now() - 40 * day });
  await store.upsert(old);
  await store.upsert(lastMonth);
  const removed = await store.purgeOldCompleted();
  assert.equal(removed, 1);
  assert.equal(await store.get(old.id), null);
  assert.ok(await store.get(lastMonth.id), 'last month is still there for its report');
});

await check('export carries tasks and projects, and records the backup', async () => {
  const json = JSON.parse(await store.exportJSON());
  assert.equal(json.version, 2);
  assert.ok(Array.isArray(json.projects) && json.projects.length >= 60);
  assert.equal(json.tasks.length, (await store.getAll()).length);
  assert.ok((await store.getSettings()).lastBackupAt > 0);
});

await check('a version 1 backup (tasks only) still imports', async () => {
  const v1 = JSON.stringify({ version: 1, tasks: [{ ...legacyTask, id: 't_from_v1' }] });
  const count = await store.importJSON(v1);
  assert.deepEqual(count, { tasks: 1, projects: 0 });
  assert.ok(await store.get('t_from_v1'));
});

await check('import rejects a file that is not a backup', async () => {
  await assert.rejects(() => store.importJSON('{"nope":1}'), /Not a Dual backup file/);
});

await check('a failed write is reported, and retried on the next flush', async () => {
  failWrites = true;
  const task = T.makeTask({ title: 'written later' });
  await store.upsert(task);
  await store.flush();
  assert.match(store.getWriteError(), /QUOTA_BYTES/);

  failWrites = false;
  await store.flush();
  assert.equal(store.getWriteError(), null);
  assert.ok(local.get('tasks')[task.id], 'the queued write landed');
});

console.log(`\n${pass} checks passed`);
