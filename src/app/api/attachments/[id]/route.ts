import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/attachments/:id -> the file, such as a screenshot a tool returned.
// Only for the user whose conversation it belongs to.
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);

  const attachment = await prisma.messageAttachment.findFirst({
    where: { id, message: { conversation: { userId: user.id } } },
    select: { mimeType: true, data: true },
  });
  if (!attachment) return jsonError("Not found", 404);

  return new Response(new Uint8Array(attachment.data), {
    headers: {
      "Content-Type": attachment.mimeType,
      // An attachment never changes
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
