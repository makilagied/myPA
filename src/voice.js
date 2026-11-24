// Speech recognition needs native code that Expo Go doesn't include, so load it defensively.
let Mod = null;
try {
  Mod = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
} catch {}

let Tts = null;
try { Tts = require('expo-speech'); } catch {}
export const speechAvailable = !!Tts;

export const voiceAvailable = (() => {
  try {
    return !!Mod && (Mod.isRecognitionAvailable ? !!Mod.isRecognitionAvailable() : true);
  } catch {
    return false;
  }
})();

export const VOICE_LANGS = [['en-US', 'English'], ['sw-TZ', 'Kiswahili (TZ)'], ['sw-KE', 'Kiswahili (KE)']];
let lang = 'en-US';
export const setVoiceLang = (l) => { lang = l || 'en-US'; };

let subs = [];
const cleanup = () => { subs.forEach((s) => s?.remove?.()); subs = []; };

export async function startVoice({ onText, onEnd, onError, continuous = false }) {
  const perm = await Mod.requestPermissionsAsync();
  if (!perm.granted) throw new Error('Microphone permission was denied.');
  cleanup();
  subs = [
    Mod.addListener('result', (e) => onText(e.results?.[0]?.transcript || '', !!e.isFinal)),
    Mod.addListener('end', () => { cleanup(); onEnd(); }),
    Mod.addListener('error', (e) => { cleanup(); onError(e?.message || 'Voice input failed.'); }),
  ];
  Mod.start({ lang, interimResults: true, continuous });
}

export function stopVoice() {
  try { Mod?.stop(); } catch {}
}

// Reads Jolly's reply aloud in the chosen language. Emoji and markdown marks are dropped so they aren't spoken.
export function speak(text, { onDone } = {}) {
  if (!Tts) return onDone?.();
  const clean = String(text)
    .replace(/[*_`#>~]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .slice(0, Tts.maxSpeechInputLength || 3500);
  Tts.speak(clean, { language: lang, onDone, onStopped: () => {}, onError: () => onDone?.() });
}

export function stopSpeaking() {
  try { Tts?.stop(); } catch {}
}

const words = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
const STOP_WORDS = ['stop', 'wait', 'hold', 'hey', 'hapana', 'acha', 'simama', 'subiri', 'sikiliza'];

/**
 * While the assistant is talking, the mic also hears her own voice. A transcript counts as the
 * user talking over her only if it holds words she did not say, or an explicit "stop".
 */
export function isInterruption(heard, spoken) {
  const said = new Set(words(spoken));
  const w = words(heard);
  if (w.some((x) => STOP_WORDS.includes(x) && !said.has(x))) return true;
  return w.filter((x) => !said.has(x)).length >= 2;
}
