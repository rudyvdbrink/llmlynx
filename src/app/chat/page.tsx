"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownMessage from "../../components/MarkdownMessage";
import styles from "./Chat.module.css";
import Sidebar from "./sidebar/Sidebar";

type Role = "user" | "assistant" | "system";
type ChatMessage = { role: Role; content: string };
type UiMessage = { sender: "user" | "bot"; text: string };
type User = { id: string; email: string } | null;

type ConversationSummary = {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

type ConversationWithMessages = {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messages: { id: string; role: Role; content: string; createdAt: string }[];
};

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

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 760) {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then((r) => r.json().catch(() => ({ user: null })))
      .then((data) => {
        if (active) setUser(data.user ?? null);
      })
      .catch(() => {
        if (active) setUser(null);
      });
    return () => {
      active = false;
    };
  }, []);

  function refreshConversations() {
    if (!user) {
      setConversations([]);
      return;
    }
    fetch("/api/conversations")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setConversations(data.conversations ?? []))
      .catch(() => setConversations([]));
  }

  useEffect(() => {
    refreshConversations();
    // Reset active conversation when logging out
    if (!user) {
      setActiveConversationId(null);
    }
  }, [user]);

  useEffect(() => {
    const ta = textAreaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(200, ta.scrollHeight) + "px";
  }, [input]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [uiMessages]);

  async function ensureConversation(): Promise<string | null> {
    if (!user) return null; // guest mode: no conversation
    if (activeConversationId) return activeConversationId;
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw new Error("Failed to create conversation");
    const data = await res.json();
    const id = data.conversation.id as string;
    setActiveConversationId(id);
    refreshConversations();
    return id;
  }

  async function handleSend() {
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
        model,
        messages: [...conversation, userMsg],
      };
      if (convId) body.conversationId = convId;

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

      // Refresh list so updatedAt bumps to top (only if authenticated)
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

  async function onOpenConversation(id: string) {
    if (isStreaming || !user) return; // guests cannot open saved convos
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const convo = data.conversation;

      // Map DB messages to UI and chat state
      const msgs: ChatMessage[] = convo.messages.map((m: any) => ({
        role: m.role,
        content: m.content,
      }));

      const ui: UiMessage[] = convo.messages.map((m: any) => ({
        sender: m.role === "user" ? "user" : "bot",
        text: m.content,
      }));

      setActiveConversationId(convo.id);
      setConversation(msgs);
      setUiMessages(ui);
      if (convo.model) setModel(convo.model);
    } catch {
      // ignore
    }
  }

  function onNewConversation() {
    if (isStreaming) return;
    setActiveConversationId(null);
    setConversation([]);
    setUiMessages([]);
  }

  // Rename conversation
  async function onRenameConversation(id: string, newTitle: string) {
    if (!user) return;
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    }).then((r) => {
      if (!r.ok) throw new Error("Rename failed");
    }).catch(() => {});
    refreshConversations();
  }

  // Delete conversation
  async function onDeleteConversation(id: string) {
    if (!user) return;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" })
      .then((r) => {
        if (!r.ok && r.status !== 204) throw new Error("Delete failed");
      })
      .catch(() => {});
    if (id === activeConversationId) {
      setActiveConversationId(null);
      setConversation([]);
      setUiMessages([]);
    }
    refreshConversations();
  }

  return (
    <main className={styles.page}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        user={user}
        model={model}
        onChangeModel={setModel}
        modelDisabled={isStreaming}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onNewConversation={onNewConversation}
        onOpenConversation={onOpenConversation}
        onRenameConversation={onRenameConversation}
        onDeleteConversation={onDeleteConversation}
        footerNavLabel="Agents"
        footerNavHref="/agents"
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