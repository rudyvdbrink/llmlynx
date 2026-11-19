// Tests of the context budget and the reduction ladder: what leaves the view
// when the conversation no longer fits, in which order, what takes its place,
// and that the same view comes back on the next request.

import { describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { addMessage, newConversation, newUser } from "@/test/db";
import { createBudget } from "./budget";
import type { StoredToolCall } from "./conversation";
import { limitImages, MAX_IMAGES, reduceView } from "./reduce";
import { loadView, type StepInfo, type ToolMessage, type ViewMessage } from "./view";

const RECALL = { results: true, files: true, runs: true };
const text = (chars: number, of = "x") => of.repeat(chars);

let rows = 0;

/** A step of a reply that called one tool, and its result, as two messages of a view. */
function step(name: string, args: Record<string, unknown>, content: string, info: Partial<StepInfo> = {}, extra?: unknown): ViewMessage[] {
  const position = ++rows;
  const call: StoredToolCall = { id: `call-${position}`, name, arguments: args };
  return [
    { role: "assistant", content: "", calls: [call], position, ...(extra !== undefined ? { extra } : {}) },
    {
      role: "tool",
      callId: call.id,
      name,
      content,
      step: { rowId: `row-${position}`, position, error: false, chars: content.length, cleared: false, files: [], deleted: [], imageIds: [], ...info },
    },
  ];
}

const readOf = (from: number, to: number, fileId = "f1") => ({ read: { fileId, name: "app.py", unit: "lines" as const, from, to, total: 400 } });
const results = (view: ViewMessage[]) => view.filter((m): m is ToolMessage => m.role === "tool");

describe("the budget of a context window", () => {
  it("starts a reduction at 70% of the window, and ends it with the history at half of its room", () => {
    const budget = createBudget(10_000, []);
    const view: ViewMessage[] = [{ role: "user", content: "Hello" }];
    expect(budget.start).toBe(7_000);
    expect(budget.target(view)).toBe(3_500);
    expect(budget.protectedTokens(view)).toBe(1_750);
    // With a head, the room of the history is what the head leaves of the 70%
    const withHead: ViewMessage[] = [{ role: "system", content: text(3_488) }, ...view];
    expect(budget.headTokens(withHead)).toBe(1_000);
    expect(budget.target(withHead)).toBe(4_000);
  });

  it("counts a very large window as 200,000 tokens", () => {
    expect(createBudget(1_000_000, []).start).toBe(140_000);
  });

  it("measures the view by what a request took, and estimates only what was added since", () => {
    const budget = createBudget(10_000, []);
    const view: ViewMessage[] = [{ role: "user", content: text(4_000) }];
    expect(budget.tokens(view)).toBe(Math.ceil(4_012 / 3.5));
    budget.measured(view, { input: 2_006, output: 10 });
    expect(budget.tokens(view)).toBe(2_006);
    // What is added counts as 3 characters a token, as tool results take more tokens than prose
    view.push({ role: "tool", callId: "c", name: "web_read", content: text(2_988) });
    expect(budget.tokens(view)).toBe(3_006);
    // until two requests say how many it really is: here 2 characters a token
    budget.measured(view, { input: 3_506, output: 10 });
    view.push({ role: "tool", callId: "d", name: "web_read", content: text(1_988) });
    expect(budget.tokens(view)).toBe(4_506);
    // A request after a reduction says nothing about that: what was added cannot be told from what went
    budget.reduced();
    view.splice(1, 1);
    view.push({ role: "tool", callId: "e", name: "web_read", content: text(4_988) });
    budget.measured(view, { input: 4_000, output: 10 });
    view.push({ role: "tool", callId: "f", name: "web_read", content: text(1_988) });
    expect(budget.tokens(view)).toBe(5_000);
  });

  it("lets the results of one round share a fifth of the window", () => {
    const budget = createBudget(16_000, []);
    budget.startRound();
    // One result: a quarter of the window, at most 12,000 characters; the round has 16,000 x 0.2 tokens,
    // at 3 characters a token of tool results: 9,600
    expect(budget.resultChars()).toBe(9_600);
    budget.addResult(8_000);
    expect(budget.resultChars()).toBe(1_600);
    budget.addResult(1_600);
    // A call past the round's share can still say how to read the rest
    expect(budget.resultChars()).toBe(500);
    budget.startRound();
    expect(budget.resultChars()).toBe(9_600);
  });
});

describe("the reduction ladder", () => {
  it("clears what is superseded first, then old results, oldest first, and keeps the newest", async () => {
    const view: ViewMessage[] = [
      { role: "user", content: "Work on app.py" },
      ...step("read_file", { file: "app.py", start_line: 1, end_line: 100 }, text(6_000), readOf(1, 100)),
      ...step("web_read", { url: "https://a.example/docs" }, text(6_000)),
      ...step("read_file", { file: "app.py", start_line: 1, end_line: 200 }, text(6_000), readOf(1, 200)),
      ...step("web_search", { query: "flask blueprints" }, text(5_000)),
      ...step("web_read", { url: "https://b.example/" }, text(2_000)),
    ];
    const [read1, page1, read2, search, page2] = results(view);
    const budget = createBudget(10_000, []);
    expect(budget.tokens(view)).toBeGreaterThan(budget.start);

    expect(await reduceView(view, { conversationId: "none", budget, recall: RECALL })).toBe(true);
    expect(budget.tokens(view)).toBeLessThanOrEqual(budget.target(view));

    // Superseded: the read that was made again, and the search whose pages were read
    expect(read1.content).toBe("[Cleared to save room. You read lines 1 to 100 of app.py again later: that result is below.]");
    expect(search.content).toBe('[Cleared to save room. Search results for "flask blueprints". You read pages afterwards.]');
    // Then the oldest result that is left, with the way back to it
    expect(page1.content).toBe(
      `[Cleared to save room. The page a.example/docs, 6000 characters. Read it again with read_result, result ${page1.step!.position}.]`
    );
    // Enough: the later read and the newest result stay as they are
    expect(read2.content).toBe(text(6_000));
    expect(page2.content).toBe(text(2_000));
    expect(results(view).map((m) => m.step!.cleared)).toEqual([true, true, false, true, false]);
    // The calls stay, so the model still sees what it did
    expect(view.filter((m) => m.role === "assistant")).toHaveLength(5);
  });

  it("protects the newest results and the latest view of a file from being cleared for their age", async () => {
    const view: ViewMessage[] = [
      { role: "user", content: "Work on app.py" },
      ...step("web_read", { url: "https://a.example/" }, text(9_000)),
      ...step("read_file", { file: "app.py" }, text(2_500), readOf(1, 80)),
      ...step("web_read", { url: "https://b.example/" }, text(9_000)),
      ...step("web_read", { url: "https://c.example/" }, text(9_000)),
      ...step("web_read", { url: "https://d.example/" }, text(1_000)),
      { role: "assistant", content: "Done." },
      { role: "user", content: "Go on." },
    ];
    const budget = createBudget(10_000, []);
    await reduceView(view, { conversationId: "none", budget, recall: RECALL });
    // The read of app.py is older than two pages that went, but it is the latest view of the file
    expect(results(view).map((m) => m.step!.cleared)).toEqual([true, false, true, true, false]);
  });

  it("says that a file changed since it was read, so the model reads it again before it edits it", async () => {
    const view: ViewMessage[] = [
      { role: "user", content: "Change app.py" },
      ...step("read_file", { file: "app.py" }, text(8_000), readOf(1, 300)),
      ...step("edit_file", { file: "app.py", edits: [] }, "Edited app.py.", { files: ["app.py"] }),
      ...step("web_read", { url: "https://a.example/" }, text(9_000)),
      ...step("web_read", { url: "https://b.example/" }, text(9_000)),
    ];
    await reduceView(view, { conversationId: "none", budget: createBudget(10_000, []), recall: RECALL });
    expect(results(view)[0].content).toBe(
      "[Cleared to save room. You read lines 1 to 300 of app.py, which has changed since: read it again before you rely on it or edit it.]"
    );
  });

  it("cuts the long arguments of a cleared call short, but not those of a step whose provider needs it back as it was", async () => {
    const code = text(40, "line\n");
    const view: ViewMessage[] = [
      { role: "user", content: "Write two files" },
      ...step("create_file", { name: "a.py", content: text(7_000, "a\n") }, "Created a.py.", { files: ["a.py"] }),
      ...step("create_file", { name: "b.py", content: text(7_000, "b\n") }, "Created b.py.", { files: ["b.py"] }, { reasoning: "signed" }),
      ...step("run_code", { language: "python", code }, text(9_000), { run: { id: "run-1", kind: "run", status: "ok" } }),
      ...step("web_read", { url: "https://a.example/" }, text(2_000)),
      { role: "assistant", content: "Done." },
      { role: "user", content: "Go on." },
    ];
    await reduceView(view, { conversationId: "none", budget: createBudget(10_000, []), recall: RECALL });
    const calls = view.flatMap((m) => (m.role === "assistant" ? (m.calls ?? []) : []));
    expect(calls[0].arguments).toEqual({ name: "a.py", content: "[7001 lines, saved as a.py, cleared to save room]" });
    expect(results(view)[0].content).toBe("[Cleared to save room. This call made or changed a.py, which is in the sandbox.]");
    expect(calls[1].arguments.content).toBe(text(7_000, "b\n"));
    expect(results(view)[2].content).toBe("[Cleared to save room. A run of code, run-1 (ok). Read what it printed with read_run_log, run run-1.]");
    expect(calls[2].arguments.code).toBe(code);
  });

  it("names no way back that the model does not have", async () => {
    const view: ViewMessage[] = [
      { role: "user", content: "Read" },
      ...step("web_read", { url: "https://a.example/" }, text(15_000)),
      ...step("web_read", { url: "https://b.example/" }, text(15_000)),
      { role: "assistant", content: "Done." },
      { role: "user", content: "Go on." },
    ];
    await reduceView(view, { conversationId: "none", budget: createBudget(10_000, []), recall: { results: false, files: false, runs: false } });
    expect(results(view)[0].content).toBe("[Cleared to save room. The page a.example, 15000 characters.]");
  });

  it("turns a second copy into a pointer too when the result it referred to is cleared", async () => {
    const view: ViewMessage[] = [
      { role: "user", content: "List the files" },
      ...step("search_workspace", { path: "**" }, text(12_000)),
      ...step("search_workspace", { path: "**" }, "[Nothing changed: this result is identical to that of your earlier search_workspace call above.]"),
      ...step("web_read", { url: "https://a.example/" }, text(14_000)),
      { role: "assistant", content: "Done." },
      { role: "user", content: "Go on." },
    ];
    const [first, copy] = results(view);
    copy.step!.sameAs = first.step!.rowId;
    await reduceView(view, { conversationId: "none", budget: createBudget(10_000, []), recall: RECALL });
    expect(first.step!.cleared).toBe(true);
    // Read back as the result it stood for
    expect(copy.content).toBe(
      `[Cleared to save room. The result of search_workspace, 12000 characters. Read it again with read_result, result ${first.step!.position}.]`
    );
  });

  it("clears everything when it must, so that a request never passes the window", async () => {
    const view: ViewMessage[] = [{ role: "user", content: "Read" }, ...step("web_read", { url: "https://a.example/" }, text(40_000))];
    const budget = createBudget(10_000, []);
    // The newest result is protected: the view stays too long
    expect(await reduceView(view, { conversationId: "none", budget, recall: RECALL })).toBe(false);
    expect(results(view)[0].step!.cleared).toBe(false);
    expect(await reduceView(view, { conversationId: "none", budget, recall: RECALL, hard: true, limit: budget.hardLimit })).toBe(true);
    expect(results(view)[0].step!.cleared).toBe(true);
  });

  it("stores what it cleared with the steps, so that the next request has the same view", async () => {
    const conversationId = await newConversation(await newUser());
    await addMessage(conversationId, { role: "user", content: "Read two pages" });
    for (const [id, url] of [
      ["c1", "https://a.example/"],
      ["c2", "https://b.example/"],
    ]) {
      await addMessage(conversationId, { role: "assistant", content: "", toolCalls: [{ id, name: "web_read", arguments: { url } }] });
      await addMessage(conversationId, { role: "tool", content: text(15_000), toolCallId: id, toolName: "web_read", metadata: { label: "Read", error: false } });
    }
    await addMessage(conversationId, { role: "assistant", content: "Both read." });
    const memory = await addMessage(conversationId, { role: "user", content: "First question", metadata: { memory: "[Working memory 1]" } });
    await addMessage(conversationId, { role: "assistant", content: "Answer." });
    await addMessage(conversationId, { role: "user", content: "Second question", metadata: { memory: "[Working memory 2]" } });

    const options = { tools: ["web_read", "read_result"] };
    const view = await loadView(conversationId, options);
    await reduceView(view, { conversationId, budget: createBudget(10_000, []), recall: RECALL });
    expect(results(view)[0].content).toMatch(/^\[Cleared to save room\. The page a\.example, 15000 characters\. Read it again with read_result, result 2\.\]$/);
    // The older copy of the working memory went; the newest stays
    expect(view.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["Read two pages", "First question", "Second question\n\n[Working memory 2]"]);

    expect(await loadView(conversationId, options)).toEqual(view);
    // The result itself is still stored, for read_result and for the user
    const stored = await prisma.message.findFirstOrThrow({ where: { conversationId, position: 2 } });
    expect(stored.content).toBe(text(15_000));
    expect((await prisma.message.findUniqueOrThrow({ where: { id: memory } })).metadata).toMatchObject({ memoryCleared: true });
  });
});

describe("the images of a request", () => {
  const image = { mimeType: "image/jpeg", data: "aaaa" };
  const shot = (n: number) => {
    const messages = step("web_screenshot", { url: `https://a.example/${n}` }, "");
    (messages[1] as ToolMessage).images = [image];
    return messages;
  };

  it("stay as they are up to the limit", async () => {
    const view: ViewMessage[] = [{ role: "user", content: "Look" }, ...Array.from({ length: MAX_IMAGES }, (_, i) => shot(i)).flat()];
    expect(await limitImages(view)).toBe(false);
    expect(results(view).every((m) => m.images?.length === 1)).toBe(true);
  });

  it("lose their older half at once past the limit, never those of the newest round", async () => {
    const view: ViewMessage[] = [{ role: "user", content: "Look" }, ...Array.from({ length: MAX_IMAGES + 1 }, (_, i) => shot(i)).flat()];
    expect(await limitImages(view)).toBe(true);
    // Eight older ones: four go, and the page says so in their place
    expect(results(view).map((m) => m.images?.length ?? 0)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1]);
    expect(results(view)[0].content).toBe("[Its image is no longer shown here, to save room.]");
  });
});
