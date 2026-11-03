"use client";

import { useCallback, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import { parseSelection } from "@/lib/selection";
import type { DisplayMessage, ReplyStatus } from "@/lib/types";

const isReplyStatus = (value: unknown): value is ReplyStatus => value === "loading" || value === "thinking";

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

      const controller = new AbortController();
      abortRef.current = controller;

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

        let reply = "";
        let reasoning = "";
        await readNdjson(res.body, (obj) => {
          const line = obj as { message?: { content?: unknown; thinking?: unknown }; status?: unknown; error?: unknown };
          if (isReplyStatus(line?.status)) setReplyStatus(line.status);
          const thought = line?.message?.thinking;
          if (typeof thought === "string" && thought) {
            reasoning += thought;
            updateReply({ reasoning });
          }
          const delta = line?.message?.content;
          if (typeof delta === "string" && delta) {
            reply += delta;
            updateReply({ content: reply });
          }
          // Ollama and the OpenAI-compatible providers report a failed chat as an { error } line.
          if (typeof line?.error === "string" && line.error) updateReply({ error: line.error });
        });

        refreshConversations();
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") updateReply({ error: (err as Error)?.message || "Stream error" });
      } finally {
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

  return { messages, isStreaming, replyStatus, send, cancel, loadHistory, reset };
}
