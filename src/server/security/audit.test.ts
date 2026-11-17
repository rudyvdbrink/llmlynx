// Tests of the audit log: events are collected in memory and written in one
// go, and they go when their conversation or account goes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { eventsOf, newConversation, newUser } from "@/test/db";
import { contentHash, createAuditLog } from "./audit";

afterEach(() => vi.restoreAllMocks());

describe("the audit log", () => {
  it("writes nothing until it is flushed, and then everything with one query", async () => {
    const userId = await newUser();
    const conversationId = await newConversation(userId);
    const audit = createAuditLog(userId, conversationId);
    const write = vi.spyOn(prisma.securityEvent, "createMany");

    audit.add({ tool: "web_read", check: "injection", verdict: "allow", reason: "clean", score: 0.02, host: "a.example", contentHash: contentHash("page"), durationMs: 12 });
    audit.add({ tool: "web_fetch", check: "virus", verdict: "allow", reason: "clean", host: "b.example" });
    audit.add({ check: "decision", verdict: "block", reason: "injection", decision: "stop" });
    expect(write).not.toHaveBeenCalled();
    expect(await eventsOf(userId)).toEqual([]);

    await audit.flush();
    expect(write).toHaveBeenCalledTimes(1);
    const events = await eventsOf(userId);
    expect(events.map((event) => [event.check, event.verdict, event.reason, event.conversationId])).toEqual([
      ["injection", "allow", "clean", conversationId],
      ["virus", "allow", "clean", conversationId],
      ["decision", "block", "injection", conversationId],
    ]);
    expect(events[0]).toMatchObject({ tool: "web_read", score: 0.02, host: "a.example", durationMs: 12, decision: null });
    expect(events[0].contentHash).toBe(contentHash("page"));

    // A second flush has nothing left to write
    await audit.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never throws: a log that cannot be written does not break a reply", async () => {
    const audit = createAuditLog("no-such-user", null);
    audit.add({ check: "virus", verdict: "allow", reason: "clean" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(audit.flush()).resolves.toBeUndefined();
  });

  it("refers to content by its SHA-256", () => {
    expect(contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(contentHash(Buffer.from("abc"))).toBe(contentHash("abc"));
  });

  it("loses its events with their conversation, and with their account", async () => {
    const userId = await newUser();
    const kept = await newConversation(userId);
    const gone = await newConversation(userId);
    for (const conversationId of [kept, gone, null]) {
      const audit = createAuditLog(userId, conversationId);
      audit.add({ check: "virus", verdict: "allow", reason: "clean" });
      await audit.flush();
    }
    await prisma.upload.create({ data: { userId, name: "draft.txt", mimeType: "text/plain", data: Buffer.from("x") } });

    await prisma.conversation.delete({ where: { id: gone } });
    expect((await eventsOf(userId)).map((event) => event.conversationId).sort()).toEqual([kept, null].sort());

    await prisma.user.delete({ where: { id: userId } });
    expect(await eventsOf(userId)).toEqual([]);
    expect(await prisma.upload.count({ where: { userId } })).toBe(0);
  });
});
