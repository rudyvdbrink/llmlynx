"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownMessage from "../../components/MarkdownMessage";
import styles from "./Chat.module.css";
import Sidebar from "./Sidebar";

type Role = "user" | "assistant";
type ChatMessage = { role: Role; content: string };
type UiMessage = { sender: "user" | "bot"; text: string };
type User = { id: string; email: string } | null;

export default function ChatPage() {
  const [conversation, setConversation] = useState<ChatMessage[]>([]);
  const [uiMessages, setUiMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [model, setModel] = useState("gpt-oss:20b");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [user, setUser] = useState<User>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 760) {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then(r => r.json().catch(() => ({ user: null })))
      .then(data => { if (active) setUser(data.user ?? null); })
      .catch(() => { if (active) setUser(null); });
    return () => { active = false; };
  }, []);

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

    const botIndex = uiMessages.length + 1;
    setUiMessages(prev => [...prev, { sender: "bot", text: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          model,
          messages: [...conversation, userMsg],
        }),
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
            /* ignore partial JSON */
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
    if (isStreaming) return; // Prevent submit while streaming (stop button handles cancel)
    handleSend();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <main className={styles.page}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        user={user}
        model={model}
        onChangeModel={setModel}
        modelDisabled={isStreaming}
      />

      <div className={styles.chatArea}>
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
            placeholder={isStreaming ? "Model is responding..." : "Ask the llynx..."}
            aria-label="Message"
            rows={1}
          />
          {isStreaming ? (
            <button
              type="button"
              aria-label="Stop response"
              className={`${styles.stopButton} ${styles.iconButton}`}
              onClick={handleCancel}
            >
              {/* Stop square */}
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="7" y="7" width="10" height="10" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!input.trim()}
              className={styles.iconButton}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4 12L20 4L12 20L11 13L4 12Z" transform="translate(-0.5 0)" />
              </svg>
            </button>
          )}
        </form>
      </div>
    </main>
  );
}