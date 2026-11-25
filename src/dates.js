// Stored date format: "YYYY-MM-DD" (date only) or "YYYY-MM-DDTHH:mm" (local time, no zone).
export const pad = (n) => String(n).padStart(2, '0');

export const REPEATS = ['none', 'daily', 'weekly', 'monthly'];
export const REPEAT_LABEL = { none: 'Never', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// Date-only values are treated as local 09:00; date-times parse as local.
export function parseLocal(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3], 9, 0) : new Date(s);
  return isNaN(d) ? null : d;
}

export function toStored(d, withTime) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

export const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function addPeriod(d, repeat, n) {
  const x = new Date(d);
  if (repeat === 'daily') x.setDate(x.getDate() + n);
  else if (repeat === 'weekly') x.setDate(x.getDate() + 7 * n);
  else if (repeat === 'monthly') {
    const day = x.getDate();
    x.setDate(1);
    x.setMonth(x.getMonth() + n);
    x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
  }
  return x;
}

/** First occurrence at or after `from` (the start itself if it is not repeating or still ahead). */
export function nextOccurrence(stored, repeat, from = new Date()) {
  const d = parseLocal(stored);
  if (!d) return null;
  if (!repeat || repeat === 'none' || d >= from) return d;
  let n = 0;
  let x = d;
  while (x < from && n < 4000) x = addPeriod(d, repeat, ++n);
  return x;
}

export function occurrenceStored(stored, repeat, from = new Date()) {
  const d = nextOccurrence(stored, repeat, from);
  return d ? toStored(d, stored.includes('T')) : stored;
}

export const occurrences = (stored, repeat, count) => {
  const d = parseLocal(stored);
  if (!d) return [];
  return Array.from({ length: count }, (_, i) => addPeriod(d, repeat, i));
};

/** Completing a repeating task rolls it to its next due date instead of closing it. */
export function completeTask(t) {
  if (t.repeat && t.repeat !== 'none' && t.due) {
    const due = parseLocal(t.due);
    const from = new Date(Math.max(Date.now(), due ? due.getTime() + 60000 : 0));
    return { ...t, due: occurrenceStored(t.due, t.repeat, from), done: false };
  }
  return { ...t, done: true };
}

const DEFAULT_MIN = 60;
const dayKey = (d) => toStored(d, false);

/** Everything on the calendar for one day (app events plus phone-calendar events), as { title, start, end, allDay, source }. */
export function dayEvents(data, day = new Date(), device = []) {
  const start = startOfDay(day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const out = [];
  for (const e of data.events || []) {
    const at = nextOccurrence(e.start, e.repeat, start);
    if (!at || at < start || at >= end) continue;
    const timed = e.start.includes('T');
    out.push({ title: e.title, start: at, end: new Date(at.getTime() + DEFAULT_MIN * 60000), allDay: !timed, source: 'app', location: e.location });
  }
  for (const e of device) {
    const s = parseLocal(e.start);
    if (!s) continue;
    const en = (e.end && parseLocal(e.end)) || new Date(s.getTime() + DEFAULT_MIN * 60000);
    if (e.allDay ? dayKey(s) !== dayKey(start) : s < start || s >= end) continue;
    out.push({ title: e.title, start: s, end: en, allDay: !!e.allDay, source: 'calendar', location: e.location });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Overlapping timed events, and ones with under 10 minutes between them. */
export function findClashes(events) {
  const timed = events.filter((e) => !e.allDay).sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (b.start >= a.end) {
        if (j === i + 1 && b.start - a.end < 10 * 60000) out.push({ a, b, kind: 'tight' });
        break;
      }
      out.push({ a, b, kind: 'overlap' });
    }
  }
  return out;
}

/** Free gaps of at least `minutes` inside working hours on one day. */
export function freeSlots(events, day, minutes = 30, workStart = 9, workEnd = 18) {
  const d = startOfDay(day);
  let cursor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), workStart);
  const endOfWork = new Date(d.getFullYear(), d.getMonth(), d.getDate(), workEnd);
  if (dayKey(d) === dayKey(new Date()) && cursor < new Date()) cursor = new Date(Math.ceil(Date.now() / 900000) * 900000);
  const out = [];
  for (const e of events.filter((x) => !x.allDay).sort((a, b) => a.start - b.start)) {
    if (e.start - cursor >= minutes * 60000 && cursor < endOfWork) out.push({ from: cursor, to: new Date(Math.min(+e.start, +endOfWork)) });
    if (e.end > cursor) cursor = e.end;
  }
  if (endOfWork - cursor >= minutes * 60000) out.push({ from: cursor, to: endOfWork });
  return out;
}

export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Date a person is next due a check-in, or null. */
export function reachOutDue(p) {
  if (!p.every) return null;
  const base = parseLocal(p.last || (p.created || '').slice(0, 10));
  if (!base) return null;
  return addPeriod(base, 'daily', p.every);
}

/** Plain-text summary of one day, used for the morning-briefing notification. */
export function buildBriefing(data, day = new Date(), device = []) {
  const start = startOfDay(day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const events = dayEvents(data, day, device);
  const open = (data.tasks || []).filter((t) => !t.done);
  const dueToday = open.filter((t) => t.due && parseLocal(t.due) < end && parseLocal(t.due) >= start);
  const overdue = open.filter((t) => t.due && parseLocal(t.due) < start);
  const urgent = open.filter((t) => t.priority === 'high').length;
  const waiting = (data.waiting || []).filter((w) => !w.done && w.due && parseLocal(w.due) < end);
  const reach = (data.people || []).filter((p) => { const d = reachOutDue(p); return d && d < end; });
  const clashes = findClashes(events).filter((c) => c.kind === 'overlap');
  const title = 'Good morning ☀️';
  const parts = [];
  if (events.length) parts.push(`${events.length} meeting${events.length > 1 ? 's' : ''}`);
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (urgent) parts.push(`${urgent} urgent`);
  if (waiting.length) parts.push(`${waiting.length} to chase`);
  if (reach.length) parts.push(`${reach.length} to check in with`);
  if (!parts.length) return { title, body: 'Nothing scheduled today. Enjoy a clear day!' };
  let body = parts.join(' · ');
  const first = events.find((e) => !e.allDay) || events[0];
  if (first) body += `. First: ${first.allDay ? '' : hhmm(first.start) + ' '}${first.title}`;
  if (clashes.length) body += `. ⚠ ${clashes[0].a.title} clashes with ${clashes[0].b.title}`;
  return { title, body };
}

/** Evening summary: what is still open today and what tomorrow holds. */
export function buildWrapup(data, day = new Date(), device = []) {
  const tomorrow = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const start = startOfDay(day);
  const open = (data.tasks || []).filter((t) => !t.done && t.due && parseLocal(t.due) < new Date(start.getTime() + 86400000));
  const next = dayEvents(data, tomorrow, device);
  const chase = (data.waiting || []).filter((w) => !w.done && w.due && parseLocal(w.due) < new Date(tomorrow.getTime() + 86400000));
  const parts = [];
  if (open.length) parts.push(`${open.length} task${open.length > 1 ? 's' : ''} still open`);
  if (chase.length) parts.push(`${chase.length} to chase`);
  parts.push(next.length ? `${next.length} meeting${next.length > 1 ? 's' : ''} tomorrow` : 'nothing booked tomorrow');
  const f = next.find((e) => !e.allDay);
  let body = parts.join(' · ');
  if (f) body += `. First: ${hhmm(f.start)} ${f.title}`;
  return { title: 'Day wrap-up 🌙', body };
}

/** The next `count` occurrences at or after `from` (just one for non-repeating items). */
export function upcoming(stored, repeat, count, from = new Date()) {
  const first = nextOccurrence(stored, repeat, from);
  if (!first || first < from) return [];
  if (!repeat || repeat === 'none') return [first];
  return Array.from({ length: count }, (_, i) => addPeriod(first, repeat, i));
}
