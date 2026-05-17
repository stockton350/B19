// ── LLM Provider: DeepSeek ───────────────────────────────────────────────
// To swap providers: replace sendMessage() with another implementation.
// Contract: sendMessage(messages, persona, apiKey) → Promise<string>

const MODEL    = 'deepseek-chat';
const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';

const PERSONAS = {
  SPARK: `You are Spark, a warm and curious voice assistant. You are speaking aloud — never write markdown, lists, or bullet points. Use short natural sentences. Ask the occasional follow-up question. Never say "certainly", "absolutely", or "great question". Never mention being an AI unless directly asked.`,
  NOVA:  `You are Nova, a precise and efficient voice assistant. Answer directly and briefly. No pleasantries, no padding. Just the answer, spoken naturally. Never use markdown or lists.`,
  ECHO:  `You are Echo, a voice assistant with a dry wit. Helpful but not obsequious. Occasionally make an observation nobody asked for. Short sentences, natural speech. Never sycophantic. No markdown.`
};

export async function sendMessage(messages, persona, apiKey) {
  const system = PERSONAS[persona] ?? PERSONAS.SPARK;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content
        }))
      ],
      temperature: 0.9,
      max_tokens: 300,
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
