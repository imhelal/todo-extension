// Presentational builders. Every one returns a detached DOM node.
//
// Task text is user content and is always set via textContent — never
// innerHTML — which keeps the extension trivially CSP-clean.

import { hueOf, initials } from '../lib/projects.js';
import { CONTEXTS, CONTEXT_LABEL, parseDueToken } from '../lib/tasks.js';
import { relativeDue, startOfDay, toDatetimeLocal } from '../lib/time.js';

/** el('div.row', { onclick }, [child, 'text']) */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('html is not allowed; use text');
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }

  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Inline SVG: no icon font, no remote fetch. Shapes are kept to straight runs
// and wide arcs so they stay crisp at 13–15px rather than turning to mush.
const ICONS = {
  sliders: ['M5 20v-6M5 10V4M12 20v-9M12 7V4M19 20v-4M19 12V4', 'M2 14h6M9 7h6M16 16h6'],
  back: ['M15 5l-7 7 7 7'],
  plus: ['M12 5v14M5 12h14'],
  trash: ['M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13'],
  chevron: ['M6 9.5l6 6 6-6'],
  'chevron-right': ['M9.5 6l6 6-6 6'],
  'arrow-up': ['M12 19V5M5 12l7-7 7 7'],
  x: ['M6 6l12 12M18 6L6 18'],
  repeat: ['M4 9a5 5 0 0 1 5-5h11M20 4l-3-3M20 4l-3 3', 'M20 15a5 5 0 0 1-5 5H4M4 20l3-3M4 20l3 3'],
  search: ['M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M20 20l-4.8-4.8'],
  list: ['M9 6h11M9 12h11M9 18h11', 'M4 6h1M4 12h1M4 18h1'],
  layers: ['M12 3.5l8.5 4.5-8.5 4.5L3.5 8 12 3.5z', 'M3.5 12.5l8.5 4.5 8.5-4.5', 'M3.5 16.5l8.5 4.5 8.5-4.5'],
  external: ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
  play: ['M8 5.5v13l10-6.5-10-6.5z'],
  stop: ['M7 7h10v10H7z'],
  clock: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M12 7.5V12l3 2'],
  pencil: ['M4 20h4L19 9l-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  shield: ['M12 3l7.5 3v5.5c0 4.6-3.1 7.8-7.5 9.5-4.4-1.7-7.5-4.9-7.5-9.5V6L12 3z', 'M8.8 12l2.2 2.2 4.2-4.4'],
  sparkle: ['M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9-1.9 5.6-1.9-5.6-5.6-1.9 5.6-1.9L12 3.5z'],
  copy: ['M9 9h10.5v11H9z', 'M5 15.5V4h10.5'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  calendar: ['M4.5 6h15v14h-15z', 'M4.5 10.5h15', 'M8.5 3.5v4M15.5 3.5v4'],
  history: ['M4.5 12a7.5 7.5 0 1 0 2.2-5.3', 'M4.5 4.5v3.5H8', 'M12 8v4l2.8 1.8'],
  note: ['M6 3.5h8.5l4 4v13H6z', 'M14 3.5V8h4.5', 'M9 12.5h6M9 16h4'],
  globe: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M3.5 12h17', 'M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z'],
  pause: ['M9 6v12M15 6v12'],
  flag: ['M5.5 21V4.5', 'M5.5 4.5h11.5l-2.5 4.25L17 13H5.5'],
  sun: ['M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z', 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4'],
};

export function icon(name, extraClass = '') {
  const svg = svgNode('svg', {
    viewBox: '0 0 24 24',
    class: 'icon' + (extraClass ? ' ' + extraClass : ''),
    'aria-hidden': 'true',
  });
  for (const d of ICONS[name] || []) svg.append(svgNode('path', { d }));
  return svg;
}

/** A client's initials on their own colour, so each site is recognisable at a glance. */
export function avatar(project, size = 'md') {
  return el('span.avatar', {
    className: `avatar avatar-${size}`,
    style: `--hue:${hueOf(project.name)}`,
    'aria-hidden': 'true',
    text: initials(project.name),
  });
}

/**
 * A circular progress ring. `morph` names it so a re-render can glide from the
 * previous value instead of jumping; the first showing fills from empty.
 */
export function progressRing({ value, max, size = 44, stroke = 4, label, morph, context }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max ? Math.min(1, value / max) : 0;
  const svg = svgNode('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' });
  svg.append(svgNode('circle', { class: 'ring-track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke }));
  const fill = svgNode('circle', {
    class: 'ring-fill',
    cx: size / 2,
    cy: size / 2,
    r,
    'stroke-width': stroke,
    'stroke-dasharray': c.toFixed(2),
    style: `stroke-dashoffset:${(c * (1 - pct)).toFixed(2)}`,
  });
  if (morph) {
    fill.dataset.morph = morph;
    fill.dataset.morphProp = 'strokeDashoffset';
    fill.dataset.morphFrom = c.toFixed(2);
  }
  svg.append(fill);
  return el('span.ring', {
    dataset: context ? { context } : {},
    className: 'ring' + (pct >= 1 ? ' is-full' : ''),
    style: `--size:${size}px`,
  }, [svg, label != null ? el('span.ring-label', { text: label }) : null]);
}

/**
 * The balance bar: one rail split proportionally by open count across the
 * streams. A stream with nothing open collapses to nothing; one that has gone
 * untouched past the stale threshold is hatched, so neglect is visible before
 * you read a single word.
 */
export function balanceBar(summary, { onPick, active } = {}) {
  const total = summary.reduce((sum, s) => sum + s.open, 0);

  const rail = el('div.balance-rail', {
    role: 'img',
    'aria-label': total
      ? summary.map((s) => `${s.label}: ${s.open} open`).join(', ')
      : 'Nothing open',
  });

  if (!total) {
    rail.append(el('div.balance-seg.is-empty'));
  } else {
    for (const s of summary) {
      if (!s.open) continue;
      const stale = s.staleDays != null && s.staleDays >= (s.threshold ?? 2);
      rail.append(
        el('div.balance-seg', {
          dataset: { context: s.context, morph: `bal-${s.context}`, morphProp: 'flexGrow', morphFrom: '0' },
          style: `flex-grow:${s.open}`,
          className: 'balance-seg' + (stale ? ' is-stale' : ''),
        }),
      );
    }
  }

  const legend = el('div.balance-legend');
  for (const s of summary) {
    const stale = s.open > 0 && s.staleDays != null && s.staleDays >= (s.threshold ?? 2);
    legend.append(
      el(
        'button.legend-item',
        {
          type: 'button',
          dataset: { context: s.context },
          className: 'legend-item' + (active === s.context ? ' is-active' : ''),
          title: `Show ${s.label}`,
          onclick: () => onPick && onPick(s.context),
        },
        [
          el('span.dot', { dataset: { context: s.context } }),
          el('span.legend-label', { text: s.label }),
          el('span.legend-count', { text: String(s.open) }),
          s.overdue ? el('span.legend-late', { text: `${s.overdue} late` }) : null,
          stale
            ? el('span.legend-stale', {
                text: s.staleDays === 1 ? 'quiet 1d' : `quiet ${s.staleDays}d`,
              })
            : null,
        ],
      ),
    );
  }

  return el('section.balance', {}, [rail, legend]);
}

/**
 * A row of options with a raised pill that slides to the active one. The pill
 * is a separate `.ink` element positioned after render (see app.js placeInk),
 * because the DOM is rebuilt on every render and CSS alone cannot carry a
 * transition across that.
 */
function inkGroup(spec, key, children) {
  return el(spec, { role: 'tablist', dataset: { ink: key } }, [el('span.ink', { 'aria-hidden': 'true' }), ...children]);
}

export function contextTabs(active, counts, onSelect) {
  const tabs = [
    { key: 'all', label: 'All' },
    ...CONTEXTS.map((c) => ({ key: c, label: CONTEXT_LABEL[c] })),
  ];

  return inkGroup(
    'nav.tabs',
    'context',
    tabs.map((tab) =>
      el(
        'button.tab',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(tab.key === active),
          dataset: { context: tab.key },
          className: 'tab' + (tab.key === active ? ' is-active' : ''),
          onclick: () => onSelect(tab.key),
        },
        [
          el('span', { text: tab.label }),
          counts[tab.key] ? el('span.tab-count', { text: String(counts[tab.key]) }) : null,
        ],
      ),
    ),
  );
}

/** The top-level switch between the task list and the client projects. */
export function viewNav(active, onSelect, badges = {}) {
  const items = [
    { key: 'tasks', label: 'Tasks', icon: 'list' },
    { key: 'projects', label: 'Projects', icon: 'layers' },
  ];
  return inkGroup(
    'nav.nav',
    'view',
    items.map((item) =>
      el('button.nav-btn', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(item.key === active),
        className: 'nav-btn' + (item.key === active ? ' is-active' : ''),
        dataset: { view: item.key },
        onclick: () => onSelect(item.key),
      }, [
        icon(item.icon),
        el('span', { text: item.label }),
        badges[item.key] ? el('span.nav-badge', { text: String(badges[item.key]) }) : null,
      ]),
    ),
  );
}

/** Chips above the quick-add input showing how the line was understood. */
export function parsePreview(parsed, { onClearProject } = {}) {
  const chips = el('div.preview');
  chips.append(
    el('span.chip.chip-context', {
      dataset: { context: parsed.context },
      text: CONTEXT_LABEL[parsed.context],
    }),
  );
  if (parsed.projectName) {
    chips.append(
      el('span.chip.chip-project', { style: `--hue:${hueOf(parsed.projectName)}` }, [
        el('span.chip-dot'),
        el('span', { text: parsed.projectName }),
        !parsed.projectExplicit && onClearProject
          ? el('button.chip-x', {
              type: 'button',
              'aria-label': `Don't file under ${parsed.projectName}`,
              onclick: onClearProject,
            }, [icon('x')])
          : null,
      ]),
    );
  }
  if (parsed.priority) chips.append(el('span.chip.chip-priority', {}, [icon('flag'), el('span', { text: 'Priority' })]));
  for (const tag of parsed.tags) chips.append(el('span.chip', { text: '#' + tag }));
  if (parsed.due) chips.append(el('span.chip.chip-due', { text: relativeDue(parsed.due) }));
  return chips;
}

export function sectionHeader(label, count, extra, key) {
  return el('div.section-head', { dataset: key ? { section: key } : {} }, [
    el('span.section-label', { text: label }),
    count != null ? el('span.section-count', { text: String(count) }) : null,
    el('span.section-rule'),
    extra || null,
  ]);
}

/** A round check whose tick is drawn on, tinted to the task's stream. */
export function checkbox(task, onToggle, extraClass = '') {
  const mark = svgNode('svg', { viewBox: '0 0 24 24', class: 'check-mark', 'aria-hidden': 'true' });
  mark.append(svgNode('path', { d: 'M6.5 12.5l3.6 3.6 7.4-7.6' }));
  return el('button.check' + extraClass, {
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(task.done),
    'aria-label': task.done ? 'Reopen task' : 'Mark done',
    dataset: { context: task.context },
    onclick: (event) => {
      event.stopPropagation();
      onToggle(task);
    },
  }, [mark]);
}

/**
 * The priority flag. Always shown on a flagged task; on the rest it appears on
 * hover, so marking something urgent is one click from the list.
 */
export function flagButton(task, onFlag) {
  return el('button.flag-btn', {
    type: 'button',
    className: 'flag-btn' + (task.priority ? ' is-on' : ''),
    'aria-pressed': String(Boolean(task.priority)),
    'aria-label': task.priority ? 'Remove priority' : 'Mark as priority',
    title: task.priority ? 'Remove priority' : 'Mark as priority',
    onclick: (event) => {
      event.stopPropagation();
      onFlag(task);
    },
  }, [icon('flag')]);
}

export function projectChip(project) {
  return el('span.proj-chip', { style: `--hue:${hueOf(project.name)}` }, [
    el('span.chip-dot'),
    el('span.proj-chip-name', { text: project.name }),
  ]);
}

export function taskRow(task, { expanded, onToggle, onOpen, onFlag, drag, project, index = 0 }) {
  const check = checkbox(task, onToggle);

  const meta = el('div.row-meta');
  if (project) meta.append(projectChip(project));
  if (task.kind === 'feature') meta.append(el('span.kind-chip', {}, [icon('sparkle'), el('span', { text: 'Feature' })]));
  for (const tag of task.tags.slice(0, 3)) meta.append(el('span.tag', { text: '#' + tag }));
  if (task.recur) meta.append(icon('repeat'));
  const openSubs = task.subtasks.filter((s) => !s.done).length;
  if (openSubs) meta.append(el('span.subcount', { text: `${openSubs} left` }));

  const due = task.due
    ? el('span.due', {
        dataset: { state: task.due < Date.now() && !task.done ? 'late' : 'ok' },
        text: relativeDue(task.due),
      })
    : null;

  // Only undated tasks are draggable: everywhere else the due date decides the
  // order, so a drag would appear to do nothing.
  const dragProps = drag
    ? {
        draggable: true,
        ondragstart: (event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', task.id);
          drag.onStart(task.id);
          event.currentTarget.classList.add('is-dragging');
        },
        ondragover: (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          event.currentTarget.classList.add('is-drop-target');
        },
        ondragleave: (event) => event.currentTarget.classList.remove('is-drop-target'),
        ondrop: (event) => {
          event.preventDefault();
          event.currentTarget.classList.remove('is-drop-target');
          drag.onDrop(event.dataTransfer.getData('text/plain') || drag.currentId, task.id);
        },
        ondragend: (event) => {
          event.currentTarget.classList.remove('is-drop-target', 'is-dragging');
        },
      }
    : {};

  return el(
    'article.row',
    {
      dataset: { context: task.context, id: task.id, flip: task.id },
      className:
        'row' + (task.done ? ' is-done' : '') + (expanded ? ' is-expanded' : '')
        + (task.priority && !task.done ? ' is-priority' : ''),
      style: `--i:${Math.min(index, 14)}`,
      tabIndex: 0,
      onclick: () => onOpen(task),
      onkeydown: (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(task);
        }
      },
      ...dragProps,
    },
    [
      check,
      el('div.row-body', {}, [
        el('div.row-title', {}, [el('span.strike', { text: task.title })]),
        meta.childNodes.length ? meta : null,
      ]),
      due,
      onFlag && !task.done ? flagButton(task, onFlag) : null,
    ],
  );
}

const RECUR_OPTIONS = [
  { value: '', label: 'Does not repeat' },
  { value: 'day', label: 'Every day' },
  { value: 'week', label: 'Every week' },
  { value: 'month', label: 'Every month' },
];

/**
 * A <select> with the OS arrow suppressed and our own chevron drawn over it.
 * The native popup is kept — it is the only one that behaves correctly inside
 * a 380px popup — but the closed control matches the rest of the form.
 */
export function selectField(props, options) {
  return el('div.select-wrap', {}, [
    el('select.field.select', props, options),
    icon('chevron'),
  ]);
}

const DUE_PRESETS = [
  { label: 'Today', token: 'today' },
  { label: 'Tomorrow', token: 'tomorrow' },
  { label: 'Next week', token: '1w' },
];

/**
 * Due date as one-tap chips over an exact picker. Setting a date is the common
 * case and should not require driving a date field; the picker stays for when
 * a specific time actually matters.
 */
function dueField(task, onPatch) {
  const now = Date.now();
  const presets = DUE_PRESETS.map((p) => ({ ...p, ts: parseDueToken(p.token, now) }));
  const matched = task.due != null
    ? presets.find((p) => startOfDay(p.ts) === startOfDay(task.due))
    : null;
  const isCustom = task.due != null && !matched;

  // The native date control is the one genuinely dated-looking part of the
  // form, so it stays hidden unless a preset will not do.
  const exact = el('input.field.date-field', {
    type: 'datetime-local',
    value: toDatetimeLocal(task.due),
    'aria-label': 'Exact due date and time',
    dataset: { focusKey: 'due-exact' },
    hidden: !isCustom,
    onchange: (event) => onPatch({ dueLocal: event.target.value }),
  });

  const chips = presets.map(({ label, ts }) => {
    const active = matched != null && matched.ts === ts;
    return el('button.pick', {
      type: 'button',
      'aria-pressed': String(active),
      className: 'pick' + (active ? ' is-active' : ''),
      text: label,
      onclick: () => onPatch({ dueLocal: active ? '' : toDatetimeLocal(ts) }),
    });
  });

  if (isCustom) {
    chips.push(
      el('span.pick.is-active.pick-custom', {
        text: new Date(task.due).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        }),
      }),
    );
  }

  chips.push(
    el('button.pick.pick-exact', {
      type: 'button',
      text: isCustom ? 'Edit' : 'Pick date',
      'aria-expanded': String(isCustom),
      onclick: (event) => {
        exact.hidden = !exact.hidden;
        event.currentTarget.setAttribute('aria-expanded', String(!exact.hidden));
        if (!exact.hidden) exact.focus();
      },
    }),
  );

  if (task.due != null) {
    chips.push(
      el('button.pick.pick-clear', {
        type: 'button',
        'aria-label': 'Clear the due date',
        text: 'Clear',
        onclick: () => onPatch({ dueLocal: '' }),
      }),
    );
  }

  return el('div.due-field', {}, [el('div.picks', {}, chips), exact]);
}

/**
 * Tags as removable pills with an inline entry, rather than a text box the
 * user has to space-separate by hand. Enter or comma commits; Backspace on an
 * empty entry removes the last pill.
 */
function tagField(task, onPatch) {
  const commit = (input) => {
    const value = input.value.trim().replace(/^#/, '').toLowerCase();
    input.value = '';
    if (!value || task.tags.includes(value)) return;
    onPatch({ tags: [...task.tags, value] });
  };

  const pills = task.tags.map((tag) =>
    el('span.tag-pill', {}, [
      el('span', { text: tag }),
      el(
        'button.tag-x',
        {
          type: 'button',
          'aria-label': `Remove tag ${tag}`,
          onclick: () => onPatch({ tags: task.tags.filter((t) => t !== tag) }),
        },
        [icon('x')],
      ),
    ]),
  );

  const entry = el('input.tag-entry', {
    type: 'text',
    placeholder: task.tags.length ? 'Add another' : 'Add a tag',
    'aria-label': 'Add a tag',
    autocomplete: 'off',
    dataset: { focusKey: 'tag-entry' },
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        commit(event.target);
      } else if (event.key === 'Backspace' && !event.target.value && task.tags.length) {
        onPatch({ tags: task.tags.slice(0, -1) });
      }
    },
    onblur: (event) => commit(event.target),
  });

  return el('div.tag-input', { onclick: () => entry.focus() }, [...pills, entry]);
}

/** Segmented single choice. `context` tints the active option by stream. */
export function segmented(options, value, onPick, { label, className = '' } = {}) {
  return el(
    'div.seg' + (className ? '.' + className : ''),
    { role: 'radiogroup', 'aria-label': label },
    options.map((opt) =>
      el('button.seg-btn', {
        type: 'button',
        role: 'radio',
        'aria-checked': String(value === opt.value),
        dataset: opt.context ? { context: opt.context } : {},
        className: 'seg-btn' + (value === opt.value ? ' is-active' : ''),
        text: opt.label,
        onclick: () => onPick(opt.value),
      }),
    ),
  );
}

/**
 * Inline editor, opened by clicking a row. Narrow surfaces make modals worse.
 * It replaces the row rather than sitting under it, so the title is not shown
 * twice — the editable field is the row.
 */
export function taskEditor(task, handlers) {
  const {
    onPatch, onDelete, onClose, onToggle,
    onAddSubtask, onToggleSubtask, onRemoveSubtask,
    projects = [],
  } = handlers;
  const onFlag = () => onPatch({ priority: !task.priority });

  const contextPicker = segmented(
    CONTEXTS.map((c) => ({ value: c, label: CONTEXT_LABEL[c], context: c })),
    task.context,
    (c) => onPatch({ context: c }),
    { label: 'Context' },
  );

  const recurSelect = selectField(
    {
      'aria-label': 'Repeat',
      onchange: (event) =>
        onPatch({ recur: event.target.value ? { every: event.target.value, interval: 1 } : null }),
    },
    RECUR_OPTIONS.map((opt) =>
      el('option', { value: opt.value, text: opt.label, selected: task.recur?.every === opt.value }),
    ),
  );

  // Maintenance runs belong to their site for good; everything else can be
  // filed under a project, and joins that project's stream when it is.
  const isMaint = task.kind === 'maint';
  const projectField = !isMaint && projects.length
    ? el('label.field-label', {}, [
        'Project',
        selectField(
          {
            'aria-label': 'Project',
            onchange: (event) => {
              const project = projects.find((p) => p.id === event.target.value);
              onPatch(project
                ? { projectId: project.id, context: project.context }
                : { projectId: null, kind: 'task' });
            },
          },
          [
            el('option', { value: '', text: 'No project', selected: !task.projectId }),
            ...projects.map((p) =>
              el('option', { value: p.id, text: p.name, selected: task.projectId === p.id }),
            ),
          ],
        ),
      ])
    : null;

  const kindField = !isMaint && task.projectId
    ? segmented(
        [
          { value: 'task', label: 'Task' },
          { value: 'feature', label: 'Feature request' },
        ],
        task.kind === 'feature' ? 'feature' : 'task',
        (kind) => onPatch({ kind }),
        { label: 'Type', className: 'kind-seg' },
      )
    : null;

  const notes = el('textarea.field.notes', {
    value: task.notes,
    rows: 3,
    placeholder: 'Add a note',
    'aria-label': 'Notes',
    dataset: { focusKey: 'notes' },
    onchange: (event) => onPatch({ notes: event.target.value }),
  });

  const subList = el('ul.subtasks');
  for (const sub of task.subtasks) {
    subList.append(
      el('li.subtask', { className: 'subtask' + (sub.done ? ' is-done' : '') }, [
        checkbox({ ...sub, context: task.context }, () => onToggleSubtask(sub.id), '.check-sm'),
        el('span.subtask-title', { text: sub.title }),
        el('button.icon-btn', {
          type: 'button',
          'aria-label': `Remove ${sub.title}`,
          onclick: () => onRemoveSubtask(sub.id),
        }, [icon('trash')]),
      ]),
    );
  }

  const subInput = el('input.field.sub-add', {
    type: 'text',
    placeholder: isMaint ? 'Add a step for this month' : 'Add a step',
    'aria-label': 'Add a step',
    autocomplete: 'off',
    dataset: { focusKey: 'sub-add' },
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value.trim();
      if (!value) return;
      onAddSubtask(value);
      event.target.value = '';
    },
  });

  const titleInput = el('input.title-field', {
    type: 'text',
    value: task.title,
    'aria-label': 'Task',
    dataset: { focusKey: 'title' },
    onchange: (event) => {
      const value = event.target.value.trim();
      if (value) onPatch({ title: value });
    },
  });

  return el('div.editor', { onclick: (event) => event.stopPropagation() }, [
    el('div.editor-head', {}, [checkbox(task, onToggle), titleInput, flagButton(task, onFlag)]),
    contextPicker,
    projectField,
    kindField,
    el('label.field-label', {}, ['Due', dueField(task, onPatch)]),
    isMaint ? null : el('label.field-label', {}, ['Repeat', recurSelect]),
    el('label.field-label', {}, ['Tags', tagField(task, onPatch)]),
    el('label.field-label', {}, ['Notes', notes]),
    el('div.sub-block', {}, [
      el('span.field-label', { text: isMaint ? 'Checklist' : 'Steps' }),
      subList.childNodes.length ? subList : null,
      subInput,
    ]),
    el('div.editor-actions', {}, [
      el('button.ghost-btn.danger', { type: 'button', text: 'Delete', onclick: onDelete }),
      el('button.ghost-btn', { type: 'button', text: 'Close', onclick: onClose }),
    ]),
  ]);
}

/**
 * An editable list of strings — a maintenance checklist template. Enter adds;
 * each item has its own remove button. Used by the project form and Settings.
 */
export function listEditor(items, { onChange, placeholder, focusKey }) {
  const list = el('ul.list-editor');
  items.forEach((item, index) => {
    list.append(
      el('li.list-item', { style: `--i:${Math.min(index, 14)}` }, [
        el('span.list-bullet', { 'aria-hidden': 'true' }),
        el('span.list-text', { text: item }),
        el('button.icon-btn', {
          type: 'button',
          'aria-label': `Remove ${item}`,
          onclick: () => onChange(items.filter((_, i) => i !== index)),
        }, [icon('x')]),
      ]),
    );
  });
  const entry = el('input.field.list-add', {
    type: 'text',
    placeholder,
    'aria-label': placeholder,
    autocomplete: 'off',
    dataset: { focusKey },
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value.trim();
      if (!value || items.includes(value)) return;
      event.target.value = '';
      onChange([...items, value]);
    },
  });
  return el('div.list-editor-wrap', {}, [items.length ? list : null, entry]);
}

/** The app's own mark, drawn quietly, so a cleared list still feels designed. */
function emptyMark() {
  const svg = svgNode('svg', { viewBox: '0 0 48 40', class: 'empty-mark', 'aria-hidden': 'true' });
  const bars = [
    { x: 6, y: 6, h: 28, context: 'business' },
    { x: 19.5, y: 14, h: 20, context: 'freelance' },
    { x: 33, y: 21, h: 13, context: 'personal' },
  ];
  for (const bar of bars) {
    svg.append(svgNode('rect', {
      x: bar.x, y: bar.y, width: 9, height: bar.h, rx: 4.5,
      class: `mark-bar mark-${bar.context}`,
    }));
  }
  return svg;
}

export function emptyState(message, hint, action) {
  return el('div.empty', {}, [
    emptyMark(),
    el('p.empty-line', { text: message }),
    hint ? el('p.empty-hint', { text: hint }) : null,
    action || null,
  ]);
}

export function banner(message, onDismiss) {
  return el('div.banner', { role: 'status' }, [
    el('span', { text: message }),
    el('button.ghost-btn', { type: 'button', text: 'Dismiss', onclick: onDismiss }),
  ]);
}
