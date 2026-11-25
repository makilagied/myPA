import { toStored } from './dates';

// Read-only view of the phone's calendar (Google Calendar etc). Loaded defensively: old builds lack the module.
let Cal = null;
try { Cal = require('expo-calendar/legacy'); } catch {}

let cache = [];
export const calendarAvailable = !!Cal;
export const deviceEvents = () => cache;

export async function hasCalendarPermission() {
  try { return !!Cal && (await Cal.getCalendarPermissionsAsync()).granted; } catch { return false; }
}

export async function requestCalendarPermission() {
  try { return !!Cal && (await Cal.requestCalendarPermissionsAsync()).granted; } catch { return false; }
}

/** Loads the next `days` of events into the cache and returns them: [{id,title,start,end,allDay,location,source}]. */
export async function refreshCalendar(days = 14) {
  if (!(await hasCalendarPermission())) { cache = []; return cache; }
  try {
    const cals = await Cal.getCalendarsAsync(Cal.EntityTypes?.EVENT);
    const ids = cals.filter((c) => c.isVisible !== false).map((c) => c.id);
    if (!ids.length) { cache = []; return cache; }
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + days * 86400000);
    const raw = await Cal.getEventsAsync(ids, from, to);
    const seen = new Set();
    cache = raw
      .map((e) => {
        const s = new Date(e.startDate);
        const en = new Date(e.endDate);
        if (isNaN(s)) return null;
        const key = `${e.id}|${s.getTime()}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return {
          id: 'cal:' + key,
          title: e.title || '(no title)',
          start: toStored(s, !e.allDay),
          end: isNaN(en) ? null : toStored(en, !e.allDay),
          allDay: !!e.allDay,
          location: e.location || '',
          source: 'calendar',
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start.localeCompare(b.start));
  } catch {
    cache = [];
  }
  return cache;
}

export function clearCalendarCache() { cache = []; }
