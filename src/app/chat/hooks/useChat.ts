"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, UiMessage, User } from "../types/chat";

export function useChat(options: {
  user: User;
  selection: string;
  ensureConversation: () => Promise<string | null>;
  refreshConversations: () => void;
}) {
  const { user, selection, ensureConversation, refreshConversations } = options;

  const [conversation, setConversation] = useState<ChatMessage[]>([]);
  const [uiMessages, setUiMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus textarea automatically after a streaming response completes (desktop)
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const prev = prevStreamingRef.current;
    if (prev && !isStreaming) {
      if (typeof window !== "undefined" && window.innerWidth >= 760) {
        const ta = textAreaRef.current;
        if (ta) {
          ta.focus();
          const len = ta.value.length;
          try {
            ta.setSelectionRange(len, len);
          } catch {
            // ignore if not supported
          }
        }
      }
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    setConversation((prev) => [...prev, userMsg]);
    setUiMessages((prev) => [...prev, { sender: "user", text: trimmed }]);
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const botIndex = uiMessages.length + 1;
    setUiMessages((prev) => [...prev, { sender: "bot", text: "" }]);

    try {
      const convId = await ensureConversation(); // null in guest mode

      const body: any = {
        messages: [...conversation, userMsg],
      };
      if (convId) body.conversationId = convId;

      if (selection.startsWith("agent:")) {
        body.agentId = selection.slice("agent:".length);
      } else if (selection.startsWith("model:")) {
        body.model = selection.slice("model:".length);
      } else {
        body.model = selection;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error("Network/response error");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let botAccum = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        const lines = chunk
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.message?.content) {
              botAccum += obj.message.content;
              setUiMessages((prev) => {
                const copy = [...prev];
                copy[botIndex] = { sender: "bot", text: botAccum };
                return copy;
              });
            }
            if (obj.done) {
              setConversation((prev) => [...prev, { role: "assistant", content: botAccum }]);
            }
          } catch {
            // ignore partial JSON
          }
        }
      }

      if (user) refreshConversations();
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setUiMessages((prev) => {
          const copy = [...prev];
          copy[botIndex] = {
            sender: "bot",
            text: (copy[botIndex]?.text || "") + "\n\n*(Stream error)*",
          };
          return copy;
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [
    input,
    isStreaming,
    uiMessages.length,
    ensureConversation,
    selection,
    conversation,
    user,
    refreshConversations,
  ]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (isStreaming) return;
      handleSend();
    },
    [isStreaming, handleSend]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isStreaming) handleSend();
      }
    },
    [isStreaming, handleSend]
  );

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback((msgs: ChatMessage[]) => {
    const ui = msgs.map((m) => ({
      sender: m.role === "user" ? "user" : "bot",
      text: m.content,
    })) as UiMessage[];
    setConversation(msgs);
    setUiMessages(ui);
  }, []);

  const reset = useCallback(() => {
    setConversation([]);
    setUiMessages([]);
    setInput("");
  }, []);

  return {
    // state
    conversation,
    uiMessages,
    input,
    isStreaming,
    // setters
    setInput,
    loadHistory,
    reset,
    // refs
    textAreaRef, // reserved if you want to pass it into a custom Composer; current Composer uses its own ref
    // handlers
    onSubmit,
    onKeyDown,
    onCancel,
  };
}