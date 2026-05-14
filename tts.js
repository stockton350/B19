// ── TTS Provider: Gemini TTS ──────────────────────────────────────────────
// Uses gemini-2.5-flash-preview-tts — same API key as the LLM, no extra setup.
// To swap providers: replace initTTS(), speak(), VOICES implementations.

const MODEL    = 'gemini-2.5-flash-preview-tts';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Gemini TTS built-in voices
export const VOICES = [
  { id: 'Aoede',   label: 'AOEDE    (female, warm)'    },
  { id: 'Kore',    label: 'KORE     (female, clear)'   },
  { id: 'Leda',    label: 'LEDA     (female, bright)'  },
  { id: 'Charon',  label: 'CHARON   (male, deep)'      },
  { id: 'Fenrir',  label: 'FENRIR   (male, strong)'    },
  { id: 'Puck',    label: 'PUCK     (male, light)'     },
  { id: 'Orus',    label: 'ORUS     (male, steady)'    },
  { id: 'Zephyr',  label: 'ZEPHYR   (neutral, airy)'  },
];

let audioCtx    = null;
let activeSource = null;
let apiKey      = null;

// No heavy init needed — Gemini TTS is cloud-based
export async function initTTS(onProgress) {
  onProgress?.({ status: 'done', progress: 100, file: 'gemini-tts' });
}

export function setTTSApiKey(key) { apiKey = key; }

export function isTTSReady() { return true; }

export function warmAudioContext() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  console.log('[audio] context state:', audioCtx.state);
}

export async function speak(text, voice = 'Aoede', onStart, onEnd) {
  if (!apiKey) throw new Error('TTS API key not set');

  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice }
          }
        }
      }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `TTS HTTP ${res.status}`);
  }

  const data    = await res.json();
  const b64     = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  const mime    = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType ?? '';
  if (!b64) throw new Error('No audio data in TTS response');

  // Decode base64 → ArrayBuffer
  const binary  = atob(b64);
  const bytes   = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // Parse sample rate from mime type e.g. "audio/pcm;rate=24000"
  const rateMatch = mime.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;

  // Convert LINEAR16 (Int16) PCM → Float32
  const pcm16   = new Int16Array(bytes.buffer);
  const pcm32   = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) pcm32[i] = pcm16[i] / 32768;

  const buffer  = audioCtx.createBuffer(1, pcm32.length, sampleRate);
  buffer.copyToChannel(pcm32, 0);

  const source  = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  activeSource  = source;

  return new Promise(resolve => {
    source.onended = () => { activeSource = null; onEnd?.(); resolve(); };
    onStart?.();
    source.start();
  });
}

export function stopSpeaking() {
  if (activeSource) { try { activeSource.stop(); } catch {} activeSource = null; }
}

export function getAudioContext() { return audioCtx; }
