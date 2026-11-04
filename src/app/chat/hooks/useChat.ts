"use client";

import { useCallback, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import { parseSelection } from "@/lib/selection";
import { addReasoning, upsertToolStep } from "@/lib/trace";
import type { DisplayMessage, ReplyStatus, ToolStep, TraceItem } from "@/lib/types";

const isReplyStatus = (value: unknown): value is ReplyStatus => value === "loading" || value === "thinking";

// A { tool } line: a new step (with all fields), or an update of one (with its id)
const isToolLine = (value: unknown): value is Partial<ToolStep> & { id: string } =>
  !!value && typeof value === "object" && typeof (value as ToolStep).id === "string";

// Before calling a tool, models such as qwen3.5 may say what they are about to
// do, in one short line ("Let me look that up."). Text that goes on past a line
// break, or is longer than that, is taken for the answer.
const PREAMBLE_MAX = 300;
const looksLikeAnswer = (text: string) => /\S\s*\n\s*\S/.test(text) || text.trim().length > PREAMBLE_MAX;

export function useChat({
  selection,
  ensureConversation,
  refreshConversations,
}: {
  selection: string;
  ensureConversation: () => Promise<string>;
  refreshConversations: () => void;
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // What the model is doing until its reply starts; null until the server says
  const [replyStatus, setReplyStatus] = useState<ReplyStatus | null>(null);
  // True once the reply's answer shows, and again false while the model uses a tool
  const [answering, setAnswering] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Patch the assistant reply that is being streamed (always the last message).
  const updateReply = useCallback((patch: Partial<DisplayMessage>) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role !== "assistant") return prev;
      return [...prev.slice(0, -1), { ...last, ...patch }];
    });
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || isStreaming) return;

      setMessages((prev) => [...prev, { role: "user", content }, { role: "assistant", content: "" }]);
      setIsStreaming(true);
      setReplyStatus(null);
      setAnswering(false);

      const controller = new AbortController();
      abortRef.current = controller;

      // The text of the current step: the answer, unless a tool call follows it
      let reply = "";
      // Whether that text shows as the answer yet. While the model can call
      // tools, it is held back until it looks like an answer or the reply ends:
      // a model only says it calls a tool after the text before the call.
      let shown = false;

      try {
        const conversationId = await ensureConversation();
        const { kind, value } = parseSelection(selection);

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Only the new message: the server reads the rest of the conversation from the database
          body: JSON.stringify({
            message: content,
            conversationId,
            ...(kind === "agent" ? { agentId: value } : { model: selection }),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error((await res.text().catch(() => "")) || `Request failed (status ${res.status})`);
        }

        const mayCallTools = res.headers.get("X-Tools") === "1";
        // The reasoning and tool calls so far, in order
        let trace: TraceItem[] = [];
        await readNdjson(res.body, (obj) => {
          const line = obj as {
            message?: { content?: unknown; thinking?: unknown };
            status?: unknown;
            tool?: unknown;
            error?: unknown;
          };
          if (isReplyStatus(line?.status)) setReplyStatus(line.status);
          if (isToolLine(line?.tool)) {
            // Text written before a tool call is not the answer: it moves into the trace
            trace = upsertToolStep(addReasoning(trace, reply, true), line.tool);
            reply = "";
            shown = false;
            setAnswering(false);
            updateReply({ trace, content: reply });
          }
          const thought = line?.message?.thinking;
          if (typeof thought === "string" && thought) {
            trace = addReasoning(trace, thought);
            updateReply({ trace });
          }
          const delta = line?.message?.content;
          if (typeof delta === "string" && delta) {
            reply += delta;
            if (!shown && reply.trim() && (!mayCallTools || looksLikeAnswer(reply))) {
              shown = true;
              setAnswering(true);
            }
            if (shown) updateReply({ content: reply });
          }
          // Ollama and the OpenAI-compatible providers report a failed chat as an { error } line.
          if (typeof line?.error === "string" && line.error) updateReply({ content: reply, error: line.error });
        });

        refreshConversations();
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") updateReply({ error: (err as Error)?.message || "Stream error" });
      } finally {
        // Text still held back is the answer: no tool call followed it
        if (!shown && reply) updateReply({ content: reply });
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, selection, ensureConversation, refreshConversations, updateReply]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback((msgs: DisplayMessage[]) => {
    setMessages(msgs);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  return { messages, isStreaming, replyStatus, answering, send, cancel, loadHistory, reset };
}
