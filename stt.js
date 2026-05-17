// ── STT Provider: Web Speech API ─────────────────────────────────────────
// iOS Safari workarounds:
//   - isFinal is always false on iOS, so we collect interim results and
//     use them when rec.stop() is called on PTT release or via fallback timer
//   - Fresh instance each turn avoids stuck state after interruptions

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

let rec = null;
let _latestTranscript = '';
let _resultFired = false;
let _stopFallback = null;
let _onResult = null;
let _onEnd = null;

export function isSupported() {
  return !!SR;
}

export function startListening({ onResult, onError, onEnd }) {
  // Always fresh instance — avoids stuck state after interruptions
  if (rec) { try { rec.abort(); } catch {} rec = null; }
  clearTimeout(_stopFallback);
  _latestTranscript = '';
  _resultFired = false;
  _onResult = onResult;
  _onEnd = onEnd;

  if (!SR) { onError('not supported'); return; }

  rec = new SR();
  rec.continuous      = !isIOS; // continuous is unreliable on iOS
  rec.interimResults  = true;
  rec.lang            = 'en-US';
  rec.maxAlternatives = 1;

  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        // isFinal works on desktop — fire immediately
        const trimmed = text.trim();
        if (trimmed && !_resultFired) {
          _resultFired = true;
          clearTimeout(_stopFallback);
          rec = null;
          onResult(trimmed);
          return;
        }
      } else {
        interim += text;
      }
    }
    // Save latest interim for iOS (isFinal never fires there)
    if (interim.trim()) _latestTranscript = interim.trim();
  };

  rec.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    onError(e.error);
  };

  rec.onend = () => {
    if (_resultFired) return;
    // iOS: use latest interim transcript collected before stop
    if (_latestTranscript) {
      _resultFired = true;
      clearTimeout(_stopFallback);
      onResult(_latestTranscript);
    } else {
      onEnd();
    }
  };

  try { rec.start(); } catch (err) { onError(err.message); }
}

export function stopListening() {
  if (rec) { try { rec.stop(); } catch {} }

  // Fallback: if onend doesn't fire within 1s, process manually
  clearTimeout(_stopFallback);
  _stopFallback = setTimeout(() => {
    if (_resultFired) return;
    _resultFired = true;
    if (rec) { try { rec.abort(); } catch {} rec = null; }
    if (_latestTranscript && _onResult) {
      _onResult(_latestTranscript);
    } else if (_onEnd) {
      _onEnd();
    }
  }, 1000);
}

