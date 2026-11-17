import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";

type Ctx = { params: Promise<{ id: string; runId: string }> };

// GET /api/conversations/:id/sandbox/runs/:runId -> { code, output }
// A run's code (or the packages an install asked for) and what it printed, up
// to 1 MB; for a run whose output the model did not get, the output is left
// out. Only for the user who owns the chat.
export async function GET(_req: Request, ctx: Ctx) {
  const { id, runId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  const run = await prisma.sandboxRun.findFirst({
    where: { id: runId, conversationId: id, conversation: { userId: user.id } },
    select: { code: true, output: true, status: true },
  });
  if (!run) return jsonError("Not found", 404);
  return NextResponse.json({ code: run.code, output: run.status === "withheld" ? null : run.output });
}
