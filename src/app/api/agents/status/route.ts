import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { listProviderModels, type ModelListing } from "@/server/chat/models";
import { jsonError } from "@/server/http";
import { hasModel, PROVIDER_LABELS, type ProviderId } from "@/lib/providers";
import { parseBaseModel } from "@/lib/selection";
import type { AgentStatus } from "@/lib/types";

export const runtime = "nodejs";

type Listing = { listing: ModelListing } | { problem: string };

async function loadListing(userId: string, provider: ProviderId): Promise<Listing> {
  const label = PROVIDER_LABELS[provider];
  try {
    const listing = await listProviderModels(userId, provider);
    return listing ? { listing } : { problem: `No ${label} API key` };
  } catch (err) {
    const refused = (err as { status?: number })?.status === 401;
    return { problem: refused ? `${label} refuses the API key` : `${label} cannot be reached` };
  }
}

// GET /api/agents/status -> { statuses: { [agentId]: AgentStatus } }
// Whether each agent can be used now: its provider must be reachable and still
// offer its base model. Asks only the providers the user's agents run on.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const agents = await prisma.agent.findMany({ where: { userId: user.id }, select: { id: true, baseModel: true } });
  const bases = agents.map((agent) => ({ id: agent.id, base: parseBaseModel(agent.baseModel) }));
  const providers = [...new Set(bases.flatMap(({ base }) => (base ? [base.provider] : [])))];
  const listings = new Map(
    await Promise.all(providers.map(async (provider) => [provider, await loadListing(user.id, provider)] as const))
  );

  const statuses: Record<string, AgentStatus> = {};
  for (const { id, base } of bases) {
    const found = base && listings.get(base.provider);
    if (!base || !found) {
      statuses[id] = { unavailable: "No base model", expiresOn: null };
    } else if ("problem" in found) {
      statuses[id] = { unavailable: found.problem, expiresOn: null };
    } else if (!hasModel(base.provider, found.listing.models, base.model)) {
      const gone = base.provider === "ollama" ? "Model not on your Ollama server" : "Model no longer available";
      statuses[id] = { unavailable: gone, expiresOn: null };
    } else {
      statuses[id] = { unavailable: null, expiresOn: found.listing.expiries[base.model] ?? null };
    }
  }
  return NextResponse.json({ statuses }, { headers: { "Cache-Control": "no-store" } });
}
