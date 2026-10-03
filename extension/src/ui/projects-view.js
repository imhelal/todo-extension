// The Projects side of the app: client sites on a monthly maintenance cycle.
//
// Three screens, all built from the same app state and handed their actions by
// app.js (which owns every mutation):
//   projectsView  every site, led by this month's maintenance overview
//   projectDetail one site — its run, time, tasks, requests, history, report
//   projectEdit   the add / edit form
//
// Nothing here writes to storage. Builders only read `ctx.state` and call
// `ctx.act.*`, so the same rules hold wherever an action is triggered.

import * as P from '../lib/projects.js';
import { CONTEXTS, CONTEXT_LABEL } from '../lib/tasks.js';
import {
  dueState,
  formatElapsed,
  formatMinutes,
  monthKey,
  monthLabel,
  relativeDue,
  shiftMonth,
  shortDate,
} from '../lib/time.js';
import {
  avatar,
  checkbox,
  el,
  emptyState,
  icon,
  listEditor,
  progressRing,
  sectionHeader,
  segmented,
  selectField,
} from './components.js';

// --- shared bits ---------------------------------------------------------------

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** One short phrase for where a site stands this month, and its tone. */
export function statusLabel(status, now = Date.now()) {
  const { state, task } = status;
  if (state === 'done') return { text: 'Done', tone: 'ok' };
  if (state === 'off') return { text: 'Paused', tone: 'muted' };
  if (state === 'overdue') return { text: `Overdue · ${relativeDue(task.due, now)}`, tone: 'late' };
  if (state === 'due') {
    const soon = dueState(task.due, now) === 'today' || task.due - now < 3 * 864e5;
    return { text: `Due ${relativeDue(task.due, now)}`, tone: soon ? 'soon' : 'muted' };
  }
  return { text: task ? `Next ${shortDate(task.due)}` : 'Not scheduled', tone: 'muted' };
}

function statusPill(status, now) {
  const { text, tone } = statusLabel(status, now);
  return el('span.status-pill', { dataset: { tone } }, [
    tone === 'ok' ? icon('check') : el('span.status-dot'),
    el('span', { text }),
  ]);
}

function card(spec, children, props = {}) {
  return el('section.card' + spec, props, children);
}

function cardHead(iconName, title, extra) {
  return el('div.card-head', {}, [
    el('span.card-icon', {}, [icon(iconName)]),
    el('h3.card-title', { text: title }),
    extra || null,
  ]);
}

// --- the projects list -----------------------------------------------------------

function overviewCard(overview, minutes) {
  const { done, total, overdue, due } = overview;
  const headline = !total
    ? 'Nothing scheduled this month'
    : done === total
      ? 'Every site is done'
      : `${total - done} ${total - done === 1 ? 'site' : 'sites'} to go`;

  return el('section.overview', {}, [
    progressRing({
      value: done,
      max: total || 1,
      size: 60,
      stroke: 5,
      label: total ? `${done}/${total}` : '–',
      morph: 'overview',
    }),
    el('div.overview-body', {}, [
      el('span.kicker', { text: `${overview.month} maintenance` }),
      el('strong.overview-title', { text: headline }),
      el('div.overview-stats', {}, [
        overdue ? el('span.stat', { dataset: { tone: 'late' }, text: `${overdue} overdue` }) : null,
        due ? el('span.stat', { dataset: { tone: 'soon' }, text: `${due} upcoming` }) : null,
        el('span.stat', {}, [icon('clock'), el('span', { text: `${formatMinutes(minutes)} logged` })]),
      ]),
    ]),
  ]);
}

function projectCard(project, ctx, index) {
  const { state, now, act } = ctx;
  const status = P.monthStatus(project, state.tasks, now);
  const mine = state.tasks.filter((t) => t.projectId === project.id && !t.done && t.kind !== 'maint');
  const features = mine.filter((t) => t.kind === 'feature').length;
  const openTasks = mine.length - features;
  const minutes = P.minutesIn(project, monthKey(now));
  const progress = P.checklistProgress(status.task);
  const showProgress = status.state !== 'done' && status.state !== 'off' && progress.total;
  const host = P.hostnameOf(project.url);

  const sub = [host, project.platform].filter(Boolean).join(' · ') || project.client || 'No site address';

  return el('article.pcard', {
    dataset: { flip: project.id, state: status.state, id: project.id },
    style: `--hue:${P.hueOf(project.name)};--i:${Math.min(index, 14)}`,
    tabIndex: 0,
    role: 'button',
    'aria-label': `${project.name}, ${statusLabel(status, now).text}`,
    onclick: () => act.openProject(project.id),
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        act.openProject(project.id);
      }
    },
  }, [
    el('div.pcard-main', {}, [
      avatar(project),
      el('div.pcard-text', {}, [
        el('div.pcard-name', { text: project.name }),
        el('div.pcard-sub', { text: sub }),
      ]),
      statusPill(status, now),
    ]),
    el('div.pcard-foot', {}, [
      showProgress
        ? el('div.mini-progress', { title: `${progress.done} of ${progress.total} steps` }, [
            el('div.meter.meter-sm', {}, [
              el('div.meter-fill', {
                style: `width:${(progress.done / progress.total) * 100}%`,
              }),
            ]),
            el('span.mini-label', { text: `${progress.done}/${progress.total}` }),
          ])
        : el('span.pcard-spacer'),
      el('div.pcard-stats', {}, [
        openTasks ? el('span.pstat', { title: 'Open tasks' }, [icon('list'), String(openTasks)]) : null,
        features ? el('span.pstat', { title: 'Feature requests' }, [icon('sparkle'), String(features)]) : null,
        minutes || project.retainerHours
          ? el('span.pstat', {
              title: 'Time this month',
              dataset: { over: String(Boolean(project.retainerHours && minutes > project.retainerHours * 60)) },
            }, [
              icon('clock'),
              project.retainerHours
                ? `${formatMinutes(minutes)} / ${project.retainerHours}h`
                : formatMinutes(minutes),
            ])
          : null,
      ]),
    ]),
  ]);
}

/** The Projects tab body: overview, then every site, then the add button. */
export function projectsView(ctx) {
  const { state, now, act } = ctx;
  const all = state.projects;
  const q = state.query.trim().toLowerCase();
  const filtered = q
    ? all.filter((p) =>
        [p.name, p.client, p.url, p.platform].some((v) => String(v || '').toLowerCase().includes(q)),
      )
    : all;
  const sorted = P.sortProjects(filtered, state.tasks, now);

  const list = el('div.list.project-list', { onscroll: ctx.onScroll });

  if (!all.length) {
    list.append(
      emptyState(
        'No client sites yet.',
        'Add each site you look after. Every one gets a monthly checklist, a reminder, a time log and a report you can send.',
        el('button.primary-btn', { type: 'button', onclick: act.newProject }, [icon('plus'), el('span', { text: 'Add your first site' })]),
      ),
    );
  } else {
    const key = monthKey(now);
    const minutes = all.reduce((sum, p) => sum + P.minutesIn(p, key), 0);
    list.append(overviewCard(P.monthOverview(all, state.tasks, now), minutes));
    if (!sorted.length) list.append(emptyState('No site matches that.', 'Search looks at name, client, address and platform.'));
    const grid = el('div.pcards');
    sorted.forEach((project, i) => grid.append(projectCard(project, ctx, i)));
    list.append(grid);
  }

  const dock = all.length
    ? el('div.dock', {}, [
        el('button.primary-btn.wide', { type: 'button', onclick: act.newProject }, [
          icon('plus'),
          el('span', { text: 'New project' }),
        ]),
      ])
    : null;

  return [list, dock];
}

// --- one project -----------------------------------------------------------------

function linkChips(project) {
  const chips = [];
  const site = P.hrefOf(project.url);
  if (site) {
    chips.push(
      el('a.link-chip.is-primary', { href: site, target: '_blank', rel: 'noopener noreferrer' }, [
        icon('globe'),
        el('span', { text: 'Visit site' }),
        icon('external', 'link-arrow'),
      ]),
    );
  }
  for (const link of project.links || []) {
    const href = P.hrefOf(link.url);
    if (!href) continue;
    chips.push(
      el('a.link-chip', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, [
        icon('link'),
        el('span', { text: link.label || P.hostnameOf(href) }),
        icon('external', 'link-arrow'),
      ]),
    );
  }
  return chips.length ? el('div.link-row', {}, chips) : null;
}

function maintenanceCard(project, ctx) {
  const { state, now, act } = ctx;
  const status = P.monthStatus(project, state.tasks, now);
  const task = status.task;

  if (status.state === 'off') {
    return card('.maint-card', [
      cardHead('shield', 'Monthly maintenance'),
      el('p.card-note', {
        text: project.status === 'paused'
          ? 'This project is paused, so no maintenance is scheduled and no reminders fire.'
          : 'Maintenance is switched off for this site.',
      }),
      el('button.ghost-btn', { type: 'button', text: 'Change in project settings', onclick: () => act.editProject(project) }),
    ], { dataset: { state: 'off' } });
  }

  const key = monthKey(now);
  const ringKey = `ring-${project.id}`;

  if (status.state === 'done') {
    const { entry } = status;
    const total = entry.items.length + entry.skipped.length;
    const loggedTask = state.tasks.find((t) => t.id === entry.taskId);
    return card('.maint-card', [
      el('div.maint-top', {}, [
        progressRing({ value: 1, max: 1, size: 52, stroke: 5, label: '✓', morph: ringKey, context: 'ok' }),
        el('div.maint-text', {}, [
          el('span.kicker', { text: `${monthLabel(key, { short: true })} maintenance` }),
          el('strong.maint-title', { text: `Completed ${shortDate(entry.at)}` }),
          el('span.maint-sub', {
            text: [
              total ? `${entry.items.length} of ${total} steps` : null,
              task ? `next run ${shortDate(task.due)}` : null,
            ].filter(Boolean).join(' · '),
          }),
        ]),
      ]),
      loggedTask
        ? el('div.card-actions', {}, [
            el('button.text-btn', { type: 'button', text: 'Reopen this run', onclick: () => act.reopen(loggedTask) }),
          ])
        : null,
    ], { dataset: { state: 'done' } });
  }

  const progress = P.checklistProgress(task);
  const periodKey = task ? monthKey(task.due) : key;
  const sub = status.state === 'overdue'
    ? `Was due ${shortDate(task.due)}`
    : status.state === 'due'
      ? `Due ${relativeDue(task.due, now)}`
      : task ? `First run ${shortDate(task.due)}` : 'Not scheduled';

  const steps = el('ul.steps');
  for (const step of task ? task.subtasks : []) {
    steps.append(
      el('li.step', {
        className: 'step' + (step.done ? ' is-done' : ''),
        onclick: () => act.toggleStep(task, step.id),
      }, [
        checkbox({ ...step, context: task.context }, () => act.toggleStep(task, step.id), '.check-sm'),
        el('span.step-title', {}, [el('span.strike', { text: step.title })]),
      ]),
    );
  }

  const allTicked = progress.total > 0 && progress.done === progress.total;
  const actions = task
    ? el('div.card-actions', {}, [
        el('button.primary-btn', {
          type: 'button',
          onclick: (event) => act.completeMaintenance(task, { asIs: false }, event.currentTarget),
        }, [icon('check'), el('span', { text: allTicked || !progress.total ? 'Complete maintenance' : 'Tick all & complete' })]),
        !allTicked && progress.done
          ? el('button.text-btn', {
              type: 'button',
              text: `Complete as is (${progress.done}/${progress.total})`,
              onclick: (event) => act.completeMaintenance(task, { asIs: true }, event.currentTarget),
            })
          : null,
      ])
    : null;

  return card('.maint-card', [
    el('div.maint-top', {}, [
      progressRing({
        value: progress.done,
        max: progress.total || 1,
        size: 52,
        stroke: 5,
        label: progress.total ? `${progress.done}/${progress.total}` : '–',
        morph: ringKey,
        context: status.state === 'overdue' ? 'late' : project.context,
      }),
      el('div.maint-text', {}, [
        el('span.kicker', { text: `${monthLabel(periodKey, { short: true })} maintenance` }),
        el('strong.maint-title', {
          text: status.state === 'overdue' ? 'Overdue' : progress.done ? 'In progress' : 'Ready to start',
        }),
        el('span.maint-sub', { text: sub }),
      ]),
    ]),
    steps.childNodes.length ? steps : null,
    actions,
  ], { dataset: { state: status.state } });
}

function timeCard(project, ctx) {
  const { state, now, act } = ctx;
  const key = monthKey(now);
  const minutes = P.minutesIn(project, key);
  const retainer = Number(project.retainerHours) || 0;
  const running = state.timer && state.timer.projectId === project.id;
  const pct = retainer ? minutes / (retainer * 60) : 0;

  const entries = (project.time || []).filter((e) => monthKey(e.at) === key).slice(0, 4);

  const custom = el('input.field.time-input', {
    type: 'text',
    placeholder: '1h 30m',
    'aria-label': 'Log a custom amount of time',
    autocomplete: 'off',
    dataset: { focusKey: 'time-custom' },
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (act.addTimeText(project, event.target.value)) event.target.value = '';
    },
  });

  return card('.time-card', [
    cardHead('clock', 'Time this month', el('span.card-figure', {
      dataset: { over: String(retainer > 0 && pct > 1) },
      text: retainer ? `${formatMinutes(minutes)} of ${retainer}h` : formatMinutes(minutes),
    })),
    retainer
      ? el('div.meter', { className: 'meter' + (pct > 1 ? ' is-over' : pct > 0.85 ? ' is-near' : '') }, [
          el('div.meter-fill', {
            style: `width:${Math.min(100, pct * 100).toFixed(1)}%`,
            dataset: { morph: `meter-${project.id}`, morphProp: 'width', morphFrom: '0%' },
          }),
        ])
      : null,
    el('div.time-actions', {}, [
      el('button.timer-btn', {
        type: 'button',
        className: 'timer-btn' + (running ? ' is-running' : ''),
        'aria-label': running ? 'Stop the timer' : 'Start a timer',
        onclick: () => (running ? act.stopTimer() : act.startTimer(project)),
      }, running
        ? [icon('stop'), el('span.timer-time', { text: formatElapsed(now - state.timer.startedAt) })]
        : [icon('play'), el('span', { text: 'Start timer' })]),
      ...[15, 30, 60].map((m) =>
        el('button.pick.time-chip', {
          type: 'button',
          text: m < 60 ? `+${m}m` : '+1h',
          onclick: () => act.addTime(project, m),
        }),
      ),
      custom,
    ]),
    entries.length
      ? el('ul.time-log', {}, entries.map((entry) =>
          el('li.time-entry', {}, [
            el('span.time-when', { text: shortDate(entry.at) }),
            el('span.time-amount', { text: formatMinutes(entry.minutes) }),
            entry.note ? el('span.time-note', { text: entry.note }) : el('span.time-note'),
            el('button.icon-btn', {
              type: 'button',
              'aria-label': `Remove ${formatMinutes(entry.minutes)} on ${shortDate(entry.at)}`,
              onclick: () => act.removeTime(project, entry.id),
            }, [icon('x')]),
          ]),
        ))
      : null,
  ]);
}

function taskSection(project, ctx, { kind, title, placeholder, emptyText }) {
  const { state, act, renderRow } = ctx;
  const open = state.tasks
    .filter((t) => t.projectId === project.id && !t.done && (kind === 'feature' ? t.kind === 'feature' : t.kind === 'task'))
    // Flagged work first, then by due date.
    .sort((a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority))
      || (a.due || Infinity) - (b.due || Infinity) || a.order - b.order);

  const input = el('input.field.inline-add', {
    type: 'text',
    placeholder,
    'aria-label': placeholder,
    autocomplete: 'off',
    dataset: { focusKey: `add-${kind}` },
    onkeydown: async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = event.target.value;
      event.target.value = '';
      await act.addProjectTask(project, kind, value);
    },
  });

  const group = el('div.group');
  open.forEach((task, i) => group.append(renderRow(task, null, i, { showProject: false })));

  return el('section.detail-section', {}, [
    sectionHeader(title, open.length || null),
    open.length ? group : el('p.section-empty', { text: emptyText }),
    el('div.inline-add-wrap', {}, [icon('plus'), input]),
  ]);
}

function doneSection(project, ctx) {
  const { state, act } = ctx;
  const done = state.tasks
    .filter((t) => t.projectId === project.id && t.done && t.kind !== 'maint')
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  if (!done.length) return null;

  const toggle = el('button.ghost-btn.section-toggle', {
    type: 'button',
    text: state.showProjectDone ? 'Hide' : 'Show',
    onclick: act.toggleProjectDone,
  });

  return el('section.detail-section', {}, [
    sectionHeader('Done recently', done.length, toggle),
    state.showProjectDone
      ? el('div.group', {}, done.slice(0, 30).map((task, i) => ctx.renderRow(task, null, i, { showProject: false })))
      : null,
  ]);
}

function historySection(project) {
  const log = project.log || [];
  return el('section.detail-section', {}, [
    sectionHeader('Maintenance history', log.length || null),
    log.length
      ? el('ol.history', {}, log.map((entry) => {
          const total = entry.items.length + entry.skipped.length;
          const minutes = P.minutesIn(project, entry.period);
          return el('li.history-item', {}, [
            el('span.history-dot', { dataset: { full: String(!entry.skipped.length) } }),
            el('div.history-body', {}, [
              el('span.history-month', { text: monthLabel(entry.period) }),
              el('span.history-meta', {
                text: [
                  `Done ${shortDate(entry.at)}`,
                  total ? `${entry.items.length}/${total} steps` : null,
                  minutes ? formatMinutes(minutes) : null,
                ].filter(Boolean).join(' · '),
              }),
            ]),
          ]);
        }))
      : el('p.section-empty', { text: 'Each finished run is kept here, two years back.' }),
  ]);
}

function notesSection(project, ctx) {
  return el('section.detail-section', {}, [
    sectionHeader('Notes'),
    el('textarea.field.notes.project-notes', {
      value: project.notes || '',
      rows: 4,
      placeholder: 'Hosting, access, quirks, what the client cares about. Keep passwords in a password manager, not here.',
      'aria-label': 'Project notes',
      dataset: { focusKey: 'project-notes' },
      onchange: (event) => ctx.act.patchProject(project, { notes: event.target.value }),
    }),
  ]);
}

function reportSection(project, ctx) {
  const { state, now, act } = ctx;
  const thisKey = monthKey(now);
  const key = state.reportMonth === 'last' ? shiftMonth(thisKey, -1) : thisKey;
  const text = P.buildReport(project, state.tasks, key);

  return card('.report-card', [
    cardHead('note', 'Client report'),
    segmented(
      [
        { value: 'this', label: monthLabel(thisKey, { short: true }) },
        { value: 'last', label: monthLabel(shiftMonth(thisKey, -1), { short: true }) },
      ],
      state.reportMonth,
      act.setReportMonth,
      { label: 'Report month', className: 'report-seg' },
    ),
    el('pre.report-preview', { text }),
    el('div.card-actions', {}, [
      el('button.primary-btn', { type: 'button', onclick: () => act.copyReport(text) }, [
        icon('copy'),
        el('span', { text: 'Copy report' }),
      ]),
    ]),
  ]);
}

export function projectDetail(ctx) {
  const { state, act } = ctx;
  const project = state.projects.find((p) => p.id === state.projectId);
  if (!project) return null;

  const host = P.hostnameOf(project.url);
  const head = el('header.head.head-detail', { style: `--hue:${P.hueOf(project.name)}` }, [
    el('button.icon-btn.back-btn', { type: 'button', 'aria-label': 'Back', onclick: act.back }, [icon('back')]),
    avatar(project, 'lg'),
    el('div.detail-title', {}, [
      el('h1.detail-name', { text: project.name }),
      el('span.detail-sub', {
        text: [host, project.platform, project.client].filter(Boolean).join(' · ')
          || CONTEXT_LABEL[project.context],
      }),
    ]),
    el('button.icon-btn.edit-btn', {
      type: 'button',
      'aria-label': 'Edit project',
      onclick: () => act.editProject(project),
    }, [icon('pencil')]),
  ]);

  const list = el('div.list.detail-list', { onscroll: ctx.onScroll }, [
    linkChips(project),
    maintenanceCard(project, ctx),
    timeCard(project, ctx),
    taskSection(project, ctx, {
      kind: 'task',
      title: 'Tasks',
      placeholder: 'Add a task — !fri, #tag work here',
      emptyText: 'Nothing open for this site.',
    }),
    taskSection(project, ctx, {
      kind: 'feature',
      title: 'Feature requests',
      placeholder: 'Add a request from the client',
      emptyText: 'No requests waiting.',
    }),
    doneSection(project, ctx),
    reportSection(project, ctx),
    historySection(project),
    notesSection(project, ctx),
  ]);

  return el('div.app.app-detail', { dataset: { view: 'project', context: project.context } }, [head, list]);
}

// --- add / edit ------------------------------------------------------------------

function formField(label, control, hint) {
  return el('label.form-field', {}, [
    el('span.form-label', { text: label }),
    control,
    hint ? el('span.form-hint', { text: hint }) : null,
  ]);
}

/**
 * Typing updates the draft without a re-render, so a keystroke never costs the
 * caret. Choices that change the form's shape (a chip, a toggle, a list edit)
 * re-render through `act.updateDraft`.
 */
function textInput(draft, key, props) {
  return el('input.field', {
    type: 'text',
    value: draft[key] ?? '',
    autocomplete: 'off',
    spellcheck: false,
    dataset: { focusKey: `pf-${key}` },
    oninput: (event) => { draft[key] = event.target.value; },
    ...props,
  });
}

export function projectEdit(ctx) {
  const { state, act } = ctx;
  const draft = state.draftProject;
  if (!draft) return null;
  const isNew = !state.projects.some((p) => p.id === draft.id);
  const m = draft.maintenance;

  const head = el('header.head.head-detail.head-form', {}, [
    el('button.icon-btn.back-btn', { type: 'button', 'aria-label': 'Cancel', onclick: act.cancelEdit }, [icon('back')]),
    el('h1.detail-name', { text: isNew ? 'New project' : 'Edit project' }),
    el('button.primary-btn.sm', { type: 'button', text: 'Save', onclick: act.saveProject }),
  ]);

  const platforms = el('div.picks', {}, P.PLATFORMS.map((name) =>
    el('button.pick', {
      type: 'button',
      className: 'pick' + (draft.platform === name ? ' is-active' : ''),
      'aria-pressed': String(draft.platform === name),
      text: name,
      onclick: () => act.updateDraft({ platform: draft.platform === name ? '' : name }),
    }),
  ));

  const dayPicker = selectField(
    {
      'aria-label': 'Day of the month',
      onchange: (event) => act.updateDraft({ maintenance: { ...m, day: Number(event.target.value) } }),
    },
    Array.from({ length: 28 }, (_, i) => i + 1).map((d) =>
      el('option', { value: String(d), text: `${ordinal(d)} of each month`, selected: m.day === d }),
    ),
  );

  const linkLabel = el('input.field', {
    type: 'text',
    placeholder: 'Label — Admin, Hosting…',
    'aria-label': 'Link label',
    dataset: { focusKey: 'pf-link-label' },
  });
  const linkUrl = el('input.field', {
    type: 'text',
    placeholder: 'acme.com/wp-admin',
    'aria-label': 'Link address',
    dataset: { focusKey: 'pf-link-url' },
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addLink();
    },
  });
  const addLink = () => {
    if (!P.hrefOf(linkUrl.value)) {
      linkUrl.focus();
      return;
    }
    act.updateDraft({ links: [...draft.links, P.makeLink(linkLabel.value || P.hostnameOf(linkUrl.value), linkUrl.value)] });
  };

  const form = el('div.list.form-list', { onscroll: ctx.onScroll }, [
    state.editError ? el('p.form-error', { role: 'alert', text: state.editError }) : null,

    el('section.form-group', {}, [
      formField('Name', textInput(draft, 'name', { placeholder: 'Acme Bakery', 'aria-required': 'true' })),
      formField('Website', textInput(draft, 'url', { placeholder: 'acmebakery.com', inputMode: 'url' }),
        'Opening the popup on this site files new tasks here.'),
      // Adding a site while on it: offer the address rather than make you type it.
      state.tabHost && !draft.url
        ? el('button.pick.suggest', {
            type: 'button',
            onclick: () => act.updateDraft({ url: state.tabHost }),
          }, [icon('globe'), el('span', { text: `Use ${state.tabHost}` })])
        : null,
      formField('Client contact', textInput(draft, 'client', { placeholder: 'Jane Doe, jane@example.com' })),
      el('div.form-field', {}, [el('span.form-label', { text: 'Platform' }), platforms]),
      el('div.form-field', {}, [
        el('span.form-label', { text: 'Stream' }),
        segmented(
          CONTEXTS.map((c) => ({ value: c, label: CONTEXT_LABEL[c], context: c })),
          draft.context,
          (context) => act.updateDraft({ context }),
          { label: 'Stream' },
        ),
      ]),
    ]),

    el('section.form-group', {}, [
      el('div.form-group-head', {}, [
        el('h2.group-title', { text: 'Monthly maintenance' }),
        el('input.switch', {
          type: 'checkbox',
          checked: m.enabled,
          'aria-label': 'Schedule monthly maintenance',
          onchange: (event) => act.updateDraft({ maintenance: { ...m, enabled: event.target.checked } }),
        }),
      ]),
      m.enabled
        ? el('div.form-stack', {}, [
            formField('Due on the', dayPicker, 'A reminder fires at 10:00 that day.'),
            el('div.form-field', {}, [
              el('div.form-label-row', {}, [
                el('span.form-label', { text: 'Checklist' }),
                el('button.text-btn', {
                  type: 'button',
                  text: 'Reset to default',
                  onclick: () => act.updateDraft({
                    maintenance: { ...m, checklist: [...(state.settings.defaultChecklist || P.DEFAULT_CHECKLIST)] },
                  }),
                }),
              ]),
              listEditor(m.checklist, {
                placeholder: 'Add a step',
                focusKey: 'pf-checklist',
                onChange: (checklist) => act.updateDraft({ maintenance: { ...m, checklist } }),
              }),
            ]),
          ])
        : el('p.form-hint', { text: 'No monthly run or reminders for this site.' }),
    ]),

    el('section.form-group', {}, [
      formField(
        'Retainer',
        el('div.input-suffix', {}, [
          el('input.field', {
            type: 'number',
            min: '0',
            step: '0.5',
            value: draft.retainerHours ?? '',
            placeholder: '5',
            'aria-label': 'Hours included per month',
            dataset: { focusKey: 'pf-retainer' },
            oninput: (event) => {
              const v = parseFloat(event.target.value);
              draft.retainerHours = Number.isFinite(v) && v > 0 ? v : null;
            },
          }),
          el('span.suffix', { text: 'hours / month' }),
        ]),
        'Logged time is measured against this. Leave empty if you bill by the hour.',
      ),
    ]),

    el('section.form-group', {}, [
      el('h2.group-title', { text: 'Quick links' }),
      draft.links.length
        ? el('ul.link-list', {}, draft.links.map((link) =>
            el('li.link-item', {}, [
              icon('link'),
              el('span.link-label', { text: link.label }),
              el('span.link-url', { text: P.hostnameOf(link.url) }),
              el('button.icon-btn', {
                type: 'button',
                'aria-label': `Remove ${link.label}`,
                onclick: () => act.updateDraft({ links: draft.links.filter((l) => l.id !== link.id) }),
              }, [icon('x')]),
            ]),
          ))
        : null,
      el('div.link-add', {}, [
        linkLabel,
        linkUrl,
        el('button.ghost-btn', { type: 'button', text: 'Add', onclick: addLink }),
      ]),
      el('p.form-hint', { text: 'Admin, hosting, analytics, repo — one click from the project page.' }),
    ]),

    el('section.form-group', {}, [
      el('div.form-field', {}, [
        el('span.form-label', { text: 'Status' }),
        segmented(
          [
            { value: 'active', label: 'Active' },
            { value: 'paused', label: 'Paused' },
          ],
          draft.status,
          (status) => act.updateDraft({ status }),
          { label: 'Status' },
        ),
        el('span.form-hint', { text: 'Paused sites keep their history but get no runs or reminders.' }),
      ]),
    ]),

    isNew
      ? null
      : el('section.form-group.danger-zone', {}, [
          el('button.ghost-btn.danger.confirm-btn', {
            type: 'button',
            className: 'ghost-btn danger confirm-btn' + (state.confirmDelete ? ' is-armed' : ''),
            text: state.confirmDelete ? 'Click again to delete for good' : 'Delete project',
            onclick: () => act.deleteProject(draft.id),
          }),
          el('p.form-hint', { text: 'Removes the project, its tasks, time and history.' }),
        ]),
  ]);

  const dock = el('div.dock.dock-form', {}, [
    el('button.ghost-btn', { type: 'button', text: 'Cancel', onclick: act.cancelEdit }),
    el('button.primary-btn', { type: 'button', onclick: act.saveProject }, [
      icon('check'),
      el('span', { text: isNew ? 'Add project' : 'Save changes' }),
    ]),
  ]);

  return el('div.app.app-detail.app-form', { dataset: { view: 'edit' } }, [head, form, dock]);
}
