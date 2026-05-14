// ── STT Provider: Web Speech API ─────────────────────────────────────────
// To swap providers: replace startListening() and stopListening().

let rec = null;

export function isSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function getRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error('Speech recognition not supported');
  if (!rec) {
    rec = new SR();
    rec.continuous      = true;   // keeps listening through pauses
    rec.interimResults  = true;   // fire as speech comes in
    rec.lang            = 'en-US';
    rec.maxAlternatives = 1;
  }
  return rec;
}

export function startListening({ onResult, onError, onEnd }) {
  const r = getRecognition();

  r.onresult = e => {
    // Look for the first final result
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        const text = e.results[i][0].transcript.trim();
        if (text) {
          r.stop(); // got what we need — stop and hand off
          onResult(text);
          return;
        }
      }
    }
  };

  r.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    onError(e.error);
  };

  r.onend = onEnd;

  try { r.start(); } catch (err) { onError(err.message); }
}

export function stopListening() {
  if (rec) { try { rec.stop(); } catch {} }
}
