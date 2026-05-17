import { sendMessage, RESPONSE_LENGTHS } from './llm.js';
import { initTTS, speak, stopSpeaking, isTTSReady } from './tts.js';
import { isSupported, startListening, stopListening } from './stt.js';

// ── Constants ─────────────────────────────────────────────────────────────
const STORAGE = {
  KEY:             'b19_key',
  PERSONA:         'b19_persona',
  MODE:            'b19_mode',
  RESPONSE_LENGTH: 'b19_response_length',
  VOICE:           'b19_voice',
};
const SESSIONS_KEY = 'b19_sessions';
const BAR_COUNT = 28;

// ── App State ─────────────────────────────────────────────────────────────
let mode  = 'text'; // 'text' | 'ptt' | 'auto'
let phase = 'idle'; // 'idle' | 'listening' | 'thinking' | 'speaking'
let messages = [];
let currentSession = null;
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
  voice:          localStorage.getItem(STORAGE.VOICE)           || 'en-US-female',
};

// ── DOM ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  settings: $('scr-settings'),
  loading:  $('scr-loading'),
  main:     $('scr-main'),
};

// ── Boot ──────────────────────────────────────────────────────────────────
function unlockAudio() {
  // Play a silent WebAudio buffer to unlock the iOS audio session for
  // speechSynthesis speaker output before any user interaction is needed.
  try {
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    src.onended = () => ctx.close();
  } catch {}
}

let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !window.speechSynthesis) return;
  speechUnlocked = true;
  unlockAudio();
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0.001;
  u.rate   = 0.1;
  const voices = window.speechSynthesis.getVoices();
  u.voice = voices.find(v => v.name === cfg.voice) ?? voices.find(v => v.lang.startsWith('en')) ?? null;
  window.speechSynthesis.speak(u);
}

function boot() {
  startNewSession();
  buildBars();
  restoreSettings();
  setupListeners();
  setupViewport();
  unlockAudio();

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

const VOICE_BLOCKLIST = new Set([
  'Albert','Bad News','Bahh','Bells','Boing','Bubbles','Cellos','Deranged',
  'Fred','Good News','Hysterical','Jester','Junior','Kathy','Organ',
  'Pipe Organ','Princess','Ralph','Superstar','Trinoids','Whisper',
  'Wobble','Zarvox',
]);

function populateVoices() {
  const sel = $('settings-voice');
  if (!sel) return;
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const english = voices.filter(v => v.lang.startsWith('en') && !VOICE_BLOCKLIST.has(v.name));
  const list = english.length ? english : voices.filter(v => !VOICE_BLOCKLIST.has(v.name));
  if (!list.length) return;
  sel.innerHTML = '';
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.name;
    o.selected = v.name === cfg.voice;
    sel.appendChild(o);
  });
}

function populateVoicesWithRetry() {
  populateVoices();
  if ($('settings-voice')?.options.length) return;
  // iOS often needs a moment after a user gesture before getVoices() returns results
  let attempts = 0;
  const t = setInterval(() => {
    populateVoices();
    if ($('settings-voice')?.options.length || ++attempts >= 10) clearInterval(t);
  }, 250);
}

function restoreSettings() {
  if (cfg.apiKey) $('api-key').value = cfg.apiKey;

  document.querySelectorAll('.p-btn:not(.rl-btn)').forEach(b =>
    b.classList.toggle('on', b.dataset.p === cfg.persona));

  document.querySelectorAll('.rl-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.rl === cfg.responseLength));

  populateVoicesWithRetry();
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = populateVoices;
  }

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
  populateVoicesWithRetry();
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
}

// ── Event Listeners ───────────────────────────────────────────────────────
function setupListeners() {
  $('init-btn').addEventListener('click', onInit);
  $('gear-btn').addEventListener('click', showSettings);
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
  cfg.voice          = $('settings-voice').value || 'en-US-female';
  save();
  unlockSpeech();
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
  unlockSpeech();

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
    }, cfg.responseLength);
    bubble.classList.remove('streaming');
    messages.push({ role: 'assistant', content: reply });
    attachCopyButton(bubble, reply);
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

  unlockSpeech();

  // On iOS, speechSynthesis called from async callbacks requires the audio
  // session to be active. Queue a silent keep-alive utterance during the
  // gesture so the session stays open through STT + LLM wait.
  try {
    const ka = new SpeechSynthesisUtterance('waiting waiting waiting waiting waiting waiting waiting waiting waiting waiting');
    ka.volume = 0.001;
    ka.rate   = 0.1;
    window.speechSynthesis.speak(ka);
  } catch {}

  // Also unlock WebAudio session so iOS routes speech to speaker
  try {
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    src.onended = () => ctx.close();
  } catch {}

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
    // PTT: no streaming — wait for full reply then speak once (iOS TTS reliability)
    const reply = await sendMessage(messages, cfg.persona, cfg.apiKey, maxTokens, null, cfg.responseLength);
    messages.push({ role: 'assistant', content: reply });
    addBubble('assistant', reply);
    if (messages.length % 10 === 0) autoSave();

    setPhase('speaking');
    // Cancel keep-alive and speak synchronously in the same tick — iOS requires this
    window.speechSynthesis.cancel();
    const voices = window.speechSynthesis.getVoices();
    const utter = new SpeechSynthesisUtterance(reply);
    utter.voice  = voices.find(v => v.name === cfg.voice) ?? voices.find(v => v.lang.startsWith('en')) ?? null;
    utter.rate   = 1.05;
    utter.volume = 1.0;
    utter.lang   = 'en-US';
    utter.onend  = () => setPhase('idle');
    utter.onerror = e => {
      setPTTStatus(`> TTS ERR: ${e.error}`);
      setTimeout(() => setPhase('idle'), 3000);
    };
    window.speechSynthesis.speak(utter);
  } catch (err) {
    setPTTStatus(`> ERROR: ${err.message.slice(0, 30).toUpperCase()}`);
    setTimeout(() => setPhase('idle'), 2500);
  }
}

// ── AUTO mode ─────────────────────────────────────────────────────────────
function startAutoListen() {
  if (mode !== 'auto' || phase !== 'idle') return;

  setPhase('listening');
  // No startMicViz() in AUTO — using both getUserMedia and SpeechRecognition
  // simultaneously causes iOS audio session conflicts when switching to PTT.
  // The bar animation from setPhase is sufficient feedback.

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
      setPhase('idle');
      setTimeout(() => { if (mode === 'auto') startAutoListen(); }, 400);
    },
  });
}

async function processAutoResult(transcript) {
  if (mode !== 'auto') return;

  addBubble('user', transcript);
  messages.push({ role: 'user', content: transcript });
  trimHistory();

  setPhase('thinking');

  // Keep audio session alive on iOS while the async LLM call runs
  try {
    const ka = new SpeechSynthesisUtterance('waiting waiting waiting waiting waiting waiting waiting waiting waiting waiting');
    ka.volume = 0.001;
    ka.rate   = 0.1;
    window.speechSynthesis.speak(ka);
  } catch {}

  try {
    const maxTokens = RESPONSE_LENGTHS[cfg.responseLength] ?? 120;
    const reply = await sendMessage(messages, cfg.persona, cfg.apiKey, maxTokens, null, cfg.responseLength);
    messages.push({ role: 'assistant', content: reply });
    addBubble('assistant', reply);
    if (messages.length % 10 === 0) autoSave();

    if (mode !== 'auto') return; // user switched away during LLM call

    setPhase('speaking');
    window.speechSynthesis.cancel();
    const voices = window.speechSynthesis.getVoices();
    const utter  = new SpeechSynthesisUtterance(reply);
    utter.voice  = voices.find(v => v.name === cfg.voice) ?? voices.find(v => v.lang.startsWith('en')) ?? null;
    utter.rate   = 1.05;
    utter.volume = 1.0;
    utter.lang   = 'en-US';
    utter.onend  = () => {
      if (mode !== 'auto') return;
      setPhase('idle');
      startAutoListen();
    };
    utter.onerror = e => {
      if (e.error === 'interrupted' || e.error === 'canceled') {
        if (mode === 'auto') { setPhase('idle'); startAutoListen(); }
        return;
      }
      if (mode !== 'auto') return;
      setPTTStatus(`> TTS ERR: ${e.error}`);
      setTimeout(() => { if (mode === 'auto') { setPhase('idle'); startAutoListen(); } }, 3000);
    };
    window.speechSynthesis.speak(utter);
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
  if (role === 'assistant' && text) attachCopyButton(bubble, text);
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

// ── Service worker ────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Go ────────────────────────────────────────────────────────────────────
boot();
