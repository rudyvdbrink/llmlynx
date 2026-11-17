// What the attachment routes share: finding a user's own file, and the
// headers that keep a served file from running in the app.

import { prisma } from "@/server/db/prisma";
import { baseName } from "@/lib/files";
import type { ConversationFile, FileInfo, FileOrigin } from "./store";

/** A file of one of the user's conversations, with what the previews need; null when it is not theirs. */
export async function ownFile(id: string, userId: string): Promise<(ConversationFile & { conversationId: string }) | null> {
  const row = await prisma.messageAttachment.findFirst({
    where: { id, deleted: false, message: { conversation: { userId } } },
    select: {
      id: true,
      name: true,
      mimeType: true,
      size: true,
      text: true,
      info: true,
      origin: true,
      createdAt: true,
      message: { select: { role: true, conversationId: true } },
    },
  });
  if (!row) return null;
  const origin: FileOrigin =
    row.origin === "code" || row.origin === "internet" ? row.origin : row.message.role === "user" ? "user" : "model";
  return {
    id: row.id,
    name: row.name ?? "file",
    mimeType: row.mimeType,
    size: row.size ?? 0,
    origin,
    text: row.text,
    info: (row.info as FileInfo | null) ?? null,
    createdAt: row.createdAt,
    conversationId: row.message.conversationId,
  };
}

/** Content-Disposition for `name` (its file name only): plain ASCII for old browsers, and the full name in UTF-8. */
export function disposition(type: "inline" | "attachment", name: string | null): string {
  if (!name) return type;
  const file = baseName(name);
  const ascii = file.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file)}`;
}

/**
 * The policy of anything served from a chat's files but an HTML artifact: it
 * loads nothing, runs nothing and is in an origin of its own (sandbox).
 */
export const FILE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

/**
 * The policy of an HTML artifact in its frame: its scripts run, in an origin
 * of its own (sandbox without allow-same-origin), so it cannot read the app's
 * cookies or call the app. It cannot load anything from the internet or the
 * app (only what is in the page, and data: and blob: URLs it makes itself),
 * submit forms, open pop-ups, navigate the page, or be framed by another
 * site. Its own navigations are held by the frame-src of the app's pages (see
 * next.config.ts).
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");
