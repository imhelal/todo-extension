// Mounts the real UI in jsdom against a stubbed chrome API and drives it the
// way a person would: type, press Enter, tick a checkbox, open the editor.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body data-mode="popup"><div id="root"></div></body></html>',
  { url: 'https://localhost/', pretendToBeVisual: true },
);

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.alert = () => {};
globalThis.confirm = () => true;
if (!window.crypto) window.crypto = globalThis.crypto;

let copied = null;
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text) => { copied = text; } },
});

const sync = new Map();
const local = new Map();
const session = new Map();
const mapApi = (m) => ({
  async get(keys) {
    if (keys === null || keys === undefined) return Object.fromEntries(m);
    const out = {};
    for (const k of [].concat(keys)) if (m.has(k)) out[k] = m.get(k);
    return out;
  },
  async set(items) {
    for (const [k, v] of Object.entries(items)) m.set(k, v);
  },
  async remove(keys) {
    for (const k of [].concat(keys)) m.delete(k);
  },
});

globalThis.chrome = {
  storage: {
    sync: mapApi(sync),
    local: mapApi(local),
    session: mapApi(session),
    onChanged: { addListener() {} },
  },
  runtime: { sendMessage: async () => ({ ok: true }) },
};

// Today's brief card depends on the clock; it is held back until its own
// tests at the end, so earlier ones see the same list at any hour.
const todayKey = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
local.set('ui', { briefSeenOn: todayKey });

const { mount } = await import('../extension/src/ui/app.js');

const root = document.getElementById('root');
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 30));
// Completing a task plays a short exit animation before it commits.
const settle = () => new Promise((r) => setTimeout(r, 340));

let pass = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + (e.stack || e.message)); process.exitCode = 1; }
};

async function type(value) {
  const input = $('.composer-input');
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  return input;
}

async function submit(value) {
  const input = await type(value);
  input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await tick();
}

await mount(root, 'popup');
await tick();

await check('mounts with an empty state and the composer folded into a + button', () => {
  assert.match($('.empty-line').textContent, /Everything is clear/);
  assert.ok($('.composer'), 'composer is present');
  assert.ok(!$('.composer').classList.contains('is-open'), 'folded by default');
  assert.equal($('.composer-toggle').getAttribute('aria-label'), 'Add a task');
  assert.equal($('.composer-input').tabIndex, -1, 'the hidden input is out of the tab order');
});

await check('starting to type anywhere unfolds it, ready for the keystroke', async () => {
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'C', bubbles: true }));
  await tick();
  assert.ok($('.composer').classList.contains('is-open'));
  assert.equal(document.activeElement, $('.composer-input'), 'focus moved, so the letter lands in the input');
  assert.equal($('.composer-toggle').getAttribute('aria-label'), 'Close');
});

await check('Esc on an empty line folds it back', async () => {
  $('.composer-input').dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  await tick();
  assert.ok(!$('.composer').classList.contains('is-open'));
});

await check('the + button opens it and the × closes it', async () => {
  click($('.composer-toggle'));
  await tick();
  assert.ok($('.composer').classList.contains('is-open'));
  assert.equal(document.activeElement, $('.composer-input'));
  click($('.composer-toggle'));
  await tick();
  assert.ok(!$('.composer').classList.contains('is-open'));
});

await check('a keystroke in a field never hijacks focus', async () => {
  click($('.search-btn'));
  await tick();
  $('.search-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x', bubbles: true }));
  await tick();
  assert.ok(!$('.composer').classList.contains('is-open'), 'typing a search is just typing a search');
  click($('.search-btn'));
  await tick();
});

await check('preview shows how the typed line was understood', async () => {
  await type('Call supplier @business #urgent !tomorrow');
  const chips = $$('.preview .chip').map((c) => c.textContent);
  assert.ok(chips.includes('Business'), 'context chip');
  assert.ok(chips.includes('#urgent'), 'tag chip');
  assert.ok(chips.some((c) => /tomorrow/.test(c)), 'due chip');
});

await check('Enter adds the task and clears the composer', async () => {
  await submit('Call supplier @business #urgent !tomorrow');
  const titles = $$('.row-title').map((n) => n.textContent);
  assert.deepEqual(titles, ['Call supplier']);
  assert.equal($('.composer-input').value, '', 'composer resets for the next thought');
  assert.equal($('.preview-slot').textContent, '', 'preview clears too');
});

await check('a task lands in the right context and shows its tag', () => {
  const row = $('.row');
  assert.equal(row.dataset.context, 'business');
  assert.equal($('.row-meta .tag').textContent, '#urgent');
});

await check('the balance bar reflects both streams', async () => {
  await submit('Fix checkout bug @freelance');
  await submit('Write proposal @freelance');
  const segs = $$('.balance-seg');
  assert.equal(segs.length, 2, 'one segment per stream with open work');
  const grow = segs.map((s) => s.style.flexGrow);
  assert.deepEqual(grow, ['1', '2'], 'segments are weighted by open count');
  const counts = $$('.legend-count').map((n) => n.textContent);
  assert.deepEqual(counts, ['1', '2', '0'], 'the legend names all three streams');
});

await check('context tabs filter the list', async () => {
  const freelanceTab = $$('.tab').find((t) => t.dataset.context === 'freelance');
  click(freelanceTab);
  await tick();
  const titles = $$('.row-title').map((n) => n.textContent);
  assert.deepEqual(titles.sort(), ['Fix checkout bug', 'Write proposal']);
  assert.equal($('.tab.is-active').dataset.context, 'freelance');
});

await check('a new task inherits the selected tab as its context', async () => {
  await submit('Chase invoice');
  const row = $$('.row').find((r) => r.querySelector('.row-title').textContent === 'Chase invoice');
  assert.ok(row, 'task appears under the freelance tab');
  assert.equal(row.dataset.context, 'freelance');
  click($$('.tab').find((t) => t.dataset.context === 'all'));
  await tick();
});

await check('ticking the checkbox completes the task', async () => {
  const row = $$('.row').find((r) => r.querySelector('.row-title').textContent === 'Chase invoice');
  click(row.querySelector('.check'));
  assert.ok(
    row.classList.contains('is-completing'),
    'the row acknowledges the tick before it leaves',
  );
  await settle();
  assert.ok($('.section-head'), 'sections still render');
  const completedHead = $$('.section-label').find((n) => n.textContent === 'Completed');
  assert.ok(completedHead, 'a Completed section appears');
  const open = $$('.row-title').map((n) => n.textContent);
  assert.ok(!open.includes('Chase invoice'), 'it leaves the open list');
});

await check('completed tasks can be shown and reopened', async () => {
  click($('.section-toggle'));
  await tick();
  const doneRow = $$('.row.is-done').find(
    (r) => r.querySelector('.row-title').textContent === 'Chase invoice',
  );
  assert.ok(doneRow, 'completed task is listed');
  assert.equal(doneRow.querySelector('.check').getAttribute('aria-checked'), 'true');
  click(doneRow.querySelector('.check'));
  await tick();
  assert.ok(
    $$('.row:not(.is-done) .row-title').map((n) => n.textContent).includes('Chase invoice'),
    'reopening puts it back',
  );
});

await check('clicking a row opens the inline editor', async () => {
  const row = $$('.row').find((r) => r.querySelector('.row-title').textContent === 'Call supplier');
  click(row);
  await tick();
  assert.ok($('.editor'), 'editor is open');
  assert.equal($('.title-field').value, 'Call supplier');
  assert.equal($('.seg-btn.is-active').dataset.context, 'business');
});

await check('the open editor replaces the row, so the title is not shown twice', () => {
  assert.equal($$('.editor').length, 1);
  assert.equal($('.row-shell .row'), null, 'no read-only row above the editor');
  assert.equal($('.editor-head .check').getAttribute('aria-checked'), 'false');
});

await check('switching context in the editor moves the task', async () => {
  const freelanceBtn = $$('.editor .seg-btn').find((b) => b.dataset.context === 'freelance');
  click(freelanceBtn);
  await tick();
  assert.equal($('.row-shell').dataset.context, 'freelance');
  assert.equal($('.title-field').value, 'Call supplier', 'editor stays open on the same task');
});

await check('adding a step records a subtask', async () => {
  const subInput = $('.sub-add');
  subInput.value = 'Get the part number';
  subInput.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await tick();
  assert.equal($('.subtask-title').textContent, 'Get the part number');
});

await check('the collapsed row shows how many steps are left', async () => {
  const closeBtn = $$('.editor-actions .ghost-btn').find((b) => b.textContent === 'Close');
  click(closeBtn);
  await tick();
  assert.equal($('.editor'), null, 'editor closed');
  const row = $$('.row').find((r) => r.querySelector('.row-title').textContent === 'Call supplier');
  assert.equal(row.querySelector('.subcount').textContent, '1 left');
  click(row);
  await tick();
});

await check('tags render as removable pills, not a text box', async () => {
  const entry = $('.tag-entry');
  assert.ok(entry, 'there is an inline tag entry');
  entry.value = 'urgent';
  entry.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await tick();
  assert.deepEqual($$('.tag-pill span:first-child').map((n) => n.textContent), ['urgent']);
});

await check('a tag pill can be removed with its own button', async () => {
  click($('.tag-x'));
  await tick();
  assert.equal($$('.tag-pill').length, 0);
});

await check('typing a tag keeps the caret in the entry across the re-render', async () => {
  const entry = $('.tag-entry');
  entry.focus();
  entry.value = 'packing';
  entry.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await tick();
  assert.equal(
    document.activeElement.dataset.focusKey,
    'tag-entry',
    'focus returns to the tag entry so a second tag can be typed straight away',
  );
});

const pickChip = (label) => $$('.picks .pick').find((b) => b.textContent === label);

await check('the due date shows as a selected chip, with no date field in sight', () => {
  const labels = $$('.picks .pick').map((b) => b.textContent);
  assert.deepEqual(labels.slice(0, 3), ['Today', 'Tomorrow', 'Next week']);
  // This task was captured as "!tomorrow" in the very first test.
  assert.equal($('.pick.is-active').textContent, 'Tomorrow');
  assert.ok($('.date-field').hidden, 'the native date control stays out of the way');
});

await check('another chip moves the due date', async () => {
  click(pickChip('Today'));
  await tick();
  assert.equal($('.pick.is-active').textContent, 'Today');
  assert.ok($('.row-shell'), 'the editor stayed open on the same task');
});

await check('the selected chip pressed again clears the due date', async () => {
  click(pickChip('Today'));
  await tick();
  assert.equal($('.pick.is-active'), null, 'nothing is selected');
  assert.equal(pickChip('Clear'), undefined, 'and the Clear chip goes with it');
});

await check('Pick date reveals the exact control on demand', async () => {
  const pick = $$('.picks .pick').find((b) => b.textContent === 'Pick date');
  assert.equal(pick.getAttribute('aria-expanded'), 'false');
  click(pick);
  await tick();
  assert.equal($('.date-field').hidden, false, 'the exact field is shown');
  assert.equal(pick.getAttribute('aria-expanded'), 'true');
});

await check('setting a repeat persists on the task', async () => {
  const select = $$('.editor select.field').find((s) =>
    [...s.options].some((o) => o.value === 'week'),
  );
  select.value = 'week';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  const task = Object.values(local.get('tasks')).find((t) => t.title === 'Call supplier');
  assert.deepEqual(task.recur, { every: 'week', interval: 1 });
});

await check('deleting removes the task and closes the editor', async () => {
  click($('.ghost-btn.danger'));
  await tick();
  assert.equal($('.editor'), null, 'editor closed');
  assert.ok(
    !$$('.row-title').map((n) => n.textContent).includes('Call supplier'),
    'task is gone',
  );
});

await check('settings opens and toggles persist', async () => {
  click($('.settings-btn'));
  await tick();
  assert.equal($('.settings-title').textContent, 'Settings');
  const toggle = $$('.setting-row')
    .find((row) => row.textContent.includes('Periodic nudge'))
    .querySelector('.switch');
  assert.equal(toggle.checked, true, 'nudges start enabled');
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(local.get('settings').nudgeEnabled, false);
});

await check('theme choice is applied to the document', async () => {
  const darkBtn = $$('.theme-seg .seg-btn').find((b) => b.textContent === 'Dark');
  click(darkBtn);
  await tick();
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(local.get('settings').theme, 'dark');
});

await check('back returns to the task list', async () => {
  click($('.head-settings .icon-btn'));
  await tick();
  assert.ok($('.composer-input'), 'list view is back');
  assert.equal($('.settings-title'), null);
});

await check('only undated rows are draggable', async () => {
  await submit('Someday: rework the shop about page');
  await submit('Someday: tidy the invoice template');
  const rows = $$('.row');
  const undated = rows.filter((r) => !r.querySelector('.due'));
  const dated = rows.filter((r) => r.querySelector('.due'));
  assert.ok(undated.length >= 2, 'undated tasks exist');
  assert.ok(undated.every((r) => r.getAttribute('draggable') === 'true'));
  assert.ok(
    dated.every((r) => r.getAttribute('draggable') !== 'true'),
    'dated rows are not draggable, since the due date decides their order',
  );
});

await check('dragging an undated task onto another reorders it', async () => {
  const titlesOf = () =>
    $$('.group[data-section="none"] .row-title').map((n) => n.textContent);
  const before = titlesOf();
  assert.ok(before.length >= 2);

  const rows = $$('.group[data-section="none"] .row');
  const data = new Map();
  const dt = {
    effectAllowed: '',
    dropEffect: '',
    setData: (k, v) => data.set(k, v),
    getData: (k) => data.get(k) || '',
  };
  const fire = (node, type) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    ev.dataTransfer = dt;
    node.dispatchEvent(ev);
  };

  fire(rows[1], 'dragstart');   // pick up the second
  fire(rows[0], 'dragover');
  fire(rows[0], 'drop');        // drop it on the first
  await tick();

  assert.deepEqual(
    titlesOf(),
    [before[1], before[0], ...before.slice(2)],
    'the dragged task took the first slot and the rest held their order',
  );
});

await check('the new order survives a reload from storage', async () => {
  const expected = $$('.group[data-section="none"] .row-title').map((n) => n.textContent);
  root.textContent = '';
  await mount(root, 'popup');
  await tick();
  assert.deepEqual(
    $$('.group[data-section="none"] .row-title').map((n) => n.textContent),
    expected,
  );
});

await check('task text is never interpreted as markup', async () => {
  await submit('<img src=x onerror=alert(1)> review');
  const row = $$('.row-title').find((n) => /review/.test(n.textContent));
  assert.ok(row, 'the task was created');
  assert.equal(row.querySelector('img'), null, 'no element was parsed out of the text');
  assert.match(row.textContent, /^<img src=x onerror=alert\(1\)> review$/);
});

// --- projects ----------------------------------------------------------------

const input = (node, value) => {
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const enter = (node) =>
  node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
const navTo = async (view) => {
  click($$('.nav-btn').find((b) => b.dataset.view === view));
  await tick();
};
const button = (text) => $$('button').find((b) => b.textContent.trim() === text);
const toastWith = (pattern) => [...document.querySelectorAll('.toast')].find((t) => pattern.test(t.textContent));
const storedTasks = () => Object.values(local.get('tasks'));
const storedProject = () => Object.values(local.get('projects'))[0];

await check('the Projects tab invites you to add your first site', async () => {
  await navTo('projects');
  assert.equal($('.nav-btn.is-active').dataset.view, 'projects');
  assert.match($('.empty-line').textContent, /No client sites yet/);
});

await check('a project needs a name before it saves', async () => {
  click(button('Add your first site'));
  await tick();
  assert.equal($('.detail-name').textContent, 'New project');
  assert.equal($$('.list-item').length, 8, 'the default checklist is filled in');
  click(button('Add project'));
  await tick();
  assert.match($('.form-error').textContent, /name/);
});

await check('saving a project opens its page with one run scheduled', async () => {
  input($('[data-focus-key="pf-name"]'), 'Acme Bakery');
  input($('[data-focus-key="pf-url"]'), 'acmebakery.com');
  click(button('WordPress'));
  await tick();
  assert.equal($('[data-focus-key="pf-name"]').value, 'Acme Bakery', 'typing survives the re-render');
  input($('.input-suffix .field'), '5');
  click(button('Add project'));
  await tick();
  assert.equal($('.detail-name').textContent, 'Acme Bakery');
  assert.match($('.detail-sub').textContent, /acmebakery\.com · WordPress/);
  assert.equal($$('.maint-card .step').length, 8);
  assert.equal(storedTasks().filter((t) => t.kind === 'maint').length, 1);
  assert.equal(storedProject().retainerHours, 5);
});

await check('ticking a checklist step saves it and moves the ring', async () => {
  click($$('.maint-card .step .check')[0]);
  await tick();
  assert.ok($$('.maint-card .step')[0].classList.contains('is-done'));
  assert.equal($('.maint-card .ring-label').textContent, '1/8');
});

await check('tasks and feature requests are added on the project page', async () => {
  let field = $$('.inline-add')[0];
  input(field, 'Fix the contact form !tomorrow');
  enter(field);
  await tick();
  field = $$('.inline-add')[1];
  input(field, 'Add a wishlist');
  enter(field);
  await tick();
  const mine = storedTasks().filter((t) => t.projectId === storedProject().id && t.kind !== 'maint');
  assert.deepEqual(
    mine.map((t) => [t.title, t.kind]).sort(),
    [['Add a wishlist', 'feature'], ['Fix the contact form', 'task']],
  );
  assert.ok(mine.find((t) => t.kind === 'task').due, 'quick-add tokens work here too');
  assert.ok(mine.every((t) => t.context === 'freelance'));
});

await check('time is logged against the retainer', async () => {
  click(button('+30m'));
  await tick();
  click(button('+1h'));
  await tick();
  assert.equal($('.time-card .card-figure').textContent, '1h 30m of 5h');
  assert.equal($$('.time-entry').length, 2);
  const custom = $('.time-input');
  custom.value = '45m';
  enter(custom);
  await tick();
  assert.equal($('.time-card .card-figure').textContent, '2h 15m of 5h');
});

await check('the timer starts, shows as running, and logs nothing under a minute', async () => {
  click(button('Start timer'));
  await tick();
  assert.ok($('.timer-btn.is-running'));
  click($('.timer-btn'));
  await tick();
  assert.equal($('.timer-btn.is-running'), null);
  assert.ok(toastWith(/under a minute/));
});

await check('completing maintenance logs it, and the report says so', async () => {
  const complete = button('Tick all & complete');
  assert.ok(complete, 'steps remain, so the button offers to tick them');
  click(complete);
  await settle();
  assert.equal($('.maint-card').dataset.state, 'done');
  assert.equal(storedProject().log.length, 1);
  assert.equal(storedProject().log[0].items.length, 8);
  assert.equal($$('.history-item').length, 1);
  const report = $('.report-preview').textContent;
  assert.match(report, /Monthly maintenance — completed/);
  assert.match(report, /Time: 2\.25 hours of 5 included/);
  assert.equal(storedTasks().filter((t) => t.kind === 'maint' && !t.done).length, 1, 'next month is scheduled');
});

await check('the report copies to the clipboard', async () => {
  click(button('Copy report'));
  await tick();
  assert.match(copied, /^Acme Bakery — website care report/);
});

await check('Undo restores the run exactly, and takes back next month', async () => {
  click(toastWith(/maintenance logged/).querySelector('.toast-btn'));
  await tick();
  assert.equal(storedProject().log.length, 0);
  const open = storedTasks().filter((t) => t.kind === 'maint' && !t.done);
  assert.equal(open.length, 1, 'still exactly one run open');
  assert.equal(open[0].subtasks.filter((s) => s.done).length, 1, 'back to the one step that was ticked');
  assert.notEqual($('.maint-card').dataset.state, 'done');
});

await check('a checklist edit is carried onto the open run, keeping ticks', async () => {
  click($('.edit-btn'));
  await tick();
  const add = $('.list-add');
  add.value = 'Check the cookie banner';
  enter(add);
  await tick();
  assert.equal($$('.list-item').length, 9);
  click(button('Save changes'));
  await tick();
  const steps = $$('.maint-card .step');
  assert.equal(steps.length, 9);
  assert.ok(steps[0].classList.contains('is-done'), 'the tick survived');
  assert.equal(steps[8].textContent, 'Check the cookie banner');
});

await check('the project shows on the Projects list under the month overview', async () => {
  click($('.back-btn'));
  await tick();
  assert.equal($$('.pcard').length, 1);
  assert.equal($('.pcard-name').textContent, 'Acme Bakery');
  assert.ok($('.overview'));
});

await check('+client in quick-add files a task under the project', async () => {
  await navTo('tasks');
  await type('Swap the hero image +acme');
  assert.ok($$('.preview .chip').some((c) => c.textContent === 'Acme Bakery'), 'the preview names the client');
  await submit('Swap the hero image +acme');
  const task = storedTasks().find((t) => t.title === 'Swap the hero image');
  assert.equal(task.projectId, storedProject().id);
  assert.equal(task.context, 'freelance');
  const row = $$('.row').find((r) => r.querySelector('.row-title').textContent === 'Swap the hero image');
  assert.equal(row.querySelector('.proj-chip-name').textContent, 'Acme Bakery');
});

await check('search finds tasks by their client\'s name', async () => {
  click($('.search-btn'));
  await tick();
  input($('.search-input'), 'bakery');
  await tick();
  const titles = $$('.row-title').map((n) => n.textContent);
  assert.ok(titles.includes('Swap the hero image'));
  assert.ok(!titles.includes('Fix checkout bug'), 'unrelated tasks are filtered out');
  click($('.search-btn'));
  await tick();
  assert.equal($('.search-input'), null);
});

await check('personal tasks have their own stream and tab', async () => {
  await submit('Book the dentist @personal');
  click($$('.tab').find((t) => t.dataset.context === 'personal'));
  await tick();
  assert.deepEqual($$('.row-title').map((n) => n.textContent), ['Book the dentist']);
  assert.equal($('.row').dataset.context, 'personal');
  click($$('.tab').find((t) => t.dataset.context === 'all'));
  await tick();
});

await check('opening the popup on a client\'s site files new tasks there', async () => {
  chrome.tabs = { query: async () => [{ url: 'https://www.acmebakery.com/menu' }] };
  root.textContent = '';
  await mount(root, 'popup');
  await tick();
  assert.equal($('.spot-name').textContent, 'Acme Bakery');
  assert.equal($('.composer-input').placeholder, 'Add to Acme Bakery…');
  await submit('Update opening hours');
  assert.equal(storedTasks().find((t) => t.title === 'Update opening hours').projectId, storedProject().id);
});

await check('dismissing the site card stops filing there', async () => {
  click($('.spot-x'));
  await tick();
  assert.equal($('.spot'), null);
  await submit('Call the bank');
  assert.equal(storedTasks().find((t) => t.title === 'Call the bank').projectId, null);
  delete chrome.tabs;
});

await check('deleting a project takes two clicks, and Undo brings it all back', async () => {
  await navTo('projects');
  click($('.pcard'));
  await tick();
  click($('.edit-btn'));
  await tick();
  click(button('Delete project'));
  await tick();
  assert.ok(button('Click again to delete for good'), 'the first click only arms it');
  assert.equal(Object.keys(local.get('projects')).length, 1);
  click(button('Click again to delete for good'));
  await tick();
  assert.equal(Object.keys(local.get('projects')).length, 0);
  assert.equal(storedTasks().filter((t) => t.projectId).length, 0, 'its tasks went with it');

  click(toastWith(/deleted/).querySelector('.toast-btn'));
  await tick();
  assert.equal(Object.keys(local.get('projects')).length, 1);
  assert.ok(storedTasks().some((t) => t.title === 'Swap the hero image'));
});

// --- priority ----------------------------------------------------------------

const rowOf = (title) => $$('.row').find((r) => r.querySelector('.row-title').textContent === title);
const priorityTitles = () => $$('.group[data-section="priority"] .row-title').map((n) => n.textContent);

await check('!! flags a task as it is added, and Priority leads the list', async () => {
  await navTo('tasks');
  await type('Chase the overdue invoice !!');
  assert.ok($$('.preview .chip').some((c) => c.textContent === 'Priority'), 'the preview says so');
  await submit('Chase the overdue invoice !!');
  assert.equal($('.section-head').dataset.section, 'priority', 'Priority is the first section');
  const row = rowOf('Chase the overdue invoice');
  assert.ok(row.classList.contains('is-priority'));
  assert.equal(row.querySelector('.flag-btn').getAttribute('aria-pressed'), 'true');
});

await check('the flag on a row lifts it into Priority, and back out', async () => {
  click(rowOf('Book the dentist').querySelector('.flag-btn'));
  await tick();
  assert.equal($('.editor'), null, 'flagging does not open the editor');
  assert.ok(priorityTitles().includes('Book the dentist'));
  click(rowOf('Book the dentist').querySelector('.flag-btn'));
  await tick();
  assert.ok(!priorityTitles().includes('Book the dentist'));
});

await check('the editor carries the flag too', async () => {
  click(rowOf('Call the bank'));
  await tick();
  click($('.editor-head .flag-btn'));
  await tick();
  assert.equal(storedTasks().find((t) => t.title === 'Call the bank').priority, true);
  click(button('Close'));
  await tick();
  assert.ok(priorityTitles().includes('Call the bank'));
});

// --- the morning brief ---------------------------------------------------------

await check('the brief is on by default at 09:00, and its time can be changed', async () => {
  click($('.settings-btn'));
  await tick();
  const row = $$('.setting-row').find((r) => r.textContent.includes('Send a brief each day'));
  assert.equal(row.querySelector('.switch').checked, true);
  const time = $$('select').find((s) => s.getAttribute('aria-label') === 'Brief time');
  assert.equal(time.value, '540');
  time.value = '0'; // midnight, so "its time has come" holds whenever this runs
  time.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(local.get('settings').briefAt, 0);
  click($('.head-settings .icon-btn'));
  await tick();
});

await check('once its time has come, today\'s brief is a card at the top of the list', async () => {
  local.set('ui', { ...local.get('ui'), briefSeenOn: '' });
  root.textContent = '';
  await mount(root, 'popup');
  await tick();
  assert.ok($('.brief'));
  assert.match($('.brief-greet').textContent, /^Good (morning|afternoon|evening)$/);
  const stat = (label) =>
    $$('.brief-stat').find((s) => s.textContent.includes(label)).querySelector('.brief-num').textContent;
  assert.equal(stat('Priority'), '2');
  const focus = $$('.brief-item-title').map((n) => n.textContent);
  assert.ok(focus.includes('Chase the overdue invoice') && focus.includes('Call the bank'), 'flagged work comes first');
});

await check('a task in the brief opens in place', async () => {
  click($$('.brief-item').find((b) => b.textContent.includes('Call the bank')));
  await tick();
  assert.equal($('.title-field').value, 'Call the bank');
  click(button('Close'));
  await tick();
});

await check('dismissing the brief keeps it away for the rest of the day', async () => {
  click($('.brief-x'));
  await tick();
  assert.equal($('.brief'), null);
  assert.equal(local.get('ui').briefSeenOn, todayKey);
  root.textContent = '';
  await mount(root, 'popup');
  await tick();
  assert.equal($('.brief'), null);
});

console.log(`\n${pass} checks passed`);
