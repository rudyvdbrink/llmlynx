// read_run_log: the output a run of code printed, as it was kept with the run
// (SandboxRun), read again by lines without running the code again, for the
// part that run_code's result left out. Output a run's result withheld stays
// withheld; a part read here is scanned like the run's own result, and one
// that is flagged withholds the whole log from then on.

import { formatSize } from "@/lib/files";
import { prisma } from "@/server/db/prisma";
import { excerpt, numbered, sourceLines } from "@/server/files/source";
import { checkAfterCall } from "@/server/security/engine";
import { toInteger } from "@/server/tools/args";
import type { Args, ToolCallContext, ToolDefinition, ToolResult } from "@/server/tools/definitions";

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });
const success = (text: string): ToolResult => ({ text, images: [], files: [], error: false });

/** The lines of `lines` that hold `find`, numbered, as many as fit in `budget`. */
function findLines(id: string, lines: string[], find: string, budget: number): string {
  const width = String(lines.length).length;
  const hits = lines.map((line, i) => ({ line, n: i + 1, at: line.indexOf(find) })).filter((h) => h.at >= 0);
  if (!hits.length) return `No line of run ${id}'s output holds ${JSON.stringify(find)}.`;
  const shown: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const row = numbered(hit.n, excerpt(hit.line, hit.at), width);
    if (used + row.length + 1 > budget) break;
    shown.push(row);
    used += row.length + 1;
  }
  const head = `${hits.length} of the ${lines.length} lines hold ${JSON.stringify(find)}${shown.length < hits.length ? `; the first ${shown.length}` : ""}:`;
  return [head, ...shown, "[Read the lines around one with start_line.]"].join("\n");
}

/** Lines `first` to `last` of `lines`, numbered, as many as fit in `budget`; a line too long is cut. */
function pageOf(lines: string[], first: number, last: number, budget: number): { text: string; lastShown: number } {
  const width = String(last).length;
  const shown: string[] = [];
  let used = 0;
  let n = first;
  for (; n <= last; n++) {
    let row = numbered(n, lines[n - 1], width);
    if (used + row.length + 1 > budget) {
      if (shown.length) break;
      row = `${row.slice(0, Math.max(100, budget - 80))} [... the rest of this line, ${lines[n - 1].length} characters in all, is left out]`;
    }
    shown.push(row);
    used += row.length + 1;
  }
  return { text: shown.join("\n"), lastShown: n - 1 };
}

/**
 * Reads the output of the run `args.run` of this chat: the lines from
 * `start_line` to `end_line`, or the lines that hold `find`. `def` is the
 * tool, for the scan of what it returns.
 */
export async function readRunLog(def: ToolDefinition, args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const id = typeof args.run === "string" ? args.run.trim() : "";
  if (!id) return failure("run is required: the run's id, as run_code's result gives it (run: run-...).");
  const run = await prisma.sandboxRun.findFirst({ where: { id, conversationId: ctx.conversationId } });
  if (!run) {
    const latest = await prisma.sandboxRun.findMany({
      where: { conversationId: ctx.conversationId, kind: "run", id: { startsWith: "run-" } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true },
    });
    return failure(`There is no run ${id} in this chat.${latest.length ? ` The latest runs are: ${latest.map((r) => r.id).join(", ")}.` : ""}`);
  }
  if (run.status === "withheld") {
    return failure("The output of this run was withheld, as it looked like instructions aimed at the model or could not be checked. It stays withheld.");
  }
  if (run.status === "blocked" || run.status === "skipped") return failure("This run did not run, so it printed nothing.");
  const lines = sourceLines(run.output);
  if (!lines.length) return success(`Run ${id} printed nothing.`);

  let text: string;
  const find = typeof args.find === "string" ? args.find : "";
  if (find.trim()) {
    text = findLines(id, lines, find, ctx.textBudget);
  } else {
    const start = toInteger(args.start_line);
    const end = toInteger(args.end_line);
    if (start === null || (start !== undefined && start < 1)) return failure("start_line must be a whole number from 1.");
    const first = start ?? 1;
    if (end === null || (end !== undefined && end < first)) return failure(`end_line must be a whole number from start_line (${first}).`);
    if (first > lines.length) return failure(`Run ${id} printed only ${lines.length} lines.`);
    const last = Math.min(end ?? lines.length, lines.length);
    const page = pageOf(lines, first, last, ctx.textBudget);
    const notes = [`Run ${id}, lines ${first} to ${page.lastShown} of ${lines.length}:`, page.text];
    if (page.lastShown < last) notes.push(`[Call read_run_log with start_line=${page.lastShown + 1} for the next part.]`);
    const kept = Buffer.byteLength(run.output);
    if (page.lastShown === lines.length && run.printedBytes !== null && run.printedBytes > kept) {
      notes.push(`[The end of what was kept. The run printed ${formatSize(run.printedBytes)}; what came after the first 1 MB was never kept and cannot be read.]`);
    }
    text = notes.join("\n");
  }

  const result = success(text);
  if (!ctx.security) return result;
  // Scanned here rather than after the call, so that a flagged part withholds the log for good
  const checked = await checkAfterCall(def, args, result, ctx.security, ctx.signal);
  if (checked.security) {
    // Content that could not be checked now may be checked later; flagged content stays withheld
    if (checked.security.flag !== "unchecked") await prisma.sandboxRun.update({ where: { id: run.id }, data: { status: "withheld" } });
    return checked;
  }
  return { ...checked, scanned: true };
}
