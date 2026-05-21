import { sendMessage, generateSummary, RESPONSE_LENGTHS } from './llm.js';
import { initTTS, speak, stopSpeaking, isTTSReady, setTTSApiKey, getVoices, unlockTTS, playDing, fetchTTSBlob, speakBlobs } from './tts.js';
import { isSupported, startListening, stopListening } from './stt.js';
import { setMemoryURL, isMemoryEnabled, getProfile, saveConversation } from './memory.js';

// ── Constants ─────────────────────────────────────────────────────────────
const STORAGE = {
  KEY:             'b19_key',
  PERSONA:         'b19_persona',
  MODE:            'b19_mode',
  RESPONSE_LENGTH: 'b19_response_length',
  VOICE:           'b19_voice',
  OPENROUTER_KEY:  'b19_openrouter_key',
  MEMORY_URL:      'b19_memory_url',
  DEBUG:           'b19_debug',
};
const SESSIONS_KEY = 'b19_sessions';
const BAR_COUNT = 28;

// ── App State ─────────────────────────────────────────────────────────────
let mode  = 'text'; // 'text' | 'ptt' | 'auto'
let phase = 'idle'; // 'idle' | 'listening' | 'thinking' | 'speaking'
let messages = [];
let currentSession = null;
let profileContext = '';
let resumeContext  = '';
let pttHeld = false;
let animFrame = null;
let micAnalyser = null;
let micStream = null;
let micAudioCtx = null;

const cfg = {
  apiKey:         localStorage.getItem(STORAGE.KEY)             || '',
  persona:        localStorage.getItem(STORAGE.PERSONA)         || 'SPARK',
  mode:           localStorage.getItem(STORAGE.MODE)            || 'text',
  responseLength: localStorage.getItem(STORAGE.RESPONSE_LENGTH) || 'CONCISE',
  voice:          localStorage.getItem(STORAGE.VOICE)           || 'af_heart',
  openRouterKey:  localStorage.getItem(STORAGE.OPENROUTER_KEY)  || '',
  memoryUrl:      localStorage.getItem(STORAGE.MEMORY_URL)      || '',
  debug:          localStorage.getItem(STORAGE.DEBUG)           === 'true',
};

// ── DOM ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  settings: $('scr-settings'),
  loading:  $('scr-loading'),
  main:     $('scr-main'),
};

// ── Boot ──────────────────────────────────────────────────────────────────


function boot() {
  startNewSession();
  buildBars();
  restoreSettings();
  setupListeners();
  setupViewport();
  if (cfg.openRouterKey) setTTSApiKey(cfg.openRouterKey);
  initDebug();

  // Disable PTT/AUTO pills if speech recognition unavailable (e.g. HTTP on iOS)
  if (!isSupported()) {
    document.querySelectorAll('.mode-pill[data-mode="ptt"], .mode-pill[data-mode="auto"]').forEach(p => {
      p.disabled = true;
      p.title = 'Requires HTTPS';
    });
  }

  cfg.apiKey ? showLoading() : showSettings();
}

function buildBars() {
  const el = $('bars');
  el.innerHTML = '';
  for (let i = 0; i < BAR_COUNT; i++) {
    const b = document.createElement('div');
    b.className = 'bar';
    el.appendChild(b);
  }
}

function populateVoices() {
  const sel = $('settings-voice');
  if (!sel) return;
  const voices = getVoices();
  // Migrate stale browser voice name to a valid Kokoro ID
  if (!voices.find(v => v.id === cfg.voice)) cfg.voice = 'af_heart';
  sel.innerHTML = '';
  voices.forEach(v => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.label;
    o.selected = v.id === cfg.voice;
    sel.appendChild(o);
  });
}

function restoreSettings() {
  if (cfg.apiKey)        $('api-key').value        = cfg.apiKey;
  if (cfg.openRouterKey) $('openrouter-key').value = cfg.openRouterKey;
  if (cfg.memoryUrl)     $('memory-url').value     = cfg.memoryUrl;

  document.querySelectorAll('.p-btn:not(.rl-btn)').forEach(b =>
    b.classList.toggle('on', b.dataset.p === cfg.persona));

  document.querySelectorAll('.rl-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.rl === cfg.responseLength));

  $('debug-btn')?.classList.toggle('on', cfg.debug);

  populateVoices();

  const savedMode = cfg.mode;
  mode = (savedMode === 'ptt' || savedMode === 'PTT') ? 'ptt'
       : savedMode === 'auto' ? 'auto'
       : 'text';
}

// ── Screen routing ────────────────────────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
}

function showSettings() {
  showScreen('settings');
  populateVoices();
}

async function showLoading() {
  showScreen('loading');
  setProgress(0);
  setLoadMsg('INITIALIZING...');

  try {
    await initTTS(({ status, progress }) => {
      if (status === 'progress') {
        setProgress(Math.round(progress));
      } else if (status === 'done') {
        setLoadMsg('READY');
        setProgress(100);
      }
    });
    setTimeout(showMain, 400);
  } catch (err) {
    setLoadMsg(`ERROR: ${err.message}`);
  }
}

function showMain() {
  showScreen('main');
  $('hdr-persona').textContent = cfg.persona;

  // Apply saved mode
  setMode(mode, false);

  // Render any existing messages (e.g. returning from settings mid-session)
  renderAllMessages();

  initMemory();
}

// ── Event Listeners ───────────────────────────────────────────────────────
function setupListeners() {
  // Unlock AudioContext on first gesture — required for iOS audio playback
  const _onFirstGesture = () => {
    unlockTTS();
    document.removeEventListener('touchstart', _onFirstGesture);
    document.removeEventListener('click',      _onFirstGesture);
  };
  document.addEventListener('touchstart', _onFirstGesture, { once: true, passive: true });
  document.addEventListener('click',      _onFirstGesture, { once: true });

  $('init-btn').addEventListener('click', onInit);
  $('gear-btn').addEventListener('click', showSettings);
  $('checkin-btn')?.addEventListener('click', runCheckin);
  $('update-btn').addEventListener('click', checkForUpdate);
  $('menu-btn')?.addEventListener('click', openSidebar);
  document.querySelectorAll('.mode-pill').forEach(btn =>
    btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  $('sidebar-overlay')?.addEventListener('click', closeSidebar);
  $('new-session-btn')?.addEventListener('click', () => { startNewSession(); renderAllMessages(); closeSidebar(); });

  document.querySelectorAll('.p-btn:not(.rl-btn)').forEach(b =>
    b.addEventListener('click', () => setPersona(b.dataset.p)));

  document.querySelectorAll('.rl-btn').forEach(b =>
    b.addEventListener('click', () => setResponseLength(b.dataset.rl)));

  $('settings-voice')?.addEventListener('change', e => { cfg.voice = e.target.value; save(); });
  $('debug-btn')?.addEventListener('click', toggleDebug);

  // Text input
  const input = $('text-input');
  input.addEventListener('input', onTextInputChange);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  $('send-btn').addEventListener('click', onSend);

  // PTT hold
  const pttEl = $('ptt-area');
  pttEl.addEventListener('mousedown',  onPTTDown);
  pttEl.addEventListener('mouseup',    onPTTUp);
  pttEl.addEventListener('mouseleave', onPTTUp);
  pttEl.addEventListener('touchstart', e => { e.preventDefault(); onPTTDown(); }, { passive: false });
  pttEl.addEventListener('touchend',   e => { e.preventDefault(); onPTTUp();   }, { passive: false });
}

function setupViewport() {
  if (!window.visualViewport) return;
  const update = () => {
    if (!screens.main.classList.contains('active')) return;
    const vv = window.visualViewport;
    const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    screens.main.style.bottom = bottom + 'px';
    scrollToBottom();
  };
  window.visualViewport.addEventListener('resize', update);
  window.visualViewport.addEventListener('scroll', update);
}

// ── Settings actions ──────────────────────────────────────────────────────
function onInit() {
  const key = $('api-key').value.trim();
  if (!key) { flash('api-key', 'ENTER YOUR DEEPSEEK KEY'); return; }
  cfg.apiKey         = key;
  cfg.persona        = document.querySelector('.p-btn:not(.rl-btn).on')?.dataset.p || 'SPARK';
  cfg.responseLength = document.querySelector('.rl-btn.on')?.dataset.rl || 'CONCISE';
  cfg.voice          = $('settings-voice').value || 'af_heart';
  cfg.openRouterKey  = $('openrouter-key').value.trim();
  cfg.memoryUrl      = $('memory-url').value.trim();
  setTTSApiKey(cfg.openRouterKey);
  save();
  showLoading();
}

function setPersona(p) {
  cfg.persona = p;
  document.querySelectorAll('.p-btn:not(.rl-btn)').forEach(b =>
    b.classList.toggle('on', b.dataset.p === p));
  save();
}

function setResponseLength(rl) {
  cfg.responseLength = rl;
  document.querySelectorAll('.rl-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.rl === rl));
  save();
}

function save() {
  localStorage.setItem(STORAGE.KEY,             cfg.apiKey);
  localStorage.setItem(STORAGE.PERSONA,         cfg.persona);
  localStorage.setItem(STORAGE.MODE,            mode);
  localStorage.setItem(STORAGE.RESPONSE_LENGTH, cfg.responseLength);
  localStorage.setItem(STORAGE.VOICE,           cfg.voice);
  localStorage.setItem(STORAGE.OPENROUTER_KEY,  cfg.openRouterKey);
  localStorage.setItem(STORAGE.MEMORY_URL,      cfg.memoryUrl);
  localStorage.setItem(STORAGE.DEBUG,           cfg.debug);
}

// ── Debug console (Eruda) ─────────────────────────────────────────────────
function initDebug() {
  if (!cfg.debug) return;
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda';
  s.onload = () => window.eruda?.init();
  document.head.appendChild(s);
}

function toggleDebug() {
  cfg.debug = !cfg.debug;
  save();
  $('debug-btn').classList.toggle('on', cfg.debug);
  if (cfg.debug) {
    if (window.eruda) { window.eruda.init(); }
    else {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/eruda';
      s.onload = () => window.eruda?.init();
      document.head.appendChild(s);
    }
  } else {
    window.eruda?.destroy();
  }
}

// Returns the index of the first sentence-ending punctuation followed by
// a space or newline in buf, or -1 if no complete sentence boundary found.
function firstSentenceEnd(buf) {
  for (let i = 0; i < buf.length; i++) {
    if ('.!?'.includes(buf[i]) && (buf[i + 1] === ' ' || buf[i + 1] === '\n')) return i;
  }
  return -1;
}

// ── Update check ──────────────────────────────────────────────────────────
async function checkForUpdate() {
  const btn  = $('update-btn');
  const hint = $('update-hint');
  btn.disabled = true;
  btn.textContent = '[ CHECKING... ]';
  hint.textContent = '';

  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) { showUpdateHint('NO SERVICE WORKER'); return; }

    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloaded) { reloaded = true; window.location.reload(); }
    });

    await reg.update();

    setTimeout(() => {
      if (!reloaded) {
        btn.disabled = false;
        btn.textContent = '[ CHECK FOR UPDATE ]';
        showUpdateHint('UP TO DATE');
      }
    }, 2500);
  } catch {
    btn.disabled = false;
    btn.textContent = '[ CHECK FOR UPDATE ]';
    showUpdateHint('ERROR');
  }
}

function showUpdateHint(msg) {
  const hint = $('update-hint');
  hint.textContent = msg;
  setTimeout(() => { hint.textContent = ''; }, 3000);
}

// ── Mode toggle ───────────────────────────────────────────────────────────
function setMode(m, persist = true) {
  const prevMode = mode;

  if (prevMode === 'auto' && m !== 'auto') {
    stopListening();
    stopMicViz();
    window.speechSynthesis.cancel();
  }

  mode = m;
  dbg(`mode→${m}`);

  // Highlight the correct pill
  document.querySelectorAll('.mode-pill').forEach(p =>
    p.classList.toggle('on', p.dataset.mode === m));

  const textArea = $('text-area');
  const pttArea  = $('ptt-area');

  if (m === 'text') {
    textArea.style.display = '';
    pttArea.style.display  = 'none';
    if (phase === 'speaking') stopSpeaking();
    setPhase('idle');
  } else if (m === 'ptt') {
    textArea.style.display = 'none';
    pttArea.style.display  = '';
    setPhase('idle');
    animateIdle();
  } else if (m === 'auto') {
    textArea.style.display = 'none';
    pttArea.style.display  = '';
    setPhase('idle');
    startAutoListen();
  }

  if (persist) save();
}

// ── Text mode ─────────────────────────────────────────────────────────────
function onTextInputChange() {
  const el = $('text-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 96) + 'px';
}

async function onSend() {
  const input = $('text-input');
  const text = input.value.trim();
  if (!text || phase !== 'idle') return;

  input.value = '';
  input.style.height = '';
  setTextInputEnabled(false);

  addBubble('user', text);
  messages.push({ role: 'user', content: text });
  trimHistory();

  const bubble = addBubble('assistant', '');
  bubble.classList.add('streaming');
  setPhase('thinking');

  try {
    const maxTokens = RESPONSE_LENGTHS[cfg.responseLength] ?? 120;
    const reply = await sendMessage(messages, cfg.persona, cfg.apiKey, maxTokens, delta => {
      bubble.textContent += delta;
      scrollToBottom();
    }, cfg.responseLength, profileContext, resumeContext);
    bubble.classList.remove('streaming');
    messages.push({ role: 'assistant', content: reply });
    attachCopyButton(bubble, reply);
    attachSpeakButton(bubble, reply);
    if (messages.length % 10 === 0) autoSave();
  } catch (err) {
    bubble.classList.remove('streaming');
    bubble.textContent = `ERROR: ${err.message}`;
  }

  setPhase('idle');
  setTextInputEnabled(true);
  $('text-input').focus();
}

function setTextInputEnabled(enabled) {
  $('text-input').disabled = !enabled;
  $('send-btn').disabled   = !enabled;
}

// ── PTT mode ──────────────────────────────────────────────────────────────
function onPTTDown() {
  dbg(`↓ m=${mode} ph=${phase}`);
  if (mode === 'auto') {
    if (phase === 'speaking') {
      window.speechSynthesis.cancel();
      stopMicViz();
      setPhase('idle');
      startAutoListen();
    }
    return;
  }
  if (mode !== 'ptt') { dbg(`↓ skip:not-ptt`); return; }
  if (phase === 'speaking') { stopSpeaking(); setPhase('idle'); return; }
  if (phase !== 'idle') { dbg(`↓ skip:ph=${phase}`); return; }

  pttHeld = true;
  setPhase('listening');
  startMicViz();
  dbg('STT:start');

  startListening({
    onResult: async transcript => {
      dbg(`STT:result "${transcript.slice(0, 20)}"`);
      stopMicViz();
      await processPTTResult(transcript);
    },
    onError: err => {
      dbg(`STT:err ${err}`);
      stopMicViz();
      setPTTStatus(`> ERROR: ${err.toUpperCase()}`);
      setTimeout(() => setPhase('idle'), 2000);
    },
    onEnd: () => {
      dbg(`STT:end ph=${phase}`);
      if (phase === 'listening') { stopMicViz(); setPhase('idle'); }
    },
  });
}

function onPTTUp() {
  dbg(`↑ m=${mode} held=${pttHeld} ph=${phase}`);
  if (mode !== 'ptt' || !pttHeld) return;
  pttHeld = false;
  if (phase === 'listening') stopListening();
}

async function processPTTResult(transcript) {
  addBubble('user', transcript);
  messages.push({ role: 'user', content: transcript });
  trimHistory();

  setPhase('thinking');

  try {
    const maxTokens = RESPONSE_LENGTHS[cfg.responseLength] ?? 120;
    // Stream the LLM response and pre-fetch TTS blobs as each sentence completes,
    // so playback can start immediately after LLM finishes rather than waiting for TTS.
    const blobPromises = [];
    let streamBuf = '';
    const reply = await sendMessage(messages, cfg.persona, cfg.apiKey, maxTokens, delta => {
      streamBuf += delta;
      let idx;
      while ((idx = firstSentenceEnd(streamBuf)) !== -1) {
        const sentence = streamBuf.slice(0, idx + 1).trim();
        streamBuf = streamBuf.slice(idx + 2).trimStart();
        if (sentence) blobPromises.push(fetchTTSBlob(sentence, cfg.voice));
      }
    }, cfg.responseLength, profileContext, resumeContext);

    if (streamBuf.trim()) blobPromises.push(fetchTTSBlob(streamBuf.trim(), cfg.voice));
    if (!blobPromises.length) blobPromises.push(fetchTTSBlob(reply, cfg.voice));

    messages.push({ role: 'assistant', content: reply });
    addBubble('assistant', reply);
    if (messages.length % 10 === 0) autoSave();

    setPhase('speaking');
    try {
      await speakBlobs(blobPromises);
    } catch (err) {
      setPTTStatus(`> TTS ERR: ${err.message.slice(0, 24).toUpperCase()}`);
      setTimeout(() => setPhase('idle'), 3000);
      return;
    }
    setPhase('idle');
  } catch (err) {
    setPTTStatus(`> ERROR: ${err.message.slice(0, 30).toUpperCase()}`);
    setTimeout(() => setPhase('idle'), 2500);
  }
}

// ── AUTO mode ─────────────────────────────────────────────────────────────
function startAutoListen() {
  if (mode !== 'auto') return;
  if (phase !== 'idle' && phase !== 'listening') return;

  if (phase !== 'listening') setPhase('listening');

  startListening({
    onResult: async transcript => {
      await processAutoResult(transcript);
    },
    onError: err => {
      if (mode !== 'auto') return;
      dbg(`AUTO:err ${err}`);
      setPTTStatus(`> ERROR: ${err.toUpperCase()}`);
      setPhase('idle');
      setTimeout(() => { if (mode === 'auto') startAutoListen(); }, 2000);
    },
    onEnd: () => {
      if (mode !== 'auto' || phase !== 'listening') return;
      // Stay in listening phase — silently restart without toggling to standby
      setTimeout(() => { if (mode === 'auto') startAutoListen(); }, 150);
    },
  });
}

async function processAutoResult(transcript) {
  if (mode !== 'auto') return;

  addBubble('user', transcript);
  messages.push({ role: 'user', content: transcript });
  trimHistory();

  setPhase('thinking');

  try {
    const maxTokens = RESPONSE_LENGTHS[cfg.responseLength] ?? 120;
    const blobPromises = [];
    let streamBuf = '';
    const reply = await sendMessage(messages, cfg.persona, cfg.apiKey, maxTokens, delta => {
      streamBuf += delta;
      let idx;
      while ((idx = firstSentenceEnd(streamBuf)) !== -1) {
        const sentence = streamBuf.slice(0, idx + 1).trim();
        streamBuf = streamBuf.slice(idx + 2).trimStart();
        if (sentence) blobPromises.push(fetchTTSBlob(sentence, cfg.voice));
      }
    }, cfg.responseLength, profileContext, resumeContext);

    if (streamBuf.trim()) blobPromises.push(fetchTTSBlob(streamBuf.trim(), cfg.voice));
    if (!blobPromises.length) blobPromises.push(fetchTTSBlob(reply, cfg.voice));

    messages.push({ role: 'assistant', content: reply });
    addBubble('assistant', reply);
    if (messages.length % 10 === 0) autoSave();

    if (mode !== 'auto') return;

    setPhase('speaking');
    try { await speakBlobs(blobPromises); } catch {}
    if (mode !== 'auto') return;
    setPhase('idle');
    startAutoListen();
  } catch (err) {
    if (mode !== 'auto') return;
    setPTTStatus(`> ERROR: ${err.message.slice(0, 30).toUpperCase()}`);
    setTimeout(() => { if (mode === 'auto') { setPhase('idle'); startAutoListen(); } }, 2500);
  }
}

// ── Phase / status ────────────────────────────────────────────────────────
function setPhase(p) {
  phase = p;

  if (mode === 'ptt' || mode === 'auto') {
    const pttLabels = {
      idle:      '> HOLD TO TALK',
      listening: '> LISTENING...',
      thinking:  '> THINKING...',
      speaking:  '> TAP TO STOP',
    };
    const autoLabels = {
      idle:      '> STAND BY...',
      listening: '> LISTENING...',
      thinking:  '> THINKING...',
      speaking:  '> TAP TO INTERRUPT',
    };
    setPTTStatus((mode === 'auto' ? autoLabels : pttLabels)[p] ?? '');

    cancelAnim();
    if (p === 'idle')                          animateIdle();
    if (p === 'listening' && mode === 'auto')  animateListen();
    if (p === 'thinking')                      animateThink();
    if (p === 'speaking')                      animateSpeak();
  }
}

function setPTTStatus(t) {
  const el = $('ptt-status');
  if (el) el.textContent = t;
}

// ── Chat rendering ────────────────────────────────────────────────────────
function addBubble(role, text) {
  const empty = $('chat-empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  if (role === 'assistant' && text) {
    attachCopyButton(bubble, text);
    if (mode === 'text') attachSpeakButton(bubble, text);
  }
  row.appendChild(bubble);
  $('chat-history').appendChild(row);
  scrollToBottom();
  return bubble;
}

function attachCopyButton(bubble, text) {
  if (bubble.querySelector('.copy-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.setAttribute('aria-label', 'Copy');
  btn.textContent = '⧉';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text ?? bubble.dataset.text ?? '').then(() => {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⧉'; }, 1500);
    });
  });
  bubble.dataset.text = text ?? bubble.textContent;
  bubble.appendChild(btn);
}

function attachSpeakButton(bubble, text) {
  if (bubble.querySelector('.speak-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'speak-btn';
  btn.setAttribute('aria-label', 'Read aloud');
  btn.textContent = '▶';
  let active = false;
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (active) {
      stopSpeaking();
      btn.textContent = '▶';
      btn.classList.remove('speaking');
      active = false;
    } else {
      await unlockTTS(); // resume AudioContext within the gesture before any awaits
      playDing();        // audible tone activates OS audio routing before async fetch
      const t = text ?? bubble.dataset.text ?? bubble.textContent;
      btn.textContent = '◼';
      btn.classList.add('speaking');
      active = true;
      try {
        await speak(t, cfg.voice, () => {}, () => {
          btn.textContent = '▶';
          btn.classList.remove('speaking');
          active = false;
        });
      } catch (err) {
        console.error('[TTS]', err);
        btn.textContent = '▶';
        btn.classList.remove('speaking');
        active = false;
      }
    }
  });
  bubble.appendChild(btn);
}


function renderAllMessages() {
  const history = $('chat-history');
  history.innerHTML = '';
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.id = 'chat-empty';
    empty.textContent = '// SAY SOMETHING';
    history.appendChild(empty);
    return;
  }
  messages.forEach(m => addBubble(m.role, m.content));
}

function scrollToBottom() {
  const el = $('chat-history');
  if (el) el.scrollTop = el.scrollHeight;
}

function trimHistory() {
  if (messages.length > 40) messages = messages.slice(-40);
}

// ── Waveform animations ───────────────────────────────────────────────────
function getBars() { return $('bars').querySelectorAll('.bar'); }

function cancelAnim() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
}

function animateIdle() {
  const bars = getBars();
  const t0 = Date.now();
  function tick() {
    const t = (Date.now() - t0) * 0.001;
    bars.forEach((b, i) => {
      b.style.height  = (3 + Math.sin(t * 0.8 + i * 0.35) * 2) + 'px';
      b.style.opacity = '0.25';
    });
    animFrame = requestAnimationFrame(tick);
  }
  tick();
}

function animateListen() {
  // All bars pulse together — obvious motion, clearly distinct from idle
  const bars = getBars();
  const t0 = Date.now();
  function tick() {
    const t = (Date.now() - t0) * 0.001;
    const breathe = 0.5 + 0.5 * Math.sin(t * 2.5); // ~2.5s period
    const h = (4 + breathe * 26) + 'px';            // 4px → 30px
    const o = String(0.3 + breathe * 0.7);           // 0.3 → 1.0
    bars.forEach(b => { b.style.height = h; b.style.opacity = o; });
    animFrame = requestAnimationFrame(tick);
  }
  tick();
}

function animateThink() {
  const bars = getBars();
  const t0 = Date.now();
  const mid = BAR_COUNT / 2;
  function tick() {
    const t = (Date.now() - t0) * 0.003;
    bars.forEach((b, i) => {
      const dist = Math.abs(i - mid) / mid;
      const v = Math.max(0, Math.sin(t - dist * 3));
      b.style.height  = (2 + v * 20) + 'px';
      b.style.opacity = String(0.2 + 0.8 * v);
    });
    animFrame = requestAnimationFrame(tick);
  }
  tick();
}

function animateSpeak() {
  const bars = getBars();
  const t0 = Date.now();
  function tick() {
    const t = (Date.now() - t0) * 0.003;
    bars.forEach((b, i) => {
      b.style.height  = (4 + Math.abs(Math.sin(t * 1.1 + i * 0.28)) * 36) + 'px';
      b.style.opacity = '1';
    });
    animFrame = requestAnimationFrame(tick);
  }
  tick();
}

function animateMic(data) {
  const bars = getBars();
  const step = Math.floor(data.length / BAR_COUNT);
  bars.forEach((b, i) => {
    const val = data[i * step] / 255;
    b.style.height  = (3 + val * 44) + 'px';
    b.style.opacity = String(0.3 + val * 0.7);
  });
}

// ── Mic visualisation ─────────────────────────────────────────────────────
async function startMicViz() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micAudioCtx = new AudioContext();
    const src = micAudioCtx.createMediaStreamSource(micStream);
    micAnalyser = micAudioCtx.createAnalyser();
    micAnalyser.fftSize = 128;
    src.connect(micAnalyser);
    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    cancelAnim();
    function tick() {
      micAnalyser.getByteFrequencyData(data);
      animateMic(data);
      animFrame = requestAnimationFrame(tick);
    }
    tick();
  } catch {
    const bars = getBars();
    cancelAnim();
    function tick() {
      bars.forEach(b => {
        b.style.height  = (3 + Math.random() * 30) + 'px';
        b.style.opacity = '1';
      });
      animFrame = requestAnimationFrame(tick);
    }
    tick();
  }
}

function stopMicViz() {
  cancelAnim();
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (micAudioCtx) { micAudioCtx.close(); micAudioCtx = null; }
  micAnalyser = null;
}

// ── UI helpers ────────────────────────────────────────────────────────────
function dbg(msg) {
  const el = $('dbg-line');
  if (el) el.textContent = msg;
  console.log('[B19]', msg);
}

function setProgress(n) {
  $('progress-fill').style.width = n + '%';
  $('progress-pct').textContent  = n + '%';
}
function setLoadMsg(t) { $('load-msg').textContent = t; }

function flash(id, msg) {
  const el = $(id);
  const prev = el.placeholder;
  el.placeholder = msg;
  el.classList.add('err');
  setTimeout(() => { el.placeholder = prev; el.classList.remove('err'); }, 2000);
}

// ── Session management ────────────────────────────────────────────────────
function startNewSession() {
  currentSession = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  messages = [];
  hideSummaryHeader();
}

function getSessionIndex() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY)) ?? []; }
  catch { return []; }
}

async function autoSave() {
  if (!currentSession) return;
  currentSession.updatedAt = new Date().toISOString();

  if (!currentSession.title) {
    currentSession.title = await generateSessionTitle();
  }

  localStorage.setItem(`b19_session_${currentSession.id}`, JSON.stringify({
    ...currentSession,
    messages,
    persona: cfg.persona,
    responseLength: cfg.responseLength,
  }));

  const index = getSessionIndex().filter(s => s.id !== currentSession.id);
  index.unshift({ id: currentSession.id, title: currentSession.title, startedAt: currentSession.startedAt, updatedAt: currentSession.updatedAt });
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(index));

  showSummaryHeader(currentSession.title, currentSession.updatedAt);

  // Cloud sync to Google Sheets if configured
  if (isMemoryEnabled()) {
    generateSummary(messages, cfg.apiKey).then(({ title, summary }) => {
      const date = new Date().toISOString().slice(0, 10);
      saveConversation(currentSession.id, date, title || currentSession.title || 'Conversation', summary || '').catch(() => {});
    }).catch(() => {});
  }
}

async function generateSessionTitle() {
  try {
    const transcript = messages.slice(0, 10)
      .map(m => `${m.role === 'user' ? 'U' : 'A'}: ${m.content.slice(0, 100)}`)
      .join('\n');
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 15,
        temperature: 0.5,
        messages: [
          { role: 'system', content: 'Give this conversation a title: 3-5 words, ALL CAPS, no punctuation, no quotes.' },
          { role: 'user', content: transcript },
        ],
      }),
    });
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? '').trim().slice(0, 40) || 'UNTITLED';
  } catch {
    return 'UNTITLED';
  }
}

function restoreSession(id) {
  try {
    const data = JSON.parse(localStorage.getItem(`b19_session_${id}`));
    if (!data) return;
    currentSession = { id: data.id, title: data.title, startedAt: data.startedAt, updatedAt: data.updatedAt };
    messages = data.messages ?? [];
    renderAllMessages();
    showSummaryHeader(data.title, data.updatedAt);
    closeSidebar();
  } catch {}
}

// ── Summary header ────────────────────────────────────────────────────────
function showSummaryHeader(title, isoDate) {
  const el = $('session-summary');
  if (!el) return;
  $('summary-title').textContent = '// ' + (title ?? 'UNTITLED');
  $('summary-date').textContent  = formatDate(isoDate);
  el.style.display = '';
}

function hideSummaryHeader() {
  const el = $('session-summary');
  if (el) el.style.display = 'none';
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function openSidebar() {
  renderSessionList();
  $('sidebar').classList.add('open');
  $('sidebar-overlay').classList.add('open');
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('open');
}

function renderSessionList() {
  const list = $('session-list');
  const index = getSessionIndex();
  list.innerHTML = '';

  if (!index.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = 'NO SAVED SESSIONS YET';
    list.appendChild(empty);
    return;
  }

  index.forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `<div class="session-item-title">${s.title ?? 'UNTITLED'}</div><div class="session-item-date">${formatDate(s.updatedAt)}</div>`;
    item.addEventListener('click', () => restoreSession(s.id));
    list.appendChild(item);
  });
}


// ── Memory ────────────────────────────────────────────────────────────────

async function initMemory() {
  if (!cfg.memoryUrl) return;
  setMemoryURL(cfg.memoryUrl);
  try {
    const profile = await getProfile();
    profileContext = profile.system_prompt || '';
    if (profileContext) {
      const banner = $('context-banner');
      banner.style.display = '';
      banner.innerHTML = '<div class="context-banner-label">// PROFILE ACTIVE</div>' +
        `<div class="context-banner-text">${escHtml(profileContext)}</div>`;
    }
  } catch {}
}

async function runCheckin() {
  showScreen('main');
  const msg = "Quick check-in — is there anything about the way I've been working with you that you'd like to adjust? Tone, topics, habits, anything.";
  addBubble('assistant', msg);
  messages.push({ role: 'assistant', content: msg });
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Service worker ────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── App visibility / audio recovery ───────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (phase === 'listening') {
      stopListening();
      stopMicViz();
      setPhase('idle');
    }
  } else {
    stopSpeaking();
    if (micAudioCtx?.state === 'suspended') micAudioCtx.resume().catch(() => {});
    setMode('text');
  }
});

// ── Go ────────────────────────────────────────────────────────────────────
boot();
