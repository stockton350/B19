import { sendMessage } from './llm.js';
import { initTTS, speak, stopSpeaking, isTTSReady, getVoices, warmAudioContext, setTTSApiKey } from './tts.js';
import { isSupported, startListening, stopListening } from './stt.js';

// ── Constants ─────────────────────────────────────────────────────────────
const S = { SETTINGS: 'settings', LOADING: 'loading', IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking' };
const STORAGE = { KEY: 'b19_key', TTS_KEY: 'b19_tts_key', PERSONA: 'b19_persona', VOICE: 'b19_voice', MODE: 'b19_mode' };
const BAR_COUNT = 28;

// ── App State ─────────────────────────────────────────────────────────────
let state = S.SETTINGS;
let messages = [];
let pttHeld = false;
let animFrame = null;
let micAnalyser = null;
let micStream = null;

const cfg = {
  apiKey:  localStorage.getItem(STORAGE.KEY)     || '',
  ttsKey:  localStorage.getItem(STORAGE.TTS_KEY) || '',
  persona: localStorage.getItem(STORAGE.PERSONA) || 'SPARK',
  voice:   localStorage.getItem(STORAGE.VOICE)   || '',
  mode:    localStorage.getItem(STORAGE.MODE)     || 'AUTO',
};

// ── DOM ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens  = { settings: $('scr-settings'), loading: $('scr-loading'), main: $('scr-main') };
const elStatus = $('status');
const elBars   = $('bars');
const elFooterL = $('footer-l');
const elFooterR = $('footer-r');
const elProgress = $('progress-fill');
const elProgressPct = $('progress-pct');
const elLoadMsg = $('load-msg');

// ── Provider label ─────────────────────────────────────────────────────────
// Derives a short label from the keys that were actually saved,
// reflecting what the app is really using at runtime.
function providerLabel() {
  const llm = cfg.apiKey ? 'DEEPSEEK' : '—';
  const tts = cfg.ttsKey ? 'OPENAI TTS' : 'BROWSER TTS';
  return `${llm} · ${tts}`;
}

// ── Init ──────────────────────────────────────────────────────────────────
function boot() {
  if (!isSupported()) {
    alert('Speech recognition is not supported in this browser.\nPlease use Safari on iOS or Chrome on desktop.');
    return;
  }

  buildBars();
  populateVoices();
  restoreSettings();
  setupListeners();

  // Pass the TTS key (OpenAI) separately from the LLM key (DeepSeek)
  setTTSApiKey(cfg.ttsKey || cfg.apiKey);

  // Re-populate voices now that provider is known
  populateVoices();

  cfg.apiKey ? showLoading() : showSettings();
}

function buildBars() {
  elBars.innerHTML = '';
  for (let i = 0; i < BAR_COUNT; i++) {
    const b = document.createElement('div');
    b.className = 'bar';
    elBars.appendChild(b);
  }
}

function populateVoices() {
  const sel = $('settings-voice');
  sel.innerHTML = '';
  getVoices().forEach(v => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.label;
    if (v.id === cfg.voice) o.selected = true;
    sel.appendChild(o);
  });
}

function restoreSettings() {
  if (cfg.apiKey) $('api-key').value = cfg.apiKey;
  if (cfg.ttsKey) $('tts-key').value = cfg.ttsKey;
  document.querySelectorAll('.p-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.p === cfg.persona));
  setMode(cfg.mode, false);
  updateSettingsFooter();
}

function updateSettingsFooter() {
  const el = $('settings-footer-r');
  if (el) el.textContent = providerLabel();
}

// ── Screen routing ────────────────────────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
}

function showSettings() {
  state = S.SETTINGS;
  showScreen('settings');
}

async function showLoading() {
  state = S.LOADING;
  showScreen('loading');
  setLoadMsg('CONNECTING...');
  setProgress(0);

  // Update loading footer with provider info
  const lfl = $('load-footer-l');
  if (lfl) lfl.textContent = providerLabel();

  try {
    await initTTS(({ status, progress, file }) => {
      if (status === 'progress') {
        setProgress(Math.round(progress));
        setLoadMsg(`LOADING ${file?.split('/').pop()?.toUpperCase() ?? 'MODELS'}...`);
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
  state = S.IDLE;
  showScreen('main');
  setStatus('> READY');
  setFooterR('●');

  // Set live provider label in main footer
  elFooterL.textContent = providerLabel();

  animateIdle();
}

// ── Event Listeners ───────────────────────────────────────────────────────
function setupListeners() {
  $('init-btn').addEventListener('click', onInit);
  $('gear-btn').addEventListener('click', showSettings);

  document.querySelectorAll('.p-btn').forEach(b =>
    b.addEventListener('click', () => setPersona(b.dataset.p)));

  $('settings-voice').addEventListener('change', e => setVoice(e.target.value));

  document.querySelectorAll('.mode-btn').forEach(b =>
    b.addEventListener('click', () => setMode(b.dataset.m)));

  // Update settings footer live as keys are typed
  $('api-key').addEventListener('input', updateSettingsFooter);
  $('tts-key').addEventListener('input', updateSettingsFooter);

  // Tap / PTT on main body
  const touch = $('main-body');
  touch.addEventListener('click',      onBodyTap);
  touch.addEventListener('mousedown',  onBodyDown);
  touch.addEventListener('mouseup',    onBodyUp);
  touch.addEventListener('touchstart', e => { e.preventDefault(); onBodyDown(); }, { passive: false });
  touch.addEventListener('touchend',   e => { e.preventDefault(); onBodyUp();   }, { passive: false });
}

function onInit() {
  const key    = $('api-key').value.trim();
  const ttsKey = $('tts-key').value.trim();
  if (!key) { flash('api-key', 'ENTER YOUR DEEPSEEK KEY'); return; }
  cfg.apiKey  = key;
  cfg.ttsKey  = ttsKey;
  cfg.persona = document.querySelector('.p-btn.on')?.dataset.p || 'SPARK';
  cfg.voice   = $('settings-voice').value;
  save();
  setTTSApiKey(cfg.ttsKey || cfg.apiKey);
  populateVoices();
  showLoading();
}

function onBodyTap() {
  console.log("[tap] mode:", cfg.mode, "state:", state);
  warmAudioContext(); // unlock AudioContext immediately on gesture
  if (cfg.mode === 'PTT') return;
  if (state === S.IDLE)      startSession();
  else if (state === S.SPEAKING) { stopSpeaking(); transitionTo(S.IDLE); }
  else if (state === S.LISTENING) cancelListen();
}

function onBodyDown() {
  warmAudioContext(); // unlock AudioContext immediately on gesture
  if (cfg.mode !== 'PTT') return;
  pttHeld = true;
  if (state === S.IDLE || state === S.SPEAKING) {
    if (state === S.SPEAKING) stopSpeaking();
    startSession();
  }
}

function onBodyUp() {
  if (cfg.mode !== 'PTT' || !pttHeld) return;
  pttHeld = false;
  if (state === S.LISTENING) stopListening();
}

// ── Session flow ──────────────────────────────────────────────────────────
function startSession() {
  console.log("[session] starting...");
  transitionTo(S.LISTENING);
  startMicViz();

  console.log('[session] calling startListening');
  startListening({
    onResult: async transcript => {
      console.log('[stt] transcript:', transcript);
      stopMicViz();
      transitionTo(S.THINKING);
      messages.push({ role: 'user', content: transcript });
      if (messages.length > 40) messages = messages.slice(-40);

      try {
        console.log('[llm] calling deepseek...');
        const reply = await sendMessage(messages, cfg.persona, cfg.apiKey);
        messages.push({ role: 'assistant', content: reply });
        console.log('[llm] reply:', reply.slice(0,60));
        transitionTo(S.SPEAKING);
        console.log('[tts] speaking...');
        await speak(reply, cfg.voice, null, () => {
          if (cfg.mode === 'AUTO') {
            setTimeout(startSession, 500);
          } else {
            transitionTo(S.IDLE);
          }
        });
      } catch (err) {
        setStatus(`> ERROR: ${err.message.toUpperCase().slice(0, 40)}`);
        setTimeout(() => transitionTo(S.IDLE), 3000);
      }
    },
    onError: err => {
      console.log('[stt] error:', err);
      stopMicViz();
      setStatus(`> MIC ERROR: ${err.toUpperCase()}`);
      setTimeout(() => transitionTo(S.IDLE), 2000);
    },
    onEnd: () => {
      console.log('[stt] ended, state:', state);
      if (state === S.LISTENING) transitionTo(S.IDLE);
    }
  });
}

function cancelListen() {
  stopListening();
  stopMicViz();
  transitionTo(S.IDLE);
}

// ── State transitions ─────────────────────────────────────────────────────
function transitionTo(s) {
  state = s;
  cancelAnim();

  const labels = {
    [S.IDLE]:      '> READY',
    [S.LISTENING]: '> LISTENING...',
    [S.THINKING]:  '> THINKING...',
    [S.SPEAKING]:  '> SPEAKING...',
  };
  setStatus(labels[s] ?? '');

  const hints = {
    [S.IDLE]:      cfg.mode === 'PTT' ? 'HOLD TO TALK' : 'TAP TO TALK',
    [S.LISTENING]: cfg.mode === 'PTT' ? 'RELEASE TO SEND' : 'TAP TO CANCEL',
    [S.THINKING]:  'PROCESSING',
    [S.SPEAKING]:  'TAP TO INTERRUPT',
  };
  setFooterR(hints[s] ?? '');

  if (s === S.IDLE)      animateIdle();
  if (s === S.THINKING)  animateThink();
  if (s === S.SPEAKING)  animateSpeak();
}

// ── Waveform animations ───────────────────────────────────────────────────
function getBars() { return elBars.querySelectorAll('.bar'); }

function cancelAnim() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
}

function animateIdle() {
  const bars = getBars();
  const t0 = Date.now();
  function tick() {
    const t = (Date.now() - t0) * 0.001;
    bars.forEach((b, i) => {
      const h = 3 + Math.sin(t * 0.8 + i * 0.35) * 2;
      b.style.height = h + 'px';
      b.style.opacity = '0.25';
    });
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
      const h = 2 + Math.max(0, Math.sin(t - dist * 3)) * 20;
      b.style.height = h + 'px';
      b.style.opacity = String(0.2 + 0.8 * Math.max(0, Math.sin(t - dist * 3)));
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
      const h = 4 + Math.abs(Math.sin(t * 1.1 + i * 0.28)) * 36;
      b.style.height = h + 'px';
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
    b.style.height = (3 + val * 44) + 'px';
    b.style.opacity = String(0.3 + val * 0.7);
  });
}

// ── Mic visualisation ─────────────────────────────────────────────────────
async function startMicViz() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser();
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
    const t0 = Date.now();
    const bars = getBars();
    cancelAnim();
    function tick() {
      bars.forEach(b => {
        b.style.height = (3 + Math.random() * 30) + 'px';
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
  micAnalyser = null;
}

// ── Settings helpers ──────────────────────────────────────────────────────
function setPersona(p) {
  cfg.persona = p;
  document.querySelectorAll('.p-btn').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  save();
}

function setVoice(v) { cfg.voice = v; save(); }

function setMode(m, persist = true) {
  cfg.mode = m;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  if (persist) save();
}

function save() {
  localStorage.setItem(STORAGE.KEY,     cfg.apiKey);
  localStorage.setItem(STORAGE.TTS_KEY, cfg.ttsKey);
  localStorage.setItem(STORAGE.PERSONA, cfg.persona);
  localStorage.setItem(STORAGE.VOICE,   cfg.voice);
  localStorage.setItem(STORAGE.MODE,    cfg.mode);
}

// ── UI helpers ────────────────────────────────────────────────────────────
function setStatus(t)    { elStatus.textContent = t; }
function setFooterR(t)   { elFooterR.textContent = t; }
function setProgress(n)  { elProgress.style.width = n + '%'; elProgressPct.textContent = n + '%'; }
function setLoadMsg(t)   { elLoadMsg.textContent = t; }

function flash(id, msg) {
  const el = $(id);
  const prev = el.placeholder;
  el.placeholder = msg;
  el.classList.add('err');
  setTimeout(() => { el.placeholder = prev; el.classList.remove('err'); }, 2000);
}

// ── Register service worker ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Go ────────────────────────────────────────────────────────────────────
boot();
