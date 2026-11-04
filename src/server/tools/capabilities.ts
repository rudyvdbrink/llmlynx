// What an Ollama model can do, such as "tools" and "vision", from Ollama's
// POST /api/show. Kept for a while, since every chat with an agent asks.

const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;

const cache = new Map<string, { at: number; capabilities: string[] }>();

/** The model's capabilities, or null when Ollama cannot be reached or does not say. */
export async function getOllamaCapabilities(baseUrl: string, model: string): Promise<string[] | null> {
  const key = `${baseUrl}\n${model}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.capabilities;

  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const raw = (await res.json().catch(() => ({}))) as { capabilities?: unknown };
    if (!Array.isArray(raw.capabilities)) return null;
    const capabilities = raw.capabilities.filter((c): c is string => typeof c === "string");
    cache.set(key, { at: Date.now(), capabilities });
    return capabilities;
  } catch {
    return null;
  }
}
