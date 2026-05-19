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

let _apiKey   = null;
let _audioCtx = null;
let _source   = null;

export function setTTSApiKey(key) { _apiKey = key; }
export function getVoices()       { return VOICES; }
export function isTTSReady()      { return !!_apiKey; }

// Call this from a user gesture (tap/click) to unlock AudioContext on iOS
export async function unlockTTS() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') await _audioCtx.resume();
  } catch {}
}

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
      voice: VOICE_IDS.has(voiceId) ? voiceId : 'af_heart',
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();

  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') await _audioCtx.resume();

  const audioBuffer = await _audioCtx.decodeAudioData(arrayBuffer);

  _source = _audioCtx.createBufferSource();
  _source.buffer = audioBuffer;
  _source.connect(_audioCtx.destination);

  return new Promise((resolve, reject) => {
    // Timeout fallback — if onended never fires (iOS quirk), resolve anyway
    const maxMs = Math.max(15000, text.length * 80);
    const timer = setTimeout(() => { _source = null; onEnd?.(); resolve(); }, maxMs);

    _source.onended = () => {
      clearTimeout(timer);
      _source = null;
      onEnd?.();
      resolve();
    };
    onStart?.();
    try {
      _source.start(0);
    } catch (err) {
      clearTimeout(timer);
      _source = null;
      reject(err);
    }
  });
}

export function stopSpeaking() {
  if (_source) {
    try { _source.stop(); } catch {}
    _source = null;
  }
}
