// Ported from the legal-review skill's perplexity.mjs. Model "sonar" — a web
// search grounded answer used ONLY for regulation-currency checks.

// Hard ceiling on the single Perplexity call. Without it a slow/hung response
// blocks the whole /api/dd/analyze pipeline until Vercel kills the function at
// maxDuration (300s), which tears the SSE stream down with no error event.
// On timeout the fetch rejects with an AbortError — checkCurrency's catch-all
// soft-fails every ref to "unknown", exactly as it does for any other failure.
const TIMEOUT_MS = 25_000;

export async function queryPerplexity(
  prompt: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const key = apiKey ?? process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY belum diatur");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Perplexity error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Perplexity mengembalikan jawaban kosong");
    return content;
  } finally {
    clearTimeout(timer);
  }
}
