import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { buildBriefing, buildWrapup, occurrences, parseLocal, reachOutDue, startOfDay, upcoming } from './dates';
import { deviceEvents } from './calendar';

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch {}

const EVENT_LEAD_MIN = 10;
const MAX_SCHEDULED = 60; // iOS caps pending local notifications at 64
const T = () => Notifications.SchedulableTriggerInputTypes;

export async function ensurePermission() {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('reminders', {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    const req = await Notifications.requestPermissionsAsync();
    return !!req.granted;
  } catch {
    return false;
  }
}

function nativeRepeatTrigger(at, repeat) {
  const base = { hour: at.getHours(), minute: at.getMinutes(), channelId: 'reminders' };
  if (repeat === 'daily') return { type: T().DAILY, ...base };
  if (repeat === 'weekly') return { type: T().WEEKLY, weekday: at.getDay() + 1, ...base }; // 1 = Sunday
  return { type: T().MONTHLY, day: at.getDate(), ...base };
}

/**
 * Cancels everything and reschedules from current data. Safe to call often.
 * prefs: { reminders, briefing, briefingTime: 'HH:mm' }
 */
export async function syncReminders(data, prefs) {
  try {
    // Cancel everything except a pending fake call, which is scheduled separately.
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      pending
        .filter((n) => n.content.data?.type !== 'fakecall')
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
    );
    const whatsapp = (data.texts || []).filter((t) => (t.type || 'text') === 'text' && t.channel === 'whatsapp' && t.status === 'scheduled');
    if (!prefs.reminders && !prefs.briefing && !prefs.wrapup && !whatsapp.length) return;
    if (!(await ensurePermission())) return;

    const now = Date.now();
    let budget = MAX_SCHEDULED;
    const schedule = async (content, trigger) => {
      if (budget <= 0) return;
      budget--;
      await Notifications.scheduleNotificationAsync({ content: { sound: true, ...content }, trigger });
    };
    const once = (content, at) =>
      at.getTime() > now + 5000 && schedule(content, { type: T().DATE, date: at, channelId: 'reminders' });

    if (prefs.reminders) {
      const items = [];
      for (const t of data.tasks) {
        if (t.done || !t.due) continue;
        const at = parseLocal(t.due);
        if (at) items.push({ at, repeat: t.repeat, title: t.priority === 'high' ? '🔴 Urgent task due' : 'Task due', body: t.title });
      }
      for (const e of data.events) {
        const d = parseLocal(e.start);
        if (!d) continue;
        const timed = e.start.includes('T');
        items.push({
          at: timed ? new Date(d.getTime() - EVENT_LEAD_MIN * 60000) : d,
          repeat: e.repeat,
          title: timed ? `In ${EVENT_LEAD_MIN} min: ${e.title}` : e.title,
          body: e.location || 'Event today',
        });
      }
      // Follow-ups you are waiting on: nudge on the chase date.
      for (const w of data.waiting || []) {
        if (w.done || !w.due) continue;
        const at = parseLocal(w.due);
        if (at) items.push({ at, repeat: 'none', title: 'Follow up', body: `${w.who ? w.who + ': ' : ''}${w.what}`, data: { type: 'waiting' } });
      }
      // People to stay in touch with: remind when a check-in is due (or tomorrow 9:00 if already overdue).
      for (const p of data.people || []) {
        const due = reachOutDue(p);
        if (!due) continue;
        let at = due;
        if (at.getTime() <= now + 60000) {
          at = new Date(now);
          at.setHours(9, 0, 0, 0);
          if (at.getTime() <= now + 60000) at.setDate(at.getDate() + 1);
        }
        items.push({ at, repeat: 'none', title: 'Stay in touch', body: `Reach out to ${p.name}${p.role ? ' (' + p.role + ')' : ''}`, data: { type: 'person' } });
      }
      items.sort((a, b) => a.at - b.at);

      for (const i of items) {
        const content = { title: i.title, body: i.body, ...(i.data ? { data: i.data } : {}) };
        if (!i.repeat || i.repeat === 'none') {
          await once(content, i.at);
        } else if (i.at.getTime() > now) {
          // Not started yet: a native repeating trigger would fire too early, so list the first few.
          for (const at of occurrences(i.at.toISOString(), i.repeat, 5)) await once(content, at);
        } else {
          await schedule(content, nativeRepeatTrigger(i.at, i.repeat));
        }
      }
    }

    // WhatsApp can't be sent for you, so each scheduled WhatsApp message becomes a reminder that
    // opens the chat with the text pre-filled. Notifications never show the message itself.
    for (const t of whatsapp) {
      const list = (t.recipients && t.recipients.length ? t.recipients : [{ name: t.name, number: t.number }]).slice(0, 10);
      for (const at of upcoming(t.at, t.repeat, 5, new Date(now))) {
        for (const r of list) {
          const digits = (r.number || '').replace(/\D/g, '');
          if (!digits) continue;
          const url = `https://wa.me/${digits}?text=${encodeURIComponent(t.message || '')}`;
          await once(
            { title: `WhatsApp ${r.name || '+' + digits}`, body: 'Tap to open the chat with your message ready', data: { type: 'whatsapp', url } },
            at,
          );
        }
      }
    }

    if (prefs.briefing) {
      const [h, m] = (prefs.briefingTime || '08:00').split(':').map(Number);
      for (let i = 0; i < 7; i++) {
        const day = new Date(startOfDay().getTime());
        day.setDate(day.getDate() + i);
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        const { title, body } = buildBriefing(data, day, deviceEvents());
        await once({ title, body, data: { type: 'briefing' } }, at);
      }
    }

    if (prefs.wrapup) {
      const [h, m] = (prefs.wrapupTime || '18:00').split(':').map(Number);
      for (let i = 0; i < 7; i++) {
        const day = new Date(startOfDay().getTime());
        day.setDate(day.getDate() + i);
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        const { title, body } = buildWrapup(data, day, deviceEvents());
        await once({ title, body, data: { type: 'wrapup' } }, at);
      }
    }
  } catch {}
}
