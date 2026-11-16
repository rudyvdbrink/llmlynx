// Replies that wait for the user's choice about flagged content from the
// internet. A pause lives as long as the attempt it belongs to runs (see
// server/chat/attempts.ts): it ends as "stop" when the chat is stopped, the
// client is gone, or nobody answers in time. Only the user it was opened for
// can answer it, once.

import { randomUUID } from "node:crypto";
import type { PauseDecision } from "@/lib/types";
import { PAUSE_TIMEOUT_MS } from "./limits";

type Pending = { userId: string; settle: (decision: PauseDecision) => void };

// On globalThis: the chat route opens a pause and another route answers it, and
// each route may get its own copy of this module
const store = globalThis as { llmlynxPauses?: Map<string, Pending> };
const pending = (store.llmlynxPauses ??= new Map<string, Pending>());

/**
 * Opens a pause for `userId`. `decision` resolves with their choice, or with
 * "stop" when `signal` aborts or `timeoutMs` pass without one.
 */
export function openPause(
  userId: string,
  signal: AbortSignal,
  timeoutMs = PAUSE_TIMEOUT_MS
): { id: string; decision: Promise<PauseDecision> } {
  const id = randomUUID();
  const decision = new Promise<PauseDecision>((resolve) => {
    const settle = (choice: PauseDecision) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(choice);
    };
    const onAbort = () => settle("stop");
    const timer = setTimeout(onAbort, timeoutMs);
    pending.set(id, { userId, settle });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { id, decision };
}

/**
 * Answers the pause `id` with `decision`. Returns false when there is no such
 * pause any more (it was answered, or its reply ended) or it is not `userId`'s.
 */
export function answerPause(id: string, userId: string, decision: PauseDecision): boolean {
  const pause = pending.get(id);
  if (!pause || pause.userId !== userId) return false;
  pause.settle(decision);
  return true;
}
