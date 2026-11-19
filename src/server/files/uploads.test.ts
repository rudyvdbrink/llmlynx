// Tests of the files users attach: checked for viruses when they are
// attached, stored as drafts, and moved into the message they are sent with.
// The scanners and the files server are stand-ins.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveUserMessage } from "@/server/chat/conversation";
import { loadView } from "@/server/chat/view";
import { prisma } from "@/server/db/prisma";
import { createAuditLog } from "@/server/security/audit";
import { openSecurity } from "@/server/security/engine";
import { DRAFT_MAX_AGE_MS } from "@/server/security/limits";
import { resetScanners } from "@/server/security/scan";
import { getToolDefinition } from "@/server/tools/definitions";
import { eventsOf, newConversation, newUser } from "@/test/db";
import { fakes, gate, INJECTION, SIGNATURE, VIRUS } from "@/test/fakes";
import { prepareMessageFiles } from "./prepare";
import { deleteUpload, receiveUpload, UploadRefused, type UploadOutcome } from "./uploads";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

const signal = () => new AbortController().signal;
const upload = (userId: string, text: string, name = "notes.txt") =>
  receiveUpload({ userId, name, data: new Uint8Array(Buffer.from(text)), signal: signal() });
const draftsOf = (userId: string) => prisma.upload.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
const idOf = (outcome: UploadOutcome) => ("id" in outcome ? outcome.id : "");
const anyFile = () => null;
/** Sends a message of `userId` with the drafts `ids`, in a new conversation. */
async function send(userId: string, ids: string[], problem: (file: { name: string; size: number }) => string | null = anyFile) {
  const conversationId = await newConversation(userId);
  const { messageId } = await saveUserMessage(conversationId, "See the file.", "agent:test", null, { userId, ids, problem });
  const attachments = await prisma.messageAttachment.findMany({ where: { messageId }, orderBy: { createdAt: "asc" } });
  return { conversationId, messageId, attachments };
}

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

afterEach(() => vi.unstubAllEnvs());

describe("attaching a file", () => {
  it("starts the virus scan and the conversion together", async () => {
    const clamd = gate();
    const files = gate();
    fakes.clamdGate = clamd.opened;
    fakes.convertGate = files.opened;
    const userId = await newUser();
    const pending = upload(userId, "Some notes.");

    // Both are running before either is done
    await vi.waitFor(() => {
      expect(fakes.clamdScans.length).toBe(1);
      expect(fakes.conversions).toEqual(["notes.txt"]);
    });
    files.open();
    clamd.open();
    expect((await pending).outcome).toBe("clean");
  });

  it("stores a clean file as a draft, with its text", async () => {
    const userId = await newUser();
    const outcome = await upload(userId, "Some notes about lynxes.");
    expect(outcome).toEqual({ outcome: "clean", id: expect.any(String) });
    expect(await draftsOf(userId)).toEqual([
      expect.objectContaining({
        id: idOf(outcome),
        name: "notes.txt",
        mimeType: "text/plain",
        text: "Some notes about lynxes.",
      }),
    ]);
    expect((await eventsOf(userId)).map((event) => [event.check, event.verdict, event.reason, event.conversationId])).toEqual([
      ["virus", "allow", "clean", null],
    ]);
  });

  it("refuses a file with a virus: nothing is stored and the conversion stops", async () => {
    fakes.convertGate = gate().opened; // the conversion would never finish by itself
    const userId = await newUser();
    const outcome = await upload(userId, `MZ ${VIRUS}`, "setup.txt");
    expect(outcome).toEqual({
      outcome: "virus",
      name: "setup.txt",
      signature: SIGNATURE,
      message: `Refused: it contains a virus (${SIGNATURE})`,
    });
    expect(await draftsOf(userId)).toEqual([]);
    await vi.waitFor(() => expect(fakes.conversionsStopped).toBe(1));
    expect(fakes.guardTexts).toEqual([]); // its text never went anywhere
    expect(await eventsOf(userId)).toEqual([expect.objectContaining({ check: "virus", verdict: "block", reason: "virus" })]);
  });

  it("does not scan the user's own file for prompt injections, also when the guard is down", async () => {
    const userId = await newUser();
    expect((await upload(userId, `Minutes. ${INJECTION}`)).outcome).toBe("clean");
    fakes.guard = "down";
    expect((await upload(userId, "More notes.", "more.txt")).outcome).toBe("clean");
    expect(fakes.guardTexts).toEqual([]);
    expect((await draftsOf(userId)).map((row) => row.text)).toEqual([`Minutes. ${INJECTION}`, "More notes."]);
    expect((await eventsOf(userId)).map((event) => event.check)).toEqual(["virus", "virus"]);
  });

  it("stores nothing when the file could not be checked", async () => {
    const userId = await newUser();
    const unchecked = { outcome: "unchecked", message: "The file could not be checked; try again in a moment" };
    fakes.clamd = "down";
    expect(await upload(userId, "Some notes.")).toEqual(unchecked);
    resetScanners();
    fakes.clamd = "up";
    fakes.files = "down"; // the file cannot be read
    expect(await upload(userId, "Some notes.")).toEqual(unchecked);
    expect(await draftsOf(userId)).toEqual([]);
  });

  it("scans an image for viruses only", async () => {
    const userId = await newUser();
    expect((await upload(userId, "PNG bytes", "photo.png")).outcome).toBe("clean");
    expect(fakes.conversions).toEqual([]);
    expect(fakes.guardTexts).toEqual([]);
    expect(await draftsOf(userId)).toEqual([expect.objectContaining({ name: "photo.png", mimeType: "image/png", text: null })]);
    expect((await upload(userId, `PNG ${VIRUS}`, "bad.png")).outcome).toBe("virus");
  });

  it("deletes drafts older than a day whenever an upload arrives", async () => {
    const owner = await newUser();
    const draft = (name: string, age: number) =>
      prisma.upload.create({ data: { userId: owner, name, mimeType: "text/plain", data: Buffer.from("x"), createdAt: new Date(Date.now() - age) } });
    await draft("stale.txt", DRAFT_MAX_AGE_MS + 60_000);
    await draft("recent.txt", DRAFT_MAX_AGE_MS - 60_000);
    await upload(await newUser(), "Someone else attaches a file.");
    expect((await draftsOf(owner)).map((row) => row.name)).toEqual(["recent.txt"]);
  });

  it("checks at most two files at once; the others wait and do not fail", async () => {
    const files = gate();
    fakes.convertGate = files.opened;
    const userId = await newUser();
    const pending = [1, 2, 3, 4, 5].map((n) => upload(userId, `File ${n}.`, `file${n}.txt`));
    await vi.waitFor(() => expect(fakes.conversions.length).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakes.conversions.length).toBe(2);
    files.open();
    expect((await Promise.all(pending)).map((outcome) => outcome.outcome)).toEqual(Array(5).fill("clean"));
    expect(fakes.conversions.length).toBe(5);
  });

  it("has no setting that switches the virus scan off", async () => {
    vi.stubEnv("SECURITY_MODE", "off");
    const userId = await newUser();
    expect((await upload(userId, `MZ ${VIRUS}`)).outcome).toBe("virus");
    expect(await draftsOf(userId)).toEqual([]);
  });
});

describe("removing a file", () => {
  it("deletes the draft, for its owner only", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const id = idOf(await upload(owner, "Some notes."));
    expect(await deleteUpload(stranger, id)).toBe(false);
    expect((await draftsOf(owner)).length).toBe(1);
    expect(await deleteUpload(owner, id)).toBe(true);
    expect(await draftsOf(owner)).toEqual([]);
    expect(await deleteUpload(owner, id)).toBe(false);
  });
});

describe("sending a message with files", () => {
  it("moves the drafts into the message without a second conversion or scan", async () => {
    const userId = await newUser();
    const first = idOf(await upload(userId, "The first file.", "a.txt"));
    const second = idOf(await upload(userId, "The second file.", "b.txt"));
    const counts = () => [fakes.conversions.length, fakes.guardTexts.length, fakes.clamdScans.length];
    const before = counts();
    expect(before).toEqual([2, 0, 2]);

    const { conversationId, messageId, attachments } = await send(userId, [first, second]);
    expect(attachments.map((a) => [a.name, a.text, a.size])).toEqual([
      ["a.txt", "The first file.", 15],
      ["b.txt", "The second file.", 16],
    ]);
    expect(await draftsOf(userId)).toEqual([]);

    // What a chat request then does with the files: nothing is converted or scanned again
    resetScanners(); // not thanks to the cache either
    await prepareMessageFiles(messageId, false, signal());
    await openSecurity({ userId, conversationId, tools: [getToolDefinition("read_file")!], audit: createAuditLog(userId, conversationId) });
    const history = await loadView(conversationId, { files: { vision: false, textBudget: 10_000, readFile: true, viewPages: false }, tools: ["read_file"] });
    expect(history[0].content).toContain("The first file.");
    expect(history[0].content).toContain("The second file.");
    expect(counts()).toEqual(before);
  });

  it("refuses another user's draft, and leaves it where it is", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const id = idOf(await upload(owner, "The owner's file."));
    await expect(send(stranger, [id])).rejects.toThrow(UploadRefused);
    expect((await draftsOf(owner)).length).toBe(1);
    expect(await prisma.message.count({ where: { conversation: { userId: stranger } } })).toBe(0);
  });

  it("refuses a draft that is gone, and one the chat cannot take, and then sends none of them", async () => {
    const userId = await newUser();
    const id = idOf(await upload(userId, "A file."));
    await expect(send(userId, [id, "no-such-draft"])).rejects.toThrow(/no longer there/);
    await expect(send(userId, [id], (file) => `${file.name}: this kind of file is not supported`)).rejects.toThrow(
      "notes.txt: this kind of file is not supported"
    );
    expect((await draftsOf(userId)).length).toBe(1);
  });

  it("gives two files of one message with the same name different names", async () => {
    const userId = await newUser();
    const ids = [idOf(await upload(userId, "One.", "photo.txt")), idOf(await upload(userId, "Two.", "photo.txt"))];
    expect((await send(userId, ids)).attachments.map((a) => a.name)).toEqual(["photo.txt", "photo (2).txt"]);
  });

  it("keeps the message and its files on a re-send, and drops the drafts that came with it", async () => {
    const userId = await newUser();
    const conversationId = await newConversation(userId);
    const requestId = "0123456789abcdef0123456789abcdef";
    const sent = (ids: string[]) => saveUserMessage(conversationId, "See the file.", "agent:test", requestId, { userId, ids, problem: anyFile });

    const first = await sent([idOf(await upload(userId, "The file."))]);
    const again = await sent([idOf(await upload(userId, "The file."))]);
    expect(again).toEqual({ messageId: first.messageId, resent: true });
    expect(await prisma.messageAttachment.count({ where: { messageId: first.messageId } })).toBe(1);
    expect(await draftsOf(userId)).toEqual([]);
  });
});
