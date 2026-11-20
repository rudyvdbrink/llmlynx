import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { isRunning } from "@/server/chat/attempts";
import { createBudget } from "@/server/chat/budget";
import { makeCheckpoint, SummaryFailed, undoCheckpoint } from "@/server/chat/checkpoint";
import { saveCheckpointStep } from "@/server/chat/conversation";
import { addConversationCost } from "@/server/chat/cost";
import { askModel, chatSetup, chatView, chatWindow, resolveTarget } from "@/server/chat/target";
import { jsonError, optionalString, readJsonObject } from "@/server/http";
import { createAuditLog } from "@/server/security/audit";
import { openSecurity } from "@/server/security/engine";
import type { Checkpoint } from "@/lib/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// Most characters of what the user asks to keep
const MAX_KEEP = 1_000;

const RUNNING = "A reply is running. Compact the conversation when it is done.";

async function ownConversation(id: string) {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return { error: jsonError("Unauthorized", 401) };
  const conversation = await prisma.conversation.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  return conversation ? { user } : { error: jsonError("Not found", 404) };
}

// POST /api/conversations/:id/compact -> { checkpoint, context }
// body: { keep?: string, model?: string, agentId?: string }
// What the user's /compact does: the model of the chat (`model` or `agentId`,
// as for POST /api/chat) writes a summary of the whole conversation so far,
// which it gets from then on in place of the steps before it (see
// server/chat/checkpoint.ts). `keep` is what the user asked to keep. The
// steps stay stored, and the chat view keeps showing them. `context` says how
// full the model's context window is afterwards, when that is known.
// Refused while a reply runs, and when there is nothing to summarise yet.
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const own = await ownConversation(id);
  if ("error" in own) return own.error;
  const { user } = own;
  if (isRunning(id)) return jsonError(RUNNING, 409);

  const body = await readJsonObject(req);
  const keep = (optionalString(body.keep) ?? "").trim().slice(0, MAX_KEEP);
  const target = await resolveTarget(user.id, body.model, body.agentId);
  if (!target) return jsonError("Agent not found", 404);
  if (!target.model) return jsonError("No model selected", 400);
  const setup = await chatSetup(user.id, target);
  if ("error" in setup) return jsonError(setup.error, setup.status);

  const { tools } = setup;
  const audit = createAuditLog(user.id, id);
  try {
    const security = target.agent ? await openSecurity({ userId: user.id, conversationId: id, tools, audit }) : null;
    const window = await chatWindow(setup);
    const made = await makeCheckpoint({
      conversationId: id,
      view: await chatView(id, setup),
      budget: window ? createBudget(window, tools) : null,
      by: "user",
      keep,
      tools,
      security,
      signal: req.signal,
      ask: (view) => askModel(setup, view, req.signal, (usd) => addConversationCost(id, usd)),
      store: (summary, meta) => saveCheckpointStep(id, summary, meta),
    });
    if (!made) return jsonError("There is nothing to compact yet.", 400);
    const checkpoint: Checkpoint = { id: made.id, summary: made.summary, by: "user", canUndo: true };
    return NextResponse.json({ checkpoint, context: made.fill ?? null });
  } catch (err) {
    if (req.signal.aborted) return jsonError("Stopped.", 499);
    if (err instanceof SummaryFailed) return jsonError(`The conversation was not compacted: ${err.message}`, 502);
    throw err;
  } finally {
    await audit.flush();
  }
}

// DELETE /api/conversations/:id/compact -> 204
// Takes the user's compaction back: the model gets the steps it covered
// again. Only while nothing was said since: after that it stays.
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const own = await ownConversation(id);
  if ("error" in own) return own.error;
  if (isRunning(id)) return jsonError(RUNNING, 409);
  if (!(await undoCheckpoint(id))) return jsonError("This can no longer be taken back.", 409);
  return new NextResponse(null, { status: 204 });
}
