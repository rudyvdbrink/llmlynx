import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError, optionalString, readJsonObject } from "@/server/http";

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
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });
  if (!conversation) return jsonError("Not found", 404);

  return NextResponse.json({ conversation });
}

// PATCH /api/conversations/:id -> update conversation title
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const title = (optionalString((await readJsonObject(req)).title) ?? "").trim();
  if (!title) return jsonError("Title is required", 400);

  const owned = await prisma.conversation.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!owned) return jsonError("Not found", 404);

  const updated = await prisma.conversation.update({
    where: { id },
    data: { title },
    select: { id: true, title: true, updatedAt: true },
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

  return new NextResponse(null, { status: 204 });
}
