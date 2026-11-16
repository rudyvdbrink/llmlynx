// A small client for clamd, ClamAV's scanning daemon: it sends bytes over TCP
// with the INSTREAM command and reads the verdict. Nothing leaves the server:
// clamd runs in the stack (see docker-compose.yml).

import net from "node:net";

export type ClamResult = { infected: false } | { infected: true; signature: string };

// clamd takes the stream in chunks, each after its length
const CHUNK_BYTES = 64 * 1024;

/** clamd's answer to INSTREAM: "stream: OK", or "stream: <signature> FOUND". Anything else is an error. */
function parseAnswer(answer: string): ClamResult {
  const line = answer.split("\0")[0].trim();
  if (line === "stream: OK") return { infected: false };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found) return { infected: true, signature: found[1] };
  throw new Error(`clamd answered: ${line || "nothing"}`);
}

/**
 * Scans `data` with the clamd at `host`:`port`. Throws when clamd cannot be
 * reached, reports an error, does not answer within `timeoutMs`, or `signal`
 * aborts.
 */
export function clamdScan(
  data: Uint8Array,
  { host, port, timeoutMs, signal }: { host: string; port: number; timeoutMs: number; signal?: AbortSignal }
): Promise<ClamResult> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let answer = "";
    let settled = false;

    const finish = (outcome: () => ClamResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      try {
        resolve(outcome());
      } catch (err) {
        reject(err);
      }
    };
    const fail = (message: string) =>
      finish(() => {
        throw new Error(message);
      });
    const onAbort = () => fail("The virus scan was stopped.");
    const timer = setTimeout(() => fail(`clamd did not answer within ${timeoutMs} ms.`), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("connect", () => {
      // "z": the command and the answer end with a NUL byte
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        const chunk = data.subarray(offset, offset + CHUNK_BYTES);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      // A chunk of length 0 ends the stream
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (part: Buffer) => {
      answer += part.toString("utf8");
      if (answer.includes("\0")) finish(() => parseAnswer(answer));
    });
    socket.on("error", (err) => fail(`clamd cannot be reached: ${err.message}`));
    socket.on("close", () => fail("clamd closed the connection without an answer."));
  });
}
