// ── TTS Provider: Kokoro via OpenRouter ───────────────────────────────────

const ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
const MODEL    = 'hexgrad/kokoro-82m';

const VOICES = [
  { id: 'af_heart',    label: 'HEART (US female)' },
  { id: 'af_bella',    label: 'BELLA (US female)' },
  { id: 'af_nicole',   label: 'NICOLE (US female)' },
  { id: 'af_sarah',    label: 'SARAH (US female)' },
  { id: 'am_adam',     label: 'ADAM (US male)' },
  { id: 'am_michael',  label: 'MICHAEL (US male)' },
  { id: 'bf_emma',     label: 'EMMA (UK female)' },
  { id: 'bf_isabella', label: 'ISABELLA (UK female)' },
  { id: 'bm_george',   label: 'GEORGE (UK male)' },
  { id: 'bm_lewis',    label: 'LEWIS (UK male)' },
];

const VOICE_IDS = new Set(VOICES.map(v => v.id));

// Minimal silent WAV — used to unlock audio on iOS before any fetch
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

let _apiKey  = null;
let _audio   = null;
let _objUrl  = null;
let _stopped = false; // set true when stopSpeaking() is called mid-play

export function setTTSApiKey(key) { _apiKey = key; }
export function getVoices()       { return VOICES; }
export function isTTSReady()      { return !!_apiKey; }

// Call once from a user gesture to unlock audio on iOS
export async function unlockTTS() {
  const a = new Audio(SILENT_WAV);
  a.volume = 0.001;
  try { await a.play(); } catch {}
}

export async function initTTS(onProgress) {
  onProgress?.({ status: 'done', progress: 100 });
}

export async function speak(text, voiceId, onStart, onEnd) {
  stopSpeaking();
  _stopped = false;

  if (!_apiKey) throw new Error('No OpenRouter API key');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_apiKey}`,
      'HTTP-Referer': 'https://stockton350.github.io/B19',
      'X-Title': 'BREAKER ONE NINER',
    },
    body: JSON.stringify({
      model: MODEL,
      input: text,
      voice: VOICE_IDS.has(voiceId) ? voiceId : 'af_heart',
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  // If stopSpeaking() was called while we were fetching, bail out
  if (_stopped) return;

  const blob = await res.blob();
  if (_stopped) return;

  _objUrl = URL.createObjectURL(blob);
  _audio  = new Audio(_objUrl); // fresh element each call — no state carryover

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      _audio = null;
      if (_objUrl) { URL.revokeObjectURL(_objUrl); _objUrl = null; }
    };
    _audio.onended  = () => { cleanup(); onEnd?.(); resolve(); };
    _audio.onerror  = (e) => {
      console.error('[TTS] audio error', e);
      cleanup();
      reject(new Error('audio playback error'));
    };
    onStart?.();
    _audio.play().catch(err => {
      console.error('[TTS] play() rejected', err);
      cleanup();
      reject(err);
    });
  });
}

export function stopSpeaking() {
  _stopped = true;
  if (_audio) {
    _audio.pause();
    _audio.onended = null;
    _audio.onerror = null;
    _audio = null;
  }
  if (_objUrl) { URL.revokeObjectURL(_objUrl); _objUrl = null; }
}
