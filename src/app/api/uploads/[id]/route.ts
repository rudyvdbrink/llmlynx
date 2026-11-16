import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { deleteUpload } from "@/server/files/uploads";
import { jsonError } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/uploads/:id -> deletes the user's draft: a file they attached
// and then removed from the composer.
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  if (!(await deleteUpload(user.id, id))) return jsonError("Not found", 404);
  return new NextResponse(null, { status: 204 });
}
