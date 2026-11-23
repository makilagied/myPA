// Speech recognition needs native code that Expo Go doesn't include, so load it defensively.
let Mod = null;
try {
  Mod = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
} catch {}

export const voiceAvailable = (() => {
  try {
    return !!Mod && (Mod.isRecognitionAvailable ? !!Mod.isRecognitionAvailable() : true);
  } catch {
    return false;
  }
})();

let subs = [];
const cleanup = () => { subs.forEach((s) => s?.remove?.()); subs = []; };

export async function startVoice({ onText, onEnd, onError }) {
  const perm = await Mod.requestPermissionsAsync();
  if (!perm.granted) throw new Error('Microphone permission was denied.');
  cleanup();
  subs = [
    Mod.addListener('result', (e) => onText(e.results?.[0]?.transcript || '', !!e.isFinal)),
    Mod.addListener('end', () => { cleanup(); onEnd(); }),
    Mod.addListener('error', (e) => { cleanup(); onError(e?.message || 'Voice input failed.'); }),
  ];
  Mod.start({ lang: 'en-US', interimResults: true, continuous: false });
}

export function stopVoice() {
  try { Mod?.stop(); } catch {}
}
