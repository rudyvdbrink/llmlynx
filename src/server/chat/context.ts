// Keeps the conversation within the model's context window while a reply
// runs. Before every request to the model, also in the middle of a reply, the
// view is checked against the budget (budget.ts): when the request would pass
// the start mark, the reduction ladder runs (reduce.ts), and when pointers
// cannot bring the request back under that mark, a checkpoint is made
// (checkpoint.ts). After every request,
// what it took is measured, stored with the step, and sent to the chat view's
// indicator.

import type { ReplyStatus } from "@/lib/types";
import type { SecuritySession } from "@/server/security/engine";
import type { ToolDefinition } from "@/server/tools/definitions";
import { createBudget, type ContextFill, type Usage } from "./budget";
import { makeCheckpoint } from "./checkpoint";
import type { AssistantReply } from "./conversation";
import { limitImages, reduceView, type Recall } from "./reduce";
import type { ViewMessage } from "./view";

/** What a chat's context is managed with: set up by the chat route, before the reply's stream starts. */
export type ContextConfig = {
  conversationId: string;
  tools: ToolDefinition[];
  security: SecuritySession | null;
  /** The model's context window in tokens; null when it is not known yet (see streamOllamaChat) or at all. */
  window: number | null;
};

/** A line of the reply's stream about its context: what the model is busy with, how full the window is, a checkpoint that was made. */
export type ContextLine =
  | { status: ReplyStatus }
  | { context: ContextFill }
  | { checkpoint: { id: string; summary: string; by: "auto" } };

/** The ways back to a cleared result that a chat with `tools` has. */
export const recallOf = (tools: Pick<ToolDefinition, "name">[]): Recall => ({
  results: tools.some((t) => t.name === "read_result"),
  files: tools.some((t) => t.name === "read_file"),
  runs: tools.some((t) => t.name === "read_run_log"),
});

export type ContextManager = {
  /** Before a request: reduces `view`, in place, when the request would be too long. */
  prepare(view: ViewMessage[]): Promise<void>;
  /** After a request: `view` as it was sent took `usage`. */
  measured(view: ViewMessage[], usage: Usage | undefined): void;
  /** A round of tool calls starts: its results share the reserve. */
  startRound(): void;
  /** The most characters the next result of the round may have. */
  resultChars(): number;
  /** A result of the round took `chars` characters. */
  addResult(chars: number): void;
};

/**
 * Opens the context of a reply on a model whose window is `window` tokens.
 * `ask` is one request to the model without tools, whose answer the user does
 * not see: it writes the summary of a checkpoint. `send` writes a line to the
 * reply's stream.
 */
export function openContext({
  config,
  window,
  reply,
  signal,
  ask,
  send,
}: {
  config: ContextConfig;
  window: number;
  reply: AssistantReply;
  signal: AbortSignal;
  ask: (messages: ViewMessage[]) => Promise<string>;
  send: (line: ContextLine) => void;
}): ContextManager {
  const { conversationId, tools, security } = config;
  const budget = createBudget(window, tools);
  const recall = recallOf(tools);

  return {
    async prepare(view) {
      if (await limitImages(view)) budget.reduced();
      if (budget.tokens(view) <= budget.start) return;
      budget.reduced();
      await reduceView(view, { conversationId, budget, recall });
      // Pointers aim for the low mark. A checkpoint is only made when they cannot even bring the request
      // back under the start mark: a summary costs a request to the model, and loses more than a pointer does
      if (budget.tokens(view) > budget.start) {
        // Writing the summary is a request to the model: the user sees what the reply waits for
        send({ status: "compacting" });
        const made = await makeCheckpoint({
          conversationId,
          view,
          budget,
          by: "auto",
          tools,
          security,
          signal,
          ask,
          store: (summary, meta) => reply.saveCheckpoint(summary, meta),
        });
        if (made) send({ checkpoint: { id: made.id, summary: made.summary, by: "auto" } });
        send({ status: "thinking" });
      }
      // Whatever is protected, the request must leave room for the reply
      if (budget.tokens(view) > budget.hardLimit) {
        await reduceView(view, { conversationId, budget, recall, hard: true, limit: budget.hardLimit });
      }
    },
    measured(view, usage) {
      if (!usage || !(usage.input > 0)) return;
      budget.measured(view, usage);
      reply.noteUsage({ input: usage.input, output: usage.output, window: budget.window });
      send({ context: budget.fill(usage) });
    },
    startRound: () => budget.startRound(),
    resultChars: () => budget.resultChars(),
    addResult: (chars) => budget.addResult(chars),
  };
}
