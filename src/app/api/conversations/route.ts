import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError, optionalString, readJsonObject } from "@/server/http";

const SUMMARY_SELECT = { id: true, title: true, model: true, createdAt: true, updatedAt: true } as const;

// GET /api/conversations -> list current user's conversations (most recent first)
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const conversations = await prisma.conversation.findMany({
    where: { userId: user.id },
    select: SUMMARY_SELECT,
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ conversations });
}

// POST /api/conversations -> create a new empty conversation
// body: { title?: string, model?: string }
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return jsonError("Unauthorized", 401);

    const body = await readJsonObject(req);
    const convo = await prisma.conversation.create({
      data: {
        userId: user.id,
        title: optionalString(body.title) ?? null,
        model: optionalString(body.model) ?? null,
      },
      select: SUMMARY_SELECT,
    });

    return NextResponse.json({ conversation: convo });
  } catch {
    return jsonError("Failed to create conversation", 500);
  }
}
