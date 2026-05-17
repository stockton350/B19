// ── TTS Provider ─────────────────────────────────────────────────────────
// Provider is selected automatically at runtime:
//   - If an OpenAI key is set via setTTSApiKey(), uses OpenAI TTS
//   - Otherwise falls back to free browser speechSynthesis
//
// To force a provider, set TTS_OVERRIDE to 'openai' or 'browser'.
// Leave as null for auto-detection.
const TTS_OVERRIDE = null;

// OpenAI TTS config
const OPENAI_MODEL    = 'tts-1';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/speech';

// ── Voices ────────────────────────────────────────────────────────────────
const OPENAI_VOICES = [
  { id: 'nova',    label: 'NOVA (female, warm)' },
  { id: 'shimmer', label: 'SHIMMER (female, clear)' },
  { id: 'alloy',   label: 'ALLOY (neutral, balanced)' },
  { id: 'echo',    label: 'ECHO (male, smooth)' },
  { id: 'fable',   label: 'FABLE (male, warm)' },
  { id: 'onyx',    label: 'ONYX (male, deep)' },
];

const BROWSER_VOICES = [
  { id: 'en-GB-female', label: 'BRIT (female)' },
  { id: 'en-US-female', label: 'YANK (female)' },
  { id: 'en-AU-female', label: 'AUSSIE (female)' },
  { id: 'en-GB-male',   label: 'BLOKE (male)' },
  { id: 'en-US-male',   label: 'YANK (male)' },
  { id: 'en-AU-male',   label: 'AUSSIE (male)' },
];

const BROWSER_VOICE_PREFS = {
  'en-GB-female': ['Google UK English Female', 'Serena', 'Karen', 'en-GB'],
  'en-US-female': ['Google US English Female', 'Samantha', 'en-US'],
  'en-AU-female': ['Google Australian English', 'en-AU'],
  'en-GB-male':   ['Google UK English Male', 'Daniel', 'en-GB'],
  'en-US-male':   ['Google US English Male', 'Alex', 'en-US'],
  'en-AU-male':   ['en-AU'],
};

// ── State ─────────────────────────────────────────────────────────────────
let _apiKey       = null;
let _provider     = TTS_OVERRIDE ?? 'browser'; // resolved in setTTSApiKey
let _utterance    = null;
let _activeSource = null;
let _audioCtx     = null;

// Voices exposed to UI — call getVoices() after setTTSApiKey() to get current list
export function getVoices() {
  return _provider === 'openai' ? OPENAI_VOICES : BROWSER_VOICES;
}

// ── Public API ────────────────────────────────────────────────────────────

export function setTTSApiKey(key) {
  _apiKey = key || null;

  if (TTS_OVERRIDE) {
    _provider = TTS_OVERRIDE;
  } else {
    // Auto-detect: OpenAI keys start with 'sk-'
    // DeepSeek keys also start with 'sk-' so we check if it looks like
    // an OpenAI project key (sk-proj-) or a standard OpenAI key
    const isOpenAI = key && (key.startsWith('sk-proj-') || (key.startsWith('sk-') && key.length > 45));
    _provider = isOpenAI ? 'openai' : 'browser';
  }

  // Update voice list to match provider
  VOICES = _provider === 'openai' ? OPENAI_VOICES : BROWSER_VOICES;
}

export async function initTTS(onProgress) {
  if (_provider === 'browser') await _waitForVoices();
  onProgress?.({ status: 'done', progress: 100, file: _provider + '-tts' });
}

export function isTTSReady() {
  if (_provider === 'openai') return !!_apiKey;
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function warmAudioContext() {
  if (_provider === 'openai') {
    if (!_audioCtx) _audioCtx = new AudioContext();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
  }
}

export function getAudioContext() { return _audioCtx; }

export async function speak(text, voice, onStart, onEnd) {
  stopSpeaking();
  if (_provider === 'openai') {
    return _speakOpenAI(text, voice ?? 'nova', onStart, onEnd);
  } else {
    return _speakBrowser(text, voice ?? 'en-GB-female', onStart, onEnd);
  }
}

export function stopSpeaking() {
  if (_activeSource) { try { _activeSource.stop(); } catch {} _activeSource = null; }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  _utterance = null;
}

// ── OpenAI TTS ────────────────────────────────────────────────────────────

async function _speakOpenAI(text, voice, onStart, onEnd) {
  if (!_apiKey) throw new Error('TTS API key not set');
  if (!_audioCtx) _audioCtx = new AudioContext();
  if (_audioCtx.state === 'suspended') await _audioCtx.resume();

  const res = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_apiKey}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, voice, input: text }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `TTS HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const audioBuffer = await _audioCtx.decodeAudioData(arrayBuffer);
  const source = _audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(_audioCtx.destination);
  _activeSource = source;

  return new Promise(resolve => {
    source.onended = () => { _activeSource = null; onEnd?.(); resolve(); };
    onStart?.();
    source.start();
  });
}

// ── Browser TTS ───────────────────────────────────────────────────────────

async function _speakBrowser(text, voiceId, onStart, onEnd) {
  if (!('speechSynthesis' in window)) throw new Error('speechSynthesis not supported');

  await _waitForVoices();

  const utterance = new SpeechSynthesisUtterance(text);
  _utterance = utterance;
  utterance.voice  = _pickBrowserVoice(voiceId);
  utterance.rate   = 1.05;
  utterance.pitch  = 1.0;
  utterance.volume = 1.0;

  return new Promise((resolve, reject) => {
    utterance.onstart = () => onStart?.();
    utterance.onend   = () => { _utterance = null; onEnd?.(); resolve(); };
    utterance.onerror = e => {
      _utterance = null;
      if (e.error === 'interrupted' || e.error === 'canceled') { resolve(); return; }
      reject(new Error(`speechSynthesis error: ${e.error}`));
    };
    window.speechSynthesis.speak(utterance);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _waitForVoices() {
  return new Promise(resolve => {
    const v = window.speechSynthesis.getVoices();
    if (v.length) { resolve(v); return; }
    window.speechSynthesis.onvoiceschanged = () => resolve(window.speechSynthesis.getVoices());
    setTimeout(resolve, 2000);
  });
}

function _pickBrowserVoice(voiceId) {
  const available = window.speechSynthesis.getVoices();
  if (!available.length) return null;
  const prefs = BROWSER_VOICE_PREFS[voiceId] ?? BROWSER_VOICE_PREFS['en-GB-female'];
  for (const pref of prefs) {
    const match = available.find(v => v.name.includes(pref) || v.lang.startsWith(pref));
    if (match) return match;
  }
  return available.find(v => v.lang.startsWith('en')) ?? available[0];
}
