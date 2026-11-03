import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError, optionalString, readJsonObject } from "@/server/http";

const SUMMARY_SELECT = { id: true, title: true, model: true, pinnedAt: true, createdAt: true, updatedAt: true } as const;
const NEWEST_FIRST: Prisma.ConversationOrderByWithRelationInput[] = [{ updatedAt: "desc" }, { id: "desc" }];

const MAX_OLDER = 1000;
const MAX_QUERY_LENGTH = 200;

// GET /api/conversations -> list current user's conversations: pinned ones first
// (most recently pinned first), then the others, most recent first
// query: since=<ISO date>  only unpinned conversations active since then, plus
//        older=<n>         the n most recent ones before it (default 0)
//        q=<text>          only conversations whose title or messages contain the text
// Without `since`, every conversation is returned.
// Responds with { conversations, hasOlder }; hasOlder: more conversations exist before `since`.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const params = req.nextUrl.searchParams;
  const sinceParam = params.get("since");
  const since = sinceParam ? new Date(sinceParam) : null;
  if (since && isNaN(since.getTime())) return jsonError("Invalid since date", 400);
  const older = Math.min(MAX_OLDER, Math.max(0, parseInt(params.get("older") ?? "0", 10) || 0));
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);

  const where: Prisma.ConversationWhereInput = {
    userId: user.id,
    // `contains` is case-insensitive for ASCII text on SQLite
    ...(q ? { OR: [{ title: { contains: q } }, { messages: { some: { content: { contains: q } } } }] } : {}),
  };

  const pinned = await prisma.conversation.findMany({
    where: { ...where, pinnedAt: { not: null } },
    select: SUMMARY_SELECT,
    orderBy: [{ pinnedAt: "desc" }, { id: "desc" }],
  });
  const recent = await prisma.conversation.findMany({
    where: { ...where, pinnedAt: null, ...(since ? { updatedAt: { gte: since } } : {}) },
    select: SUMMARY_SELECT,
    orderBy: NEWEST_FIRST,
  });
  // One extra row tells whether even older conversations exist.
  const before = since
    ? await prisma.conversation.findMany({
        where: { ...where, pinnedAt: null, updatedAt: { lt: since } },
        select: SUMMARY_SELECT,
        orderBy: NEWEST_FIRST,
        take: older + 1,
      })
    : [];

  return NextResponse.json({
    conversations: [...pinned, ...recent, ...before.slice(0, older)],
    hasOlder: before.length > older,
  });
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
