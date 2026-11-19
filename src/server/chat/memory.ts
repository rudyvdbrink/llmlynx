// The working memory: a short block llmlynx keeps up to date for an agent
// with tools, and attaches to the user's newest message. It holds what the
// model must not lose when older steps are cleared from its view: today's
// date, the files of the conversation's sandbox with what the model has read
// of each, and the task notes the model keeps itself (update_notes).
//
// The files and what was read of them are worked out from the stored steps,
// not written by the model, so they are right also with a weak model. The
// block stays with the message it went out with, so a later request sends the
// message as that one did; a message only gets a new copy when the block
// changed.

import { Prisma } from "@prisma/client";
import { MAX_NOTES } from "@/lib/agentTools";
import { formatSize } from "@/lib/files";
import { prisma } from "@/server/db/prisma";
import { conversationFiles, type ConversationFile } from "@/server/files/store";
import { chatRepos } from "@/server/sandbox/git";
import type { ReadFact, ToolDefinition } from "@/server/tools/definitions";
import { hasFileTools } from "@/server/tools/policy";
import { lastCheckpoint, storedCalls } from "./view";

const ORIGINS: Record<ConversationFile["origin"], string> = {
  user: "attached by the user",
  model: "created by you",
  code: "made by code",
  internet: "downloaded",
};

// Most files the list names one by one: the newest ones
const MAX_LISTED = 60;
// Most parts of a file the list names as read
const MAX_RANGES = 3;
// How many of the newest steps with tool calls are searched for the notes
const NOTES_LOOKBACK = 200;

const nameKey = (name: string) => name.toLowerCase();

/** What read_file showed the model so far in the conversation, oldest first. */
export async function readFacts(conversationId: string): Promise<ReadFact[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "tool", toolName: "read_file" },
    orderBy: { position: "asc" },
    select: { metadata: true },
  });
  return rows.flatMap((row) => {
    const read = (row.metadata as { read?: Partial<ReadFact> } | null)?.read;
    if (!read || typeof read.fileId !== "string" || typeof read.name !== "string") return [];
    if (typeof read.from !== "number" || typeof read.to !== "number" || typeof read.total !== "number") return [];
    return [{ fileId: read.fileId, name: read.name, unit: read.unit === "lines" ? "lines" : "characters", from: read.from, to: read.to, total: read.total }];
  });
}

/** What the model read of `file`, in words, or null when it read nothing of it. */
function readNote(file: ConversationFile, facts: ReadFact[]): string | null {
  const ofName = facts.filter((f) => nameKey(f.name) === nameKey(file.name));
  if (!ofName.length) return null;
  const current = ofName.filter((f) => f.fileId === file.id);
  if (!current.length) return "changed since you read it";
  // The parts it read as lines, or else as characters, joined where they touch
  const unit = current.some((f) => f.unit === "lines") ? "lines" : "characters";
  const parts = current.filter((f) => f.unit === unit).sort((a, b) => a.from - b.from);
  const ranges: { from: number; to: number }[] = [];
  for (const part of parts) {
    const last = ranges[ranges.length - 1];
    if (last && part.from <= last.to + (unit === "lines" ? 1 : 0)) last.to = Math.max(last.to, part.to);
    else ranges.push({ from: part.from, to: part.to });
  }
  const total = parts[parts.length - 1].total;
  const whole = ranges.length === 1 && ranges[0].from <= (unit === "lines" ? 1 : 0) && ranges[0].to >= total;
  if (whole) return "you read all of it";
  const shown = ranges.slice(0, MAX_RANGES).map((r) => `${r.from} to ${r.to}`);
  return `you read ${unit} ${shown.join(", ")}${ranges.length > MAX_RANGES ? " and more" : ""} of ${total}`;
}

/**
 * The conversation's files as lines of a list, the newest version of each,
 * with where each came from and what the model read of it. The files of a
 * git repository in a folder of `repos` are counted, not listed: git lists
 * them, and search_workspace when the agent has it (`search`).
 */
export function filesList(files: ConversationFile[], repos: string[] = [], search = false, facts: ReadFact[] = []): string[] {
  const folders = repos.filter(Boolean);
  const repoOf = (name: string) => folders.find((r) => name.toLowerCase().startsWith(`${r.toLowerCase()}/`));
  const entries: (string | { repo: string; count: number; size: number })[] = [];
  const summed = new Map<string, { repo: string; count: number; size: number }>();
  for (const repo of folders) summed.set(repo, { repo, count: 0, size: 0 });
  for (const f of files) {
    const repo = repoOf(f.name);
    if (!repo) {
      const read = readNote(f, facts);
      entries.push(`${f.name} (${formatSize(f.size)}, ${ORIGINS[f.origin]}${read ? `; ${read}` : ""})`);
      continue;
    }
    const sum = summed.get(repo)!;
    if (!sum.count) entries.push(sum);
    sum.count++;
    sum.size += f.size;
  }
  for (const sum of summed.values()) if (!sum.count) entries.push(sum);
  const lines = entries.map((e) =>
    typeof e === "string"
      ? e
      : `${e.repo}/ (a git repository: ${e.count} files, ${formatSize(e.size)}; ${search ? "search_workspace or " : ""}git ls-files lists them)`
  );
  if (repos.includes("")) lines.push("The sandbox itself is a git repository.");
  if (lines.length <= MAX_LISTED) return lines;
  const left = lines.length - MAX_LISTED;
  return [`(${left} older files are not listed${search ? ": search_workspace finds them" : ""}.)`, ...lines.slice(-MAX_LISTED)];
}

/** The task notes the model keeps: those of its newest update_notes call, or null. */
export async function taskNotes(conversationId: string): Promise<string | null> {
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "assistant", toolCalls: { not: Prisma.AnyNull } },
    orderBy: { position: "desc" },
    take: NOTES_LOOKBACK,
    select: { toolCalls: true },
  });
  for (const row of rows) {
    const call = storedCalls(row.toolCalls).findLast((c) => c.name === "update_notes");
    const notes = call?.arguments.notes;
    if (typeof notes === "string" && notes.trim()) return notes.trim().slice(0, MAX_NOTES);
  }
  return null;
}

/**
 * The working memory of a chat with `tools`, as the text that goes at the
 * end of the user's message; null for a chat without tools, which has none.
 */
export async function workingMemory(conversationId: string, tools: ToolDefinition[], today = new Date()): Promise<string | null> {
  if (!tools.length) return null;
  const has = (name: string) => tools.some((t) => t.name === name);
  const lines = ["[Working memory, kept by llmlynx. It replaces any earlier copy.", `Today's date: ${today.toISOString().slice(0, 10)}.`];
  if (hasFileTools(tools)) {
    const [files, repos, facts] = await Promise.all([
      conversationFiles(conversationId),
      has("git") ? chatRepos(conversationId) : [],
      readFacts(conversationId),
    ]);
    const list = filesList(
      files,
      repos.map((r) => r.path),
      has("search_workspace"),
      facts
    );
    if (list.length) lines.push("The files of this conversation, in its sandbox:", ...list.map((line) => `- ${line}`));
    else lines.push("The files of this conversation, in its sandbox: none.");
  }
  if (has("update_notes")) {
    const notes = await taskNotes(conversationId);
    if (notes) lines.push("Your task notes (keep them up to date with update_notes):", notes);
  }
  return `${lines.join("\n")}]`;
}

/**
 * The working memory the model has in view before the message `except` (the
 * one being sent): that of the newest user message that still has its copy,
 * or else the one that went with the newest checkpoint. A message only gets a
 * new copy when the memory changed.
 */
export async function memoryInView(conversationId: string, except: string): Promise<string | null> {
  const checkpoint = await lastCheckpoint(conversationId);
  const rows = await prisma.message.findMany({
    where: { conversationId, role: "user", position: { gt: checkpoint?.upTo ?? -1 }, id: { not: except } },
    orderBy: { position: "desc" },
    select: { metadata: true },
  });
  for (const row of rows) {
    const meta = row.metadata as { memory?: unknown; memoryCleared?: unknown } | null;
    if (typeof meta?.memory === "string" && meta.memoryCleared !== true) return meta.memory;
  }
  return checkpoint?.memory ?? null;
}
