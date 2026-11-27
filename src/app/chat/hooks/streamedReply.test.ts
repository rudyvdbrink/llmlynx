// Tests of what a reply shows while it streams in: replies are replayed token
// by token through what the chat view does with each line of the stream, and
// after every line nothing that showed as text may be taken back.

import { describe, expect, it } from "vitest";
import { toolIcon } from "@/lib/agentTools";
import { traceText } from "@/lib/trace";
import type { TraceItem } from "@/lib/types";
import { toDisplayMessages } from "@/server/chat/display";
import recorded from "@/test/replies/code-review.json";
import { endReply, NEW_REPLY, readReplyLine, type StreamedReply } from "./streamedReply";

type Step = { reasoning: string; content: string; calls?: { id: string; name: string; label: string; error: boolean }[] };

// Pieces about the size of a model's tokens: a word with the space before it, a sign, or a run of white space
const tokens = (text: string) => text.match(/\s*[\p{L}\p{N}]+|\s*[^\s\p{L}\p{N}]|\s+/gu) ?? [];

/** The lines /api/chat sends for a reply on Ollama made of `steps`, a token per line. */
function streamOf(steps: Step[]): unknown[] {
  const lines: unknown[] = [{ status: "thinking" }];
  for (const { reasoning, content, calls = [] } of steps) {
    for (const t of tokens(reasoning)) lines.push({ message: { role: "assistant", content: "", thinking: t }, done: false });
    for (const t of tokens(content)) lines.push({ message: { role: "assistant", content: t }, done: false });
    if (calls.length) {
      const toolCalls = calls.map(({ id, name }) => ({ id, function: { name, arguments: {} } }));
      lines.push({ message: { role: "assistant", content: "", tool_calls: toolCalls }, done: false });
    }
    lines.push({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" });
    for (const { id, name, label, error } of calls) {
      lines.push({ tool: { id, name, label, icon: toolIcon(name), state: "running" } });
      lines.push({ tool: { id, label, state: error ? "error" : "done" } });
    }
  }
  lines.push({ end: true });
  return lines;
}

/** The reply after each line of `lines`, and once the stream is over. */
function replay(lines: unknown[]): StreamedReply[] {
  const states: StreamedReply[] = [];
  let reply = NEW_REPLY;
  for (const line of lines) states.push((reply = readReplyLine(reply, line)));
  states.push(endReply(reply));
  return states;
}

/** The reply as the chat shows it when the conversation is opened again, from the steps as they are stored. */
function reopened(steps: Step[]) {
  type Row = Parameters<typeof toDisplayMessages>[0][number];
  const row = (fields: Partial<Row>): Row => ({
    id: String(Math.random()),
    position: 0,
    role: "assistant",
    content: "",
    reasoning: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    metadata: null,
    createdAt: new Date(0),
    attachments: [],
    ...fields,
  });
  const rows = [
    row({ role: "user", content: "Review this repository." }),
    ...steps.flatMap(({ reasoning, content, calls }) => [
      row({ content, reasoning: reasoning || null, toolCalls: calls?.map(({ id, name }) => ({ id, name, arguments: {} })) ?? null }),
      ...(calls ?? []).map(({ id, name, label, error }) =>
        row({ role: "tool", toolCallId: id, toolName: name, metadata: { label, error } })
      ),
    ]),
  ];
  const [, reply] = toDisplayMessages(rows);
  return { content: reply.content, trace: reply.trace ?? [] };
}

/** The text items of a trace. */
const texts = (trace: TraceItem[]) => trace.flatMap((item) => (item.kind === "text" ? [item.text] : []));

/**
 * Checks that, after every line, each text that shows is the start of the
 * text it ends as (so no text shows and then moves or goes), and that the
 * reply ends as a reopened conversation shows it.
 */
function expectSteadyText(steps: Step[], states: StreamedReply[]) {
  const last = states[states.length - 1];
  const final = texts(last.trace);
  states.forEach((state, i) => {
    const shown = texts(state.trace);
    if (!shown.every((text, j) => final[j]?.startsWith(text))) {
      throw new Error(`After line ${i}, the reply showed text it later took back:\n${shown.join("\n---\n").slice(-300)}`);
    }
  });
  expect({ content: traceText(last.trace), trace: last.trace }).toEqual(reopened(steps));
}

describe("a reply that streams in", () => {
  const steps = recorded.steps as Step[];

  it("shows the text of each step between its reasoning and tool calls, also when it is long", () => {
    for (const { reasoning, content } of steps) expect(tokens(reasoning + content).join("")).toBe(reasoning + content);
    // The reply has text of more than 300 characters on one line before a tool call
    expect(steps.some((s) => s.calls && s.content.length > 300)).toBe(true);

    const states = replay(streamOf(steps));
    expectSteadyText(steps, states);
    const last = states[states.length - 1];
    expect(texts(last.trace).map((t) => t.trim())).toEqual(steps.flatMap((s) => (s.content.trim() ? [s.content.trim()] : [])));
  });

  it("keeps each step's text in its place, between the tool calls", () => {
    const toolReply: Step[] = [
      { reasoning: "The user wants the data.", content: "Let me fetch it.", calls: [{ id: "c1", name: "web_read", label: "Read data.example", error: false }] },
      {
        reasoning: "Got it. Summarize, then share the file.",
        content: "Done - here is what I found:\n\n| Model | Accuracy |\n|---|---|\n| A | 0.84 |",
        calls: [{ id: "c2", name: "share_file", label: "Shared results.csv", error: false }],
      },
      { reasoning: "", content: "The file is above." },
    ];
    const states = replay(streamOf(toolReply));
    expectSteadyText(toolReply, states);
    const last = states[states.length - 1];
    expect(last.trace.map((item) => item.kind)).toEqual(["reasoning", "text", "tool", "reasoning", "text", "tool", "text"]);
    expect(traceText(last.trace)).toBe(toolReply.map((s) => s.content).join("\n\n"));
  });

  it("shows text at once, before a line break and before the reply ends", () => {
    const answer: Step[] = [{ reasoning: "", content: "Hello there." }];
    const states = replay(streamOf(answer));
    // After the status line and the first token
    expect(texts(states[1].trace)).toEqual(["Hello"]);
    expectSteadyText(answer, states);
  });

  it("starts no text with white space alone", () => {
    const lines = [
      { message: { role: "assistant", content: "", thinking: "Plan." }, done: false },
      { message: { role: "assistant", content: "\n\n" }, done: false },
      { tool: { id: "c1", name: "web_read", label: "Reading a.example", icon: toolIcon("web_read"), state: "running" } },
      { end: true },
    ];
    expect(replay(lines).at(-1)!.trace.map((item) => item.kind)).toEqual(["reasoning", "tool"]);
  });

  it("puts a checkpoint that was made while the reply ran in its trace, where it happened", () => {
    const lines = [
      { status: "thinking" },
      { tool: { id: "c1", name: "web_read", label: "Reading a.example", icon: toolIcon("web_read"), state: "running" } },
      { tool: { id: "c1", label: "Read a.example", state: "done" } },
      { status: "compacting" },
      { checkpoint: { id: "k1", summary: "[Summary of the steps so far.]", by: "auto" } },
      { status: "thinking" },
      { context: { used: 900, full: 5600 } },
      { message: { role: "assistant", content: "The answer." }, done: false },
      { end: true },
    ];
    const last = replay(lines).at(-1)!;
    expect(last.trace).toEqual([
      expect.objectContaining({ kind: "tool" }),
      { kind: "checkpoint", checkpoint: { id: "k1", summary: "[Summary of the steps so far.]", by: "auto" } },
      { kind: "text", text: "The answer." },
    ]);
  });

  it("keeps the newest list of the sandbox's image files, which the text's images are matched against", () => {
    const panda = { id: "p1", name: "panda.jpg", mimeType: "image/jpeg", size: 10 };
    const chart = { id: "c1", name: "chart.png", mimeType: "image/png", size: 20 };
    const states = replay([
      { status: "thinking" },
      { images: [panda] },
      { message: { role: "assistant", content: "One moment." }, done: false },
      { images: [panda, chart] },
      { message: { role: "assistant", content: "![A chart](chart.png)" }, done: false },
      { end: true },
    ]);
    expect(states[1].imageFiles).toEqual([panda]);
    expect(states.at(-1)!.imageFiles).toEqual([panda, chart]);
    // They are not files of the reply
    expect(states.at(-1)!.files).toEqual([]);
  });
});
