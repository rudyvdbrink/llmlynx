// Files the user attached in the composer and has not sent yet: drafts (the
// Upload model). A file is checked when it is attached (see checkFile in
// server/security/engine.ts), while the user types, and is stored as a draft
// with its text. Sending a message moves its drafts into the message, so
// nothing is converted or checked again.

import type { Prisma } from "@prisma/client";
import { mimeTypeOf } from "@/lib/files";
import { prisma } from "@/server/db/prisma";
import { createAuditLog } from "@/server/security/audit";
import { checkFile } from "@/server/security/engine";
import { DRAFT_MAX_AGE_MS, MAX_UPLOADS_AT_ONCE } from "@/server/security/limits";

/**
 * What POST /api/uploads answers. "clean": stored, `id` is the draft's.
 * "virus" and "unchecked": nothing was stored.
 */
export type UploadOutcome =
  | { outcome: "clean"; id: string }
  | { outcome: "virus"; name: string; signature: string; message: string }
  | { outcome: "unchecked"; message: string };

const UNCHECKED_MESSAGE = "The file could not be checked; try again in a moment";

/** Runs at most `max` pieces of work at once; more wait their turn. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function inTurn<T>(work: () => Promise<T>): Promise<T> {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      // The next in line takes this turn over
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// As many as the files server converts at once: the server may be small
const inTurn = createLimiter(MAX_UPLOADS_AT_ONCE);

/**
 * Checks a file the user attached and stores it as a draft, unless it has a
 * virus or could not be checked. Drafts older than a day are deleted first.
 * Throws only when `signal` aborts (the user removed the file again).
 */
export async function receiveUpload({
  userId,
  name,
  data,
  signal,
}: {
  userId: string;
  name: string;
  data: Uint8Array<ArrayBuffer>;
  signal: AbortSignal;
}): Promise<UploadOutcome> {
  await prisma.upload.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - DRAFT_MAX_AGE_MS) } } });
  const audit = createAuditLog(userId, null);
  try {
    return await inTurn(async (): Promise<UploadOutcome> => {
      const check = await checkFile({ data, name, source: "user", audit, signal });
      if (check.outcome === "virus") {
        const { signature } = check;
        return { outcome: "virus", name, signature, message: `Refused: it contains a virus (${signature})` };
      }
      // A user's file is not scanned for prompt injections, so only a clean one is left
      if (check.outcome !== "clean") return { outcome: "unchecked", message: UNCHECKED_MESSAGE };
      const { id } = await prisma.upload.create({
        data: { userId, name, mimeType: mimeTypeOf(name), data, text: check.text, ...(check.info ? { info: check.info } : {}) },
        select: { id: true },
      });
      return { outcome: "clean", id };
    });
  } finally {
    await audit.flush();
  }
}

/** Deletes the user's draft `id`. Returns false when there is no such draft. */
export async function deleteUpload(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.upload.deleteMany({ where: { id, userId } });
  return count > 0;
}

/** A sent message may not have one of its drafts. The message says why, for the user. */
export class UploadRefused extends Error {}

/**
 * The drafts a message is sent with: `problem` says why the chat cannot take a
 * file, or null. `room` says why the files do not fit in the chat's sandbox,
 * or null (see server/sandbox/room.ts).
 */
export type UploadsToSend = {
  userId: string;
  ids: string[];
  problem: (file: { name: string; size: number }) => string | null;
  room?: (files: { name: string; size: number }[]) => string | null;
};

/** A draft as it moves into a message. */
export type SentFile = {
  name: string;
  mimeType: string;
  data: Uint8Array<ArrayBuffer>;
  text: string | null;
  info: Prisma.InputJsonValue | null;
};

/**
 * Takes the drafts out of the store, in the order of `ids`, for the message
 * they are sent with. Throws UploadRefused, and takes none, when one of them
 * is not the user's or cannot go to this chat.
 */
export async function takeUploads(tx: Prisma.TransactionClient, { userId, ids, problem, room }: UploadsToSend): Promise<SentFile[]> {
  const wanted = [...new Set(ids)];
  const rows = await tx.upload.findMany({ where: { id: { in: wanted }, userId } });
  const drafts = wanted.map((id) => rows.find((row) => row.id === id));
  const files: SentFile[] = [];
  for (const draft of drafts) {
    if (!draft) throw new UploadRefused("An attached file is no longer there. Attach it again.");
    const why = problem({ name: draft.name, size: draft.data.length });
    if (why) throw new UploadRefused(why);
    files.push({
      name: draft.name,
      mimeType: draft.mimeType,
      data: draft.data,
      text: draft.text,
      info: draft.info as Prisma.InputJsonValue | null,
    });
  }
  const full = room?.(files.map((f) => ({ name: f.name, size: f.data.length })));
  if (full) throw new UploadRefused(`The files do not fit: ${full}`);
  await tx.upload.deleteMany({ where: { id: { in: wanted }, userId } });
  return files;
}
