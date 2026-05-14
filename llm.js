// ── LLM Provider: Gemini ──────────────────────────────────────────────────
// To swap providers: replace sendMessage() with another implementation.
// Contract: sendMessage(messages, persona, apiKey) → Promise<string>

const MODEL    = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PERSONAS = {
  SPARK: `You are Spark, a warm and curious voice assistant. You are speaking aloud — never write markdown, lists, or bullet points. Use short natural sentences. Ask the occasional follow-up question. Never say "certainly", "absolutely", or "great question". Never mention being an AI unless directly asked.`,
  NOVA:  `You are Nova, a precise and efficient voice assistant. Answer directly and briefly. No pleasantries, no padding. Just the answer, spoken naturally. Never use markdown or lists.`,
  ECHO:  `You are Echo, a voice assistant with a dry wit. Helpful but not obsequious. Occasionally make an observation nobody asked for. Short sentences, natural speech. Never sycophantic. No markdown.`
};

export async function sendMessage(messages, persona, apiKey) {
  const system = PERSONAS[persona] ?? PERSONAS.SPARK;

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 300,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
