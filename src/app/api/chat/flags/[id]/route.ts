import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { markFalsePositive } from "@/server/security/engine";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/chat/flags/:id
// The user marks the prompt injection flag of the stored tool step :id
// (ToolStep.rowId) a false positive: it no longer taints the chat, so code
// runs in it without asking. The flagged content stays withheld from the
// model. Only for a step in one of the user's own conversations.
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  if (!(await markFalsePositive(user.id, id))) return jsonError("Not found", 404);
  return new NextResponse(null, { status: 204 });
}
