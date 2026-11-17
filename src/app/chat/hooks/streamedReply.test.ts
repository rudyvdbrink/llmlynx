// Tests of what a reply shows while it streams in: replies are replayed token
// by token through what the chat view does with each line of the stream, and
// after every line nothing that showed as the answer may be taken back.

import { describe, expect, it } from "vitest";
import { toolIcon } from "@/lib/agentTools";
import { toDisplayMessages } from "@/server/chat/display";
import recorded from "@/test/replies/code-review.json";
import { endReply, NEW_REPLY, readReplyLine, shownText, type StreamedReply } from "./streamedReply";

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
function replay(lines: unknown[], mayCallTools = true): StreamedReply[] {
  const states: StreamedReply[] = [];
  let reply = NEW_REPLY;
  for (const line of lines) states.push((reply = readReplyLine(reply, line, mayCallTools)));
  states.push(endReply(reply));
  return states;
}

/** The reply as the chat shows it when the conversation is opened again, from the steps as they are stored. */
function reopened(steps: Step[]) {
  type Row = Parameters<typeof toDisplayMessages>[0][number];
  const row = (fields: Partial<Row>): Row => ({
    id: String(Math.random()),
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

/**
 * Checks that, after every line, what shows as the answer is the start of the
 * answer the reply ends with (so nothing shows as the answer and then moves
 * into the trace), and that the reply ends as a reopened conversation shows it.
 */
function expectSteadyAnswer(steps: Step[], states: StreamedReply[]) {
  const last = states[states.length - 1];
  const answer = shownText(last);
  states.forEach((state, i) => {
    const shown = shownText(state);
    if (!answer.startsWith(shown)) throw new Error(`After line ${i}, the answer showed text it later took back:\n${shown.slice(-300)}`);
  });
  expect({ content: answer, trace: last.trace }).toEqual(reopened(steps));
}

describe("a reply that streams in", () => {
  const steps = recorded.steps as Step[];

  it("never shows what a model says before a tool call as the answer, also when it is long", () => {
    for (const { reasoning, content } of steps) expect(tokens(reasoning + content).join("")).toBe(reasoning + content);
    // The reply has text of more than 300 characters on one line before a tool call
    expect(steps.some((s) => s.calls && s.content.length > 300)).toBe(true);

    const states = replay(streamOf(steps));
    expectSteadyAnswer(steps, states);
    // That text stays in the trace: the answer is the text of the last step only
    expect(shownText(states[states.length - 1])).toBe(steps[steps.length - 1].content);
  });

  it("keeps text meant for the user in the answer when a tool call follows it", () => {
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
    expectSteadyAnswer(toolReply, states);
    expect(shownText(states[states.length - 1])).toBe(`${toolReply[1].content}\n\n${toolReply[2].content}`);
  });

  it("streams the answer once it goes past a line break, before the reply ends", () => {
    const answer: Step[] = [{ reasoning: "Easy.", content: "First line.\nSecond line, and more." }];
    const lines = streamOf(answer);
    const states = replay(lines);
    expectSteadyAnswer(answer, states);
    const beforeEnd = states[lines.length - 2];
    expect(shownText(beforeEnd)).toBe(answer[0].content);
  });

  it("shows text at once when the model cannot call tools", () => {
    const answer: Step[] = [{ reasoning: "", content: "Hello there." }];
    const states = replay(streamOf(answer), false);
    // After the status line and the first token
    expect(shownText(states[1])).toBe("Hello");
    expectSteadyAnswer(answer, states);
  });
});
