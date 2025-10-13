import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { getCurrentUser } from "../../../../lib/session";

// GET /api/conversations/:id -> get conversation with messages
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const convo = await prisma.conversation.findUnique({
    where: { id },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });

  if (!convo || convo.userId !== user.id) {
    return NextResponse.json({ message: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    conversation: {
      id: convo.id,
      title: convo.title,
      model: convo.model,
      createdAt: convo.createdAt,
      updatedAt: convo.updatedAt,
      messages: convo.messages,
    },
  });
}

// PATCH /api/conversations/:id -> update conversation title
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const payload = await req.json().catch(() => ({}));
  const rawTitle = typeof payload.title === "string" ? payload.title : "";
  const title = rawTitle.trim();
  if (!title) {
    return NextResponse.json({ message: "Title is required" }, { status: 400 });
  }

  const convo = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });

  if (!convo || convo.userId !== user.id) {
    return NextResponse.json({ message: "Not found" }, { status: 404 });
  }

  const updated = await prisma.conversation.update({
    where: { id },
    data: { title },
    select: { id: true, title: true, updatedAt: true },
  });

  return NextResponse.json({ conversation: updated });
}

// DELETE /api/conversations/:id -> delete conversation and its messages
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const convo = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });

  if (!convo || convo.userId !== user.id) {
    return NextResponse.json({ message: "Not found" }, { status: 404 });
  }

  await prisma.conversation.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}