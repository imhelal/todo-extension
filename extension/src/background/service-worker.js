// The always-on half of the extension: badge, due reminders, balance nudge,
// morning brief.
//
// MV3 service workers are killed after ~30s idle, so setTimeout/setInterval are
// unusable for scheduling. Everything is driven by chrome.alarms, which wake
// the worker back up. State that must survive a worker restart (but not a
// browser restart) lives in chrome.storage.session.

import * as brief from '../lib/brief.js';
import * as projects from '../lib/projects.js';
import * as store from '../lib/store.js';
import * as tasks from '../lib/tasks.js';
import { HOUR, dayKey, inQuietHours, relativeDue } from '../lib/time.js';

const TICK = 'tick';
const NUDGE = 'nudge';
const BRIEF = 'brief';
const SNOOZE_MS = HOUR;

const NOTIFY_PREFIX = 'task:';
const BATCH_PREFIX = 'batch:';
const TEST_PREFIX = 'test:';
const NUDGE_ID = 'nudge:balance';
const BRIEF_ID = 'brief:today';

// --- session state ---------------------------------------------------------
// `fired` records which task ids have already produced a notification, so the
// one-minute tick does not re-notify the same task every minute.

async function getFired() {
  const { fired } = await chrome.storage.session.get('fired');
  return new Set(fired || []);
}

async function setFired(set) {
  await chrome.storage.session.set({ fired: [...set] });
}

// --- lifecycle -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarms();
  await store.purgeOldCompleted();
  await repairMaintenance();
  await refresh();
});

// Alarms can be lost across browser/profile changes, so re-assert on startup.
chrome.runtime.onStartup.addListener(async () => {
  await setupAlarms();
  await store.purgeOldCompleted();
  await repairMaintenance();
  await refresh();
  await catchUpBrief();
});

/**
 * Make sure every active site has exactly one maintenance run scheduled. The
 * UI does the same on open; doing it here too means a site's reminders keep
 * coming even if the panel is never opened.
 */
async function repairMaintenance() {
  const { upserts, removals } = projects.syncMaintenance(
    await store.getProjects(),
    await store.getAll(),
  );
  if (!upserts.length && !removals.length) return;
  for (const task of upserts) await store.upsert(task);
  for (const id of removals) await store.remove(id);
  await store.flush();
}

async function projectMap() {
  return new Map((await store.getProjects()).map((p) => [p.id, p]));
}

/** What a notification calls a task: maintenance runs are named for their site. */
function taskLabel(task, project) {
  if (task.kind === 'maint' && project) return `${project.name} — monthly maintenance`;
  return task.title;
}

async function setupAlarms() {
  const settings = await store.getSettings();
  await chrome.alarms.create(TICK, { periodInMinutes: 1 });
  await chrome.alarms.create(NUDGE, {
    periodInMinutes: Math.max(1, (settings.nudgeIntervalHours || 2) * 60),
    delayInMinutes: Math.max(1, (settings.nudgeIntervalHours || 2) * 60),
  });

  // The brief is a one-shot alarm re-armed each time it fires, so it lands on
  // the clock time every day — a 24-hour period would drift across DST.
  await chrome.alarms.clear(BRIEF);
  if (settings.briefEnabled) {
    await chrome.alarms.create(BRIEF, { when: brief.nextBriefAt(settings) });
  }

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (err) {
    console.warn('[sw] side panel behaviour not set', err);
  }
}

// The UI asks for an alarm reset when the nudge interval changes.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'settings-changed') {
    setupAlarms().then(() => refresh()).then(() => sendResponse({ ok: true }));
    return true; // keep the channel open for the async response
  }
  if (message?.type === 'refresh-badge') {
    refresh().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'test-reminder') {
    sendTestReminder(message.kind).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

/**
 * Fire a sample notification on demand so the alert — and whether Windows is
 * actually playing a sound for it — can be checked without waiting for a real
 * due date. Deliberately ignores quiet hours: the user just asked for this.
 */
async function sendTestReminder(kind = 'single') {
  const id = TEST_PREFIX + Date.now();

  if (kind === 'brief') {
    await sendBrief({ test: true });
    return;
  }

  if (kind === 'batch') {
    await chrome.notifications.create(id, {
      type: 'list',
      iconUrl: iconFor(null),
      title: '3 tasks due',
      message: '1 Business  ·  1 Freelance  ·  1 Personal',
      items: [
        { title: 'Business', message: 'Reconcile last week’s payouts' },
        { title: 'Freelance', message: 'Acme Bakery — monthly maintenance' },
        { title: 'Personal', message: 'Book the dentist for the kids' },
      ],
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: 'Dismiss' }],
    });
    return;
  }

  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: iconFor('business'),
    title: 'Chase the packaging supplier',
    message: 'Business · due now',
    contextMessage: 'Test reminder — no task was changed',
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: 'Dismiss' }],
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK) await tick();
  else if (alarm.name === NUDGE) await runNudge();
  else if (alarm.name === BRIEF) await runBrief();
});

// --- badge -----------------------------------------------------------------

/**
 * Badge shows open tasks that are overdue or due today — red when anything is
 * overdue, amber when only due-today. Cleared at zero so an empty badge always
 * means "nothing is pressing".
 */
async function refresh() {
  const all = await store.getAll();
  const now = Date.now();
  const soon = tasks.dueSoon(all, now);
  const late = tasks.overdue(all, now);

  await chrome.action.setBadgeText({ text: soon.length ? String(soon.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: late.length ? '#dc2626' : '#d97706' });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}

// --- the one-minute tick ---------------------------------------------------

async function tick() {
  const settings = await store.getSettings();
  const all = await store.getAll();
  const now = Date.now();

  await refresh();

  // During quiet hours nothing is delivered, but nothing is dropped either:
  // the reminder stays due, so it fires on the first tick after the window.
  if (inQuietHours(settings.quietHours || {}, now)) return;

  const fired = await getFired();
  const pending = tasks.dueForReminder(all, now).filter((t) => !fired.has(t.id));
  if (!pending.length) return;

  // Several tasks coming due together get one grouped notification rather than
  // a stack of popups — the stack is what makes people turn reminders off.
  // Flagged ones lead, so they are never the rows cut off after the fifth.
  pending.sort((a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)));
  if (pending.length === 1) await notifyTask(pending[0]);
  else await notifyBatch(pending);

  for (const task of pending) fired.add(task.id);
  await setFired(fired);
}

function iconFor(context) {
  const file = tasks.CONTEXTS.includes(context)
    ? `src/icons/icon-${context}-128.png`
    : 'src/icons/icon-128.png';
  return chrome.runtime.getURL(file);
}

async function notifyTask(task) {
  const project = task.projectId ? (await projectMap()).get(task.projectId) : null;
  const label = [
    task.priority ? 'Priority' : '',
    tasks.CONTEXT_LABEL[task.context] || '',
    task.kind !== 'maint' && project ? project.name : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const when = task.due ? relativeDue(task.due) : '';

  await chrome.notifications.create(NOTIFY_PREFIX + task.id, {
    type: 'basic',
    // The icon is tinted to the task's stream, so which side of your life this
    // belongs to is clear before a word is read.
    iconUrl: iconFor(task.context),
    title: taskLabel(task, project),
    message: when ? `${label} · due ${when}` : `${label} · due now`,
    contextMessage: task.tags.length ? task.tags.map((t) => '#' + t).join('  ') : undefined,
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: 'Mark done' }, { title: 'Snooze 1 hour' }],
  });
}

/** One notification listing everything that just came due. */
async function notifyBatch(pending) {
  const id = BATCH_PREFIX + Date.now();
  const byId = await projectMap();
  const byContext = tasks.CONTEXTS.map((context) => ({
    context,
    count: pending.filter((t) => t.context === context).length,
  })).filter((c) => c.count);

  const summary = byContext
    .map((c) => `${c.count} ${tasks.CONTEXT_LABEL[c.context]}`)
    .join('  ·  ');

  await chrome.storage.session.set({ [id]: pending.map((t) => t.id) });

  await chrome.notifications.create(id, {
    type: 'list',
    // Mixed contexts get the neutral mark; a single-stream batch keeps its tint.
    iconUrl: byContext.length === 1 ? iconFor(byContext[0].context) : iconFor(null),
    title: `${pending.length} tasks due`,
    message: summary,
    items: pending.slice(0, 5).map((task) => ({
      title: task.priority ? `${tasks.CONTEXT_LABEL[task.context]} · Priority` : tasks.CONTEXT_LABEL[task.context],
      message: taskLabel(task, byId.get(task.projectId)),
    })),
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: 'Open list' }, { title: 'Snooze all 1 hour' }],
  });
}

// --- notification interaction ---------------------------------------------

chrome.notifications.onButtonClicked.addListener(async (id, buttonIndex) => {
  if (id === BRIEF_ID) {
    await openBrief();
    return;
  }
  if (id.startsWith(TEST_PREFIX)) {
    await chrome.notifications.clear(id);
    return;
  }
  if (id.startsWith(BATCH_PREFIX)) {
    await handleBatchButton(id, buttonIndex);
    return;
  }
  if (!id.startsWith(NOTIFY_PREFIX)) return;
  const taskId = id.slice(NOTIFY_PREFIX.length);
  const task = await store.get(taskId);
  if (!task) return;

  if (buttonIndex === 0) {
    // A maintenance run is also written into its site's history here, so a
    // run ticked off from the notification still shows up in the report.
    const project = task.projectId ? await store.getProject(task.projectId) : null;
    const done = projects.completeTask(task, project);
    await store.upsert(done.task);
    if (done.next) await store.upsert(done.next);
    if (done.project) await store.upsertProject(done.project);
    await store.touchContext(task.context);
    await clearFired(taskId);
  } else {
    await store.upsert(tasks.snooze(task, SNOOZE_MS));
    await clearFired(taskId); // so the snoozed reminder can fire again
  }

  await chrome.notifications.clear(id);
  // The worker may be killed the moment this handler returns, so write now
  // rather than waiting for the store's debounce.
  await store.flush();
  await refresh();
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (id === BRIEF_ID) {
    await openBrief();
    return;
  }
  if (id.startsWith(TEST_PREFIX)) {
    await chrome.notifications.clear(id);
    return;
  }
  if (id.startsWith(NOTIFY_PREFIX)) {
    await chrome.storage.session.set({ focusTaskId: id.slice(NOTIFY_PREFIX.length) });
  }
  await chrome.notifications.clear(id);
  await openPanel();
});

async function handleBatchButton(id, buttonIndex) {
  const stored = await chrome.storage.session.get(id);
  const ids = stored[id] || [];

  if (buttonIndex === 0) {
    await openPanel();
  } else {
    // Snooze all, so a busy morning can be pushed in one action.
    const fired = await getFired();
    for (const taskId of ids) {
      const task = await store.get(taskId);
      if (!task || task.done) continue;
      await store.upsert(tasks.snooze(task, SNOOZE_MS));
      fired.delete(taskId);
    }
    await setFired(fired);
    await store.flush();
  }

  await chrome.storage.session.remove(id);
  await chrome.notifications.clear(id);
  await refresh();
}

async function clearFired(taskId) {
  const fired = await getFired();
  if (fired.delete(taskId)) await setFired(fired);
}

// --- balance nudge ---------------------------------------------------------

async function runNudge() {
  const settings = await store.getSettings();
  if (!settings.nudgeEnabled) return;
  if (inQuietHours(settings.quietHours || {}, Date.now())) return;

  const all = await store.getAll();
  const nudge = tasks.buildNudge(all, settings, Date.now(), {
    maintenance: projects.monthOverview(await store.getProjects(), all),
  });
  if (!nudge) return;

  await chrome.notifications.create(NUDGE_ID, {
    type: 'list',
    // Tinted to the neglected stream when there is one, so the nudge is
    // recognisable at a glance from across the desk.
    iconUrl: iconFor(nudge.stale),
    title: nudge.title,
    message: nudge.message,
    items: nudge.items,
    priority: 1,
    requireInteraction: false,
    buttons: [{ title: nudge.stale ? `Open ${tasks.CONTEXT_LABEL[nudge.stale]}` : 'Open list' }],
  });
}

chrome.notifications.onButtonClicked.addListener(async (id) => {
  if (id !== NUDGE_ID) return;
  const settings = await store.getSettings();
  const all = await store.getAll();
  const nudge = tasks.buildNudge(all, settings);
  if (nudge && nudge.stale) {
    await chrome.storage.session.set({ focusContext: nudge.stale });
  }
  await chrome.notifications.clear(id);
  await openPanel();
});

// --- morning brief ---------------------------------------------------------

/** The brief's alarm went off: send it, then arm tomorrow's. */
async function runBrief() {
  const settings = await store.getSettings();
  if (settings.briefEnabled) await sendBrief();
  await chrome.alarms.create(BRIEF, { when: brief.nextBriefAt(await store.getSettings()) });
}

/**
 * Chrome was closed at brief time: send it now, up to a few hours late. Not
 * inside quiet hours, though — a late brief is not worth waking anyone for.
 */
async function catchUpBrief() {
  const settings = await store.getSettings();
  const now = Date.now();
  if (!brief.briefMissed(settings, now)) return;
  if (inQuietHours(settings.quietHours || {}, now)) return;
  await sendBrief();
}

/**
 * Build and show the brief. Once a day only, and silent on a day with nothing
 * overdue, due or flagged — unless `test` asks for it from Settings, which
 * always answers so the button visibly does something.
 */
async function sendBrief({ test = false } = {}) {
  const settings = await store.getSettings();
  const now = Date.now();
  if (!test) {
    if (settings.lastBriefOn === dayKey(now)) return;
    await store.setSettings({ lastBriefOn: dayKey(now) });
    await store.flush();
  }

  const all = await store.getAll();
  const built = brief.buildBrief(all, await store.getProjects(), settings, now);
  if (!built && !test) return;

  await chrome.notifications.create(BRIEF_ID, built
    ? {
        type: 'list',
        iconUrl: iconFor(null),
        title: built.title,
        message: built.message,
        items: built.items,
        priority: 1,
        requireInteraction: false,
        buttons: [{ title: 'Plan my day' }],
      }
    : {
        type: 'basic',
        iconUrl: iconFor(null),
        title: `${brief.greeting(now)} · nothing due today`,
        message: 'Nothing overdue, due or flagged. The brief stays quiet on days like this.',
        priority: 1,
        buttons: [{ title: 'Plan my day' }],
      });
}

/** From the brief, land on the list with today's card showing. */
async function openBrief() {
  await chrome.storage.session.set({ focusBrief: true });
  await chrome.notifications.clear(BRIEF_ID);
  await openPanel();
}

// --- opening the panel -----------------------------------------------------

const PANEL_PATH = 'src/sidepanel/panel.html';

function openPanelInTab() {
  return chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_PATH) });
}

/**
 * Open the side panel from a keyboard shortcut.
 *
 * chrome.sidePanel.open() must be reached with the user gesture still intact.
 * Awaiting anything first — even chrome.windows.getLastFocused() — spends the
 * gesture, and Chrome then rejects the call. So the windowId is taken from the
 * tab the command handler already hands us, and open() is called immediately,
 * with no await in front of it.
 */
function openPanelFromGesture(tab) {
  if (tab && tab.windowId != null) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch((err) => {
        console.warn('[sw] side panel refused, opening a tab instead', err);
        openPanelInTab();
      });
    return;
  }
  // No tab context (rare). The gesture is unusable from here anyway.
  openPanel();
}

/** Open the panel with no gesture to spend — used from notification clicks. */
async function openPanel() {
  try {
    const win = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (err) {
    // A notification click is not a user gesture as far as sidePanel.open() is
    // concerned, so this path usually lands in a tab. That is expected.
    console.warn('[sw] could not open side panel, opening tab instead', err);
    await openPanelInTab();
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-side-panel') openPanelFromGesture(tab);
});

// Keep the badge honest when any surface or another device changes tasks.
store.onChange((type) => {
  if (type === 'remote' || type === 'local') refresh();
});

/**
 * Every time the worker wakes, make sure the tick (and the brief, when it is
 * on) are still scheduled. Alarms can be lost across a reload or a profile
 * change, and onInstalled/onStartup do not cover every path — without the
 * tick, nothing ever reminds.
 */
async function ensureAlarms() {
  const settings = await store.getSettings();
  const missingBrief = settings.briefEnabled && !(await chrome.alarms.get(BRIEF));
  if (!(await chrome.alarms.get(TICK)) || missingBrief) await setupAlarms();
}

// A cold start of the worker (e.g. woken by an alarm after being killed) still
// needs the cache hydrated before anything reads it.
store.init()
  .then(ensureAlarms)
  .then(refresh)
  .then(catchUpBrief)
  .catch((err) => console.error('[sw] init failed', err));
