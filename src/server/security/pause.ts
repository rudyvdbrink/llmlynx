// Replies that wait for the user's choice: about flagged content from the
// internet ("flagged": remove it and continue, or stop), or, in a tainted
// chat, about running code ("approval": run it, or go on without). A pause
// lives as long as the attempt it belongs to runs (see
// server/chat/attempts.ts): it ends as "stop" when the chat is stopped, the
// client is gone, or nobody answers in time. Only the user it was opened for
// can answer it, once.

import { randomUUID } from "node:crypto";
import type { ApprovalDecision, PauseDecision } from "@/lib/types";
import { PAUSE_TIMEOUT_MS } from "./limits";

export type PauseKind = "flagged" | "approval";

/** What a pause can be answered with, by its kind. Both can end as "stop". */
export type Answer = PauseDecision | ApprovalDecision;

const ANSWERS: Record<PauseKind, Answer[]> = { flagged: ["remove", "stop"], approval: ["run", "skip"] };

type Pending = { userId: string; kind: PauseKind; settle: (decision: Answer) => void };

// On globalThis: the chat route opens a pause and another route answers it, and
// each route may get its own copy of this module
const store = globalThis as { llmlynxPauses?: Map<string, Pending> };
const pending = (store.llmlynxPauses ??= new Map<string, Pending>());

/**
 * Opens a pause of `kind` for `userId`. `decision` resolves with their choice,
 * or with "stop" when `signal` aborts or `timeoutMs` pass without one.
 */
export function openPause<Kind extends PauseKind = "flagged">(
  userId: string,
  signal: AbortSignal,
  timeoutMs = PAUSE_TIMEOUT_MS,
  kind: Kind = "flagged" as Kind
): { id: string; decision: Promise<Kind extends "approval" ? ApprovalDecision | "stop" : PauseDecision> } {
  const id = randomUUID();
  const decision = new Promise<Answer>((resolve) => {
    const settle = (choice: Answer) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(choice);
    };
    const onAbort = () => settle("stop");
    const timer = setTimeout(onAbort, timeoutMs);
    pending.set(id, { userId, kind, settle });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { id, decision: decision as Promise<Kind extends "approval" ? ApprovalDecision | "stop" : PauseDecision> };
}

/**
 * Answers the pause `id` with `decision`. Returns false when there is no such
 * pause any more (it was answered, or its reply ended), it is not `userId`'s,
 * or `decision` is not an answer to its kind of pause.
 */
export function answerPause(id: string, userId: string, decision: Answer): boolean {
  const pause = pending.get(id);
  if (!pause || pause.userId !== userId || !ANSWERS[pause.kind].includes(decision)) return false;
  pause.settle(decision);
  return true;
}
