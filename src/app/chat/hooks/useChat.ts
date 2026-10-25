"use client";

import { useCallback, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import { parseSelection } from "@/lib/selection";
import type { ChatMessage, DisplayMessage } from "@/lib/types";

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

      // Earlier turns plus the new message. Replies that produced no text are left out.
      const history: ChatMessage[] = [...messages, { role: "user" as const, content }]
        .filter((m) => m.content.length > 0)
        .map(({ role, content }) => ({ role, content }));

      setMessages((prev) => [...prev, { role: "user", content }, { role: "assistant", content: "" }]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const conversationId = await ensureConversation();
        const { kind, value } = parseSelection(selection);

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history,
            conversationId,
            ...(kind === "agent" ? { agentId: value } : { model: selection }),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error("Network/response error");

        let reply = "";
        await readNdjson(res.body, (obj) => {
          const delta = (obj as { message?: { content?: unknown } })?.message?.content;
          if (typeof delta === "string" && delta) {
            reply += delta;
            updateReply({ content: reply });
          }
        });

        refreshConversations();
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") updateReply({ error: true });
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, messages, selection, ensureConversation, refreshConversations, updateReply]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  return { messages, isStreaming, send, cancel, loadHistory, reset };
}
