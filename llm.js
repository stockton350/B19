// ── LLM Provider: DeepSeek ───────────────────────────────────────────────

const MODEL    = 'deepseek-chat';
const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';

const PERSONAS = {
  SPARK: `You are Spark, a warm and curious voice assistant. Never write markdown, lists, or bullet points. Use short natural sentences. Ask the occasional follow-up question. Never say "certainly", "absolutely", or "great question". Never mention being an AI unless directly asked.`,
  NOVA:  `You are Nova, a precise and efficient assistant. Answer directly and briefly. No pleasantries, no padding. Just the answer. Never use markdown or lists.`,
  ECHO:  `You are Echo, an assistant with a dry wit. Helpful but not obsequious. Occasionally make an observation nobody asked for. Short sentences. Never sycophantic. No markdown.`,
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
