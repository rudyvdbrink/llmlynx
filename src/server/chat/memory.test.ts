// Tests of the working memory: the list of the conversation's files with
// what the model read of each, its task notes, and that a message only gets a
// copy when the memory changed.

import { describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import type { ConversationFile } from "@/server/files/store";
import { getToolDefinition, type ReadFact } from "@/server/tools/definitions";
import { addFile, addMessage, newConversation, newUser } from "@/test/db";
import { saveCheckpointStep, saveMemory } from "./conversation";
import { filesList, memoryInView, taskNotes, workingMemory } from "./memory";

const tools = (...names: string[]) => names.map((name) => getToolDefinition(name)!);
const TODAY = new Date("2026-11-19T10:00:00Z");

const file = (name: string, id = name, origin: ConversationFile["origin"] = "model"): ConversationFile => ({
  id,
  name,
  mimeType: "text/plain",
  size: 2048,
  origin,
  text: null,
  info: null,
  createdAt: new Date(0),
});
const read = (name: string, fileId: string, from: number, to: number, total = 400, unit: ReadFact["unit"] = "lines"): ReadFact => ({ fileId, name, unit, from, to, total });

describe("the list of the conversation's files", () => {
  it("says where each file came from, and what the model read of it", () => {
    const list = filesList(
      [file("app.py", "v2"), file("data.csv", "d1", "user"), file("out.txt", "o2", "code"), file("notes.md", "n1")],
      [],
      false,
      [read("app.py", "v2", 1, 120), read("app.py", "v2", 121, 200), read("app.py", "v2", 300, 340), read("out.txt", "o1", 1, 10), read("notes.md", "n1", 0, 500, 500, "characters")]
    );
    expect(list).toEqual([
      "app.py (2 KB, created by you; you read lines 1 to 200, 300 to 340 of 400)",
      "data.csv (2 KB, attached by the user)",
      // Read as an older version: what the model knows of it is out of date
      "out.txt (2 KB, made by code; changed since you read it)",
      "notes.md (2 KB, created by you; you read all of it)",
    ]);
  });

  it("names the newest files one by one when there are very many", () => {
    const many = Array.from({ length: 70 }, (_, i) => file(`f${i}.txt`));
    const list = filesList(many, [], true);
    expect(list).toHaveLength(61);
    expect(list[0]).toBe("(10 older files are not listed: search_workspace finds them.)");
    expect(list.at(-1)).toMatch(/^f69\.txt /);
  });
});

describe("the working memory of a chat", () => {
  it("is none without tools, and has today's date with them", async () => {
    const conversationId = await newConversation(await newUser());
    expect(await workingMemory(conversationId, [], TODAY)).toBeNull();
    expect(await workingMemory(conversationId, tools("web_search"), TODAY)).toBe(
      "[Working memory, kept by llmlynx. It replaces any earlier copy.\nToday's date: 2026-11-19.]"
    );
  });

  it("lists the files with what was read of them, from the stored steps, and has the model's newest notes", async () => {
    const conversationId = await newConversation(await newUser());
    const message = await addMessage(conversationId, { role: "user", content: "Look at these." });
    const fileId = await addFile(message, "report.txt", "The report.");
    await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id: "n1", name: "update_notes", arguments: { notes: "Goal: old." } }] });
    await addMessage(conversationId, { role: "tool", content: "Notes saved.", toolCallId: "n1", toolName: "update_notes" });
    await addMessage(conversationId, {
      role: "tool",
      content: "The report.",
      toolCallId: "r1",
      toolName: "read_file",
      metadata: { read: read("report.txt", fileId, 0, 11, 11, "characters") },
    });
    await addMessage(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "x", name: "read_file", arguments: { file: "report.txt" } },
        { id: "n2", name: "update_notes", arguments: { notes: "Goal: summarise the report.\nDone: read it." } },
      ],
    });

    expect(await taskNotes(conversationId)).toBe("Goal: summarise the report.\nDone: read it.");
    expect(await workingMemory(conversationId, tools("read_file", "run_code", "update_notes"), TODAY)).toBe(
      [
        "[Working memory, kept by llmlynx. It replaces any earlier copy.",
        "Today's date: 2026-11-19.",
        "The files of this conversation, in its sandbox:",
        "- report.txt (11 B, attached by the user; you read all of it)",
        "Your task notes (keep them up to date with update_notes):",
        "Goal: summarise the report.",
        "Done: read it.]",
      ].join("\n")
    );
    // An agent without files to work on gets no list
    expect(await workingMemory(conversationId, tools("web_search"), TODAY)).not.toContain("report.txt");
  });
});

describe("the working memory the model has in view", () => {
  it("is that of the newest message that still has its copy, the message being sent aside", async () => {
    const conversationId = await newConversation(await newUser());
    const first = await addMessage(conversationId, { role: "user", content: "One" });
    const second = await addMessage(conversationId, { role: "user", content: "Two" });
    const third = await addMessage(conversationId, { role: "user", content: "Three" });
    expect(await memoryInView(conversationId, third)).toBeNull();

    await saveMemory(first, "[Memory 1]");
    await saveMemory(second, "[Memory 2]");
    expect(await memoryInView(conversationId, third)).toBe("[Memory 2]");
    // A message that is sent again does not count its own copy of the attempt before
    expect(await memoryInView(conversationId, second)).toBe("[Memory 1]");

    // A message that got none, as nothing changed, keeps no copy
    await saveMemory(second, null);
    expect(await memoryInView(conversationId, third)).toBe("[Memory 1]");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: second } })).metadata).toBeNull();
  });

  it("is the one that went with the newest checkpoint, when no message after it has one", async () => {
    const conversationId = await newConversation(await newUser());
    const first = await addMessage(conversationId, { role: "user", content: "One" });
    await saveMemory(first, "[Memory 1]");
    await saveCheckpointStep(conversationId, "[Summary]", { upTo: 0, by: "user", memory: "[Memory at the checkpoint]" });
    const next = await addMessage(conversationId, { role: "user", content: "Two" });
    expect(await memoryInView(conversationId, next)).toBe("[Memory at the checkpoint]");
  });

  it("keeps the request id of a message when its memory is stored", async () => {
    const conversationId = await newConversation(await newUser());
    const id = await addMessage(conversationId, { role: "user", content: "One", metadata: { requestId: "abc" } });
    await saveMemory(id, "[Memory]");
    expect((await prisma.message.findUniqueOrThrow({ where: { id } })).metadata).toEqual({ requestId: "abc", memory: "[Memory]" });
    await saveMemory(id, null);
    expect((await prisma.message.findUniqueOrThrow({ where: { id } })).metadata).toEqual({ requestId: "abc" });
  });
});
