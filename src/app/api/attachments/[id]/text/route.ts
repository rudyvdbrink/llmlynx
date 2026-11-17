import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { fileText } from "@/server/files/convert";
import { fileData } from "@/server/files/store";
import { ownFile } from "@/server/files/served";
import { fileKind } from "@/lib/files";

type Ctx = { params: Promise<{ id: string }> };

// Most characters one request gets: long files load in parts
const MAX_LENGTH = 1_000_000;

// GET /api/attachments/:id/text[?start=0&length=200000] -> { text, start, end, total, pages? }
// A file of the chat's sandbox as text, for the sandbox panel's preview: a
// text or code file as it is, a document (Word, PowerPoint, PDF, Excel) as the
// model sees it. A part of it at a time: from `start`, at most `length`
// characters; `total` says how many it has. Only for the owner of the chat.
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  const file = await ownFile(id, user.id);
  if (!file) return jsonError("Not found", 404);

  const params = new URL(req.url).searchParams;
  const start = Math.max(0, Math.floor(Number(params.get("start")) || 0));
  const length = Math.min(MAX_LENGTH, Math.max(1, Math.floor(Number(params.get("length")) || 200_000)));

  let text: string | null;
  let pages: number | undefined;
  const kind = fileKind(file.name);
  if (kind === "text") {
    text = new TextDecoder("utf-8").decode(await fileData(file.id));
  } else if (kind === "document") {
    const converted = await fileText(file, req.signal);
    text = converted.text;
    pages = converted.info?.pages;
    if (text === null) return jsonError(converted.info?.error ?? "The file could not be read.", 422);
  } else {
    return jsonError("This file has no text to show.", 415);
  }
  const end = Math.min(text.length, start + length);
  return NextResponse.json({ text: text.slice(start, end), start, end, total: text.length, ...(pages ? { pages } : {}) });
}
