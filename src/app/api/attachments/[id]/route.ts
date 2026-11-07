import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { isInlineImage } from "@/lib/files";

type Ctx = { params: Promise<{ id: string }> };

/** Content-Disposition for `name`: plain ASCII for old browsers, and the full name in UTF-8. */
function disposition(type: "inline" | "attachment", name: string | null): string {
  if (!name) return type;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// GET /api/attachments/:id[?download=1] -> the file: a screenshot a tool
// returned, a file the user attached, or one an agent created. Only for the
// user whose conversation it belongs to. Images show in the browser (unless
// ?download=1); every other file only downloads, so that a file such as HTML
// or SVG never runs on this site.
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const attachment = await prisma.messageAttachment.findFirst({
    where: { id, message: { conversation: { userId: user.id } } },
    select: { mimeType: true, data: true, name: true },
  });
  if (!attachment) return jsonError("Not found", 404);

  const download = new URL(req.url).searchParams.get("download") === "1";
  const inline = isInlineImage(attachment.mimeType) && !download;
  return new Response(new Uint8Array(attachment.data), {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Disposition": disposition(inline ? "inline" : "attachment", attachment.name),
      // An attachment never changes
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
