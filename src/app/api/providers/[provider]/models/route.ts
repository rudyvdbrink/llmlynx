import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { getApiConfig, getOllamaUrl } from "@/server/providers";
import { listApiModels, listOllamaModels } from "@/server/chat/models";
import { jsonError } from "@/server/http";
import { isProviderId, PROVIDER_LABELS } from "@/lib/providers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ provider: string }> };

// GET /api/providers/:provider/models -> { models: string[] }, sorted by name
// Uses the current user's Ollama server or API key. 502 when the provider cannot be reached.
export async function GET(_req: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  if (!isProviderId(provider)) return jsonError("Unknown provider", 404);

  try {
    let models: string[];
    if (provider === "ollama") {
      models = await listOllamaModels(await getOllamaUrl(user.id));
    } else {
      const config = await getApiConfig(user.id, provider);
      if (!config) return jsonError(`No ${PROVIDER_LABELS[provider]} API key. Add one on the account page.`, 403);
      models = await listApiModels(provider, config);
    }
    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err), 502);
  }
}
