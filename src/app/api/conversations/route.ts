import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { getCurrentUser } from "../../../lib/session";

// GET /api/conversations -> list current user's conversations (most recent first)
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const conversations = await prisma.conversation.findMany({
    where: { userId: user.id },
    select: { id: true, title: true, model: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ conversations });
}

// POST /api/conversations -> create a new empty conversation
// body: { title?: string, model?: string }
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { title, model } = await req.json().catch(() => ({}));
    const convo = await prisma.conversation.create({
      data: { userId: user.id, title: title ?? null, model: model ?? null },
      select: { id: true, title: true, model: true, createdAt: true, updatedAt: true },
    });

    return NextResponse.json({ conversation: convo });
  } catch {
    return NextResponse.json({ message: "Failed to create conversation" }, { status: 500 });
  }
}