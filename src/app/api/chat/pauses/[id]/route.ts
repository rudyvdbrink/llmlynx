import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError, readJsonObject } from "@/server/http";
import { answerPause } from "@/server/security/pause";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/chat/pauses/:id
// body: { decision: "remove" | "stop" }
// The user's choice about content from the internet that looked like
// instructions aimed at the model, for which their reply paused (the
// { pause } line of /api/chat): "remove" goes on without the content, "stop"
// ends the reply. Works once, for the user whose reply it is, while that reply
// is still waiting.
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const { decision } = await readJsonObject(req);
  if (decision !== "remove" && decision !== "stop") return jsonError("decision must be remove or stop", 400);
  if (!answerPause(id, user.id, decision)) return jsonError("Not found", 404);
  return new NextResponse(null, { status: 204 });
}
