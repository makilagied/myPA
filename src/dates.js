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

/** Plain-text summary of one day, used for the morning-briefing notification. */
export function buildBriefing(data, day = new Date()) {
  const start = startOfDay(day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const events = data.events
    .map((e) => ({ e, at: nextOccurrence(e.start, e.repeat, start) }))
    .filter((x) => x.at && x.at >= start && x.at < end)
    .sort((a, b) => a.at - b.at);
  const tasks = data.tasks.filter((t) => {
    if (t.done || !t.due) return false;
    const d = parseLocal(t.due);
    return d && d < end;
  });
  const title = 'Good morning ☀️';
  if (!events.length && !tasks.length) return { title, body: 'Nothing scheduled today. Enjoy a clear day!' };
  const parts = [];
  if (events.length) parts.push(`${events.length} event${events.length > 1 ? 's' : ''}`);
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length > 1 ? 's' : ''} to do`);
  let body = parts.join(' · ');
  if (events.length) {
    const f = events[0];
    const t = f.e.start.includes('T') ? `${pad(f.at.getHours())}:${pad(f.at.getMinutes())} ` : '';
    body += `. First: ${t}${f.e.title}`;
  }
  return { title, body };
}

/** The next `count` occurrences at or after `from` (just one for non-repeating items). */
export function upcoming(stored, repeat, count, from = new Date()) {
  const first = nextOccurrence(stored, repeat, from);
  if (!first || first < from) return [];
  if (!repeat || repeat === 'none') return [first];
  return Array.from({ length: count }, (_, i) => addPeriod(first, repeat, i));
}
