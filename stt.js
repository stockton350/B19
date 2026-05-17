// ── STT Provider: Web Speech API ─────────────────────────────────────────
// iOS Safari workarounds:
//   - isFinal is always false on iOS, so we track interim results and use
//     them when rec.stop() is called on PTT release
//   - Singleton instance avoids the system chime on repeated creation
//   - continuous: false works more reliably on iOS for PTT

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Singleton instance — created once, reused each session
let rec = null;
let _latestTranscript = '';
let _callbacks = null;
let _active = false;

function getRecognition() {
  if (rec) return rec;
  if (!SR) throw new Error('Speech recognition not supported');
  rec = new SR();
  rec.continuous     = !isIOS; // continuous causes issues on iOS
  rec.interimResults = true;
  rec.lang           = 'en-US';
  rec.maxAlternatives = 1;

  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        // isFinal works on desktop — use it directly
        _latestTranscript = text.trim();
        if (_latestTranscript && _callbacks) {
          _active = false;
          const cb = _callbacks.onResult;
          _callbacks = null;
          cb(_latestTranscript);
          return;
        }
      } else {
        interim += text;
      }
    }
    // Store latest interim for iOS PTT release
    if (interim.trim()) _latestTranscript = interim.trim();
  };

  rec.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (_callbacks) _callbacks.onError(e.error);
  };

  rec.onend = () => {
    if (!_active) return;
    _active = false;

    // On iOS, isFinal never fires — use latest interim transcript on end
    if (_latestTranscript && _callbacks) {
      const cb = _callbacks.onResult;
      _callbacks = null;
      cb(_latestTranscript);
      return;
    }

    if (_callbacks) {
      const cb = _callbacks.onEnd;
      _callbacks = null;
      cb();
    }
  };

  return rec;
}

export function isSupported() {
  return !!SR;
}

export function startListening(callbacks) {
  _callbacks = callbacks;
  _latestTranscript = '';
  _active = true;

  const r = getRecognition();
  try { r.start(); } catch (err) {
    // Already started — abort and retry
    try { r.abort(); } catch {}
    setTimeout(() => {
      try { r.start(); } catch (e) { callbacks.onError(e.message); }
    }, 200);
  }
}

export function stopListening() {
  // Stop immediately — onend should fire and pick up the latest interim transcript
  if (rec) { try { rec.stop(); } catch {} }

  // Fallback: if onend doesn't fire within 1s, process manually
  setTimeout(() => {
    if (!_active) return; // already handled
    _active = false;
    if (_latestTranscript && _callbacks) {
      const cb = _callbacks.onResult;
      _callbacks = null;
      cb(_latestTranscript);
    } else if (_callbacks) {
      const cb = _callbacks.onEnd;
      _callbacks = null;
      cb();
    }
  }, 1000);
}

