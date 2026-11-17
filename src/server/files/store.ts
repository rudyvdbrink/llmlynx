// The files of a conversation, its sandbox: those the user attached, and those
// its tools made (the file tools, runs of code and downloads). All of them are
// message attachments with a name, which is the file's path in the sandbox
// (see the MessageAttachment model); the model refers to them by it. A name
// can have several versions: the newest is the current one, the older ones
// are its history. A run that deletes a file stores a deletion, so that the
// history stays as well.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { baseName, extensionOf } from "@/lib/files";

/** What converting a file found. */
export type FileInfo = {
  pages?: number; // a PDF's number of pages
  textlessPages?: number[]; // a PDF's pages without text, from 1: probably scanned
  page?: number; // a derived image: the PDF page it shows
  error?: string; // why the file could not be converted
};

/**
 * Where a file came from: attached by the user, made by a file tool
 * ("model"), made or changed by code, or downloaded from the internet. Files
 * from code or the internet are untrusted (see isUntrusted).
 */
export type FileOrigin = "user" | "model" | "code" | "internet";

export type ConversationFile = {
  id: string;
  name: string; // its path in the sandbox, such as "out/plot.png"
  mimeType: string;
  size: number;
  origin: FileOrigin;
  text: string | null;
  info: FileInfo | null;
  createdAt: Date;
};

/** A version of a file, as the sandbox panel lists it: a deletion holds no data. */
export type FileVersion = ConversationFile & { deleted: boolean };

/**
 * Files from code or the internet: their text is scanned for prompt
 * injections before the model reads it, and their URLs never become known.
 */
export const isUntrusted = (file: Pick<ConversationFile, "origin">) => file.origin === "code" || file.origin === "internet";

const FILE_SELECT = {
  id: true,
  name: true,
  mimeType: true,
  size: true,
  text: true,
  info: true,
  origin: true,
  deleted: true,
  createdAt: true,
  message: { select: { role: true } },
} satisfies Prisma.MessageAttachmentSelect;

type FileRow = Prisma.MessageAttachmentGetPayload<{ select: typeof FILE_SELECT }>;

function toVersion(row: FileRow): FileVersion {
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
    deleted: row.deleted,
  };
}

const toFile = ({ deleted: _deleted, ...file }: FileVersion): ConversationFile => file;

// Names are compared without case, as the model refers to files by name
const nameKey = (name: string) => name.toLowerCase();

/** Every version of every file, in the order they came, deletions included. */
async function allVersions(conversationId: string): Promise<FileVersion[]> {
  const rows = await prisma.messageAttachment.findMany({
    where: { message: { conversationId }, name: { not: null }, parentId: null },
    orderBy: [{ message: { position: "asc" } }, { createdAt: "asc" }],
    select: FILE_SELECT,
  });
  return rows.map(toVersion);
}

/** The versions of each name, oldest first, in the order of each name's newest version. */
function byName(versions: FileVersion[]): FileVersion[][] {
  const names = new Map<string, FileVersion[]>();
  for (const version of versions) {
    const key = nameKey(version.name);
    const list = names.get(key) ?? [];
    names.delete(key); // so that the map keeps the order of the newest versions
    names.set(key, [...list, version]);
  }
  return [...names.values()];
}

/**
 * The conversation's sandbox: its files in the order they came, the newest
 * version of each name only. A file whose newest version is a deletion is gone.
 */
export async function conversationFiles(conversationId: string): Promise<ConversationFile[]> {
  return byName(await allVersions(conversationId))
    .map((versions) => versions[versions.length - 1])
    .filter((newest) => !newest.deleted)
    .map(toFile);
}

/**
 * The sandbox's files with their history, for the sandbox panel: per file, all
 * of its versions, newest first, deletions included.
 */
export async function sandboxHistory(conversationId: string): Promise<FileVersion[][]> {
  return byName(await allVersions(conversationId))
    .filter((versions) => !versions[versions.length - 1].deleted)
    .map((versions) => [...versions].reverse());
}

/** How many bytes the files take together. */
export function sandboxBytes(files: Pick<ConversationFile, "size">[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/**
 * The file the model means by `name`: the one with that path (without case),
 * else the only one with that file name in any folder, else the only one with
 * that name without extension, or whose path ends with it.
 */
export function findFile(files: ConversationFile[], name: unknown): ConversationFile | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const wanted = name.trim().toLowerCase().replace(/\\/g, "/").replace(/^\/?(sandbox\/)?(\.\/)?/, "");
  const exact = files.find((f) => nameKey(f.name) === wanted);
  if (exact) return exact;
  const only = (matches: ConversationFile[]) => (matches.length === 1 ? matches[0] : null);
  const wantedBase = baseName(wanted);
  const sameBase = only(files.filter((f) => nameKey(baseName(f.name)) === wantedBase));
  if (sameBase) return sameBase;
  const stem = (f: ConversationFile) => nameKey(baseName(f.name)).slice(0, -(extensionOf(f.name).length + 1));
  return only(files.filter((f) => stem(f) === wantedBase || nameKey(f.name).endsWith(wanted)));
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

/** A prompt injection scan of a part of an untrusted file's text, as it is remembered with the file. */
export type RememberedScan = { flagged: boolean; score: number; chunk?: string };

/** The key of a remembered scan of a file's whole text, such as that of a download (see checkFile). */
export const WHOLE_TEXT = "all";

/**
 * The remembered scan of the part of the file's text whose SHA-256 is `hash`,
 * if it was scanned; a clean scan of the whole text counts for every part.
 */
export async function rememberedScan(id: string, hash: string): Promise<RememberedScan | null> {
  const row = await prisma.messageAttachment.findUnique({ where: { id }, select: { scans: true } });
  const scans = (row?.scans ?? {}) as Record<string, RememberedScan>;
  return scans[hash] ?? (scans[WHOLE_TEXT]?.flagged === false ? scans[WHOLE_TEXT] : null);
}

/** Remembers the scan of a part of the file's text, by the part's SHA-256. */
export async function rememberScan(id: string, hash: string, scan: RememberedScan) {
  const row = await prisma.messageAttachment.findUnique({ where: { id }, select: { scans: true } });
  const scans = (row?.scans ?? {}) as Record<string, RememberedScan>;
  await prisma.messageAttachment.update({
    where: { id },
    data: { scans: { ...scans, [hash]: scan } as Prisma.InputJsonValue },
  });
}

/**
 * Deletes the file `name` from the conversation's sandbox, with all of its
 * versions. Returns how many versions were deleted (0: there is no such file).
 */
export async function deleteSandboxFile(conversationId: string, name: string): Promise<number> {
  const versions = (await allVersions(conversationId)).filter((v) => nameKey(v.name) === nameKey(name));
  if (!versions.length) return 0;
  const { count } = await prisma.messageAttachment.deleteMany({ where: { id: { in: versions.map((v) => v.id) } } });
  return count;
}
