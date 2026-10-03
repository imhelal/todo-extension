// Drives the background service worker against a stubbed chrome API: the alarm
// tick, badge counting, notification batching, snooze, the balance nudge, and
// what a reminder does for a client site's maintenance run.
import assert from 'node:assert/strict';

const local = new Map();
const session = new Map();
const listeners = {
  alarm: [], notifButton: [], notifClick: [], message: [], command: [], installed: [], startup: [],
};

const notifications = new Map(); // id -> options
const alarms = new Map();
let badge = { text: '', color: null };
let openedPanel = 0;
let openedTabs = 0;
let lastPanelOpen = null;
// Ordered log of the chrome calls that matter for user-gesture preservation.
const apiCalls = [];

const mapApi = (m) => ({
  async get(keys) {
    if (keys == null) return Object.fromEntries(m);
    const out = {};
    for (const k of [].concat(keys)) if (m.has(k)) out[k] = m.get(k);
    return out;
  },
  async set(items) { for (const [k, v] of Object.entries(items)) m.set(k, v); },
  async remove(keys) { for (const k of [].concat(keys)) m.delete(k); },
});

globalThis.chrome = {
  storage: {
    sync: mapApi(new Map()),
    session: mapApi(session),
    local: mapApi(local),
    onChanged: { addListener() {} },
  },
  runtime: {
    getURL: (p) => 'chrome-extension://test/' + p,
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
  alarms: {
    async create(name, opts) { alarms.set(name, opts); },
    async get(name) { return alarms.has(name) ? { name, ...alarms.get(name) } : undefined; },
    async clear(name) { return alarms.delete(name); },
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  notifications: {
    async create(id, options) { notifications.set(id, options); return id; },
    async clear(id) { notifications.delete(id); },
    onButtonClicked: { addListener: (fn) => listeners.notifButton.push(fn) },
    onClicked: { addListener: (fn) => listeners.notifClick.push(fn) },
  },
  action: {
    async setBadgeText({ text }) { badge.text = text; },
    async setBadgeBackgroundColor({ color }) { badge.color = color; },
    async setBadgeTextColor() {},
  },
  commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
  sidePanel: {
    async setPanelBehavior() {},
    async open(opts) {
      apiCalls.push('sidePanel.open');
      openedPanel += 1;
      lastPanelOpen = opts;
    },
  },
  windows: {
    async getLastFocused() {
      apiCalls.push('windows.getLastFocused');
      return { id: 1 };
    },
  },
  tabs: {
    async create() {
      apiCalls.push('tabs.create');
      openedTabs += 1;
    },
  },
};

const store = await import('../extension/src/lib/store.js');
const T = await import('../extension/src/lib/tasks.js');
const P = await import('../extension/src/lib/projects.js');
await import('../extension/src/background/service-worker.js');

const HOUR = 36e5;
const DAY = 864e5;

let pass = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + (e.stack || e.message)); process.exitCode = 1; }
};

const fireAlarm = async (name) => {
  for (const fn of listeners.alarm) await fn({ name });
};
const pressButton = async (id, index) => {
  for (const fn of listeners.notifButton) await fn(id, index);
};

async function reset(tasks = [], settings = {}, projects = []) {
  local.clear();
  session.clear();
  notifications.clear();
  local.set('schema', 2);
  local.set('tasks', Object.fromEntries(tasks.map((t) => [t.id, t])));
  local.set('projects', Object.fromEntries(projects.map((p) => [p.id, p])));
  local.set('settings', {
    nudgeEnabled: true,
    nudgeIntervalHours: 2,
    quietHours: { start: 22, end: 8 },
    staleContextDays: 2,
    lastTouched: { business: Date.now(), freelance: Date.now(), personal: Date.now() },
    theme: 'system',
    // The brief has its own tests; elsewhere it would add notifications the
    // assertions do not expect, depending on the time of day the suite runs.
    briefEnabled: false,
    ...settings,
  });
  // The stub bypasses onChanged, so the cache has to be dropped by hand.
  await store.reload();
}

// A one-hour quiet window twelve hours from now, so reminders are never held
// back by the time of day the suite happens to run at.
const awayHour = () => (new Date().getHours() + 12) % 24;
const notifyingHours = () => ({ quietHours: { start: awayHour(), end: (awayHour() + 1) % 24 } });

// --- badge -----------------------------------------------------------------

await check('badge counts overdue and due-today, and goes red when late', async () => {
  await reset([
    T.makeTask({ title: 'late', due: Date.now() - HOUR, remindAt: Date.now() - HOUR }),
    T.makeTask({ title: 'today', due: Date.now() + HOUR, remindAt: Date.now() + HOUR }),
    T.makeTask({ title: 'next week', due: Date.now() + 7 * DAY }),
  ], notifyingHours());
  await fireAlarm('tick');
  assert.equal(badge.text, '2');
  assert.equal(badge.color, '#dc2626');
});

await check('badge clears when nothing is pressing', async () => {
  await reset([T.makeTask({ title: 'someday' })], notifyingHours());
  await fireAlarm('tick');
  assert.equal(badge.text, '');
});

// --- single reminder -------------------------------------------------------

await check('a single due task gets its own notification, tinted to its stream', async () => {
  const task = T.makeTask({
    title: 'Chase the supplier',
    context: 'business',
    tags: ['supplier'],
    due: Date.now() - 60000,
    remindAt: Date.now() - 60000,
  });
  await reset([task], notifyingHours());
  await fireAlarm('tick');

  const entry = [...notifications.entries()].find(([id]) => id.startsWith('task:'));
  assert.ok(entry, 'a task notification was raised');
  const [, opts] = entry;
  assert.equal(opts.title, 'Chase the supplier');
  assert.match(opts.message, /^Business · due/);
  assert.match(opts.iconUrl, /icon-business-128\.png$/);
  assert.equal(opts.contextMessage, '#supplier');
  assert.deepEqual(opts.buttons.map((b) => b.title), ['Mark done', 'Snooze 1 hour']);
  assert.equal(opts.requireInteraction, true);
});

await check('the same task does not re-notify on the next tick', async () => {
  const before = notifications.size;
  await fireAlarm('tick');
  assert.equal(notifications.size, before, 'no duplicate popup a minute later');
});

// --- batching --------------------------------------------------------------

const dueNow = (title, context) => {
  const at = Date.now() - 60000;
  return T.makeTask({ title, context, due: at, remindAt: at });
};

await check('several tasks due at once are grouped into one notification', async () => {
  await reset([
    dueNow('Reconcile payouts', 'business'),
    dueNow('Restock tape', 'business'),
    dueNow('Send the build', 'freelance'),
    dueNow('Invoice Meridian', 'freelance'),
  ], notifyingHours());
  await fireAlarm('tick');

  assert.equal(notifications.size, 1, 'one popup, not four');
  const [id, opts] = [...notifications.entries()][0];
  assert.ok(id.startsWith('batch:'));
  assert.equal(opts.type, 'list');
  assert.equal(opts.title, '4 tasks due');
  assert.equal(opts.message, '2 Business  ·  2 Freelance');
  assert.deepEqual(opts.items.map((i) => i.message), [
    'Reconcile payouts', 'Restock tape', 'Send the build', 'Invoice Meridian',
  ]);
  assert.deepEqual(opts.buttons.map((b) => b.title), ['Open list', 'Snooze all 1 hour']);
});

await check('a single-stream batch keeps that stream\'s tint', async () => {
  await reset([dueNow('a', 'freelance'), dueNow('b', 'freelance')], notifyingHours());
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.match(opts.iconUrl, /icon-freelance-128\.png$/);
});

await check('a mixed batch uses the neutral mark', async () => {
  await reset([dueNow('a', 'business'), dueNow('b', 'freelance')], notifyingHours());
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.match(opts.iconUrl, /icon-128\.png$/);
});

await check('the batch lists at most five tasks but counts them all', async () => {
  await reset(
    Array.from({ length: 8 }, (_, i) => dueNow('task ' + i, 'business')),
    notifyingHours(),
  );
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.equal(opts.title, '8 tasks due');
  assert.equal(opts.items.length, 5);
});

// --- notification actions --------------------------------------------------

await check('Mark done completes the task and rolls a recurring one forward', async () => {
  const at = Date.now() - 60000;
  const task = T.makeTask({
    title: 'Weekly invoice',
    context: 'freelance',
    due: at,
    remindAt: at,
    recur: { every: 'week', interval: 1 },
  });
  await reset([task], notifyingHours());
  await fireAlarm('tick');
  const id = [...notifications.keys()].find((k) => k.startsWith('task:'));

  await pressButton(id, 0);

  const all = await store.getAll();
  assert.equal(all.length, 2, 'the completed one plus its next instance');
  assert.equal(all.find((t) => t.id === task.id).done, true);
  const next = all.find((t) => t.id !== task.id);
  assert.equal(next.done, false);
  assert.ok(next.due > Date.now(), 'the follow-up is in the future');
  assert.equal(notifications.has(id), false, 'the popup is dismissed');
});

await check('Snooze pushes the reminder an hour out and lets it fire again', async () => {
  const at = Date.now() - 60000;
  const task = T.makeTask({ title: 'Call back', due: at, remindAt: at });
  await reset([task], notifyingHours());
  await fireAlarm('tick');
  const id = [...notifications.keys()].find((k) => k.startsWith('task:'));

  await pressButton(id, 1);

  const stored = await store.get(task.id);
  assert.ok(stored.remindAt > Date.now() + 50 * 60000, 'pushed roughly an hour out');
  assert.equal(stored.done, false, 'snoozing does not complete it');

  const { fired } = await chrome.storage.session.get('fired');
  assert.ok(!(fired || []).includes(task.id), 'it is eligible to notify again');
});

await check('Snooze all pushes every task in a batch', async () => {
  const tasks = [dueNow('one', 'business'), dueNow('two', 'business'), dueNow('three', 'freelance')];
  await reset(tasks, notifyingHours());
  await fireAlarm('tick');
  const id = [...notifications.keys()].find((k) => k.startsWith('batch:'));

  await pressButton(id, 1);

  for (const t of tasks) {
    const stored = await store.get(t.id);
    assert.ok(stored.remindAt > Date.now() + 50 * 60000, `${t.title} was snoozed`);
  }
  assert.equal(notifications.has(id), false);
});

await check('Open list on a batch opens the side panel', async () => {
  await reset([dueNow('one', 'business'), dueNow('two', 'business')], notifyingHours());
  await fireAlarm('tick');
  const id = [...notifications.keys()].find((k) => k.startsWith('batch:'));
  const before = openedPanel;
  await pressButton(id, 0);
  assert.equal(openedPanel, before + 1);
});

// --- quiet hours -----------------------------------------------------------

await check('quiet hours hold reminders back without dropping them', async () => {
  const at = Date.now() - 60000;
  const hour = new Date().getHours();
  await reset(
    [T.makeTask({ title: 'overnight', due: at, remindAt: at })],
    { quietHours: { start: hour, end: (hour + 2) % 24 } },
  );
  await fireAlarm('tick');
  assert.equal(notifications.size, 0, 'nothing fires inside the window');
  assert.equal(badge.text, '1', 'but the badge still counts it');

  // Step outside the window; the reminder is still due, so it lands.
  await store.setSettings(notifyingHours());
  await store.flush();
  await fireAlarm('tick');
  assert.equal(notifications.size, 1, 'it arrives once the window ends');
});

// --- nudge -----------------------------------------------------------------

await check('the nudge names the quiet stream and lists both', async () => {
  await reset([
    T.makeTask({ title: 'shop', context: 'business' }),
    T.makeTask({ title: 'client a', context: 'freelance' }),
    T.makeTask({ title: 'client b', context: 'freelance' }),
  ], {
    ...notifyingHours(),
    lastTouched: { business: Date.now(), freelance: Date.now() - 3 * DAY },
  });

  await fireAlarm('nudge');
  const opts = notifications.get('nudge:balance');
  assert.ok(opts, 'the nudge fired');
  assert.equal(opts.type, 'list');
  assert.match(opts.title, /Freelance has been quiet for 3 days/);
  assert.match(opts.iconUrl, /icon-freelance-128\.png$/);
  assert.deepEqual(opts.items.map((i) => i.title), ['Business', 'Freelance']);
  assert.deepEqual(opts.buttons.map((b) => b.title), ['Open Freelance']);
});

await check('the nudge stays silent when nothing is open', async () => {
  await reset([T.makeTask({ title: 'done', done: true, completedAt: Date.now() })], notifyingHours());
  await fireAlarm('nudge');
  assert.equal(notifications.has('nudge:balance'), false);
});

await check('the nudge respects being switched off', async () => {
  await reset([T.makeTask({ title: 'open', context: 'business' })], {
    ...notifyingHours(),
    nudgeEnabled: false,
  });
  await fireAlarm('nudge');
  assert.equal(notifications.has('nudge:balance'), false);
});

await check('the nudge is silent during quiet hours', async () => {
  const hour = new Date().getHours();
  await reset([T.makeTask({ title: 'open', context: 'business' })], {
    quietHours: { start: hour, end: (hour + 2) % 24 },
  });
  await fireAlarm('nudge');
  assert.equal(notifications.has('nudge:balance'), false);
});

await check('the nudge button hands the panel the quiet stream to open on', async () => {
  await reset([
    T.makeTask({ title: 'client', context: 'freelance' }),
    T.makeTask({ title: 'shop', context: 'business' }),
  ], {
    ...notifyingHours(),
    lastTouched: { business: Date.now(), freelance: Date.now() - 5 * DAY },
  });
  await fireAlarm('nudge');
  await pressButton('nudge:balance', 0);

  const { focusContext } = await chrome.storage.session.get('focusContext');
  assert.equal(focusContext, 'freelance');
});

// --- test reminders --------------------------------------------------------

const sendMessage = async (msg) => {
  for (const fn of listeners.message) {
    await new Promise((resolve) => {
      const kept = fn(msg, {}, resolve);
      if (!kept) resolve();
    });
  }
};

await check('the test button raises a sample reminder', async () => {
  await reset([], notifyingHours());
  await sendMessage({ type: 'test-reminder', kind: 'single' });

  const entry = [...notifications.entries()].find(([id]) => id.startsWith('test:'));
  assert.ok(entry, 'a sample notification appeared');
  const [, opts] = entry;
  assert.equal(opts.type, 'basic');
  assert.equal(opts.requireInteraction, true);
  assert.match(opts.contextMessage, /Test reminder/);
  assert.deepEqual(opts.buttons.map((b) => b.title), ['Dismiss']);
  assert.equal(opts.silent, undefined, 'sound is left at the system default');
});

await check('the grouped test uses the list layout', async () => {
  notifications.clear();
  await sendMessage({ type: 'test-reminder', kind: 'batch' });
  const [, opts] = [...notifications.entries()][0];
  assert.equal(opts.type, 'list');
  assert.equal(opts.items.length, 3);
});

await check('a test reminder fires even inside quiet hours', async () => {
  const hour = new Date().getHours();
  await reset([], { quietHours: { start: hour, end: (hour + 2) % 24 } });
  notifications.clear();
  await sendMessage({ type: 'test-reminder', kind: 'single' });
  assert.equal(notifications.size, 1, 'an explicit request is not held back');
});

await check('dismissing a test reminder changes no task data', async () => {
  const task = T.makeTask({ title: 'untouched', context: 'business' });
  await reset([task], notifyingHours());
  notifications.clear();
  await sendMessage({ type: 'test-reminder', kind: 'single' });
  const id = [...notifications.keys()][0];

  await pressButton(id, 0);

  assert.equal(notifications.has(id), false, 'the popup is dismissed');
  const all = await store.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].done, false, 'the real task was left alone');
});

// --- opening the side panel ------------------------------------------------
//
// chrome.sidePanel.open() only works while the user gesture is still intact.
// Awaiting any other chrome API first spends it and Chrome rejects the call —
// which is what made Ctrl+Shift+U open a tab instead of the panel.

const fireCommand = (command, tab) => {
  for (const fn of listeners.command) fn(command, tab);
};

await check('the shortcut opens the panel without spending the user gesture first', async () => {
  apiCalls.length = 0;
  openedTabs = 0;
  fireCommand('open-side-panel', { id: 7, windowId: 42 });
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(
    apiCalls,
    ['sidePanel.open'],
    'open() must be the first chrome call — nothing may be awaited before it',
  );
  assert.deepEqual(lastPanelOpen, { windowId: 42 }, 'uses the windowId the command handed us');
  assert.equal(openedTabs, 0, 'no tab fallback when the panel opens');
});

await check('an unknown command is ignored', async () => {
  apiCalls.length = 0;
  fireCommand('_execute_action', { id: 7, windowId: 42 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(apiCalls, []);
});

await check('the panel falls back to a tab if Chrome refuses to open it', async () => {
  const realOpen = chrome.sidePanel.open;
  chrome.sidePanel.open = async () => {
    apiCalls.push('sidePanel.open');
    throw new Error('`sidePanel.open()` may only be called in response to a user gesture.');
  };
  apiCalls.length = 0;
  openedTabs = 0;

  fireCommand('open-side-panel', { id: 7, windowId: 42 });
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(apiCalls, ['sidePanel.open', 'tabs.create']);
  assert.equal(openedTabs, 1, 'the list stays reachable either way');
  chrome.sidePanel.open = realOpen;
});

// --- waking up -------------------------------------------------------------

await check('a worker that wakes to find its alarms gone puts them back', async () => {
  // The worker checked on import; the stub started with no alarms at all.
  assert.ok(alarms.has('tick'), 'the one-minute tick was re-created');
  assert.ok(alarms.has('nudge'));
});

// --- the personal stream ---------------------------------------------------

await check('a personal reminder is tinted green', async () => {
  await reset([dueNow('Book the dentist', 'personal')], notifyingHours());
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.match(opts.iconUrl, /icon-personal-128\.png$/);
  assert.match(opts.message, /^Personal · due/);
});

await check('a three-stream batch counts each stream', async () => {
  await reset(
    [dueNow('a', 'business'), dueNow('b', 'freelance'), dueNow('c', 'personal')],
    notifyingHours(),
  );
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.equal(opts.message, '1 Business  ·  1 Freelance  ·  1 Personal');
});

// --- client sites ----------------------------------------------------------

const site = (fields = {}) => P.makeProject({ name: 'Acme Bakery', url: 'acmebakery.com', ...fields });

await check('a maintenance reminder is named for its site', async () => {
  const project = site();
  const run = P.makeMaintenanceTask(project, Date.now() - 60000);
  await reset([run], notifyingHours(), [project]);
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.equal(opts.title, 'Acme Bakery — monthly maintenance');
  assert.match(opts.iconUrl, /icon-freelance-128\.png$/);
});

await check('a project task names its client in the reminder', async () => {
  const project = site();
  const task = T.makeTask({
    title: 'Fix the footer link',
    context: 'freelance',
    projectId: project.id,
    due: Date.now() - 60000,
    remindAt: Date.now() - 60000,
  });
  await reset([task], notifyingHours(), [project]);
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.equal(opts.title, 'Fix the footer link');
  assert.match(opts.message, /^Freelance · Acme Bakery · due/);
});

await check('Mark done on a maintenance run logs it to the site and schedules next month', async () => {
  const project = site();
  const run = P.makeMaintenanceTask(project, Date.now() - 60000);
  await reset([run], notifyingHours(), [project]);
  await fireAlarm('tick');
  const id = [...notifications.keys()].find((k) => k.startsWith('task:'));

  await pressButton(id, 0);

  const stored = await store.getProject(project.id);
  assert.equal(stored.log.length, 1, 'the run is in the history');
  assert.equal(stored.log[0].items.length, P.DEFAULT_CHECKLIST.length, 'every step counted as done');
  const open = P.openMaintenance(await store.getAll(), project.id);
  assert.equal(open.length, 1, 'next month is scheduled');
  assert.ok(open[0].due > Date.now());
  assert.ok(open[0].subtasks.every((s) => !s.done), 'with a fresh checklist');
});

await check('startup schedules a run for a site that has none', async () => {
  const project = site();
  await reset([], notifyingHours(), [project]);
  for (const fn of listeners.startup) await fn();
  const open = P.openMaintenance(await store.getAll(), project.id);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'maint');
});

// --- priority --------------------------------------------------------------

await check('a priority reminder says so', async () => {
  const task = dueNow('Fix checkout bug', 'freelance');
  task.priority = true;
  await reset([task], notifyingHours());
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.match(opts.message, /^Priority · Freelance · due/);
});

await check('flagged tasks lead a grouped notification', async () => {
  const urgent = dueNow('Urgent one', 'business');
  urgent.priority = true;
  const list = [...Array.from({ length: 6 }, (_, i) => dueNow('task ' + i, 'business')), urgent];
  await reset(list, notifyingHours());
  await fireAlarm('tick');
  const [, opts] = [...notifications.entries()][0];
  assert.equal(opts.items[0].message, 'Urgent one', 'not cut off after the fifth row');
  assert.equal(opts.items[0].title, 'Business · Priority');
});

// --- the morning brief -----------------------------------------------------

const B = await import('../extension/src/lib/brief.js');
const minutesNow = () => new Date().getHours() * 60 + new Date().getMinutes();
const briefOn = (extra = {}) => ({ ...notifyingHours(), briefEnabled: true, ...extra });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

await check('switching the brief on arms its alarm for the next brief time', async () => {
  await reset([], briefOn({ briefAt: 9 * 60 }));
  await sendMessage({ type: 'settings-changed' });
  const alarm = alarms.get('brief');
  assert.ok(alarm, 'the brief alarm exists');
  assert.equal(alarm.when, B.nextBriefAt({ briefAt: 9 * 60 }));
  assert.equal(new Date(alarm.when).getHours(), 9);
});

await check('switching it off removes the alarm', async () => {
  await reset([], { ...notifyingHours(), briefEnabled: false });
  await sendMessage({ type: 'settings-changed' });
  assert.equal(alarms.has('brief'), false);
});

await check('the brief lists the day, sends once, and re-arms for tomorrow', async () => {
  const late = T.makeTask({ title: 'Reconcile payouts', context: 'business', due: Date.now() - 2 * HOUR });
  const flagged = T.makeTask({ title: 'Send the proposal', context: 'freelance', priority: true });
  await reset([late, flagged], briefOn());
  await fireAlarm('brief');

  const opts = notifications.get('brief:today');
  assert.ok(opts, 'the brief was sent');
  assert.equal(opts.type, 'list');
  assert.deepEqual(opts.items.map((i) => i.title).slice(0, 2), ['Overdue', 'Priority']);
  assert.match(opts.items[0].message, /Reconcile payouts/);
  assert.match(opts.items[1].message, /Send the proposal/);
  assert.deepEqual(opts.buttons.map((b) => b.title), ['Plan my day']);
  assert.equal((await store.getSettings()).lastBriefOn, today(), 'today is recorded');
  assert.ok(alarms.get('brief').when > Date.now(), 'the next one is armed');

  notifications.clear();
  await fireAlarm('brief');
  assert.equal(notifications.size, 0, 'a second firing the same day sends nothing');
});

await check('the brief stays silent on a day with nothing to say', async () => {
  await reset([T.makeTask({ title: 'someday', context: 'business' })], briefOn());
  await fireAlarm('brief');
  assert.equal(notifications.has('brief:today'), false);
});

await check('a brief missed while Chrome was closed arrives on startup', async () => {
  const late = T.makeTask({ title: 'Call the bank', context: 'personal', due: Date.now() - HOUR });
  await reset([late], briefOn({ briefAt: Math.max(0, minutesNow() - 60) }));
  for (const fn of listeners.startup) await fn();
  assert.ok(notifications.has('brief:today'));
});

await check('a brief whose time has not come is not sent early', async () => {
  const late = T.makeTask({ title: 'Call the bank', context: 'personal', due: Date.now() - HOUR });
  await reset([late], briefOn({ briefAt: Math.min(23 * 60 + 30, minutesNow() + 60) }));
  for (const fn of listeners.startup) await fn();
  assert.equal(notifications.has('brief:today'), false);
});

await check('opening the brief lands on the list with today\'s card', async () => {
  const late = T.makeTask({ title: 'Call the bank', context: 'personal', due: Date.now() - HOUR });
  await reset([late], briefOn());
  await fireAlarm('brief');
  const before = openedPanel;
  for (const fn of listeners.notifClick) await fn('brief:today');
  assert.equal(openedPanel, before + 1);
  const { focusBrief } = await chrome.storage.session.get('focusBrief');
  assert.equal(focusBrief, true);
});

await check('"Send it now" always answers, even on a quiet day', async () => {
  await reset([], briefOn({ lastBriefOn: today() }));
  await sendMessage({ type: 'test-reminder', kind: 'brief' });
  const opts = notifications.get('brief:today');
  assert.ok(opts);
  assert.match(opts.title, /nothing due today/);
});

await check('the nudge adds a row for sites still waiting this month', async () => {
  const project = site();
  const run = P.makeMaintenanceTask(project, Date.now() - 60000);
  await reset([run, T.makeTask({ title: 'shop', context: 'business' })], notifyingHours(), [project]);
  await fireAlarm('nudge');
  const opts = notifications.get('nudge:balance');
  const row = opts.items.find((i) => i.title === 'Maintenance');
  assert.ok(row, 'there is a maintenance row');
  assert.match(row.message, /1 of 1 sites left/);
  assert.match(row.message, /1 overdue/);
});

console.log(`\n${pass} checks passed`);
