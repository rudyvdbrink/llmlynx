import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { readSheets } from "@/server/files/convert";
import { ownFile } from "@/server/files/served";
import { extensionOf } from "@/lib/files";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/attachments/:id/sheets -> { sheets: [{ name, rows, more }] }
// An Excel workbook of the chat's sandbox as tables, a sheet each, its first
// 1,000 rows, for the sandbox panel's preview. Only for the owner of the chat.
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  const file = await ownFile(id, user.id);
  if (!file || !["xlsx", "xls"].includes(extensionOf(file.name))) return jsonError("Not found", 404);

  const sheets = await readSheets(file, req.signal);
  if ("error" in sheets) return jsonError(sheets.error, 422);
  return NextResponse.json(sheets);
}
