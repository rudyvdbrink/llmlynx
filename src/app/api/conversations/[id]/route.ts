import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError, optionalString, readJsonObject } from "@/server/http";
import { deleteUnusedSetups } from "@/server/chat/setup";
import { DISPLAY_MESSAGE_SELECT, toDisplayMessages } from "@/server/chat/display";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/conversations/:id -> get conversation with messages
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      title: true,
      model: true,
      pinnedAt: true,
      createdAt: true,
      updatedAt: true,
      // The user's messages and every step of the replies, tool steps included
      messages: {
        where: { role: { in: ["user", "assistant", "tool"] } },
        orderBy: { position: "asc" },
        select: DISPLAY_MESSAGE_SELECT,
      },
    },
  });
  if (!conversation) return jsonError("Not found", 404);

  // A reply that used tools is shown as one message with its tool steps
  return NextResponse.json({ conversation: { ...conversation, messages: toDisplayMessages(conversation.messages) } });
}

// PATCH /api/conversations/:id -> rename and/or pin the conversation
// body: { title?: string, pinned?: boolean }
// Neither counts as activity, so the conversation keeps its place in the date groups.
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const body = await readJsonObject(req);
  const data: Prisma.ConversationUpdateInput = {};
  if (body.title !== undefined) {
    const title = (optionalString(body.title) ?? "").trim();
    if (!title) return jsonError("Title is required", 400);
    data.title = title;
  }
  if (typeof body.pinned === "boolean") data.pinnedAt = body.pinned ? new Date() : null;
  if (Object.keys(data).length === 0) return jsonError("Nothing to update", 400);

  const owned = await prisma.conversation.findFirst({
    where: { id, userId: user.id },
    select: { id: true, updatedAt: true },
  });
  if (!owned) return jsonError("Not found", 404);

  const updated = await prisma.conversation.update({
    where: { id },
    data: { ...data, updatedAt: owned.updatedAt },
    select: { id: true, title: true, pinnedAt: true, updatedAt: true },
  });

  return NextResponse.json({ conversation: updated });
}

// DELETE /api/conversations/:id -> delete conversation and its messages
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const { count } = await prisma.conversation.deleteMany({ where: { id, userId: user.id } });
  if (count === 0) return jsonError("Not found", 404);
  // Drop the system prompts and options only its replies used
  await deleteUnusedSetups(user.id);

  return new NextResponse(null, { status: 204 });
}
