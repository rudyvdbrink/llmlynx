// Gets the files of a new user message ready for the model, before it
// answers: see server/files/history.ts for how they then reach it.

import { prisma } from "@/server/db/prisma";
import { fileKind } from "@/lib/files";
import type { ToolImage } from "@/server/tools/mcp";
import { fileText, MAX_RENDERED_PAGES, prepareImage, renderPdfPages } from "./convert";
import type { FileInfo } from "./store";

async function saveDerived(
  parent: { id: string; messageId: string },
  image: ToolImage,
  info: FileInfo | null
) {
  const data = Buffer.from(image.data, "base64");
  await prisma.messageAttachment.create({
    data: {
      messageId: parent.messageId,
      parentId: parent.id,
      mimeType: image.mimeType,
      data,
      size: data.length,
      ...(info ? { info } : {}),
    },
  });
}

/**
 * Converts the documents of the message to text and, for a model that can see
 * images (`vision`), makes smaller copies of large photos and images of a
 * PDF's scanned pages (at most MAX_RENDERED_PAGES). What it makes is stored
 * with the attachments, so the next replies use it again; work already done
 * is skipped. Throws only when `signal` aborts.
 */
export async function prepareMessageFiles(messageId: string, vision: boolean, signal: AbortSignal) {
  const rows = await prisma.messageAttachment.findMany({
    where: { messageId, parentId: null, name: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, messageId: true, name: true, mimeType: true, text: true, info: true, derived: { select: { id: true } } },
  });
  for (const row of rows) {
    const file = { ...row, name: row.name!, info: (row.info as FileInfo | null) ?? null };
    if (fileKind(file.name) === "image") {
      if (!vision || row.derived.length) continue;
      const image = await prepareImage(file, signal);
      if (image) await saveDerived(file, image, null);
      continue;
    }
    const { info } = await fileText(file, signal);
    const textless = info?.textlessPages ?? [];
    if (!vision || !textless.length || row.derived.length) continue;
    const rendered = await renderPdfPages(file, textless.slice(0, MAX_RENDERED_PAGES), signal);
    if ("error" in rendered) continue;
    for (const { page, image } of rendered.images) await saveDerived(file, image, { page });
  }
}
