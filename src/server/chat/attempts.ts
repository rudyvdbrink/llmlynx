// A conversation has one reply running at a time. A send can reach the server
// more than once: browsers re-send a request by themselves when its connection
// fails before the response starts, and users send a failed message again, or
// a new one. The connection of the reply before is gone, but the server may not
// know yet, as a phone that changes networks does not say so. Such a reply is
// stopped here, so it does not go on writing next to the new one.

const encoder = new TextEncoder();

type Attempt = { abort: AbortController; finished: Promise<void> };

const running = new Map<string, Attempt>();

/** True while a reply runs for `key` (a conversation). */
export const isRunning = (key: string) => running.has(key);

/** Stops the reply running for `key` (a conversation), if any, and waits until what it wrote is stored. */
export async function stopAttempt(key: string): Promise<void> {
  const attempt = running.get(key);
  if (!attempt) return;
  attempt.abort.abort();
  await attempt.finished;
}

/**
 * Returns `reply`, a chat's NDJSON stream, with a last { end: true } line, by
 * which the client tells a finished reply from one that was cut off. Runs as
 * the reply of `key` until it ends, `stopAttempt` stops it or
 * `clientGone` aborts. Stopping cancels `reply`, which stores what it has.
 * `onEnd` runs when the attempt is over, however it ended.
 */
export function trackAttempt(
  key: string | null,
  reply: ReadableStream<Uint8Array>,
  clientGone: AbortSignal,
  onEnd?: () => Promise<void>
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ end: true }) + "\n"));
    },
  });
  const finished = reply
    .pipeTo(writable, { signal: AbortSignal.any([abort.signal, clientGone]) })
    .catch(() => {}) // stopped, or the client left
    .then(() => onEnd?.())
    .catch(() => {})
    .finally(() => {
      if (key && running.get(key)?.abort === abort) running.delete(key);
    });
  if (key) running.set(key, { abort, finished });
  return readable;
}
