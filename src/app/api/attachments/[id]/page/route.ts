import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { renderPdfPages } from "@/server/files/convert";
import { FILE_CSP, ownFile } from "@/server/files/served";
import { extensionOf } from "@/lib/files";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/attachments/:id/page?n=1 -> a page of a PDF of the chat's sandbox,
// as an image, made by the files server's PDF renderer, for the sandbox panel.
// Only for the owner of the chat.
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  const file = await ownFile(id, user.id);
  if (!file || extensionOf(file.name) !== "pdf") return jsonError("Not found", 404);

  const page = Math.floor(Number(new URL(req.url).searchParams.get("n")));
  if (!Number.isInteger(page) || page < 1) return jsonError("n must be a page number from 1", 400);
  const rendered = await renderPdfPages(file, [page], req.signal);
  if ("error" in rendered) return jsonError(rendered.error, 422);
  const [first] = rendered.images;
  if (!first) return jsonError("There is no such page.", 404);
  return new Response(new Uint8Array(Buffer.from(first.image.data, "base64")), {
    headers: {
      "Content-Type": first.image.mimeType,
      // A version of a file never changes
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": FILE_CSP,
    },
  });
}
