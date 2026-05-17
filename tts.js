// ── TTS Provider: Web Speech API (browser-only) ───────────────────────────

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

let _utterance = null;

export function getVoices() { return BROWSER_VOICES; }

export async function initTTS(onProgress) {
  await _waitForVoices();
  onProgress?.({ status: 'done', progress: 100 });
}

export function isTTSReady() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export async function speak(text, voice, onStart, onEnd) {
  stopSpeaking();
  return _speakBrowser(text, voice ?? 'en-US-female', onStart, onEnd);
}

export function stopSpeaking() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  _utterance = null;
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
  const prefs = BROWSER_VOICE_PREFS[voiceId] ?? BROWSER_VOICE_PREFS['en-US-female'];
  for (const pref of prefs) {
    const match = available.find(v => v.name.includes(pref) || v.lang.startsWith(pref));
    if (match) return match;
  }
  return available.find(v => v.lang.startsWith('en')) ?? available[0];
}
