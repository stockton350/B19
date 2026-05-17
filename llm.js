// ── LLM Provider: DeepSeek ───────────────────────────────────────────────

const MODEL    = 'deepseek-chat';
const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';

const VOICE_CTX = `You are a voice assistant. The user speaks to you — their words arrive as transcribed speech. Your responses are read aloud, so write exactly as you would speak: no markdown, no lists, no bullet points, no asterisks. Never say "I cannot hear you." Never mention being an AI unless the user directly and sincerely asks. Never open with "Certainly", "Absolutely", "Of course", "Great question", or "Sure".`;

const PERSONAS = {
  SPARK: `${VOICE_CTX} You are Spark — fast-thinking, warm, genuinely curious. Short punchy sentences. Ask one follow-up question when it feels natural. Never over-explain. If you don't know something, admit it briefly and move on.`,
  NOVA:  `${VOICE_CTX} You are Nova — precise, direct, zero padding. One or two sentences unless more is genuinely needed. No pleasantries. No sign-off phrases. Just the answer. If the user is vague, make a reasonable assumption and state it rather than asking for clarification.`,
  ECHO:  `${VOICE_CTX} You are Echo — dry, observational, unhurried. Answer helpfully but never enthusiastically. Occasionally note something the user didn't ask about if it's worth saying. Short sentences. Low tolerance for obvious questions but you answer them anyway, sometimes with a brief dry comment first.`,
};

const LENGTH_INSTRUCTIONS = {
  BRIEF:   'Keep every response to 1-2 sentences maximum.',
  CONCISE: 'Keep every response to 3-4 sentences maximum.',
  VERBOSE: 'Respond fully and thoroughly with as much detail as is useful.',
};

export const RESPONSE_LENGTHS = { BRIEF: 80, CONCISE: 120, VERBOSE: 250 };

// onChunk: optional callback for streaming — if provided, streams and calls onChunk(delta)
// returns the full reply string either way
export async function sendMessage(messages, persona, apiKey, maxTokens = 120, onChunk = null, responseLength = 'CONCISE') {
  const lengthRule = LENGTH_INSTRUCTIONS[responseLength] ?? LENGTH_INSTRUCTIONS.CONCISE;
  const system = (PERSONAS[persona] ?? PERSONAS.SPARK) + ' ' + lengthRule;
  const stream = !!onChunk;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      ],
      temperature: 0.9,
      max_tokens: maxTokens,
      stream,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  if (!stream) {
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  // SSE streaming
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // hold incomplete line for next chunk
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content ?? '';
        if (delta) { full += delta; onChunk(delta); }
      } catch {}
    }
  }

  return full;
}
