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

let _apiKey = null;
let _audio  = null;
let _objUrl = null;

export function setTTSApiKey(key) { _apiKey = key; }
export function getVoices()       { return VOICES; }
export function isTTSReady()      { return !!_apiKey; }

export async function initTTS(onProgress) {
  onProgress?.({ status: 'done', progress: 100 });
}

export async function speak(text, voiceId, onStart, onEnd) {
  stopSpeaking();
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
      voice: voiceId || 'af_heart',
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  const blob = await res.blob();
  _objUrl = URL.createObjectURL(blob);
  _audio  = new Audio(_objUrl);

  return new Promise((resolve, reject) => {
    _audio.onplay  = () => onStart?.();
    _audio.onended = () => { _cleanup(); onEnd?.(); resolve(); };
    _audio.onerror = () => { _cleanup(); reject(new Error('audio playback error')); };
    _audio.play().catch(err => { _cleanup(); reject(err); });
  });
}

export function stopSpeaking() {
  if (_audio) {
    _audio.pause();
    _audio.onended = null;
    _audio.onerror = null;
    _audio = null;
  }
  _cleanup();
}

function _cleanup() {
  if (_objUrl) { URL.revokeObjectURL(_objUrl); _objUrl = null; }
}
