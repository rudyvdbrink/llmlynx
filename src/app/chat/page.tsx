"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownMessage from "../../components/MarkdownMessage";
import styles from "./Chat.module.css";

type Role = "user" | "assistant";
type ChatMessage = { role: Role; content: string };

// UI-friendly shape (maps assistant -> bot)
type UiMessage = { sender: "user" | "bot"; text: string };

export default function ChatPage() {
  // Only keep user & assistant messages client-side; system prompt stays server-only
  const [conversation, setConversation] = useState<ChatMessage[]>([]);
  const [uiMessages, setUiMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [model, setModel] = useState("gpt-oss:20b");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textAreaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
  }, [input]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [uiMessages]);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    setConversation(prev => [...prev, userMsg]);
    setUiMessages(prev => [...prev, { sender: "user", text: trimmed }]);
    setInput("");

    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // Placeholder assistant (bot) entry
    const botIndex = uiMessages.length + 1; // after adding user above
    setUiMessages(prev => [...prev, { sender: "bot", text: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          model,
          // Do NOT send system prompt; server injects from env
          messages: [...conversation, userMsg],
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error("Network/response error");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let botAccum = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        // Split newline-delimited JSON
        const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.message?.content) {
              botAccum += obj.message.content;
              setUiMessages(prev => {
                const copy = [...prev];
                copy[botIndex] = { sender: "bot", text: botAccum };
                return copy;
              });
            }
            if (obj.done) {
              setConversation(prev => [...prev, { role: "assistant", content: botAccum }]);
            }
          } catch {
            // Ignore partial/invalid line
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setUiMessages(prev => {
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
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    handleSend();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <main className={styles.page}>
      <div className={styles.chat}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Model"
            style={{
              background: "#0b1220",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "6px 10px",
            }}
            disabled={isStreaming}
          >
	        <option value="gpt-oss:20b">gpt-oss:20b</option>
            <option value="gemma3:1b">gemma3:1b</option>
            <option value="gemma3:12b">gemma3:12b</option>
            <option value="mistral">mistral</option>
          </select>
          {isStreaming && (
            <button
              type="button"
              onClick={handleCancel}
              style={{
                background: "#501f1f",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "6px 12px",
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          )}
        </div>

        <section className={styles.messages} aria-live="polite" aria-label="Chat messages">
          {uiMessages.map((msg, idx) => (
            <div
              key={idx}
              className={`${styles.messageRow} ${
                msg.sender === "user" ? styles.user : styles.bot
              }`}
            >
              <div className={styles.bubble}>
                <MarkdownMessage content={msg.text} />
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </section>

        <form className={styles.composer} onSubmit={onSubmit}>
          <textarea
            ref={textAreaRef}
            value={input}
            disabled={isStreaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isStreaming ? "Waiting for model..." : "Ask the llynx..."}
            aria-label="Message"
            rows={1}
          />
          <button type="submit" aria-label="Send" disabled={isStreaming || !input.trim()}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path d="M4 12L20 4L12 20L11 13L4 12Z" fill="currentColor" />
            </svg>
          </button>
        </form>
      </div>
    </main>
  );
}