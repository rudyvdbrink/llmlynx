import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { listProviderModels } from "@/server/chat/models";
import { jsonError } from "@/server/http";
import { isProviderId, PROVIDER_LABELS } from "@/lib/providers";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ provider: string }> };

// GET /api/providers/:provider/models -> { models: string[], expiries: { [model]: "YYYY-MM-DD" } }
// Models sorted by name, and the announced last day of those that have one.
// Uses the current user's Ollama server or API key. 502 when the provider cannot be reached.
export async function GET(_req: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  if (!isProviderId(provider)) return jsonError("Unknown provider", 404);

  try {
    const listing = await listProviderModels(user.id, provider);
    if (!listing) return jsonError(`No ${PROVIDER_LABELS[provider]} API key. Add one on the account page.`, 403);
    return NextResponse.json(listing, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err), 502);
  }
}
