# BREAKER ONE NINER // B1-9

> Breaker one niner, do you copy?

A voice-only AI assistant with a retro ASCII terminal aesthetic. Runs entirely in your browser — no backend, no server costs.

## Stack

| Layer | Provider | Swap via |
|-------|----------|----------|
| STT | Web Speech API (browser built-in) | `stt.js` |
| LLM | Gemini 2.0 Flash (free tier) | `llm.js` |
| TTS | Kokoro-js (runs in browser) | `tts.js` |

## Setup (5 minutes)

### 1. Get a free Gemini API key
Go to [aistudio.google.com](https://aistudio.google.com) → Get API key → Create API key.
Free tier: 1,500 requests/day, more than enough for personal use.

### 2. Host on GitHub Pages
```bash
git init
git add .
git commit -m "breaker one niner"
gh repo create breaker-one-niner --private --push
```
Then go to repo Settings → Pages → Deploy from main branch.
Your URL will be: `https://<your-username>.github.io/breaker-one-niner`

### 3. Add to iPhone home screen
Open the URL in Safari → Share → Add to Home Screen → B1-9

### 4. First launch
Enter your Gemini API key when prompted. Stored locally in your browser, never sent anywhere except Gemini's API.

## File structure

```
index.html     ← app shell + all three screens
app.js         ← state machine, UI, conversation loop
llm.js         ← Gemini API (swap to change LLM)
tts.js         ← Kokoro-js (swap to change TTS)
stt.js         ← Web Speech API (swap to change STT)
manifest.json  ← PWA config
sw.js          ← service worker (offline support)
```

## Personas

| Name | Vibe |
|------|------|
| SPARK | Warm, curious, conversational |
| NOVA | Precise, efficient, no fluff |
| ECHO | Dry wit, occasionally opinionated |

## Voices (Kokoro-js)

`af_heart` (default) · `af_bella` · `af_nicole` · `af_sarah`  
`am_michael` · `am_adam` · `bf_emma` · `bm_george`

## Notes

- Requires HTTPS (GitHub Pages provides this)
- Safari on iOS recommended for best Web Speech API support
- First load downloads ~80MB of Kokoro model weights — cached after that
- Conversation history resets on page reload (Phase 2: persistent memory)

## Phase 2 (planned)
- Persistent memory via GitHub Gist
- Remembers facts and preferences across sessions
