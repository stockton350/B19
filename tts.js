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

let _apiKey    = null;
// Singleton AudioContext — once unlocked via a user gesture it stays unlocked,
// so decodeAudioData + source.start() work from async contexts on iOS.
let _ctx       = null;
let _sources   = []; // scheduled BufferSourceNodes currently live
let _stopped   = false;
let _resolveEnd = null;

export function setTTSApiKey(key) { _apiKey = key; }
export function getVoices()       { return VOICES; }
export function isTTSReady()      { return !!_apiKey; }

function _getCtx() {
  if (!_ctx || _ctx.state === 'closed') _ctx = new AudioContext();
  return _ctx;
}

// Resume the AudioContext within a user gesture.
// Pass withDing=true (from the speak button) to also play a short audible tone
// that activates OS audio routing before the async TTS fetch begins.
export async function unlockTTS(withDing = false) {
  const ctx = _getCtx();
  await ctx.resume().catch(() => {});
  try {
    if (withDing) {
      const t    = ctx.currentTime;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 960;
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.start(t);
      osc.stop(t + 0.15);
    } else {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch {}
}

export async function initTTS(onProgress) {
  onProgress?.({ status: 'done', progress: 100 });
}

// Split on sentence-ending punctuation followed by whitespace or end of string.
function splitSentences(text) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if ('.!?'.includes(text[i])) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\n') {
        parts.push(buf.trim());
        buf = '';
        if (next === ' ' || next === '\n') i++;
      }
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length ? parts : [text];
}

// Fetch TTS audio for a text chunk; returns a Blob promise.
// Starting this early (while other audio plays or LLM is still streaming) hides latency.
export async function fetchTTSBlob(text, voiceId) {
  if (!_apiKey) throw new Error('No OpenRouter API key');

  // Kokoro stops at colons — replace ": " with ", " so it reads through.
  // Only target colon-space so timestamps like 3:30 are left alone.
  const input = text.replace(/: /g, ', ').replace(/:$/gm, '');

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
      input,
      voice: VOICE_IDS.has(voiceId) ? voiceId : 'af_heart',
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  return res.blob();
}

// Decode a Blob into an AudioBuffer via the shared context.
async function _decode(blob) {
  const ctx = _getCtx();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const ab = await blob.arrayBuffer();
  // Use callback form for widest iOS compatibility
  return new Promise((resolve, reject) => ctx.decodeAudioData(ab, resolve, reject));
}

// Play an ordered list of blob promises with zero gap between them.
// Blobs may already be in-flight (pre-fetched); each is decoded as it resolves
// and scheduled on the AudioContext timeline immediately after the previous one.
// Because AudioContext scheduling is sample-accurate, there is no load()/play()
// round-trip between sentences.
export async function speakBlobs(blobPromises, onStart, onEnd) {
  stopSpeaking();
  _stopped = false;

  const ctx = _getCtx();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  onStart?.();

  let scheduleAt = ctx.currentTime;
  let lastSrc    = null;

  for (const blobPromise of blobPromises) {
    if (_stopped) return;

    const blob = await blobPromise;
    if (_stopped) return;

    let audioBuf;
    try {
      audioBuf = await _decode(blob);
    } catch (e) {
      console.error('[TTS] decode error', e);
      continue;
    }
    if (_stopped) return;

    // If context was suspended during decode, resume and keep schedule coherent
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const startAt  = Math.max(ctx.currentTime, scheduleAt);
    scheduleAt     = startAt + audioBuf.duration;

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    _sources.push(src);
    src.start(startAt);
    lastSrc = src;
  }

  if (!lastSrc || _stopped) {
    if (!_stopped) onEnd?.();
    return;
  }

  // Wait for the final scheduled buffer to end
  await new Promise(resolve => {
    _resolveEnd = resolve;
    lastSrc.onended = () => {
      _resolveEnd = null;
      _sources = _sources.filter(s => s !== lastSrc);
      resolve();
    };
  });

  if (!_stopped) onEnd?.();
}

// Convenience: split text into sentences, fetch all blobs in parallel, play in order.
export async function speak(text, voiceId, onStart, onEnd) {
  const sentences   = splitSentences(text);
  const blobPromises = sentences.map(s => fetchTTSBlob(s, voiceId));
  await speakBlobs(blobPromises, onStart, onEnd);
}

export function stopSpeaking() {
  _stopped = true;
  for (const src of _sources) {
    try { src.stop(0); src.disconnect(); } catch {}
  }
  _sources = [];
  _resolveEnd?.();
  _resolveEnd = null;
}
