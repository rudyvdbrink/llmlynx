// A send can reach the server more than once: browsers re-send a request by
// themselves when its connection fails before the response starts, and users
// send a failed message again. Every attempt has the same request id. The
// connection of the attempt before is gone, but the server may not know yet, as
// a phone that changes networks does not say so. Such an attempt is stopped
// here, so it does not go on to write a second reply.

const encoder = new TextEncoder();

type Attempt = { abort: AbortController; finished: Promise<void> };

const running = new Map<string, Attempt>();

/** Stops the attempt running for `key`, if any, and waits until what it wrote is stored. */
export async function stopAttempt(key: string): Promise<void> {
  const attempt = running.get(key);
  if (!attempt) return;
  attempt.abort.abort();
  await attempt.finished;
}

/**
 * Returns `reply`, a chat's NDJSON stream, with a last { end: true } line, by
 * which the client tells a finished reply from one that was cut off. Runs as
 * the attempt `key` until the reply ends, `stopAttempt` stops it or
 * `clientGone` aborts. Stopping cancels `reply`, which stores what it has.
 */
export function trackAttempt(
  key: string | null,
  reply: ReadableStream<Uint8Array>,
  clientGone: AbortSignal
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
    .finally(() => {
      if (key && running.get(key)?.abort === abort) running.delete(key);
    });
  if (key) running.set(key, { abort, finished });
  return readable;
}
