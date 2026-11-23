import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { nextOccurrence, parseLocal } from './dates';

// Native Android module (modules/mypa-native). Missing in Expo Go, present in the development build / APK.
const Native = Platform.OS === 'android' ? requireOptionalNativeModule('MypaNative') : null;
export const nativeAvailable = !!Native;

const P = PermissionsAndroid.PERMISSIONS;
const GRANTED = PermissionsAndroid.RESULTS.GRANTED;

export const normalizeNumber = (n) => (n || '').replace(/[\s\-().]/g, '');
export const validNumber = (n) => /^\+?\d{4,15}$/.test(normalizeNumber(n));

// ---------- permissions / device settings ----------
export const hasSmsPermission = () => PermissionsAndroid.check(P.SEND_SMS);
export async function requestCallPermission() {
  return (await PermissionsAndroid.request(P.CALL_PHONE)) === GRANTED;
}
export async function requestSmsPermission() {
  return (await PermissionsAndroid.request(P.SEND_SMS)) === GRANTED;
}

export async function getCommsStatus() {
  if (!Native) return null;
  return {
    sms: await hasSmsPermission(),
    exact: Native.canScheduleExactAlarms(),
    battery: Native.isIgnoringBatteryOptimizations(),
    overlay: Native.canDrawOverlays(),
  };
}
export const openExactAlarmSettings = () => Native?.openExactAlarmSettings();
export const openBatterySettings = () => Native?.openBatterySettings();
export const openOverlaySettings = () => Native?.openOverlaySettings();

// ---------- fake-call ringing (the phone's real ringtone) ----------
export const startRingtone = () => { try { Native?.startRingtone(); } catch {} };
export const stopRingtone = () => { try { Native?.stopRingtone(); } catch {} };

export const typeOf = (t) => t.type || 'text';
export const channelOf = (t) => t.channel || 'sms';
export const openAppSettings = () => Native?.openAppSettings();

// ---------- SIMs ----------
/** Returns 'granted' | 'denied' | 'never_ask_again' (also what Android answers if the APK lacks the permission). */
export async function requestPhoneStatePermission() {
  return PermissionsAndroid.request(P.READ_PHONE_STATE);
}
export const hasPhoneStatePermission = () => PermissionsAndroid.check(P.READ_PHONE_STATE);

/** Active SIMs as [{ subId, slot, name, carrier }] (empty until phone permission is granted). */
export function getSims() {
  if (!Native) return [];
  try {
    return JSON.parse(Native.getSims() || '[]');
  } catch {
    return [];
  }
}

export const MAX_RECIPIENTS = 25;
export const recipientsOf = (t) =>
  t.recipients && t.recipients.length ? t.recipients : t.number ? [{ name: t.name || '', number: t.number }] : [];

// ---------- calls ----------
export function placeCall(number, name, subId = -1) {
  const go = async () => {
    if (Native) {
      const res = await PermissionsAndroid.request(P.CALL_PHONE);
      if (res === GRANTED && Native.callNumber(normalizeNumber(number), subId)) return;
    }
    Linking.openURL(`tel:${normalizeNumber(number)}`); // falls back to the dialer
  };
  Alert.alert(`Call ${name || number}?`, name ? number : undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Call', onPress: go },
  ]);
}

// ---------- scheduled texts ----------
/** Re-arms every pending text as a native exact alarm. Returns false if the native module is missing. */
export function syncTexts(texts) {
  if (!Native) return false;
  try {
    Native.cancelAllSms();
    const now = Date.now();
    for (const t of texts) {
      if (t.status !== 'scheduled') continue;
      if (typeOf(t) === 'text' && channelOf(t) === 'whatsapp') continue; // WhatsApp items are reminder notifications
      const at = nextOccurrence(t.at, t.repeat, new Date(now));
      if (!at || at.getTime() <= now) continue;
      const numbers = recipientsOf(t).map((r) => normalizeNumber(r.number)).filter(Boolean).slice(0, MAX_RECIPIENTS).join(',');
      if (!numbers) continue;
      if (typeOf(t) === 'call') Native.scheduleCall(t.id, numbers.split(',')[0], at.getTime(), t.repeat || 'none', t.sim && t.sim.subId != null ? t.sim.subId : -1);
      else Native.scheduleSms(t.id, numbers, t.message, at.getTime(), t.repeat || 'none', t.sim && t.sim.subId != null ? t.sim.subId : -1);
    }
    return true;
  } catch {
    return false;
  }
}

/** Pulls send results recorded by the native alarm. Returns [] when there are none. */
export function takeResults() {
  if (!Native) return [];
  try {
    return JSON.parse(Native.takeSmsResults() || '[]');
  } catch {
    return [];
  }
}

/** Applies native results to the texts list. Returns the same array if nothing changed. */
export function applyResults(texts, results, now = Date.now()) {
  let out = texts;
  for (const r of results) {
    out = out.map((t) => {
      if (t.id !== r.id) return t;
      if (t.repeat && t.repeat !== 'none') return { ...t, lastStatus: r.status, lastAt: r.at, error: r.error || null };
      return { ...t, status: r.status, doneAt: r.at, error: r.error || null };
    });
  }
  // One-off texts whose time passed without any result were never sent.
  out = out.map((t) => {
    if (t.status !== 'scheduled' || (t.repeat && t.repeat !== 'none')) return t;
    const d = parseLocal(t.at);
    if (typeOf(t) === 'text' && channelOf(t) === 'whatsapp') {
      return d && d.getTime() < now ? { ...t, status: 'reminded' } : t; // the reminder notification has fired
    }
    if (d && d.getTime() < now - 12 * 60000) return { ...t, status: 'missed', error: 'The time passed before it could be sent' };
    return t;
  });
  return JSON.stringify(out) === JSON.stringify(texts) ? texts : out;
}
