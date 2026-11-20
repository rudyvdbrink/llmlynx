// The reduction ladder: what leaves the view when the conversation no longer
// fits in the model's context window, least loss first.
//
//   1. What is superseded: older copies of the working memory, a read of a
//      file that was read again or changed since, a failed call that was
//      followed by one that worked, search results once pages were read, and
//      older images.
//   2. Old results, oldest first: each becomes a pointer, one line that says
//      what it was and how to get it back. The call stays, so the model still
//      sees what it did; its long arguments are cut short with it.
//
// The newest results, and the latest view of each file the model works on,
// are protected from step 2. When this is not enough, a checkpoint follows
// (checkpoint.ts). Nothing is deleted: the steps stay stored, and what was
// cleared is stored with them, so every later request has the same view.

import { conversationFiles } from "@/server/files/store";
import { shortUrl, shorten } from "@/server/tools/args";
import type { Budget } from "./budget";
import type { StoredToolCall } from "./conversation";
import {
  IMAGES_GONE,
  patchMetadata,
  withoutMemory,
  type AssistantMessage,
  type StepInfo,
  type ToolMessage,
  type UserMessage,
  type ViewMessage,
} from "./view";

// Most images in one request: some models take only a few
export const MAX_IMAGES = 8;
// A result shorter than this is not worth a pointer
const MIN_CLEARED_CHARS = 300;
// A pointer must save at least this many characters
const MIN_SAVED_CHARS = 80;
// A text argument of a cleared call that is longer than this is cut short
const MAX_ARGUMENT_CHARS = 400;

const FILE_WRITERS = ["create_file", "edit_file", "edit_files", "create_document", "create_spreadsheet"];
const PAGE_READERS = ["web_read", "web_read_rendered"];

/** The ways back to a cleared result that the model has now. */
export type Recall = {
  results: boolean; // read_result: any earlier result again
  files: boolean; // read_file
  runs: boolean; // read_run_log
};

/** A stored tool step in the view, with its call. */
type Unit = {
  index: number;
  message: ToolMessage & { step: StepInfo };
  call: StoredToolCall | null;
  assistant: AssistantMessage | null;
};

function units(view: ViewMessage[]): Unit[] {
  const out: Unit[] = [];
  const calls = new Map<string, { call: StoredToolCall; assistant: AssistantMessage }>();
  view.forEach((message, index) => {
    if (message.role === "assistant") for (const call of message.calls ?? []) calls.set(call.id, { call, assistant: message });
    if (message.role !== "tool" || !message.step) return;
    const made = calls.get(message.callId);
    out.push({ index, message: message as Unit["message"], call: made?.call ?? null, assistant: made?.assistant ?? null });
  });
  return out;
}

const nameKey = (name: string) => name.toLowerCase();

/** The file a step is about: the one it read, or made or changed, or the one its call names. */
function fileOf({ message, call }: Unit): string | null {
  const { read, files } = message.step;
  if (read) return read.name;
  if (files.length === 1) return files[0];
  const named = call?.arguments.file ?? call?.arguments.name;
  return typeof named === "string" && named.trim() ? named.trim() : null;
}

/** What a read showed, in words: "lines 1 to 180" or "characters 0 to 4000". */
const rangeOf = ({ unit, from, to }: NonNullable<StepInfo["read"]>) => (from === to ? `${unit === "lines" ? "line" : "character"} ${from}` : `${unit} ${from} to ${to}`);

/**
 * Why a step's result is superseded by what came after it, or null when it is
 * not: the model has no use for it any more.
 */
function supersededBy(unit: Unit, later: Unit[]): string | null {
  const { step, name } = unit.message;
  if (step.read) {
    const { read } = step;
    const key = nameKey(read.name);
    if (later.some((u) => [...u.message.step.files, ...u.message.step.deleted].some((f) => nameKey(f) === key))) {
      return `You read ${rangeOf(read)} of ${read.name}, which has changed since: read it again before you rely on it or edit it.`;
    }
    const again = later.some(({ message }) => {
      const other = message.step.read;
      return !!other && !message.step.cleared && other.fileId === read.fileId && other.unit === read.unit && other.from <= read.from && other.to >= read.to;
    });
    if (again) return `You read ${rangeOf(read)} of ${read.name} again later: that result is below.`;
    return null;
  }
  if (step.error) {
    return later.some((u) => u.message.name === name && !u.message.step.error) ? `This ${name} call failed; a later one worked.` : null;
  }
  if (name === "web_search" && later.some((u) => PAGE_READERS.includes(u.message.name) && !u.message.step.error)) {
    const query = typeof unit.call?.arguments.query === "string" ? ` for "${shorten(unit.call.arguments.query, 80)}"` : "";
    return `Search results${query}. You read pages afterwards.`;
  }
  return null;
}

/** The line that takes the place of a result: what it was, and how to get it back. */
function pointerFor(unit: Unit, recall: Recall, currentFiles: Map<string, string>, original?: Unit): string {
  const { message, call } = unit;
  const { step, name } = message;
  // A second copy of a result is read back as the result it referred to
  const source = original ?? unit;
  const again = recall.results ? ` Read it again with read_result, result ${source.message.step.position}.` : "";
  if (step.read) {
    const { read } = step;
    const current = currentFiles.get(nameKey(read.name));
    const state = !current
      ? `${read.name} no longer exists.`
      : current === read.fileId
        ? "The file has not changed since."
        : "The file has changed since: read it again before you rely on it or edit it.";
    const back = current && recall.files ? " Read it again with read_file if you need it." : "";
    return `[Cleared to save room. You read ${rangeOf(read)} of ${read.name}. ${state}${back}]`;
  }
  if (step.run && step.run.kind === "run") {
    const changed = step.files.length ? ` It made or changed ${shorten(step.files.join(", "), 200)}.` : "";
    const back = recall.runs ? ` Read what it printed with read_run_log, run ${step.run.id}.` : "";
    return `[Cleared to save room. A run of code, ${step.run.id} (${step.run.status}).${changed}${back}]`;
  }
  if (PAGE_READERS.includes(name)) {
    return `[Cleared to save room. The page ${shortUrl(call?.arguments.url)}, ${source.message.step.chars} characters.${again}]`;
  }
  if (name === "web_search") {
    const query = typeof call?.arguments.query === "string" ? ` for "${shorten(call.arguments.query, 80)}"` : "";
    return `[Cleared to save room. Search results${query}.${again}]`;
  }
  if (FILE_WRITERS.includes(name) && step.files.length) {
    return `[Cleared to save room. This call made or changed ${shorten(step.files.join(", "), 200)}, which ${step.files.length === 1 ? "is" : "are"} in the sandbox.]`;
  }
  return `[Cleared to save room. The result of ${name}, ${source.message.step.chars} characters.${again}]`;
}

/** A call's arguments with long texts cut short: the text is in the sandbox, or no longer matters. */
function shortArguments(unit: Unit): Record<string, unknown> | null {
  if (!unit.call) return null;
  let changed = false;
  const where = FILE_WRITERS.includes(unit.message.name) && unit.message.step.files.length === 1 ? `, saved as ${unit.message.step.files[0]}` : "";
  const short = (value: unknown): unknown => {
    if (typeof value === "string" && value.length > MAX_ARGUMENT_CHARS) {
      changed = true;
      const lines = value.split("\n").length;
      return `[${lines > 1 ? `${lines} lines` : `${value.length} characters`}${where}, cleared to save room]`;
    }
    if (Array.isArray(value)) return value.map(short);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, short(v)]));
    return value;
  };
  const args = short(unit.call.arguments) as Record<string, unknown>;
  return changed ? args : null;
}

/**
 * The steps that are protected from being cleared for their age: the newest
 * results, up to half of `chars`, and then the latest view of each file the
 * model works on, newest first, in what is left of it.
 */
function protectedSteps(all: Unit[], chars: number, round: Set<ViewMessage>): Set<string> {
  const kept = new Set<string>();
  const size = (unit: Unit) => unit.message.content.length + (unit.call ? JSON.stringify(unit.call.arguments).length : 0);
  let used = 0;
  const newestFirst = [...all].reverse().filter((u) => !u.message.step.cleared);
  // The results the model has not seen yet are kept whatever their size
  for (const unit of newestFirst) {
    if (!round.has(unit.message)) continue;
    kept.add(unit.message.step.rowId);
    used += size(unit);
  }
  for (const unit of newestFirst) {
    if (kept.has(unit.message.step.rowId)) continue;
    if (used + size(unit) > chars / 2) break;
    kept.add(unit.message.step.rowId);
    used += size(unit);
  }
  const seen = new Set<string>();
  for (const unit of newestFirst) {
    const file = fileOf(unit);
    if (!file || seen.has(nameKey(file))) continue;
    seen.add(nameKey(file));
    if (kept.has(unit.message.step.rowId)) continue;
    if (used + size(unit) > chars) continue;
    kept.add(unit.message.step.rowId);
    used += size(unit);
  }
  return kept;
}

/** The results of the round that is newest in the view: the ones after its last assistant step. */
function newestRound(view: ViewMessage[]): Set<ViewMessage> {
  const round = new Set<ViewMessage>();
  for (let i = view.length - 1; i >= 0 && view[i].role === "tool"; i--) round.add(view[i]);
  return round;
}

type Patches = Map<string, Record<string, unknown>>;

const addPatch = (patches: Patches, id: string, patch: Record<string, unknown>) => patches.set(id, { ...patches.get(id), ...patch });

/** Takes the images out of a result, which then says so. */
function clearImages(message: ToolMessage, patches: Patches) {
  if (!message.images?.length) return;
  delete message.images;
  if (!message.step?.cleared) message.content = [message.content, IMAGES_GONE].filter(Boolean).join("\n\n");
  if (message.step) addPatch(patches, message.step.rowId, { imagesCleared: true });
}

/**
 * Keeps the view within the most images a request may have: when it has
 * more, the older half of the images that tools returned goes at once, never
 * those of the newest round. Images the user attached go last, oldest first.
 * Returns true when the view changed.
 */
export async function limitImages(view: ViewMessage[]): Promise<boolean> {
  const count = () => view.reduce((n, m) => n + (m.role === "user" || m.role === "tool" ? (m.images?.length ?? 0) : 0), 0);
  if (count() <= MAX_IMAGES) return false;
  const patches: Patches = new Map();
  const round = newestRound(view);
  while (count() > MAX_IMAGES) {
    const older = view.filter((m): m is ToolMessage => m.role === "tool" && !!m.images?.length && !round.has(m));
    if (!older.length) break;
    for (const message of older.slice(0, Math.ceil(older.length / 2))) clearImages(message, patches);
  }
  // Not stored: which of them fit depends on what the tools returned since
  for (const message of view) {
    if (count() <= MAX_IMAGES) break;
    if (message.role === "user" && message.images?.length) delete message.images;
  }
  await patchMetadata([...patches].map(([id, patch]) => ({ id, patch })));
  return true;
}

/**
 * Reduces `view` in place, until it is no longer than the budget's target
 * after a reduction: what is superseded goes first, then old results become
 * pointers, oldest first. With `hard`, nothing is protected: the view must
 * get below `limit` tokens. What was cleared is stored with the steps.
 * Returns true when the view is short enough now.
 */
export async function reduceView(
  view: ViewMessage[],
  { conversationId, budget, recall, hard = false, limit }: { conversationId: string; budget: Budget; recall: Recall; hard?: boolean; limit?: number }
): Promise<boolean> {
  const target = limit ?? budget.target(view);
  const patches: Patches = new Map();
  const all = units(view);
  const current = new Map((await conversationFiles(conversationId)).map((f) => [nameKey(f.name), f.id]));

  function clear(unit: Unit, text: string, keepArguments = false) {
    const { message } = unit;
    message.content = text;
    delete message.images;
    message.step.cleared = true;
    const patch: Record<string, unknown> = { pointer: text, chars: message.step.chars };
    // The arguments of a step of the reply that is running go back to its provider as they came
    const args = keepArguments || unit.assistant?.extra !== undefined ? null : shortArguments(unit);
    if (args && unit.call) {
      unit.call.arguments = args;
      patch.args = args;
    }
    addPatch(patches, message.step.rowId, patch);
    // A second copy of this result referred to it: it is a pointer too now
    for (const other of all) {
      if (other.message.step.sameAs === message.step.rowId && !other.message.step.cleared) {
        clear(other, pointerFor(other, recall, current, unit), true);
      }
    }
  }

  // Older copies of the working memory: the newest replaces them
  const memories = view.filter((m): m is UserMessage => m.role === "user" && !!m.memory);
  for (const message of memories.slice(0, -1)) {
    withoutMemory(message);
    if (message.rowId) addPatch(patches, message.rowId, { memoryCleared: true });
  }

  // What is superseded; the results of the newest round aside, which the model has not seen yet
  const round = newestRound(view);
  all.forEach((unit, i) => {
    if (unit.message.step.cleared || (!hard && round.has(unit.message))) return;
    const reason = supersededBy(unit, all.slice(i + 1));
    if (reason && unit.message.content.length > reason.length + MIN_SAVED_CHARS) clear(unit, `[Cleared to save room. ${reason}]`);
  });

  // Older images
  const withImages = view.filter((m): m is ToolMessage => m.role === "tool" && !!m.images?.length);
  const newest = withImages.filter((m) => round.has(m));
  for (const message of withImages) {
    if (newest.length ? !round.has(message) : message !== withImages[withImages.length - 1]) clearImages(message, patches);
  }

  // Old results, oldest first
  if (budget.tokens(view) > target) {
    const kept = hard ? new Set<string>() : protectedSteps(all, budget.chars(budget.protectedTokens(view)), round);
    for (const unit of all) {
      const { message } = unit;
      if (message.step.cleared || kept.has(message.step.rowId)) continue;
      // Worth it when the result is long, has images, or its call has long arguments
      const longCall = !!unit.call && JSON.stringify(unit.call.arguments).length > MAX_ARGUMENT_CHARS;
      if (message.content.length < MIN_CLEARED_CHARS && !longCall && !message.images?.length) continue;
      const pointer = pointerFor(unit, recall, current);
      if (message.content.length < pointer.length + MIN_SAVED_CHARS && !longCall && !message.images?.length) continue;
      clear(unit, pointer);
      if (budget.tokens(view) <= target) break;
    }
  }

  await patchMetadata([...patches].map(([id, patch]) => ({ id, patch })));
  return budget.tokens(view) <= target;
}
