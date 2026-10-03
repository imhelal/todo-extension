// The morning brief: the whole day across every stream, in one look. Pure —
// the worker turns it into a notification at the chosen time, and the app into
// the card at the top of the list the first time it is opened that day.
//
// Like the nudge, it says nothing when there is nothing to say: a brief that
// arrives on an empty day teaches you to ignore the one that matters.

import { CONTEXTS, CONTEXT_LABEL, contextSummary, isSurfaced, openTasks } from './tasks.js';
import { HOUR, dayKey, endOfDay, startOfDay } from './time.js';

export const DEFAULT_BRIEF_AT = 9 * 60; // minutes after midnight
/** If Chrome was closed at brief time, the brief still comes — this late at most. */
export const CATCH_UP = 4 * HOUR;

function briefAt(settings) {
  return settings.briefAt ?? DEFAULT_BRIEF_AT;
}

/** The brief's time on the day containing `ts`. */
export function briefTimeOn(ts, minutes) {
  const d = new Date(startOfDay(ts));
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

/** The next moment the brief is due, strictly after `now`. */
export function nextBriefAt(settings, now = Date.now()) {
  const today = briefTimeOn(now, briefAt(settings));
  if (today > now) return today;
  return briefTimeOn(endOfDay(now) + 1, briefAt(settings));
}

/** Was today's brief missed — its time passed recently, and it never went out? */
export function briefMissed(settings, now = Date.now()) {
  if (!settings.briefEnabled) return false;
  if (settings.lastBriefOn === dayKey(now)) return false;
  const at = briefTimeOn(now, briefAt(settings));
  return now >= at && now - at <= CATCH_UP;
}

export function greeting(now = Date.now()) {
  const h = new Date(now).getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Build the brief, or null on a day with nothing overdue, due or flagged.
 *
 * Returns the notification's title, message and rows, plus counts and up to
 * three tasks to focus on first for the in-app card.
 */
export function buildBrief(tasks, projects, settings, now = Date.now()) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const label = (t) => {
    const project = byId.get(t.projectId);
    if (t.kind === 'maint') return project ? `${project.name} maintenance` : 'Site maintenance';
    return t.title;
  };
  const names = (list, n = 2) =>
    list.slice(0, n).map(label).join(', ') + (list.length > n ? ` +${list.length - n}` : '');
  const byDue = (a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.order - b.order;

  const live = openTasks(tasks).filter((t) => isSurfaced(t, now));
  const overdue = live.filter((t) => t.due != null && t.due < now).sort(byDue);
  const today = live.filter((t) => t.due != null && t.due >= now && t.due <= endOfDay(now)).sort(byDue);
  const priority = live.filter((t) => t.priority).sort(byDue);
  const sites = [...overdue, ...today].filter((t) => t.kind === 'maint');

  if (!overdue.length && !today.length && !priority.length) return null;

  const items = [];
  if (overdue.length) items.push({ title: 'Overdue', message: `${overdue.length} · ${names(overdue)}` });
  if (priority.length) items.push({ title: 'Priority', message: names(priority, 3) });

  const byContext = {};
  for (const context of CONTEXTS) {
    const mine = today.filter((t) => t.context === context && t.kind !== 'maint');
    byContext[context] = mine.length;
    if (mine.length) {
      items.push({ title: CONTEXT_LABEL[context], message: `${mine.length} today · ${names(mine)}` });
    }
  }
  if (sites.length) {
    items.push({
      title: 'Sites',
      message: `${sites.length} due · ${sites.slice(0, 3).map((t) => byId.get(t.projectId)?.name).filter(Boolean).join(', ')}`,
    });
  }

  // A stream gone quiet is worth a line even on a busy day.
  const threshold = settings.staleContextDays ?? 2;
  const quiet = contextSummary(tasks, settings, now)
    .filter((s) => s.open > 0 && s.staleDays !== null && s.staleDays >= threshold)
    .sort((a, b) => b.staleDays - a.staleDays)[0];
  if (quiet) {
    items.push({
      title: 'Quiet',
      message: `${quiet.label} untouched ${quiet.staleDays === 1 ? '1 day' : `${quiet.staleDays} days`}`,
    });
  }

  const counts = { overdue: overdue.length, today: today.length, priority: priority.length, sites: sites.length };
  const summary = [
    counts.overdue ? `${counts.overdue} overdue` : null,
    counts.priority ? `${counts.priority} priority` : null,
    counts.sites ? `${counts.sites} ${counts.sites === 1 ? 'site' : 'sites'}` : null,
  ].filter(Boolean);

  // What to do first: flagged work, then whatever is late, then today's.
  const focus = [...new Set([...priority, ...overdue, ...today])].slice(0, 3);

  return {
    title: `${greeting(now)} · ${counts.today ? `${counts.today} due today` : 'nothing due today'}`,
    message: summary.join(' · ') || 'A clear run — just today’s list.',
    // Chrome shows five rows of a list notification; the rest is in the panel.
    items: items.slice(0, 5),
    counts,
    byContext,
    focus,
    quiet: quiet ? quiet.context : null,
  };
}
