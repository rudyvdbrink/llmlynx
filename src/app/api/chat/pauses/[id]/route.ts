import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError, readJsonObject } from "@/server/http";
import { answerPause } from "@/server/security/pause";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/chat/pauses/:id
// body: { decision: "remove" | "stop" | "run" | "skip" }
// The user's choice for which their reply paused (the { pause } line of
// /api/chat). About content from the internet that looked like instructions
// aimed at the model: "remove" goes on without the content, "stop" ends the
// reply. About running code in a chat with such content: "run" runs it, "skip"
// goes on without the run. Works once, for the user whose reply it is, while
// that reply is still waiting, with an answer that fits the pause.
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const { decision } = await readJsonObject(req);
  if (decision !== "remove" && decision !== "stop" && decision !== "run" && decision !== "skip") {
    return jsonError("decision must be remove, stop, run or skip", 400);
  }
  if (!answerPause(id, user.id, decision)) return jsonError("Not found", 404);
  return new NextResponse(null, { status: 204 });
}
