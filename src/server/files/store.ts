// The files of a conversation: those the user attached and those the agent's
// file tools created. Both are message attachments with a name (see the
// MessageAttachment model); the model refers to them by name.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { extensionOf } from "@/lib/files";

/** What converting a file found. */
export type FileInfo = {
  pages?: number; // a PDF's number of pages
  textlessPages?: number[]; // a PDF's pages without text, from 1: probably scanned
  page?: number; // a derived image: the PDF page it shows
  error?: string; // why the file could not be converted
};

export type ConversationFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  origin: "user" | "model";
  text: string | null;
  info: FileInfo | null;
};

const FILE_SELECT = {
  id: true,
  name: true,
  mimeType: true,
  size: true,
  text: true,
  info: true,
  message: { select: { role: true } },
} satisfies Prisma.MessageAttachmentSelect;

type FileRow = Prisma.MessageAttachmentGetPayload<{ select: typeof FILE_SELECT }>;

function toFile(row: FileRow): ConversationFile {
  return {
    id: row.id,
    name: row.name ?? "file",
    mimeType: row.mimeType,
    size: row.size ?? 0,
    origin: row.message.role === "user" ? "user" : "model",
    text: row.text,
    info: (row.info as FileInfo | null) ?? null,
  };
}

/**
 * The conversation's files in the order they came, the newest version of each
 * name only: a file that edit_file changed keeps its name.
 */
export async function conversationFiles(conversationId: string): Promise<ConversationFile[]> {
  const rows = await prisma.messageAttachment.findMany({
    where: { message: { conversationId }, name: { not: null }, parentId: null },
    orderBy: [{ message: { position: "asc" } }, { createdAt: "asc" }],
    select: FILE_SELECT,
  });
  const latest = new Map<string, ConversationFile>();
  for (const row of rows) {
    const file = toFile(row);
    const key = file.name.toLowerCase();
    latest.delete(key); // so that the map keeps the order of the newest versions
    latest.set(key, file);
  }
  return [...latest.values()];
}

/**
 * The file the model means by `name`: the one with that name (without case),
 * else the only one with that name without extension, or that ends with it.
 */
export function findFile(files: ConversationFile[], name: unknown): ConversationFile | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const wanted = name.trim().toLowerCase().split(/[\\/]/).pop()!;
  const exact = files.find((f) => f.name.toLowerCase() === wanted);
  if (exact) return exact;
  const stem = (f: ConversationFile) => f.name.toLowerCase().slice(0, -(extensionOf(f.name).length + 1));
  const loose = files.filter((f) => stem(f) === wanted || f.name.toLowerCase().endsWith(wanted));
  return loose.length === 1 ? loose[0] : null;
}

/** The file's contents. */
export async function fileData(id: string): Promise<Buffer> {
  const row = await prisma.messageAttachment.findUniqueOrThrow({ where: { id }, select: { data: true } });
  return Buffer.from(row.data);
}

/** Stores what converting the file gave, so it is converted only once. */
export async function saveFileText(id: string, text: string | null, info: FileInfo | null) {
  await prisma.messageAttachment.update({
    where: { id },
    data: { text, info: (info ?? undefined) as Prisma.InputJsonValue | undefined },
  });
}
