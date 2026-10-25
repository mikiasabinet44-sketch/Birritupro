/**
 * Optional LLM access. Everything in the app works without it; when
 * ANTHROPIC_API_KEY is set the assistant and the re-categoriser can use it.
 *
 * PRIVACY: when enabled, aggregated bookkeeping data (amounts, categories,
 * customer names, invoice numbers) is sent to the Anthropic API to answer a
 * question. Leave the key unset to keep all data on your own server.
 */
export function llmConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function llmModel(): string {
  return process.env.AI_MODEL || "claude-sonnet-5-5";
}

export async function llmComplete(system: string, user: string, maxTokens = 900): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: llmModel(), max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM request failed (${resp.status}) ${text.slice(0, 200)}`);
  }
  const data: any = await resp.json();
  const block = Array.isArray(data.content) ? data.content.find((b: any) => b.type === "text") : null;
  if (!block?.text) throw new Error("LLM returned no text");
  return String(block.text);
}

/** Pulls the first JSON array/object out of a model reply (models sometimes wrap it in prose or code fences). */
export function extractJson<T = unknown>(text: string): T {
  const start = text.search(/[\[{]/);
  if (start < 0) throw new Error("no JSON found in LLM reply");
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
