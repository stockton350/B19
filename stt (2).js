// ── STT Provider: Web Speech API ─────────────────────────────────────────
// To swap providers: replace startListening() and stopListening().

let rec = null;
let _stopping = false;

export function isSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function createRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error('Speech recognition not supported');
  const r = new SR();
  r.continuous      = true;
  r.interimResults  = true;
  r.lang            = 'en-US';
  r.maxAlternatives = 1;
  return r;
}

export function startListening({ onResult, onError, onEnd }) {
  _stopping = false;
  if (rec) { try { rec.abort(); } catch {} rec = null; }
  rec = createRecognition();

  rec.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        const text = e.results[i][0].transcript.trim();
        if (text) {
          rec = null;
          onResult(text);
          return;
        }
      }
    }
  };

  rec.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    onError(e.error);
  };

  rec.onend = () => {
    // Only fire onEnd if we didn't get a result — prevents double-firing
    if (!_stopping) onEnd();
  };

  try { rec.start(); } catch (err) { onError(err.message); }
}

export function stopListening() {
  // Stop immediately — on iOS this triggers finalization and fires onresult
  _stopping = true;
  if (rec) { try { rec.stop(); } catch {} }
}
