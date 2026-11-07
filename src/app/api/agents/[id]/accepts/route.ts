import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { getModelInfo } from "@/server/chat/models";
import { jsonError } from "@/server/http";
import { attachAccept } from "@/server/tools/policy";
import { parseBaseModel } from "@/lib/selection";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/agents/:id/accepts -> { accept: AttachAccept }
// Which files a chat with the agent takes: documents when the files server is
// set up, and images too when its base model can see them.
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const agent = await prisma.agent.findFirst({ where: { id, userId: user.id }, select: { baseModel: true } });
  const base = parseBaseModel(agent?.baseModel);
  if (!agent || !base) return jsonError("Not found", 404);

  const info = await getModelInfo(user.id, base.provider, base.model);
  return NextResponse.json({ accept: attachAccept(info.capabilities) }, { headers: { "Cache-Control": "no-store" } });
}
