// The agent tools that work on the conversation itself rather than on the
// world: read_result reads an earlier tool result again, without doing the
// work again, for a result that was cleared from the model's view (see
// server/chat/reduce.ts); update_notes keeps the model's task notes, which
// stay in its working memory when older steps are cleared (see
// server/chat/memory.ts). See definitions.ts for what a tool definition is.

import { MAX_NOTES } from "@/lib/agentTools";
import { prisma } from "@/server/db/prisma";
import { checkStart, toInteger } from "./args";
import type { ToolDefinition, ToolResult } from "./definitions";

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });
const success = (text: string): ToolResult => ({ text, images: [], files: [], error: false });

// These fetch nothing and run nothing. What read_result gives was checked when it first arrived, and
// what was withheld then was never stored
const LOCAL = { untrustedOutput: false, exec: false };

export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "read_result",
    icon: "spanner",
    description:
      "Read the result of an earlier tool call again, as it was, without making the call again: for a result that " +
      "was cleared to save room. Give its number, as the note in its place says. Long results come in parts; the " +
      "result says where the next part starts.",
    parameters: {
      type: "object",
      properties: {
        result: { type: "integer", description: "The result's number, as the note that took its place gives it" },
        start: { type: "integer", description: "For long results: the character to start reading at, as the previous part says. Default 0" },
      },
      required: ["result"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 30_000,
    effects: LOCAL,
    label(args, state) {
      const number = toInteger(args.result);
      const what = typeof number === "number" ? `result ${number}` : "an earlier result";
      if (state === "running") return `Reading ${what} again`;
      return state === "done" ? `Read ${what} again` : `Could not read ${what} again`;
    },
    async run(args, ctx) {
      const number = toInteger(args.result);
      if (typeof number !== "number" || number < 0) return failure("result must be the number of an earlier result.");
      const start = checkStart(args.start);
      if ("error" in start) return failure(start.error);
      const where = { conversationId: ctx.conversationId, role: "tool" as const };
      let step = await prisma.message.findFirst({ where: { ...where, position: number }, select: { content: true, metadata: true } });
      if (!step) return failure(`there is no result ${number} in this conversation.`);
      // A second copy of a result refers to the first, which holds the text
      const sameAs = (step.metadata as { sameAs?: unknown } | null)?.sameAs;
      if (typeof sameAs === "string") {
        step = (await prisma.message.findFirst({ where: { ...where, id: sameAs }, select: { content: true, metadata: true } })) ?? step;
      }
      const text = step.content;
      if (start.start >= text.length && text.length > 0) return failure(`result ${number} has only ${text.length} characters.`);
      const end = Math.min(text.length, start.start + ctx.textBudget);
      const part = text.slice(start.start, end) || "(The result had no text.)";
      if (end < text.length) {
        return success(`${part}\n\n[Characters ${start.start} to ${end} of ${text.length}. Call read_result with result=${number} and start=${end} for the next part.]`);
      }
      return success(start.start > 0 ? `${part}\n\n[Characters ${start.start} to ${end}: the end of result ${number}.]` : part);
    },
  },
  {
    name: "update_notes",
    icon: "file",
    description:
      "Keep your task notes: the goal, the plan and how far it is, decisions and why, and what did not work. Each " +
      "call replaces the notes, so give all of them. They stay in your working memory when older steps are cleared, " +
      `so keep them short and up to date (at most ${MAX_NOTES} characters). The user does not see them.`,
    parameters: {
      type: "object",
      properties: { notes: { type: "string", description: "All of the notes, as short lines" } },
      required: ["notes"],
    },
    server: "files",
    needs: ["tools"],
    timeoutMs: 10_000,
    effects: LOCAL,
    label(_args, state) {
      if (state === "running") return "Updating its notes";
      return state === "done" ? "Updated its notes" : "Could not update its notes";
    },
    async run(args) {
      const notes = typeof args.notes === "string" ? args.notes.trim() : "";
      if (!notes) return failure("notes is required: all of your notes, as short lines.");
      if (notes.length > MAX_NOTES) return failure(`the notes are too long (${notes.length} characters; at most ${MAX_NOTES}). Shorten them.`);
      return success("Notes saved. They are in your working memory from your next reply on.");
    },
  },
];
