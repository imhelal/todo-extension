// Date helpers. Everything here is pure — no chrome.* access — so it can be
// unit-reasoned about and shared between the service worker and the UI.

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Midnight (local) at the start of the day containing `ts`. */
export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ts = Date.now()) {
  return startOfDay(ts) + DAY - 1;
}

/** Whole calendar days between two timestamps (b - a), ignoring clock time. */
export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
}

/**
 * Which bucket a task belongs in. Tasks with no due date sort last.
 * @returns {"overdue"|"today"|"upcoming"|"none"}
 */
export function dueState(due, now = Date.now()) {
  if (!due) return 'none';
  if (due < now) return 'overdue';
  if (due <= endOfDay(now)) return 'today';
  return 'upcoming';
}

/** "in 2h", "3 days ago", "Fri 14:00" — short, glanceable. */
export function relativeDue(due, now = Date.now()) {
  if (!due) return '';
  const diff = due - now;
  const abs = Math.abs(diff);
  const past = diff < 0;

  if (abs < MINUTE) return past ? 'just now' : 'now';
  if (abs < HOUR) {
    const m = Math.round(abs / MINUTE);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs < 18 * HOUR) {
    const h = Math.round(abs / HOUR);
    return past ? `${h}h ago` : `in ${h}h`;
  }

  const days = daysBetween(now, due);
  if (days === 0) return `today ${formatClock(due)}`;
  if (days === 1) return `tomorrow ${formatClock(due)}`;
  if (days === -1) return `yesterday ${formatClock(due)}`;
  if (days > 1 && days < 7) {
    return `${new Date(due).toLocaleDateString(undefined, { weekday: 'short' })} ${formatClock(due)}`;
  }
  if (days < 0) return `${Math.abs(days)} days ago`;
  return new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** `<input type="datetime-local">` wants a local-time string, not an ISO/UTC one. */
export function toDatetimeLocal(ts) {
  if (!ts) return '';
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * MINUTE);
  return d.toISOString().slice(0, 16);
}

export function fromDatetimeLocal(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Quiet hours may wrap past midnight (e.g. 22 → 8), so the in-window test
 * flips depending on whether start is after end.
 */
export function inQuietHours({ start, end }, ts = Date.now()) {
  if (start == null || end == null || start === end) return false;
  const h = new Date(ts).getHours();
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** 'YYYY-MM-DD' in local time — "has this happened today yet?" bookkeeping. */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Minutes after midnight → '09:30'. */
export function clockLabel(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// --- months ------------------------------------------------------------------
// Maintenance is billed and reported by calendar month, keyed 'YYYY-MM' in
// local time so a site done late on the 31st still counts for that month.

export function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Midnight on the first of the month a key names. */
export function monthStart(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).getTime();
}

export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1).getTime());
}

/** 'October 2026', or just 'October' when `short`. */
export function monthLabel(key, { short = false } = {}) {
  return new Date(monthStart(key)).toLocaleDateString(undefined, short
    ? { month: 'long' }
    : { month: 'long', year: 'numeric' });
}

/** 'Oct 4' — the compact date used across project history and reports. */
export function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 95 → '1h 35m', 45 → '45m', 120 → '2h'. */
export function formatMinutes(minutes) {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest}m`;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/**
 * Read a typed duration as minutes: '45', '45m', '1.5h', '1h 30m', '1h30'.
 * Bare numbers are minutes. Returns null for anything else.
 */
export function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  const m = t.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const minutes = Math.round(Number(m[1] || 0) * 60 + Number(m[2] || 0));
  return minutes > 0 ? minutes : null;
}

/** Live timer display: '4:07', '1:02:45'. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Advance a timestamp by one recurrence step, preserving time-of-day. */
export function advance(ts, every, interval = 1) {
  const d = new Date(ts);
  if (every === 'day') d.setDate(d.getDate() + interval);
  else if (every === 'week') d.setDate(d.getDate() + 7 * interval);
  else if (every === 'month') d.setMonth(d.getMonth() + interval);
  return d.getTime();
}
