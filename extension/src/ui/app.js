// Shared application for both surfaces. `mode` only changes density:
// 'popup' is compact and capped in height, 'panel' is roomy and pinnable.
//
// Views: 'tasks' and 'projects' are the two top-level tabs; 'project' (one
// site), 'edit' (the project form) and 'settings' sit beneath them. Every
// mutation lives in this file and goes through commit(), so storage, the
// badge and the screen always move together.

import * as B from '../lib/brief.js';
import * as P from '../lib/projects.js';
import * as store from '../lib/store.js';
import * as tasks from '../lib/tasks.js';
import {
  clockLabel,
  dayKey,
  dueState,
  formatElapsed,
  formatMinutes,
  fromDatetimeLocal,
  parseDuration,
  relativeDue,
} from '../lib/time.js';
import {
  avatar,
  balanceBar,
  banner,
  contextTabs,
  el,
  emptyState,
  icon,
  listEditor,
  parsePreview,
  sectionHeader,
  segmented,
  selectField,
  taskEditor,
  taskRow,
  viewNav,
} from './components.js';
import { projectDetail, projectEdit, projectsView, statusLabel } from './projects-view.js';

const state = {
  mode: 'popup',
  root: null,
  tasks: [],
  projects: [],
  settings: store.DEFAULT_SETTINGS,
  timer: null,
  view: 'tasks', // 'tasks' | 'projects' | 'project' | 'edit' | 'settings'
  back: 'projects', // where the project page returns to
  context: 'all',
  query: '',
  searchOpen: false,
  expandedId: null,
  showCompleted: false,
  showProjectDone: false,
  projectId: null,
  draftProject: null,
  editError: null,
  confirmDelete: false,
  reportMonth: 'this',
  draft: '',
  composerOpen: false, // the quick-add bar starts folded into its + button
  briefVisible: false, // today's brief card, until dismissed
  site: null, // id of the project whose site is in the active tab
  tabHost: '', // the active tab's address, offered when adding a new site
  siteDismissed: false,
  dismissedBanner: false,
  dragId: null,
  testNote: null,
  // Render bookkeeping for motion.
  enter: true,
  justAdded: null,
  renderedView: null,
};

let wired = false;

export async function mount(root, mode = 'popup') {
  state.root = root;
  state.mode = mode;
  root.dataset.mode = mode;
  state.enter = true;
  state.renderedView = null;

  await store.init();
  await reload();

  state.context = (await loadUiPref('context')) || 'all';
  // The panel reopens where it was left. The popup always opens on Tasks: it
  // is opened to capture something.
  if (mode === 'panel' && (await loadUiPref('view')) === 'projects') state.view = 'projects';
  applyTheme();

  await repairMaintenance();
  await detectSite();

  // A notification hands off where to land: a specific task from a reminder,
  // or the neglected stream from a nudge.
  const { focusTaskId, focusContext, focusBrief } = await chrome.storage.session.get([
    'focusTaskId',
    'focusContext',
    'focusBrief',
  ]);
  // Today's brief shows as a card the first time the list is opened after its
  // time, and whenever you arrive from the brief notification.
  const briefSeen = (await loadUiPref('briefSeenOn')) === dayKey();
  const briefTime = B.briefTimeOn(Date.now(), state.settings.briefAt ?? B.DEFAULT_BRIEF_AT);
  state.briefVisible = Boolean(focusBrief)
    || (state.settings.briefEnabled && !briefSeen && Date.now() >= briefTime);
  if (focusBrief) {
    Object.assign(state, { view: 'tasks', context: 'all' });
    await chrome.storage.session.remove('focusBrief');
  }
  if (focusTaskId) {
    const task = state.tasks.find((t) => t.id === focusTaskId);
    if (task && task.kind === 'maint' && task.projectId) {
      Object.assign(state, { view: 'project', projectId: task.projectId, back: 'tasks' });
    } else {
      state.view = 'tasks';
      state.expandedId = focusTaskId;
      if (task) state.context = 'all';
    }
    await chrome.storage.session.remove('focusTaskId');
  }
  if (focusContext) {
    state.view = 'tasks';
    state.context = focusContext;
    await chrome.storage.session.remove('focusContext');
  }

  if (!wired) {
    wired = true;
    // Only changes from elsewhere re-render here; local mutations render
    // themselves once, after all their writes, through commit().
    store.onChange(async (type) => {
      if (type === 'remote') {
        await reload();
        render();
      } else if (type === 'error') {
        render();
      }
    });
    document.addEventListener('keydown', onGlobalKey);
  }

  // The composer starts folded into its + button on both surfaces. Capture is
  // still one motion: start typing anywhere and it opens with that letter in
  // it (see onGlobalKey), so Ctrl+Shift+K then a sentence still works.
  render();
}

async function reload() {
  state.tasks = await store.getAll();
  state.projects = await store.getProjects();
  state.settings = await store.getSettings();
  state.timer = await store.getTimer();
}

// UI-only preferences stay local and out of the data store: they are
// per-surface conveniences, not anything worth backing up.
async function loadUiPref(key) {
  const data = await chrome.storage.local.get('ui');
  return (data.ui || {})[key];
}

async function saveUiPref(key, value) {
  const data = await chrome.storage.local.get('ui');
  await chrome.storage.local.set({ ui: { ...(data.ui || {}), [key]: value } });
}

function applyTheme() {
  const theme = state.settings.theme || 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/**
 * Unfold or fold the composer. Done on the live element rather than by a
 * render, so CSS can play the morph — the + button stretching into the bar,
 * the + turning into an ×. `state.composerOpen` keeps later renders in step.
 */
function setComposerOpen(open, { focus = false } = {}) {
  state.composerOpen = open;
  const composer = state.root.querySelector('.composer');
  if (!composer) return;
  composer.classList.toggle('is-open', open);
  const input = composer.querySelector('.composer-input');
  const toggle = composer.querySelector('.composer-toggle');
  input.tabIndex = open ? 0 : -1;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close' : 'Add a task');
  toggle.title = open ? 'Close (Esc)' : 'Add a task — or just start typing';
  if (open && focus) input.focus();
  if (!open && document.activeElement === input) input.blur();
}

function focusComposer() {
  setComposerOpen(true, { focus: true });
}

/** Keep one maintenance run scheduled per active site (see projects.syncMaintenance). */
async function repairMaintenance() {
  const { upserts, removals } = P.syncMaintenance(state.projects, state.tasks);
  if (!upserts.length && !removals.length) return;
  for (const task of upserts) await store.upsert(task);
  for (const id of removals) await store.remove(id);
  await store.flush();
  await reload();
}

/**
 * Is the active tab one of your client sites? Only readable when the popup was
 * opened by a click or the shortcut (that is what activeTab grants), which is
 * exactly when it is useful: you are on the site and about to note something.
 */
async function detectSite() {
  state.site = null;
  state.tabHost = '';
  if (!chrome.tabs || !chrome.tabs.query) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const match = P.matchProjectByUrl(state.projects, tab && tab.url);
    state.site = match ? match.id : null;
    state.tabHost = match ? '' : P.hostnameOf(tab && tab.url);
  } catch {
    // No access to the tab; nothing to detect.
  }
}

const projectById = (id) => state.projects.find((p) => p.id === id) || null;

// --- motion --------------------------------------------------------------------
//
// The DOM is rebuilt on every render, which keeps rendering simple but means
// CSS transitions never see a "before". So motion that spans a render is done
// here: positions and values are remembered between renders and played with
// the Web Animations API from the old value to the new one.

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SPRING = 'cubic-bezier(0.34, 1.32, 0.64, 1)';
const inkMemory = new Map();
const morphMemory = new Map();

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function canAnimate() {
  return !prefersReducedMotion() && typeof document.body.animate === 'function';
}

/** Slide each segmented control's raised pill to its active option. */
function placeInk(root, animate) {
  for (const host of root.querySelectorAll('[data-ink]')) {
    const ink = host.querySelector(':scope > .ink');
    const active = host.querySelector(':scope > .is-active');
    if (!ink) continue;
    if (!active) {
      ink.hidden = true;
      continue;
    }
    const x = active.offsetLeft;
    const w = active.offsetWidth;
    ink.style.transform = `translateX(${x}px)`;
    ink.style.width = `${w}px`;
    if (active.dataset.context) ink.dataset.context = active.dataset.context;
    const prev = inkMemory.get(host.dataset.ink);
    inkMemory.set(host.dataset.ink, { x, w });
    if (animate && prev && (prev.x !== x || prev.w !== w)) {
      ink.animate(
        [
          { transform: `translateX(${prev.x}px)`, width: `${prev.w}px` },
          { transform: `translateX(${x}px)`, width: `${w}px` },
        ],
        { duration: 380, easing: SPRING },
      );
    }
  }
}

/** Glide bars, rings and meters from the value they showed last render. */
function playMorphs(root, animate) {
  for (const node of root.querySelectorAll('[data-morph]')) {
    const key = node.dataset.morph;
    const prop = node.dataset.morphProp;
    const to = node.style[prop];
    const from = morphMemory.has(key) ? morphMemory.get(key) : node.dataset.morphFrom;
    morphMemory.set(key, to);
    if (animate && from != null && String(from) !== String(to)) {
      node.animate([{ [prop]: from }, { [prop]: to }], { duration: 720, easing: EASE });
    }
  }
}

function captureFlips(root) {
  const rects = new Map();
  for (const node of root.querySelectorAll('[data-flip]')) {
    rects.set(node.dataset.flip, node.getBoundingClientRect().top);
  }
  return rects;
}

/** Rows that moved because something above them changed slide into place. */
function playFlips(root, before) {
  for (const node of root.querySelectorAll('[data-flip]')) {
    const top = before.get(node.dataset.flip);
    if (top == null) continue;
    const dy = top - node.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    node.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
      { duration: 360, easing: EASE },
    );
  }
}

/** A small burst from a ticked checkbox, in the colour of its stream. */
function burst(anchor, context) {
  if (!anchor || !canAnimate()) return;
  const rect = anchor.getBoundingClientRect();
  const layer = el('div.fx', {
    dataset: { context: context || 'ok' },
    style: `left:${rect.left + rect.width / 2}px;top:${rect.top + rect.height / 2}px`,
  });
  const ring = el('span.fx-ring');
  layer.append(ring);
  ring.animate(
    [{ transform: 'translate(-50%,-50%) scale(0.4)', opacity: 0.55 }, { transform: 'translate(-50%,-50%) scale(2.4)', opacity: 0 }],
    { duration: 520, easing: EASE },
  );
  const count = 9;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 16 + Math.random() * 12;
    const dot = el('span.fx-dot');
    layer.append(dot);
    dot.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        {
          transform: `translate(calc(-50% + ${(Math.cos(angle) * dist).toFixed(1)}px), calc(-50% + ${(Math.sin(angle) * dist).toFixed(1)}px)) scale(0.2)`,
          opacity: 0,
        },
      ],
      { duration: 520 + Math.random() * 180, easing: EASE },
    );
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 800);
}

/** Fold a finished row's height away so the rows below rise to fill it. */
function collapse(node) {
  const height = node.offsetHeight;
  node.animate(
    [
      { height: `${height}px`, opacity: 1 },
      { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' },
    ],
    { duration: 210, delay: 90, easing: EASE, fill: 'forwards' },
  );
}

const DEPTH = { tasks: 0, projects: 0, project: 1, settings: 1, edit: 2 };

/**
 * Change screens. Uses a view transition where Chrome has one, so screens
 * slide (deeper / back) or cross-fade (between tabs) instead of snapping.
 * Resolves once the new screen is in the DOM.
 */
function navigate(patch) {
  const from = state.view;
  const to = patch.view ?? from;
  const sameScreen = from === to && (patch.projectId == null || patch.projectId === state.projectId);

  const apply = () => {
    Object.assign(state, patch);
    if (!sameScreen) {
      state.expandedId = null;
      state.confirmDelete = false;
      state.composerOpen = false;
      // Values on a new screen should fill in from empty, not from whatever
      // the last screen showed. The balance bar is the same everywhere.
      for (const key of [...morphMemory.keys()]) if (!key.startsWith('bal-')) morphMemory.delete(key);
    }
    state.enter = DEPTH[to] === 0 && from !== to;
    render();
  };

  if (sameScreen || !canAnimate() || typeof document.startViewTransition !== 'function') {
    apply();
    return Promise.resolve();
  }
  const html = document.documentElement;
  html.dataset.vt = DEPTH[to] > DEPTH[from] ? 'forward' : DEPTH[to] < DEPTH[from] ? 'back' : 'swap';
  const transition = document.startViewTransition(apply);
  transition.finished.finally(() => { delete html.dataset.vt; });
  return transition.updateCallbackDone;
}

// --- toasts --------------------------------------------------------------------
// Toasts live outside #root so a re-render never wipes one mid-countdown.

let toastHost = null;

function toast(message, { undo, duration = 5000 } = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el('div.toasts', { 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  while (toastHost.children.length >= 2) toastHost.firstChild.remove();

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!node.isConnected || node.classList.contains('is-leaving')) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 240);
  };
  const node = el('div.toast', {
    role: 'status',
    style: `--life:${duration}ms`,
    // Hovering holds the toast, so reaching for Undo never races the clock.
    onmouseenter: () => clearTimeout(timer),
    onmouseleave: () => { timer = setTimeout(dismiss, 1800); },
  }, [
    el('span.toast-text', { text: message }),
    undo
      ? el('button.toast-btn', {
          type: 'button',
          text: 'Undo',
          onclick: async () => {
            dismiss();
            await undo();
          },
        })
      : null,
    el('span.toast-life', { 'aria-hidden': 'true' }),
  ]);
  toastHost.append(node);
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

// --- mutations -----------------------------------------------------------------

/**
 * Apply a set of writes, then refresh state, re-render once, persist, and let
 * the worker recount the badge. `quiet` skips the render, for a mutation that
 * is about to change screens anyway — the transition paints the result.
 */
async function commit({
  tasks: upserts = [],
  removeTasks = [],
  projects: projectUpserts = [],
  removeProjects = [],
  touch = null,
} = {}, { quiet = false } = {}) {
  for (const task of upserts) await store.upsert(task);
  for (const id of removeTasks) await store.remove(id);
  for (const project of projectUpserts) await store.upsertProject(project);
  for (const id of removeProjects) await store.removeProject(id);
  if (touch) await store.touchContext(touch);
  await reload();
  if (!quiet) render();
  await store.flush();
  chrome.runtime.sendMessage({ type: 'refresh-badge' }).catch(() => {});
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function toggleTask(task, options = {}, anchor = null) {
  if (task.done) {
    await reopenTask(task);
    return;
  }

  // Let the tick land and the row fold away before it leaves the list.
  // Completing something is the moment worth celebrating.
  const row = state.root.querySelector(`.row[data-id="${task.id}"]`);
  if (row && !prefersReducedMotion()) {
    row.classList.add('is-completing');
    row.querySelector('.check')?.setAttribute('aria-checked', 'true');
    burst(row.querySelector('.check'), task.context);
    if (canAnimate()) collapse(row);
    await wait(280);
  } else if (anchor) {
    burst(anchor, task.context);
  }

  const project = task.projectId ? projectById(task.projectId) : null;
  const done = P.completeTask(task, project, Date.now(), options);
  await commit({
    tasks: [done.task, ...(done.next ? [done.next] : [])],
    projects: done.project ? [done.project] : [],
    touch: task.context,
  });

  toast(task.kind === 'maint' && project ? `${project.name} — maintenance logged` : 'Task completed', {
    // Undo puts the task back exactly as it was — steps ticked by "Tick all"
    // included — rather than merely reopening the completed copy.
    undo: async () => {
      const current = state.tasks.find((t) => t.id === task.id);
      if (current && current.done) await reopenTask(current, task);
    },
  });
}

async function reopenTask(task, restore = null) {
  const project = task.projectId ? projectById(task.projectId) : null;
  const undo = P.reopenTask(task, state.tasks, project);
  await commit({
    tasks: [restore || undo.task],
    removeTasks: undo.remove,
    projects: undo.project ? [undo.project] : [],
    touch: task.context,
  });
}

async function removeTask(task) {
  state.expandedId = null;
  await commit({ removeTasks: [task.id] });
  toast('Task deleted', { undo: () => commit({ tasks: [task] }) });
}

/** Flagging lifts a task into the Priority section; FLIP slides it up there. */
function toggleFlag(task) {
  return patchTask(task, { priority: !task.priority });
}

function dismissBrief() {
  state.briefVisible = false;
  saveUiPref('briefSeenOn', dayKey());
  render();
}

async function patchTask(task, patch) {
  const next = { ...task, ...patch };
  if ('dueLocal' in patch) {
    delete next.dueLocal;
    const due = fromDatetimeLocal(patch.dueLocal);
    next.due = due;
    next.remindAt = due;
  }
  await commit({ tasks: [next], touch: next.context });
}

function composerOptions() {
  return {
    defaultContext: state.context === 'all' ? 'business' : state.context,
    projects: state.projects,
    defaultProjectId: state.siteDismissed ? null : state.site,
  };
}

async function addFromComposer(value) {
  const task = tasks.taskFromQuickAdd(value, composerOptions());
  if (!task) return false;
  state.draft = '';
  state.justAdded = task.id;
  await commit({ tasks: [task], touch: task.context });
  return true;
}

/** The tasks the list is showing right now, before grouping. */
function visibleTasks(now = Date.now()) {
  const surfaced = state.tasks.filter((t) => tasks.isSurfaced(t, now));
  return tasks.search(
    tasks.byContext(surfaced, state.context),
    state.query,
    (id) => projectById(id)?.name,
  );
}

/**
 * Move an undated task to sit where another one is. Order is renumbered across
 * the whole undated list so the values stay small and stable.
 */
async function reorderUndated(draggedId, targetId) {
  state.dragId = null;
  if (!draggedId || draggedId === targetId) return;

  const { sections } = tasks.groupForDisplay(
    visibleTasks().filter((t) => t.kind !== 'maint'),
    Date.now(),
  );
  const undated = sections.find((s) => s.key === 'none').tasks;

  const from = undated.findIndex((t) => t.id === draggedId);
  const to = undated.findIndex((t) => t.id === targetId);
  if (from === -1 || to === -1) return;

  const ordered = [...undated];
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);

  await commit({
    tasks: ordered
      .map((task, index) => ({ ...task, order: index }))
      .filter((task, index) => undated.find((t) => t.id === task.id).order !== index),
  });
}

async function updateSettings(patch) {
  state.settings = await store.setSettings(patch);
  applyTheme();
  render();
  await store.flush();
  chrome.runtime.sendMessage({ type: 'settings-changed' }).catch(() => {});
}

// --- project actions -----------------------------------------------------------

function openProject(id, from = state.view) {
  return navigate({
    view: 'project',
    projectId: id,
    back: from === 'project' || from === 'edit' ? state.back : from,
    showProjectDone: false,
    reportMonth: 'this',
  });
}

function newProject() {
  const checklist = state.settings.defaultChecklist || P.DEFAULT_CHECKLIST;
  state.draftProject = P.makeProject({
    maintenance: { enabled: true, day: 1, checklist: [...checklist] },
  });
  state.editError = null;
  return navigate({ view: 'edit', projectId: null });
}

function editProject(project) {
  state.draftProject = JSON.parse(JSON.stringify(project));
  state.editError = null;
  return navigate({ view: 'edit', projectId: project.id });
}

function updateDraft(patch) {
  Object.assign(state.draftProject, patch);
  state.editError = null;
  render();
}

function cancelEdit() {
  const id = state.draftProject && state.projects.some((p) => p.id === state.draftProject.id)
    ? state.draftProject.id
    : null;
  return navigate(id
    ? { view: 'project', projectId: id, draftProject: null }
    : { view: 'projects', projectId: null, draftProject: null });
}

async function saveProject() {
  const draft = state.draftProject;
  // Text inputs write to the draft without re-rendering, so read the live
  // form once more in case a field still has focus.
  draft.name = String(draft.name || '').trim();
  draft.url = String(draft.url || '').trim();
  draft.client = String(draft.client || '').trim();
  if (!draft.name) {
    state.editError = 'Give the project a name.';
    render();
    state.root.querySelector('[data-focus-key="pf-name"]')?.focus();
    return;
  }

  const before = projectById(draft.id);
  const writes = { projects: [draft], tasks: [], removeTasks: [] };

  if (before) {
    // Carry the edit onto work already open for this site.
    for (const task of state.tasks) {
      if (task.projectId !== draft.id || task.done) continue;
      if (task.kind === 'maint') writes.tasks.push(P.reconcileMaintenance(task, before, draft));
      else if (before.context !== draft.context) writes.tasks.push({ ...task, context: draft.context });
    }
  }

  const changed = new Map(writes.tasks.map((t) => [t.id, t]));
  const mine = state.tasks
    .filter((t) => t.projectId === draft.id)
    .map((t) => changed.get(t.id) || t);
  const schedule = P.syncMaintenance([draft], mine);
  writes.tasks.push(...schedule.upserts);
  writes.removeTasks.push(...schedule.removals);

  await commit(writes, { quiet: true });
  await navigate({
    view: 'project',
    projectId: draft.id,
    back: before ? state.back : 'projects',
    draftProject: null,
  });
  toast(before ? 'Project saved' : `${draft.name} added`);
}

async function deleteProject(id) {
  if (!state.confirmDelete) {
    state.confirmDelete = true;
    render();
    setTimeout(() => {
      if (state.confirmDelete) {
        state.confirmDelete = false;
        if (state.view === 'edit') render();
      }
    }, 3500);
    return;
  }
  const project = projectById(id);
  if (!project) return;
  const owned = state.tasks.filter((t) => t.projectId === id);
  if (state.timer && state.timer.projectId === id) await store.setTimer(null);
  await commit({ removeProjects: [id], removeTasks: owned.map((t) => t.id) }, { quiet: true });
  await navigate({ view: 'projects', projectId: null, draftProject: null });
  toast(`${project.name} deleted`, { undo: () => commit({ projects: [project], tasks: owned }) });
}

async function patchProject(project, patch) {
  await commit({ projects: [{ ...project, ...patch }] });
}

async function toggleStep(task, stepId) {
  await patchTask(task, {
    subtasks: task.subtasks.map((s) => (s.id === stepId ? { ...s, done: !s.done } : s)),
  });
}

async function addProjectTask(project, kind, text) {
  const task = tasks.taskFromQuickAdd(text, {
    defaultContext: project.context,
    projects: state.projects,
    defaultProjectId: project.id,
  });
  if (!task) return;
  task.projectId = project.id;
  task.context = project.context;
  task.kind = kind;
  state.justAdded = task.id;
  await commit({ tasks: [task], touch: project.context });
}

async function addTime(project, minutes) {
  const updated = P.addTime(project, minutes);
  const entry = updated.time[0];
  await commit({ projects: [updated] });
  toast(`${formatMinutes(minutes)} logged to ${project.name}`, {
    undo: () => removeTime(projectById(project.id), entry.id, { quiet: true }),
  });
}

function addTimeText(project, text) {
  const minutes = parseDuration(text);
  if (!minutes) {
    toast('Try 45, 45m, 1.5h or 1h 30m');
    return false;
  }
  addTime(project, minutes);
  return true;
}

async function removeTime(project, entryId, { quiet = false } = {}) {
  if (!project) return;
  const entry = (project.time || []).find((e) => e.id === entryId);
  await commit({ projects: [P.removeTime(project, entryId)] });
  if (!quiet && entry) {
    toast(`Removed ${formatMinutes(entry.minutes)}`, {
      undo: () => commit({ projects: [{ ...projectById(project.id), time: [entry, ...projectById(project.id).time] }] }),
    });
  }
}

async function startTimer(project) {
  if (state.timer) await stopTimer();
  await store.setTimer({ projectId: project.id, startedAt: Date.now() });
  await store.flush();
  await reload();
  render();
}

/** Stop the running timer and log what it measured to its project. */
async function stopTimer() {
  const timer = state.timer;
  if (!timer) return;
  const minutes = Math.round((Date.now() - timer.startedAt) / 60000);
  const project = projectById(timer.projectId);
  await store.setTimer(null);

  if (!project || minutes < 1) {
    await commit();
    toast('Timer stopped — under a minute, nothing logged');
    return;
  }
  // A timer left running overnight should not quietly bill twelve hours.
  if (minutes > 8 * 60 && !confirm(`The timer ran for ${formatMinutes(minutes)}. Log all of it to ${project.name}?`)) {
    await commit();
    toast('Timer stopped, nothing logged');
    return;
  }
  await addTime(project, minutes);
}

async function copyReport(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API refused (no focus, say): fall back to a selection copy.
    const area = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    document.execCommand?.('copy');
    area.remove();
  }
  toast('Report copied — paste it into your email');
}

const actions = {
  openProject: (id) => openProject(id),
  newProject,
  editProject,
  updateDraft,
  cancelEdit,
  saveProject,
  deleteProject,
  patchProject,
  toggleStep,
  completeMaintenance: (task, options, anchor) => toggleTask(task, options, anchor),
  reopen: reopenTask,
  addProjectTask,
  addTime,
  addTimeText,
  removeTime: (project, id) => removeTime(project, id),
  startTimer,
  stopTimer,
  copyReport,
  setReportMonth: (value) => {
    state.reportMonth = value;
    render();
  },
  toggleProjectDone: () => {
    state.showProjectDone = !state.showProjectDone;
    render();
  },
  back: () => navigate({ view: state.back || 'projects' }),
};

// --- keyboard ------------------------------------------------------------------

function typingIn(target) {
  return target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
}

function onGlobalKey(event) {
  if (event.key === '/' && !typingIn(event.target) && (state.view === 'tasks' || state.view === 'projects')) {
    event.preventDefault();
    state.searchOpen = true;
    render();
    state.root.querySelector('.search-input')?.focus();
    return;
  }
  // Type to capture: a plain keystroke on the task list, with nothing else
  // focused for typing, unfolds the composer and lands in it. Focus moves
  // during keydown, so the character itself goes into the input.
  if (
    state.view === 'tasks'
    && !typingIn(event.target)
    && event.key.length === 1
    && event.key !== ' '
    && !event.ctrlKey && !event.metaKey && !event.altKey
  ) {
    setComposerOpen(true, { focus: true });
    return;
  }
  if (event.key === 'Escape' && !typingIn(event.target)) {
    if (state.expandedId) {
      state.expandedId = null;
      render();
    } else if (state.view === 'project' || state.view === 'settings') {
      actions.back();
    }
  }
}

// --- render --------------------------------------------------------------------

let ticker = null;

/** While a timer runs, its readouts tick every second without a full render. */
function syncTicker() {
  if (state.timer && !ticker) ticker = setInterval(updateTimerText, 1000);
  if (!state.timer && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  updateTimerText();
}

function updateTimerText() {
  if (!state.timer || !state.root) return;
  const text = formatElapsed(Date.now() - state.timer.startedAt);
  for (const node of state.root.querySelectorAll('.timer-time')) node.textContent = text;
}

function render() {
  const root = state.root;
  const animate = canAnimate();
  const viewId = `${state.view}:${state.projectId || ''}`;
  const sameView = state.renderedView === viewId;

  const flips = animate && sameView ? captureFlips(root) : null;
  const scroller = root.querySelector('.list');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  // Rendering replaces the DOM wholesale, which would otherwise drop the caret
  // mid-edit — adding a tag, say. Fields that can be typed into carry a
  // focusKey so the caret can be put back where it was.
  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.focusKey : null;
  const caret = focusKey && active.selectionStart != null ? active.selectionStart : null;

  const view = buildView();
  if (state.enter && animate) view.classList.add('is-entering');

  root.textContent = '';
  root.append(view);

  const next = root.querySelector('.list');
  if (next && sameView) next.scrollTop = scrollTop;

  if (focusKey) {
    const restored = root.querySelector(`[data-focus-key="${focusKey}"]`);
    if (restored) {
      restored.focus();
      if (caret != null && restored.setSelectionRange) {
        try {
          restored.setSelectionRange(caret, caret);
        } catch {
          // Some input types (date, number) reject selection ranges; focus is enough.
        }
      }
    }
  }

  placeInk(root, animate && state.renderedView != null);
  playMorphs(root, animate);
  if (flips) playFlips(root, flips);

  state.enter = false;
  state.justAdded = null;
  state.renderedView = `${state.view}:${state.projectId || ''}`;
  syncTicker();
}

function buildView() {
  switch (state.view) {
    case 'settings':
      return renderSettings();
    case 'projects':
      return renderProjects();
    case 'project':
    case 'edit': {
      const view = state.view === 'project' ? projectDetail(viewContext()) : projectEdit(viewContext());
      if (view) return view;
      // The project on screen was deleted from another surface.
      Object.assign(state, { view: 'projects', projectId: null, draftProject: null });
      return renderProjects();
    }
    default:
      return renderTasks();
  }
}

function viewContext() {
  return {
    state,
    now: Date.now(),
    act: actions,
    renderRow,
    onScroll: onListScroll,
  };
}

// The header is fixed above the scroller, so it earns a shadow only once there
// is something scrolled underneath it.
function onListScroll(event) {
  const app = state.root.querySelector('.app');
  if (app) app.classList.toggle('is-scrolled', event.target.scrollTop > 2);
}

function summaryNow(now) {
  return tasks
    .contextSummary(state.tasks, state.settings, now)
    .map((s) => ({ ...s, threshold: state.settings.staleContextDays ?? 2 }));
}

function switchView(view) {
  if (view === state.view) return;
  saveUiPref('view', view);
  navigate({ view, projectId: null });
}

function renderHeader(summary) {
  const now = Date.now();
  const timerProject = state.timer ? projectById(state.timer.projectId) : null;
  const lateSites = P.monthOverview(state.projects, state.tasks, now).overdue;

  return el('header.head', {}, [
    el('div.head-bar', {}, [
      viewNav(state.view, switchView, { projects: lateSites }),
      el('div.head-tools', {}, [
        timerProject
          ? el('button.timer-pill', {
              type: 'button',
              title: `Stop the timer for ${timerProject.name}`,
              'aria-label': `Stop the timer for ${timerProject.name}`,
              onclick: stopTimer,
            }, [
              el('span.timer-dot'),
              el('span.timer-time', { text: formatElapsed(now - state.timer.startedAt) }),
              // The client's mark rather than its name: the header is narrow.
              avatar(timerProject, 'xs'),
            ])
          : null,
        el('button.icon-btn.search-btn', {
          type: 'button',
          'aria-label': 'Search',
          'aria-pressed': String(state.searchOpen),
          className: 'icon-btn search-btn' + (state.searchOpen || state.query ? ' is-on' : ''),
          onclick: () => {
            state.searchOpen = !state.searchOpen;
            if (!state.searchOpen) state.query = '';
            render();
            if (state.searchOpen) state.root.querySelector('.search-input')?.focus();
          },
        }, [icon('search')]),
        el('button.icon-btn.settings-btn', {
          type: 'button',
          'aria-label': 'Settings',
          onclick: () => navigate({ view: 'settings', back: state.view }),
        }, [icon('sliders')]),
      ]),
    ]),
    state.searchOpen ? renderSearch() : null,
    balanceBar(summary, {
      active: state.view === 'tasks' && state.context !== 'all' ? state.context : null,
      onPick: (context) => {
        const next = state.view === 'tasks' && state.context === context ? 'all' : context;
        saveUiPref('context', next);
        if (state.view === 'tasks') {
          state.context = next;
          state.enter = true;
          render();
        } else {
          saveUiPref('view', 'tasks');
          navigate({ view: 'tasks', context: next });
        }
      },
    }),
  ]);
}

function renderSearch() {
  return el('div.search-row', {}, [
    icon('search'),
    el('input.search-input', {
      type: 'search',
      value: state.query,
      placeholder: state.view === 'projects' ? 'Search sites and clients' : 'Search tasks, tags, clients',
      'aria-label': 'Search',
      autocomplete: 'off',
      spellcheck: false,
      dataset: { focusKey: 'search' },
      oninput: (event) => {
        state.query = event.target.value;
        render();
      },
      onkeydown: (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          state.query = '';
          state.searchOpen = false;
          render();
        }
      },
    }),
  ]);
}

function renderTasks() {
  const now = Date.now();
  const summary = summaryNow(now);
  const visible = visibleTasks(now);
  const maintenance = visible.filter((t) => t.kind === 'maint' && !t.done);
  const { sections, completed } = tasks.groupForDisplay(
    visible.filter((t) => t.kind !== 'maint' || t.done),
    now,
  );

  const counts = { all: tasks.openTasks(state.tasks.filter((t) => tasks.isSurfaced(t, now))).length };
  for (const s of summary) counts[s.context] = s.open;

  const list = el('div.list', { onscroll: onListScroll });
  const totalOpen = sections.reduce((sum, s) => sum + s.tasks.length, 0);

  const brief = state.briefVisible && !state.query
    ? B.buildBrief(state.tasks, state.projects, state.settings, now)
    : null;
  if (brief) list.append(briefCard(brief, now));
  if (maintenance.length) list.append(maintenanceStrip(maintenance, now));

  if (!totalOpen && !maintenance.length) {
    list.append(
      state.query
        ? emptyState('Nothing matches that.', 'Try a shorter search.')
        : emptyState(
            state.context === 'all'
              ? 'Everything is clear.'
              : `${tasks.CONTEXT_LABEL[state.context]} is clear.`,
            'Type below to add the next thing.',
          ),
    );
  }

  let index = 0;
  for (const section of sections) {
    if (!section.tasks.length) continue;
    list.append(sectionHeader(section.label, section.tasks.length, null, section.key));
    const group = el('div.group', { dataset: { section: section.key } });
    for (const task of section.tasks) group.append(renderRow(task, section.key, index++));
    list.append(group);
  }

  if (completed.length) {
    list.append(
      sectionHeader(
        'Completed',
        completed.length,
        el('button.ghost-btn.section-toggle', {
          type: 'button',
          text: state.showCompleted ? 'Hide' : 'Show',
          onclick: () => {
            state.showCompleted = !state.showCompleted;
            render();
          },
        }),
      ),
    );
    if (state.showCompleted) {
      const group = el('div.group');
      for (const task of completed.slice(0, 50)) group.append(renderRow(task, null, index++));
      list.append(group);
    }
  }

  const writeError = store.getWriteError();
  const site = state.site && !state.siteDismissed ? projectById(state.site) : null;

  return el('div.app', { dataset: { view: 'tasks' } }, [
    renderHeader(summary),
    writeError && !state.dismissedBanner
      ? banner('Could not save the last change. Export a backup from Settings.', () => {
          state.dismissedBanner = true;
          render();
        })
      : null,
    site ? siteSpot(site, now) : null,
    contextTabs(state.context, counts, (context) => {
      state.context = context;
      state.enter = true;
      saveUiPref('context', context);
      render();
    }),
    list,
    // Docked at the bottom: the list is what you came to read, and the
    // composer stays quiet until it is actually being used.
    renderComposer(),
  ]);
}

function renderProjects() {
  const summary = summaryNow(Date.now());
  const [list, dock] = projectsView(viewContext());
  return el('div.app', { dataset: { view: 'projects' } }, [renderHeader(summary), list, dock]);
}

/**
 * Today at a glance, at the top of the list: what is late, due and flagged,
 * and the three things to start with. Dismissed for the day with one click.
 */
function briefCard(brief, now) {
  const stat = (label, value, tone) =>
    el('div.brief-stat', { dataset: { tone, zero: String(!value) } }, [
      el('span.brief-num', { text: String(value) }),
      el('span.brief-label', { text: label }),
    ]);

  const open = (task) => {
    if (task.kind === 'maint' && task.projectId) {
      openProject(task.projectId, 'tasks');
    } else {
      state.expandedId = task.id;
      render();
    }
  };

  return el('section.brief', {}, [
    el('div.brief-head', {}, [
      el('span.brief-sun', {}, [icon('sun')]),
      el('div.brief-titles', {}, [
        el('span.brief-greet', { text: B.greeting(now) }),
        el('span.brief-date', {
          text: new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
        }),
      ]),
      el('button.icon-btn.brief-x', {
        type: 'button',
        'aria-label': 'Dismiss today’s brief',
        title: 'Dismiss for today',
        onclick: dismissBrief,
      }, [icon('x')]),
    ]),
    el('div.brief-stats', {}, [
      stat('Overdue', brief.counts.overdue, 'late'),
      stat('Due today', brief.counts.today, 'soon'),
      stat('Priority', brief.counts.priority, 'priority'),
      state.projects.length ? stat('Sites', brief.counts.sites, 'site') : null,
    ]),
    brief.focus.length
      ? el('div.brief-focus', {}, [
          el('span.kicker', { text: 'Start with' }),
          el('ol.brief-list', {}, brief.focus.map((task) => {
            const project = task.projectId ? projectById(task.projectId) : null;
            return el('li', {}, [
              el('button.brief-item', {
                type: 'button',
                dataset: { context: task.context },
                onclick: () => open(task),
              }, [
                el('span.brief-dot'),
                el('span.brief-item-title', {
                  text: task.kind === 'maint' && project ? `${project.name} maintenance` : task.title,
                }),
                task.priority ? icon('flag', 'brief-flag') : null,
                task.due
                  ? el('span.brief-item-due', {
                      dataset: { late: String(task.due < now) },
                      text: relativeDue(task.due, now),
                    })
                  : null,
              ]),
            ]);
          })),
        ])
      : null,
  ]);
}

/** You are on a client's site: say so, and file new tasks there by default. */
function siteSpot(project, now) {
  const status = P.monthStatus(project, state.tasks, now);
  const open = state.tasks.filter((t) => t.projectId === project.id && !t.done && t.kind !== 'maint').length;
  const meta = [statusLabel(status, now).text, open ? `${open} open` : 'nothing open'];

  return el('section.spot', { style: `--hue:${P.hueOf(project.name)}` }, [
    avatar(project),
    el('div.spot-body', {}, [
      el('span.spot-kicker', { text: 'You’re on' }),
      el('span.spot-name', { text: project.name }),
      el('span.spot-meta', { text: meta.join(' · ') }),
    ]),
    el('button.ghost-btn.spot-open', {
      type: 'button',
      onclick: () => openProject(project.id, 'tasks'),
    }, [el('span', { text: 'Open' }), icon('chevron-right')]),
    el('button.icon-btn.spot-x', {
      type: 'button',
      'aria-label': 'Not now — stop filing tasks under this site',
      onclick: () => {
        state.siteDismissed = true;
        render();
      },
    }, [icon('x')]),
  ]);
}

/**
 * Maintenance runs coming due, as one strip of site chips rather than a dozen
 * identical "Monthly maintenance" rows.
 */
function maintenanceStrip(runs, now) {
  const late = runs.filter((t) => t.due < now).length;
  return el('section.maint-strip', {}, [
    el('div.maint-head', {}, [
      icon('shield'),
      el('span.maint-label', { text: 'Site maintenance' }),
      el('span.maint-count', {
        dataset: { late: String(late > 0) },
        text: late ? `${late} overdue` : `${runs.length} due soon`,
      }),
    ]),
    el('div.maint-sites', {}, runs.map((task) => {
      const project = projectById(task.projectId);
      if (!project) return null;
      const progress = P.checklistProgress(task);
      return el('button.site-chip', {
        type: 'button',
        dataset: { state: dueState(task.due, now), flip: task.id },
        title: `${project.name}: ${progress.done} of ${progress.total} steps`,
        onclick: () => openProject(project.id, 'tasks'),
      }, [
        avatar(project, 'xs'),
        el('span.site-chip-name', { text: project.name }),
        el('span.site-chip-due', { text: relativeDue(task.due, now) }),
      ]);
    })),
  ]);
}

function renderComposer() {
  const site = !state.siteDismissed && state.site ? projectById(state.site) : null;
  const open = state.composerOpen || Boolean(state.draft.trim());
  const input = el('input.composer-input', {
    type: 'text',
    value: state.draft,
    placeholder: site ? `Add to ${site.name}…` : 'What needs doing?',
    'aria-label': 'Add a task',
    autocomplete: 'off',
    spellcheck: false,
    dataset: { focusKey: 'composer' },
    oninput: (event) => {
      state.draft = event.target.value;
      updatePreview(event.target.value);
    },
    onkeydown: async (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        // First Esc clears the line; Esc on an empty line folds it away.
        if (!event.target.value) {
          setComposerOpen(false);
          return;
        }
        event.target.value = '';
        state.draft = '';
        updatePreview('');
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value;
      if (await addFromComposer(value)) focusComposer();
    },
  });
  // Folded, the input is out of the tab order; the + button stands in for it.
  input.tabIndex = open ? 0 : -1;

  const preview = el('div.preview-slot');

  // Floating over the bottom of the list: closed, a round + button; open, a
  // bar the full width of the list. Chips and the syntax hint sit above it.
  const composer = el('div.composer', {
    className: 'composer' + (open ? ' is-open' : ''),
    // Clicking away from an empty bar folds it. Checked a tick later, because
    // a re-render moves focus to the new input and that is not "away".
    onfocusout: () => {
      setTimeout(() => {
        const live = state.root.querySelector('.composer');
        if (live && !live.contains(document.activeElement) && !state.draft.trim()) {
          setComposerOpen(false);
        }
      }, 0);
    },
  }, [
    preview,
    el('div.composer-hint', { text: '@stream  #tag  !fri  !!  +client' }),
    el('div.composer-line', {}, [
      el('button.composer-toggle', {
        type: 'button',
        'aria-expanded': String(open),
        'aria-label': open ? 'Close' : 'Add a task',
        title: open ? 'Close (Esc)' : 'Add a task — or just start typing',
        onclick: () => setComposerOpen(!state.composerOpen, { focus: true }),
      }, [
        icon('plus'),
        // On a client's site the button wears that client's mark: new tasks go there.
        site ? el('span.fab-badge', {}, [avatar(site, 'xs')]) : null,
      ]),
      input,
      el('button.add-btn', {
        type: 'button',
        'aria-label': 'Add task',
        onclick: async () => {
          if (await addFromComposer(input.value)) focusComposer();
        },
      }, [icon('arrow-up')]),
    ]),
  ]);

  if (state.draft.trim()) preview.append(previewChips(state.draft));
  return composer;
}

function previewChips(value) {
  return parsePreview(tasks.parseQuickAdd(value, composerOptions()), {
    onClearProject: () => {
      state.siteDismissed = true;
      render();
    },
  });
}

function updatePreview(value) {
  const slot = state.root.querySelector('.preview-slot');
  if (!slot) return;
  slot.textContent = '';
  if (!value.trim()) return;
  slot.append(previewChips(value));
}

function renderRow(task, sectionKey, index = 0, { showProject = true } = {}) {
  const expanded = state.expandedId === task.id;

  if (!expanded) {
    const row = taskRow(task, {
      expanded,
      index,
      project: showProject && task.projectId ? projectById(task.projectId) : null,
      onToggle: (t) => toggleTask(t),
      onFlag: toggleFlag,
      onOpen: (t) => {
        state.expandedId = t.id;
        render();
      },
      drag:
        sectionKey === 'none'
          ? {
              currentId: state.dragId,
              onStart: (id) => {
                state.dragId = id;
              },
              onDrop: reorderUndated,
            }
          : null,
    });
    if (state.justAdded === task.id) row.classList.add('is-new');
    return row;
  }

  // The editor replaces the row it was opened from, so the title is not
  // repeated in a read-only line directly above its own input.
  const editor = taskEditor(task, {
    projects: state.projects,
    onToggle: (t) => toggleTask(t),
    onPatch: (patch) => patchTask(task, patch),
    onDelete: () => removeTask(task),
    onClose: () => {
      state.expandedId = null;
      render();
    },
    onAddSubtask: (title) =>
      patchTask(task, { subtasks: [...task.subtasks, tasks.makeSubtask(title)] }),
    onToggleSubtask: (id) =>
      patchTask(task, {
        subtasks: task.subtasks.map((s) => (s.id === id ? { ...s, done: !s.done } : s)),
      }),
    onRemoveSubtask: (id) =>
      patchTask(task, { subtasks: task.subtasks.filter((s) => s.id !== id) }),
  });

  return el('div.row-shell', { dataset: { context: task.context, flip: task.id } }, [editor]);
}

// --- settings --------------------------------------------------------------------

function renderSettings() {
  const s = state.settings;

  const hourOptions = (selected, onChange, label) =>
    selectField(
      { 'aria-label': label, onchange: (e) => onChange(Number(e.target.value)) },
      Array.from({ length: 24 }, (_, h) =>
        el('option', {
          value: String(h),
          text: `${String(h).padStart(2, '0')}:00`,
          selected: h === selected,
        }),
      ),
    );

  const lastBackup = s.lastBackupAt
    ? `Last exported ${relativeDue(s.lastBackupAt)}.`
    : 'Never exported.';

  return el('div.app.settings', { dataset: { view: 'settings' } }, [
    el('header.head.head-settings', {}, [
      el('button.icon-btn', {
        type: 'button',
        'aria-label': 'Back',
        onclick: () => navigate({ view: state.back === 'projects' ? 'projects' : 'tasks' }),
      }, [icon('back')]),
      el('h1.settings-title', { text: 'Settings' }),
    ]),

    el('div.list.settings-list', { onscroll: onListScroll }, [
      settingsGroup('Reminders', [
        el('div.setting-row.backup-row', {}, [
          el('button.ghost-btn', {
            type: 'button',
            text: 'Test a reminder',
            onclick: () => sendTestReminder('single'),
          }),
          el('button.ghost-btn', {
            type: 'button',
            text: 'Test a grouped one',
            onclick: () => sendTestReminder('batch'),
          }),
        ]),
        el('p.setting-note', {
          text:
            state.testNote ||
            'Fires a sample notification now, so you can check it appears and makes a sound. '
              + 'Windows controls the sound, not this extension: Settings → System → '
              + 'Notifications → Google Chrome.',
        }),
      ]),

      settingsGroup('Morning brief', [
        toggleRow('Send a brief each day', s.briefEnabled, (v) => updateSettings({ briefEnabled: v })),
        el('label.setting-row', {}, [
          el('span.setting-label', { text: 'At' }),
          selectField(
            {
              'aria-label': 'Brief time',
              onchange: (e) => updateSettings({ briefAt: Number(e.target.value) }),
            },
            Array.from({ length: 48 }, (_, i) => i * 30).map((minutes) =>
              el('option', {
                value: String(minutes),
                text: clockLabel(minutes),
                selected: (s.briefAt ?? B.DEFAULT_BRIEF_AT) === minutes,
              }),
            ),
          ),
        ]),
        el('div.setting-row.backup-row', {}, [
          el('button.ghost-btn', {
            type: 'button',
            text: 'Send it now',
            onclick: () => sendTestReminder('brief'),
          }),
        ]),
        el('p.setting-note', {
          text: 'One notification with the day across every stream: what is overdue, due today, '
            + 'flagged, and which sites need maintenance. It stays silent on a day with nothing to say. '
            + 'If Chrome was closed at the time, it arrives when Chrome opens, up to four hours late.',
        }),
      ]),

      settingsGroup('Nudges', [
        toggleRow('Periodic nudge', s.nudgeEnabled, (v) => updateSettings({ nudgeEnabled: v })),
        el('label.setting-row', {}, [
          el('span.setting-label', { text: 'Every' }),
          selectField(
            {
              'aria-label': 'Nudge interval',
              onchange: (e) => updateSettings({ nudgeIntervalHours: Number(e.target.value) }),
            },
            [0.5, 1, 2, 3, 4, 6, 8].map((h) =>
              el('option', {
                value: String(h),
                text: h < 1 ? `${h * 60} minutes` : h === 1 ? '1 hour' : `${h} hours`,
                selected: Number(s.nudgeIntervalHours) === h,
              }),
            ),
          ),
        ]),
        el('label.setting-row', {}, [
          el('span.setting-label', { text: 'Call out a quiet stream after' }),
          selectField(
            {
              'aria-label': 'Quiet-stream threshold',
              onchange: (e) => updateSettings({ staleContextDays: Number(e.target.value) }),
            },
            [0, 1, 2, 3, 5, 7].map((d) =>
              el('option', {
                value: String(d),
                text: d === 0 ? 'Same day' : d === 1 ? '1 day' : `${d} days`,
                selected: Number(s.staleContextDays) === d,
              }),
            ),
          ),
        ]),
        el('p.setting-note', {
          text: 'The nudge names whichever stream you have not touched, and how many sites still need this month’s maintenance.',
        }),
      ]),

      settingsGroup('Quiet hours', [
        el('div.setting-row.quiet-row', {}, [
          el('span.setting-label', { text: 'From' }),
          hourOptions(s.quietHours.start, (v) =>
            updateSettings({ quietHours: { ...s.quietHours, start: v } }), 'Quiet hours start'),
          el('span.setting-label', { text: 'to' }),
          hourOptions(s.quietHours.end, (v) =>
            updateSettings({ quietHours: { ...s.quietHours, end: v } }), 'Quiet hours end'),
        ]),
        el('p.setting-note', {
          text: 'Reminders wait rather than disappear. Anything due overnight arrives when the window ends.',
        }),
      ]),

      settingsGroup('New projects start with', [
        listEditor(s.defaultChecklist || P.DEFAULT_CHECKLIST, {
          placeholder: 'Add a step',
          focusKey: 'default-checklist',
          onChange: (list) => updateSettings({ defaultChecklist: list }),
        }),
        el('p.setting-note', {
          text: 'The maintenance checklist every new site gets. Each project can still change its own.',
        }),
      ]),

      settingsGroup('Appearance', [
        segmented(
          [
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ],
          s.theme || 'system',
          (theme) => updateSettings({ theme }),
          { label: 'Theme', className: 'theme-seg' },
        ),
      ]),

      settingsGroup('Backup', [
        el('div.setting-row.backup-row', {}, [
          el('button.ghost-btn', { type: 'button', text: 'Export everything', onclick: exportData }),
          el('button.ghost-btn', { type: 'button', text: 'Import', onclick: importData }),
        ]),
        el('p.setting-note', {
          text: `Tasks and projects are stored on this computer. Export to keep a copy or to move to another machine. ${lastBackup}`,
        }),
      ]),

      el('p.shortcut-note', {
        text: 'Ctrl+Shift+K captures a task from any page. Ctrl+Shift+U opens the side panel. / searches.',
      }),
    ]),
  ]);
}

function settingsGroup(title, children) {
  return el('section.setting-group', {}, [
    el('h2.group-title', { text: title }),
    ...children,
  ]);
}

function toggleRow(label, value, onChange) {
  return el('label.setting-row', {}, [
    el('span.setting-label', { text: label }),
    el('input.switch', {
      type: 'checkbox',
      checked: value,
      onchange: (event) => onChange(event.target.checked),
    }),
  ]);
}

/**
 * Ask the worker to raise a sample notification. If nothing appears, the
 * blocker is almost always Windows or Chrome permissions rather than the
 * extension, so the message says where to look.
 */
async function sendTestReminder(kind) {
  try {
    await chrome.runtime.sendMessage({ type: 'test-reminder', kind });
    state.testNote =
      'Sent. If nothing appeared, check Windows Settings → System → Notifications '
      + '— Google Chrome must be allowed, with "Play a sound" switched on, and '
      + 'Do not disturb off.';
  } catch (err) {
    state.testNote = `Could not reach the background worker: ${err.message}`;
  }
  render();
  clearTimeout(sendTestReminder.timer);
  sendTestReminder.timer = setTimeout(() => {
    state.testNote = null;
    if (state.view === 'settings') render();
  }, 15000);
}

async function exportData() {
  // An <a download> in an extension page saves without needing the "downloads"
  // permission, which keeps the install prompt to the essentials.
  const json = await store.exportJSON();
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const stamp = new Date().toISOString().slice(0, 10);
  const link = el('a', { href: url, download: `dual-backup-${stamp}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  await reload();
  render();
  toast('Backup saved to your downloads');
}

function importData() {
  const picker = el('input', { type: 'file', accept: 'application/json' });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      const count = await store.importJSON(await file.text());
      await reload();
      await repairMaintenance();
      render();
      toast(`Imported ${count.tasks} tasks and ${count.projects} projects`);
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  });
  picker.click();
}
