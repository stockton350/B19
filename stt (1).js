// ── STT Provider: Web Speech API ─────────────────────────────────────────
// To swap providers: replace startListening() and stopListening().

let rec = null;
let _stopTimer = null;

export function isSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function createRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error('Speech recognition not supported');
  const r = new SR();
  r.continuous      = true;  // keeps listening through pauses
  r.interimResults  = true;  // fire as speech comes in
  r.lang            = 'en-US';
  r.maxAlternatives = 1;
  return r;
}

export function startListening({ onResult, onError, onEnd }) {
  // Cancel any pending stop timer
  if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }

  // Always use a fresh instance — reusing a stopped instance causes silent failures
  if (rec) { try { rec.abort(); } catch {} rec = null; }
  rec = createRecognition();

  rec.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        const text = e.results[i][0].transcript.trim();
        if (text) {
          // Cancel any pending stop — result already came in
          if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }
          rec.stop();
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

  rec.onend = onEnd;

  try { rec.start(); } catch (err) { onError(err.message); }
}

export function stopListening() {
  // Delay stop by 1.5s to give iOS time to finalize the transcript
  if (_stopTimer) clearTimeout(_stopTimer);
  _stopTimer = setTimeout(() => {
    _stopTimer = null;
    if (rec) { try { rec.stop(); } catch {} rec = null; }
  }, 1500);
}
