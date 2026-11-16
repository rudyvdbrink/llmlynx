// Tests of the clamd client against a stand-in for clamd on a local socket,
// and one against a real clamd, which is skipped unless CLAMAV_TEST_HOST (and
// CLAMAV_TEST_PORT, default 3310) say where one runs.

import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { clamdScan } from "./clamd";

type Stream = { command: string; chunks: Buffer[]; ended: boolean };

/** What a client sent, read as clamd reads INSTREAM: the command, then chunks, each after its length, until a length of 0. */
function readStream(received: Buffer): Stream {
  const end = received.indexOf(0);
  if (end < 0) return { command: "", chunks: [], ended: false };
  const chunks: Buffer[] = [];
  let at = end + 1;
  while (at + 4 <= received.length) {
    const size = received.readUInt32BE(at);
    at += 4;
    if (size === 0) return { command: received.subarray(0, end).toString(), chunks, ended: true };
    if (at + size > received.length) break;
    chunks.push(received.subarray(at, at + size));
    at += size;
  }
  return { command: received.subarray(0, end).toString(), chunks, ended: false };
}

const servers: net.Server[] = [];

/** A stand-in for clamd: `answer` is what it says once the stream has ended (null: nothing), then `hangUp` closes. */
async function standIn({ answer, hangUp = false }: { answer: string | null; hangUp?: boolean }) {
  const streams: Stream[] = [];
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (part) => {
      received = Buffer.concat([received, part]);
      const stream = readStream(received);
      if (!stream.ended) return;
      streams.push(stream);
      if (answer !== null) socket.write(answer);
      if (hangUp) socket.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { host: "127.0.0.1", port: (server.address() as AddressInfo).port, streams };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("clamd client", () => {
  it("sends the bytes as an INSTREAM: the command, chunks with their lengths, and an empty chunk", async () => {
    const clamd = await standIn({ answer: "stream: OK\0" });
    const data = Buffer.alloc(200_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;

    expect(await clamdScan(data, { ...clamd, timeoutMs: 2000 })).toEqual({ infected: false });
    const [stream] = clamd.streams;
    expect(stream.command).toBe("zINSTREAM");
    expect(stream.chunks.length).toBeGreaterThan(1);
    expect(Math.max(...stream.chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.concat(stream.chunks).equals(data)).toBe(true);
  });

  it("scans nothing at all as an empty stream", async () => {
    const clamd = await standIn({ answer: "stream: OK\0" });
    expect(await clamdScan(new Uint8Array(0), { ...clamd, timeoutMs: 2000 })).toEqual({ infected: false });
    expect(clamd.streams[0]).toMatchObject({ command: "zINSTREAM", chunks: [], ended: true });
  });

  it("reports an infected stream with its signature", async () => {
    const clamd = await standIn({ answer: "stream: Win.Test.EICAR_HDB-1 FOUND\0" });
    expect(await clamdScan(Buffer.from("x"), { ...clamd, timeoutMs: 2000 })).toEqual({
      infected: true,
      signature: "Win.Test.EICAR_HDB-1",
    });
  });

  it("fails on an error from clamd, such as a stream that is too large", async () => {
    const clamd = await standIn({ answer: "INSTREAM size limit exceeded. ERROR\0" });
    await expect(clamdScan(Buffer.from("x"), { ...clamd, timeoutMs: 2000 })).rejects.toThrow(/size limit exceeded/);
  });

  it("fails when clamd closes the connection without an answer", async () => {
    const clamd = await standIn({ answer: null, hangUp: true });
    await expect(clamdScan(Buffer.from("x"), { ...clamd, timeoutMs: 2000 })).rejects.toThrow(/without an answer/);
  });

  it("fails when clamd does not answer in time", async () => {
    const clamd = await standIn({ answer: null });
    const started = Date.now();
    await expect(clamdScan(Buffer.from("x"), { ...clamd, timeoutMs: 80 })).rejects.toThrow(/did not answer within 80 ms/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("fails when nothing listens", async () => {
    const clamd = await standIn({ answer: "stream: OK\0" });
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(clamdScan(Buffer.from("x"), { ...clamd, timeoutMs: 2000 })).rejects.toThrow(/cannot be reached/);
  });

  it("stops when the caller stops", async () => {
    const clamd = await standIn({ answer: null });
    const caller = new AbortController();
    const scan = clamdScan(Buffer.from("x"), { ...clamd, timeoutMs: 5000, signal: caller.signal });
    caller.abort();
    await expect(scan).rejects.toThrow(/stopped/);
    await expect(clamdScan(Buffer.from("x"), { ...clamd, timeoutMs: 5000, signal: caller.signal })).rejects.toThrow(/stopped/);
  });
});

// Needs a real clamd: CLAMAV_TEST_HOST=127.0.0.1 npm test
const realHost = process.env.CLAMAV_TEST_HOST;

describe.skipIf(!realHost)("a real clamd", () => {
  const real = { host: realHost ?? "", port: Number(process.env.CLAMAV_TEST_PORT) || 3310, timeoutMs: 30_000 };
  // The EICAR test string, which every virus scanner reports, in two parts so that this file is not reported itself
  const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

  it("finds the EICAR test string", async () => {
    const result = await clamdScan(Buffer.from(eicar), real);
    expect(result.infected).toBe(true);
    expect(result).toMatchObject({ signature: expect.stringMatching(/eicar/i) });
  });

  it("passes plain text, also 5 MB of it", async () => {
    expect(await clamdScan(Buffer.from("The lynx is a medium-sized wild cat."), real)).toEqual({ infected: false });
    expect(await clamdScan(Buffer.alloc(5 * 1024 * 1024, "lynx "), real)).toEqual({ infected: false });
  });
});
