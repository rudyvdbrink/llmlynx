import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { deleteSandboxFile } from "@/server/files/store";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/conversations/:id/sandbox/files?path=<path>
// Deletes a file of the chat's sandbox, with all of its versions. Only for
// the user who owns the chat.
export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  const owned = await prisma.conversation.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!owned) return jsonError("Not found", 404);

  const path = new URL(req.url).searchParams.get("path")?.trim();
  if (!path) return jsonError("path is required", 400);
  if (!(await deleteSandboxFile(id, path))) return jsonError("Not found", 404);
  return new NextResponse(null, { status: 204 });
}
