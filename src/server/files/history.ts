// How the files of a conversation reach the model: each user message carries
// the text of the files attached to it, in <file> blocks, and, for a model
// that can see images, its images and images of a PDF's scanned pages. Files
// take up a lot of context, so their text shares a budget, newest first; the
// rest can be read with read_file.

import { prisma } from "@/server/db/prisma";
import { extensionOf, fileKind, isInlineImage, typeLabel } from "@/lib/files";
import type { ChatMessage } from "@/lib/types";
import type { ToolImage } from "@/server/tools/mcp";
import type { ConversationFile, FileInfo } from "./store";

export type FileHistoryOptions = {
  vision: boolean; // the model can see images
  textBudget: number; // most characters of file text in one request
  readFile: boolean; // the model has read_file
  viewPages: boolean; // the model has view_pdf_pages
};

// Images take a lot of context, and some models take only a few
const MAX_IMAGES = 8;

/**
 * Most characters of file text in one request: about half of the model's
 * context (at roughly 3.5 characters per token), within limits. Every request
 * sends it again, so it stays well below what large contexts could take.
 */
export function fileTextBudget(numCtx: unknown): number {
  const tokens = typeof numCtx === "number" && numCtx > 0 ? numCtx : 2048;
  return Math.round(Math.min(120_000, Math.max(3_000, tokens * 0.5 * 3.5)));
}
// A file whose text gets less than this is only named
const MIN_SHOWN = 400;

/** An attachment of a user message, as loadHistory selects it. */
export type HistoryAttachment = {
  id: string;
  name: string | null;
  mimeType: string;
  text: string | null;
  info: unknown;
  derived: { id: string; mimeType: string; info: unknown }[];
};

export const HISTORY_ATTACHMENT_SELECT = {
  where: { parentId: null, name: { not: null } },
  orderBy: { createdAt: "asc" },
  select: {
    id: true,
    name: true,
    mimeType: true,
    text: true,
    info: true,
    derived: { select: { id: true, mimeType: true, info: true }, orderBy: { createdAt: "asc" } },
  },
} as const;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The image ids the model sees for an attachment: a photo (or its smaller copy), or a PDF's scanned pages. */
function imagesOf(file: HistoryAttachment): { id: string; page?: number }[] {
  if (fileKind(file.name ?? "") === "image") {
    const copy = file.derived[0];
    if (copy) return [{ id: copy.id }];
    return isInlineImage(file.mimeType) && file.mimeType !== "image/gif" ? [{ id: file.id }] : [];
  }
  return file.derived.map((d) => ({ id: d.id, page: (d.info as FileInfo | null)?.page }));
}

/**
 * Adds the files to the messages: `attachments[i]` are those of `messages[i]`,
 * which gets <file> blocks and images. Messages without files stay as they are.
 */
export async function addFiles(
  messages: ChatMessage[],
  attachments: HistoryAttachment[][],
  options: FileHistoryOptions
): Promise<ChatMessage[]> {
  if (!attachments.some((list) => list.length)) return messages;

  // Newest messages first: they get the text budget and the images
  let budget = options.textBudget;
  let imagesLeft = options.vision ? MAX_IMAGES : 0;
  const imageIds = new Set<string>();
  const blocks: string[][] = attachments.map(() => []);
  const messageImages: Map<number, { id: string; page?: number }[]> = new Map();

  for (let m = attachments.length - 1; m >= 0; m--) {
    const list = attachments[m];
    const images: { id: string; page?: number }[] = [];
    for (const file of list) {
      const name = file.name ?? "file";
      const kind = fileKind(name);
      const info = (file.info as FileInfo | null) ?? null;
      const wanted = options.vision ? imagesOf(file) : [];
      const shown = wanted.slice(0, imagesLeft);
      imagesLeft -= shown.length;
      images.push(...shown);

      if (kind === "image") {
        const note = !options.vision
          ? "Not shown: you cannot see images."
          : shown.length
            ? ""
            : "Not shown again, to save room.";
        blocks[m].push(note ? `<image name="${escapeAttr(name)}">${note}</image>` : `<image name="${escapeAttr(name)}"/>`);
        continue;
      }

      const attrs = [`name="${escapeAttr(name)}"`, `type="${typeLabel(name)}"`];
      if (info?.pages) attrs.push(`pages="${info.pages}"`);
      const notes: string[] = [];
      let body: string;
      if (file.text === null) {
        body = `Could not be read: ${info?.error ?? "it was not converted"}`;
      } else {
        const room = budget >= MIN_SHOWN ? budget : 0;
        const part = file.text.slice(0, room);
        budget -= part.length;
        body = part;
        if (part.length < file.text.length) {
          const how = options.readFile ? ` Call read_file with file="${name}" and start=${part.length} for the rest.` : "";
          notes.push(
            part.length
              ? `[Cut off after ${part.length} of ${file.text.length} characters, to fit.${how}]`
              : `[Not shown: no room left.${how}]`
          );
        }
      }
      const textless = info?.textlessPages ?? [];
      if (textless.length && extensionOf(name) === "pdf") {
        const pageList = textless.join(", ");
        const seen = shown.map((s) => s.page).filter((p): p is number => typeof p === "number");
        const lines = [`[Pages ${pageList} have no text, probably scanned.`];
        if (seen.length) lines.push(`Images of pages ${seen.join(", ")} are attached.`);
        if (options.viewPages) lines.push("Look at pages with view_pdf_pages.");
        else if (!options.vision) lines.push("You cannot see them.");
        notes.push(lines.join(" ") + "]");
      }
      blocks[m].push(`<file ${attrs.join(" ")}>\n${[body, ...notes].filter(Boolean).join("\n\n")}\n</file>`);
    }
    if (images.length) messageImages.set(m, images);
    for (const image of images) imageIds.add(image.id);
  }

  const data = imageIds.size
    ? await prisma.messageAttachment.findMany({
        where: { id: { in: [...imageIds] } },
        select: { id: true, mimeType: true, data: true },
      })
    : [];
  const byId = new Map(data.map((d) => [d.id, { mimeType: d.mimeType, data: Buffer.from(d.data).toString("base64") }]));

  return messages.map((message, m) => {
    if (!blocks[m].length) return message;
    const images = (messageImages.get(m) ?? []).map((i) => byId.get(i.id)).filter((i): i is ToolImage => !!i);
    const content = [message.content, ...blocks[m]].filter(Boolean).join("\n\n");
    return { ...message, content, ...(images.length ? { images } : {}) };
  });
}

/**
 * Names the conversation's files for an agent with file tools, which refers
 * to them by name: those the user attached, and those it created in earlier
 * replies, whose tool calls it does not see again.
 */
export function filesNote(files: ConversationFile[]): string | null {
  if (!files.length) return null;
  const list = files.map((f) => `${f.name} (${f.origin === "user" ? "attached by the user" : "created by you"})`);
  return `[The files of this conversation: ${list.join(", ")}.]`;
}
