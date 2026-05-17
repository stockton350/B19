// ── TTS Provider: Browser Native (speechSynthesis) ───────────────────────
// Zero cost, zero latency, no API key needed.
// Same interface as the Gemini and Kokoro providers — swap by replacing this file.
//
// To switch to OpenAI TTS later:
//   1. Replace speak() with a fetch to https://api.openai.com/v1/audio/speech
//   2. Update VOICES to OpenAI voice IDs (alloy, echo, fable, onyx, nova, shimmer)
//   3. Set your key via setTTSApiKey()
//   4. initTTS() and isTTSReady() can stay as-is
// ─────────────────────────────────────────────────────────────────────────

// Browser voices vary by OS/device. These IDs are preferred names we'll try
// to match against whatever the system has available. Falls back gracefully.
export const VOICES = [
  { id: 'en-GB-female',  label: 'BRIT (female, default)' },
  { id: 'en-US-female',  label: 'YANK (female, clear)' },
  { id: 'en-AU-female',  label: 'AUSSIE (female, bright)' },
  { id: 'en-GB-male',    label: 'BLOKE (male, deep)' },
  { id: 'en-US-male',    label: 'YANK (male, steady)' },
  { id: 'en-AU-male',    label: 'AUSSIE (male, easy)' },
];

// Voice preference map: our ID → system voice name substrings to try, in order
const VOICE_PREFS = {
  'en-GB-female': ['Google UK English Female', 'Serena', 'Karen', 'en-GB'],
  'en-US-female': ['Google US English Female', 'Samantha', 'en-US'],
  'en-AU-female': ['Google Australian English', 'en-AU'],
  'en-GB-male':   ['Google UK English Male', 'Daniel', 'en-GB'],
  'en-US-male':   ['Google US English Male', 'Alex', 'en-US'],
  'en-AU-male':   ['en-AU'],
};

let _apiKey = null;        // unused for native TTS, reserved for future provider swap
let _utterance = null;     // track active utterance so we can cancel

// No init needed for native TTS — resolve immediately
export async function initTTS(onProgress) {
  // Warm the voice list (some browsers load it async)
  await _waitForVoices();
  onProgress?.({ status: 'done', progress: 100, file: 'browser-tts' });
}

// Reserved for provider swap — no-op for native TTS
export function setTTSApiKey(key) { _apiKey = key; }

// Native speechSynthesis is always ready once voices are loaded
export function isTTSReady() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// No AudioContext needed for native TTS — no-op, kept for interface compatibility
export function warmAudioContext() {}
export function getAudioContext() { return null; }

export async function speak(text, voiceId = 'en-GB-female', onStart, onEnd) {
  if (!isTTSReady()) throw new Error('speechSynthesis not supported in this browser');

  // Cancel anything currently speaking
  stopSpeaking();

  await _waitForVoices();

  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  _utterance = utterance;

  // Pick the best available system voice for the requested ID
  utterance.voice = _pickVoice(voiceId);
  utterance.rate  = 1.05;   // slightly faster feels more natural
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  return new Promise((resolve, reject) => {
    utterance.onstart = () => onStart?.();
    utterance.onend   = () => { _utterance = null; onEnd?.(); resolve(); };
    utterance.onerror = (e) => {
      _utterance = null;
      // 'interrupted' is normal when stopSpeaking() is called — not an error
      if (e.error === 'interrupted' || e.error === 'canceled') { resolve(); return; }
      reject(new Error(`speechSynthesis error: ${e.error}`));
    };
    synth.speak(utterance);
  });
}

export function stopSpeaking() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  _utterance = null;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function _waitForVoices() {
  return new Promise(resolve => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) { resolve(voices); return; }
    // Some browsers load voices async
    window.speechSynthesis.onvoiceschanged = () => {
      resolve(window.speechSynthesis.getVoices());
    };
    // Timeout fallback — proceed anyway after 2s
    setTimeout(resolve, 2000);
  });
}

function _pickVoice(voiceId) {
  const available = window.speechSynthesis.getVoices();
  if (!available.length) return null;

  const prefs = VOICE_PREFS[voiceId] ?? VOICE_PREFS['en-GB-female'];

  for (const pref of prefs) {
    const match = available.find(v =>
      v.name.includes(pref) || v.lang.startsWith(pref)
    );
    if (match) return match;
  }

  // Last resort: first English voice, or just the first voice
  return available.find(v => v.lang.startsWith('en')) ?? available[0];
}
