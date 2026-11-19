// Tests of a reply that runs with a context budget: what the tool loop adds
// to the conversation the model gets, what it stores so that a later request
// gets the same, and how the conversation is kept within the model's window
// while the reply runs. The model is a script of turns; the tools are stand-ins.

import { describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { getToolDefinition, type ToolCallContext, type ToolDefinition, type ToolResult } from "@/server/tools/definitions";
import { addMessage, newConversation, newUser } from "@/test/db";
import { openContext, type ContextLine } from "./context";
import { createAssistantReply } from "./conversation";
import { runToolLoop, type ModelTurn } from "./toolLoop";
import { loadView, type ToolMessage, type ViewMessage } from "./view";

const text = (chars: number, of = "x") => of.repeat(chars);
const ok = (result: string): ToolResult => ({ text: result, images: [], files: [], error: false });

/** A stand-in tool named `name` that runs `run`. */
const tool = (name: string, run: (args: Record<string, unknown>, ctx: ToolCallContext) => ToolResult): ToolDefinition =>
  ({ ...getToolDefinition("read_result")!, name, label: () => name, run: async (args: Record<string, unknown>, ctx: ToolCallContext) => run(args, ctx) }) as unknown as ToolDefinition;

type Call = ModelTurn["calls"][number];

/**
 * A reply in a chat on a model with a window of `window` tokens (none: no
 * budget), whose model makes `turns` (the calls of each request) and then
 * answers. `history` is stored before the user's message.
 */
async function reply({
  tools,
  turns,
  window,
  message = "Do the work.",
  history = [],
  maxToolCalls = 0,
  usage,
  system,
}: {
  tools: ToolDefinition[];
  turns: Call[][];
  window?: number;
  message?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  maxToolCalls?: number;
  usage?: (view: ViewMessage[]) => { input: number; output: number };
  system?: string;
}) {
  const userId = await newUser();
  const conversationId = await newConversation(userId);
  for (const step of history) await addMessage(conversationId, step);
  await addMessage(conversationId, { role: "user", content: message });
  const stored = createAssistantReply({ conversationId, userId, modelKey: "agent:test", model: "ollama:test", setup: {} });
  const names = tools.map((t) => t.name);
  const view: ViewMessage[] = [...(system ? [{ role: "system" as const, content: system }] : []), ...(await loadView(conversationId, { tools: names }))];
  const signal = new AbortController().signal;
  const lines: ContextLine[] = [];
  const asked: ViewMessage[][] = [];
  // What the model got with each request: a copy, as the view changes afterwards
  const requests: ViewMessage[][] = [];
  let turn = 0;
  await runToolLoop<ModelTurn>({
    tools,
    maxToolCalls,
    toolContext: { userId, textBudget: 12_000, conversationId, vision: false, security: null },
    reply: stored,
    signal,
    isCancelled: () => false,
    sendTool: () => {},
    sendFiles: () => {},
    sendPause: () => {},
    sendError: () => {},
    view,
    context: window
      ? openContext({
          config: { conversationId, tools, security: null, window },
          window,
          reply: stored,
          signal,
          ask: async (messages) => {
            asked.push(messages);
            return "Goal: finish the work.\nNext: go on.";
          },
          send: (line) => void lines.push(line),
        })
      : null,
    nextTurn: async (all) => {
      requests.push(structuredClone(all));
      const calls = turns[turn++] ?? [];
      const content = calls.length ? "" : "The answer.";
      stored.append(content);
      return { content, calls, ...(usage ? { usage: usage(all) } : {}) };
    },
    plainTurn: async () => ({ content: "", calls: [] }),
  });
  await stored.persist();
  const rows = () => prisma.message.findMany({ where: { conversationId }, orderBy: { position: "asc" } });
  return { conversationId, view, requests, lines, asked, rows, reload: () => loadView(conversationId, { tools: names }) };
}

const results = (view: ViewMessage[]) => view.filter((m): m is ToolMessage => m.role === "tool");

describe("what a reply adds to the conversation", () => {
  it("is what the next request gets, and what a later reply gets again", async () => {
    const page = tool("web_read", () => ok("The page says hello."));
    const run = await reply({ tools: [page], turns: [[{ name: "web_read", arguments: { url: "https://a.example/" } }]], maxToolCalls: 5 });

    // The second request has the call and its result, with the note of the loop
    const sent = "The page says hello.\n\n[Tool calls: 1 of 5 used, 4 left for this reply.]";
    expect(run.requests[1].map((m) => [m.role, m.content])).toEqual([
      ["user", "Do the work."],
      ["assistant", ""],
      ["tool", sent],
    ]);
    // A later reply gets the same, from what was stored
    const later = await run.reload();
    expect(later.map((m) => [m.role, m.content])).toEqual([...run.requests[1].map((m) => [m.role, m.content]), ["assistant", "The answer."]]);
    expect(results(later)[0].step).toMatchObject({ error: false, cleared: false });
  });

  it("stores what each request took, and tells the chat view how full the window is", async () => {
    const run = await reply({ tools: [], turns: [], window: 8_000, usage: () => ({ input: 1_200, output: 300 }) });
    expect(run.lines).toEqual([{ context: { used: 1_500, full: 5_600 } }]);
    const rows = await run.rows();
    expect(rows.at(-1)).toMatchObject({ role: "assistant", content: "The answer.", metadata: { usage: { input: 1_200, output: 300, window: 8_000 } } });
  });
});

describe("a result the model already has in view", () => {
  it("is not sent a second time: the model gets one line that says nothing changed", async () => {
    const tree = text(120, "src/app/file.py\n");
    const list = tool("search_workspace", () => ok(tree));
    const call = { name: "search_workspace", arguments: { path: "**" } };
    const run = await reply({ tools: [list], turns: [[call], [call], [{ name: "search_workspace", arguments: { path: "src/**" } }]] });

    const [first, second, third] = results(run.view);
    expect(first.content).toBe(tree);
    expect(second.content).toBe(
      `[Nothing changed: this result is identical to that of your earlier search_workspace call above (result ${first.step!.position}).]`
    );
    // Also a third copy refers to the result itself, not to the line
    expect(third.content).toBe(second.content);
    expect(second.step).toMatchObject({ sameAs: first.step!.rowId });
    // Stored as it was sent
    expect(results(await run.reload()).map((m) => m.content)).toEqual([tree, second.content, second.content]);
  });

  it("is sent again when it changed, when it is short, and when the copy is no longer in view in full", async () => {
    let count = 0;
    const changing = tool("search_workspace", () => ok(text(600, String(count++ % 10))));
    const short = tool("web_read", () => ok("Short."));
    const run = await reply({
      tools: [changing, short],
      turns: [[{ name: "search_workspace", arguments: {} }], [{ name: "search_workspace", arguments: {} }], [{ name: "web_read", arguments: {} }], [{ name: "web_read", arguments: {} }]],
    });
    expect(results(run.view).map((m) => m.content)).toEqual([text(600, "0"), text(600, "1"), "Short.", "Short."]);
  });

  it("is told apart from a run that only differs in its id and how long it took", async () => {
    let runs = 0;
    const code = tool("run_code", () => {
      const id = `run-${String(++runs).padStart(12, "0")}`;
      return ok(`run: ${id}\nexit code: 0\nduration: 0.${runs} s\n\nOutput:\n${text(700, "tree\n")}`);
    });
    const call = { name: "run_code", arguments: { language: "shell", code: "ls -R" } };
    const run = await reply({ tools: [code], turns: [[call], [call]] });
    expect(results(run.view)[1].content).toMatch(/^\[Nothing changed: this result is identical to that of your earlier run_code call above/);
  });
});

describe("the calls of one round", () => {
  it("share the room that is kept for a round of results", async () => {
    const budgets: number[] = [];
    const page = tool("web_read", (_args, ctx) => {
      budgets.push(ctx.textBudget);
      return ok(text(Math.min(ctx.textBudget, 9_000), String(budgets.length)));
    });
    const call = (n: number) => ({ name: "web_read", arguments: { url: `https://a.example/${n}` } });
    await reply({ tools: [page], turns: [[call(1), call(2), call(3)], [call(4)]], window: 16_000 });
    // A round has 16,000 x 0.2 tokens, at 3 characters a token: 9,600 characters; the next round starts again
    expect(budgets).toEqual([9_600, 600, 500, 9_600]);
  });
});

describe("a reply that would pass the window", () => {
  it("has its older results cleared in the middle of the reply, before the request that would not fit", async () => {
    let pages = 0;
    const page = tool("web_read", () => ok(text(5_500, String(++pages))));
    const call = (n: number) => [{ name: "web_read", arguments: { url: `https://a.example/${n}` } }];
    // 10,000 tokens: a reduction starts past 7,000 tokens, which is 24,500 characters
    const run = await reply({ tools: [page], turns: [call(1), call(2), call(3), call(4), call(5)], window: 10_000 });

    expect(run.requests).toHaveLength(6);
    // Four results fit; with the fifth, the request would pass the mark
    expect(results(run.requests[4]).map((m) => m.step!.cleared)).toEqual([false, false, false, false]);
    const last = results(run.requests[5]);
    // The oldest go, until the request is back at half of the room: the newest two stay
    expect(last.map((m) => m.step!.cleared)).toEqual([true, true, true, false, false]);
    expect(last[0].content).toMatch(/^\[Cleared to save room\. The page a\.example\/1, 5500 characters\.\]$/);
    expect(last[4].content).toBe(text(5_500, "5"));
    // No model call was needed for it
    expect(run.asked).toEqual([]);
    // A later reply starts from the same view
    expect(results(await run.reload()).map((m) => m.step!.cleared)).toEqual([true, true, true, false, false]);
  });

  it("keeps a result the model has not seen yet, also when it takes most of the room: no summary is made over it", async () => {
    let pages = 0;
    const page = tool("web_read", (_args, ctx) => ok(text(ctx.textBudget, String(++pages))));
    const call = (n: number) => [{ name: "web_read", arguments: { url: `https://a.example/${n}` } }];
    // A small window with a long system prompt: the head and one result (4,800 characters) are more
    // than a reduction aims for, but less than the mark at which one starts
    const run = await reply({ tools: [page], turns: [call(1), call(2), call(3)], window: 8_000, system: text(12_000) });

    expect(run.asked).toEqual([]);
    expect(run.lines.some((line) => "checkpoint" in line)).toBe(false);
    // Each request has the newest result in full, and the ones before it as pointers
    expect(results(run.requests[2]).map((m) => m.step!.cleared)).toEqual([true, false]);
    expect(results(run.requests[3]).map((m) => m.step!.cleared)).toEqual([true, true, false]);
    expect(results(run.requests[3])[2].content).toBe(text(4_800, "3"));
  });

  it("gets a checkpoint when there is nothing left to clear: a summary takes the place of the older steps", async () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      content: `${i % 2 ? "Answer" : "Question"} ${i} ${text(4_000)}`,
    }));
    const run = await reply({ tools: [], turns: [], window: 8_000, history, message: "And the last question?" });

    // One request to the model wrote the summary, from the older steps as text
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0].map((m) => m.role)).toEqual(["system", "user"]);
    expect(run.asked[0][1].content).toContain("USER:\nQuestion 4");
    expect(run.asked[0][1].content).toContain("Goal: what the user wants");
    expect(run.lines.slice(0, 3)).toEqual([
      { status: "compacting" },
      { checkpoint: { id: expect.any(String), summary: expect.stringContaining("Goal: finish the work."), by: "auto" } },
      { status: "thinking" },
    ]);

    // The model then got the summary, and the user's new message after it
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]).toHaveLength(1);
    const content = run.requests[0][0].content;
    expect(content).toMatch(/^\[Summary of the conversation so far\./);
    expect(content).toContain('- Their latest message: "Question 4 ');
    expect(content).toContain("Your own note on where things stand:\nGoal: finish the work.\nNext: go on.");
    expect(content.endsWith("[End of the summary. The conversation goes on here.]\n\nAnd the last question?")).toBe(true);
    expect(content.length).toBeLessThan(6_000);

    // Stored as a step: the older steps stay, and a later reply starts from the summary
    const rows = await run.rows();
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "system", "assistant"]);
    expect(rows[7].metadata).toMatchObject({ checkpoint: { upTo: 5, by: "auto" } });
    const later = await run.reload();
    expect(later.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(later[0].content).toBe(content);
  });
});
