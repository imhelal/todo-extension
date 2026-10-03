# Dual — Business, Clients & Personal

A Chrome extension for running several streams of life at once: your own
shop, the client sites you look after, and everything at home. It exists
because focusing on one side makes the *others* go quiet — the badge, the
reminders, the balance bar and the nudge are all there to keep every stream
visible without you having to remember to look.

No build step. No dependencies. Load the folder and it runs.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick the `extension` folder
4. Pin the toolbar icon so the badge count is always in view
5. Right-click the icon → **Open side panel** (or press `Ctrl+Shift+U`) to keep the list pinned beside your work

Updating from 1.x: click **Reload** on the extension card. Your tasks and
settings move across on their own (see *Storage* below).

## Using it

**Capture** — the quick-add bar stays folded into a round **+** button at the
bottom of the list, so the list gets the whole height. Click it and it
stretches into the bar (the + turns into an × to close it) — or skip the click
and just start typing: the first keystroke unfolds it and lands in it. So
`Ctrl+Shift+K` from any page, then a sentence and Enter, is still all it
takes. Esc on an empty line, or clicking away from it, folds it back. The line
understands:

| You type | You get |
| --- | --- |
| `@business` / `@freelance` / `@personal` (or `@fre`, `@per`) | the stream |
| `+acme` | file it under a client project (by name or site address) |
| `!!` | mark it as a priority |
| `#invoice` | a tag |
| `!today` `!tomorrow` `!tonight` | a due date |
| `!fri` `!mon` | the next weekday |
| `!3d` `!2w` | days or weeks out |
| `!14:30` | a time today, or tomorrow if it has passed |

`Fix the footer link +acme !fri` becomes a Freelance task on the Acme Bakery
project, due 9am Friday. Chips above the bar show what was understood before
you commit.

**Priority** — type `!!`, or click the flag on a row (it appears on hover) or
in the editor. Flagged tasks get their own **Priority** section at the top of
the list whatever their date, lead the client's list on a project page, say
*Priority* in their reminder, and come first in a grouped notification.

**Three streams** — Business, Freelance and Personal each have a colour that
follows their work everywhere: the balance bar, a row's edge, a ticked box.

**Balance bar** — the rail across the top splits by how much is open in each
stream. When one has gone untouched past your threshold it turns hatched and
the legend says `quiet 3d`. Click any stream to filter to it.

**Search** — the magnifier, or `/` anywhere. Finds tasks by title, note, tag or
client name; on the Projects tab, sites by name, client, address or platform.

**Undo** — completing or deleting anything shows a toast with **Undo** for five
seconds (hover to hold it).

## Client projects

The **Projects** tab is for the sites you maintain on retainer. Each project
has:

- **A monthly maintenance run.** Pick a day of the month and a checklist
  (backups, updates, uptime and SSL, security scan, forms, speed, broken
  links, analytics — edit it per site, or change the default in Settings).
  The run is a real task: it reminds you at 10:00 on the day, shows in the
  badge, and can be snoozed. Tick the steps on the project page, then
  **Complete maintenance**; next month's run is scheduled automatically.
- **Tasks and feature requests** — ongoing work for that client, with the same
  due dates, tags and reminders as any task.
- **Time** — a timer (it shows in the header while it runs, and survives
  closing the popup) plus one-tap `+15m` `+30m` `+1h` or a typed amount like
  `1h 30m`. With a monthly retainer set, a meter shows hours used against it.
- **Quick links** — site, admin, hosting, analytics: one click away.
- **History** — every finished run, kept two years back.
- **Client report** — a plain-text summary of the month (maintenance done,
  features shipped, fixes, what is in progress, hours used) with a **Copy**
  button, ready to paste into an email.
- **Notes** — hosting quirks, access, what the client cares about. Keep
  passwords in a password manager, not here.

The top of the tab shows **this month at a glance** — how many sites are done,
upcoming and overdue — and the Projects tab carries a red badge when any site
is overdue. In the Tasks list, runs due in the next three days appear as one
strip of site chips rather than a dozen identical rows; further-off runs stay
on the Projects tab so they do not crowd the list or tip the balance bar.

**On a client's site?** Open the popup there and it says *You're on Acme
Bakery*, and anything you type is filed under that project. Dismiss the card
to stop it.

How a run is counted: done on time or late, it counts for the month it was
due; done early, it counts for the first month not yet done. So a site you
add and maintain the same day is done for this month, and a site that fell
months behind picks up from this month instead of queuing a run for every
month it missed. Pausing a project withdraws its run and its reminders while
keeping its history.

## Morning brief

Once a day, at the time you choose (09:00 unless you change it in Settings), a
single notification sums up the day across every stream: what is overdue,
what is flagged, what each stream has due today, which sites need
maintenance, and any stream that has gone quiet. **Plan my day** opens the
list.

The first time you open the list after the brief's time, the same summary
sits at the top as a card — *Good morning*, the counts, and the three things
to start with (flagged first, then late, then today's). Click one to open it;
dismiss the card and it stays away until tomorrow.

The brief says nothing on a day with nothing overdue, due or flagged. If
Chrome was closed at brief time, it arrives when Chrome opens, up to four
hours late (but not inside quiet hours). **Settings → Morning brief → Send it
now** shows it on demand.

## Reminders, nudges, quiet hours

**Reminders** — a desktop notification at the due time with **Mark done** and
**Snooze 1 hour**. The icon is tinted to the task's stream; maintenance runs
are named for their site. The badge shows everything overdue or due today:
red when something is late, amber when it is merely due.

When several tasks come due together you get **one** grouped notification
listing them — *"4 tasks due · 2 Business · 1 Freelance · 1 Personal"* — with
**Open list** and **Snooze all 1 hour**. A stack of separate popups is what
makes people switch reminders off.

**Nudge** — every couple of hours it summarises each stream as a list,
leading with whichever one you have been ignoring (*"Personal has been quiet
for 3 days"*), plus a row for sites still waiting on this month's
maintenance. Its button opens the panel already filtered to the quiet stream.
It stays silent when nothing is open.

**Quiet hours** — nothing fires overnight, and nothing is dropped either. A
reminder that came due at 3am arrives on the first check after the window
ends.

Undated tasks can be dragged into whatever order you want. Dated ones sort by
when they are due.

## How it is put together

```
extension/                       <- load THIS folder; nothing else ships
  manifest.json
  src/
    background/service-worker.js   alarms, notifications, badge
    lib/store.js                   the only module that touches chrome.storage
    lib/tasks.js                   pure logic: parsing, recurrence, grouping
    lib/projects.js                pure logic: maintenance runs, time, reports
    lib/brief.js                   pure logic: the morning brief
    lib/time.js                    pure date helpers
    ui/app.js                      one app, mounted by both surfaces; owns every mutation
    ui/projects-view.js            the Projects screens: list, project, form
    ui/components.js               DOM builders
    ui/app.css                     tokens, styles and motion
    popup/  sidepanel/             thin entry points
    icons/                         drawn by tools/icons.mjs
test/                            development only
tools/pack.mjs                   zips extension/ for the Web Store
tools/icons.mjs                  redraws the icons (no dependencies)
```

The extension folder holds nothing but the extension, so `node_modules` and the
tests can never end up in a published package. There is no build step: load
`extension/` unpacked and hit Reload on the extension card after a change.

To publish, `npm run pack` writes `dist/dual-tasks-<version>.zip` containing
only the files under `extension/`.

Things worth knowing before changing it:

**Storage is local, not sync.** Version 1 kept everything in
`chrome.storage.sync`, which caps the whole extension at 100 KB — a client
list with monthly checklists, time logs and history outgrows that within
months, and then every save fails. Version 2 keeps data in
`chrome.storage.local` (the manifest asks for `unlimitedStorage`), and on first
run copies version 1's tasks and settings across, leaving the sync copy
untouched. The trade is that data no longer follows you to a second computer;
**Settings → Backup** exports and imports everything. `store.js` owns all of
this: one key per collection, debounced writes of only what changed, and
record-by-record merging when another surface (popup, panel, worker) saves, so
an unsaved edit in one is not lost to a save in another.

**Nothing is scheduled with timers.** MV3 service workers are killed after
about 30 seconds idle, so `setTimeout` and `setInterval` cannot be used for
scheduling. A one-minute `chrome.alarms` tick drives due checks and the badge;
a second alarm drives the nudge; a third, one-shot and re-armed each time it
fires, drives the brief (a 24-hour period would drift across DST). They are
created on install and startup, and every time the worker wakes it checks the
tick and the brief still exist.

**Recurrence advances from the original due date**, not from when you ticked
the box, so a weekly Monday task stays on Monday even when completed late. If
it was due long ago, it skips forward to the next occurrence still in the
future rather than firing a burst of past-due ones. Maintenance runs are the
exception: they follow the calendar of months done (above).

**Rendering replaces the DOM wholesale**, which keeps it simple but means CSS
transitions never see a "before". Motion that spans a render — the sliding
pill on segmented controls, the balance bar and progress rings gliding to new
values, rows sliding when something above them changes — is played by
`app.js` with the Web Animations API from remembered values. Screen changes
use view transitions. Everything honours reduced motion.

Any field that can be typed into carries a `data-focus-key` so `render()` can
put the caret back. Add that attribute to any new text input, or editing it
will drop focus on the first keystroke that changes state.

## Tests

```
npm install   # jsdom, for the UI tests only — the extension ships no dependencies
npm test
```

186 checks across five files:

- `test/logic.test.mjs` — quick-add parsing, recurrence, grouping, the nudge,
  quiet-hour wrapping, priority, and building and timing the morning brief
- `test/projects.test.mjs` — maintenance scheduling and month counting,
  matching the active tab to a site, logging and undoing runs, time, the
  client report, `+client` quick-add
- `test/store.test.mjs` — the move out of sync storage, round trips, merging a
  save from another surface under an unsaved edit, backups, write failures
- `test/reminders.test.mjs` — drives the service worker against a stubbed
  chrome API: the alarm tick, badge colours, notification batching, snooze and
  snooze-all, quiet-hour holding, the nudge, maintenance runs ticked off
  from a notification, priority in reminders, and the brief: armed, sent once,
  silent on an empty day, caught up after a closed browser
- `test/ui.test.mjs` — mounts the real UI in jsdom and drives it the way a
  person would: unfold the composer by click or by typing, capture, tick, edit, drag; then create a project, tick its
  checklist, log time, complete a run, copy the report, undo, and delete;
  flag tasks three ways; change the brief's time, see today's card, dismiss it

## A note on the editor's controls

Due dates are set with chips (Today / Tomorrow / Next week), and the native
`datetime-local` control stays hidden behind **Pick date** unless the task has
a date no preset covers. Tags are pills with their own remove buttons, added
from an inline entry on Enter or comma. Selects keep the native popup — the
only one that behaves correctly in a 400px window — with the OS arrow
suppressed and our own chevron drawn over it.

## License

MIT — see [LICENSE](LICENSE). Use it, change it, share it.
