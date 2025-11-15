"use client";

import { useEffect, useState } from "react";
import styles from "./Chat.module.css";
import Sidebar from "./sidebar/Sidebar";

import type { User } from "./types/chat";
import { useConversations } from "./hooks/useConversations";
import { useChat } from "./hooks/useChat";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";

export default function ChatClientPage({ user }: { user: User }) {
  // Collapsible sidebar behavior
  const [collapsed, setCollapsed] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 760) {
      setCollapsed(true);
    }
  }, []);

  // Selection can be "model:<name>" or "agent:<id>"
  const [selection, setSelection] = useState<string>("model:gpt-oss:20b");

  // Conversations (list + active + CRUD)
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    refreshConversations,
    ensureConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    newConversation,
  } = useConversations(user, selection, setSelection);

  // Chat state (messages + composer + streaming)
  const {
    uiMessages,
    input,
    isStreaming,
    setInput,
    loadHistory,
    reset,
    onSubmit,
    onKeyDown,
    onCancel,
  } = useChat({
    user,
    selection,
    ensureConversation,
    refreshConversations,
  });

  // Handlers bridging conversations <> chat
  async function handleOpenConversation(id: string) {
    if (isStreaming || !user) return;
    try {
      const { messages } = await openConversation(id);
      loadHistory(messages);
    } catch {
      // ignore
    }
  }

  function handleNewConversation() {
    if (isStreaming) return;
    newConversation();
    reset();
  }

  async function handleDeleteConversation(id: string) {
    if (!user) return;
    const deletedActive = await deleteConversation(id);
    if (deletedActive) {
      reset();
    }
  }

  return (
    <main className={styles.page}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        user={user}
        model={selection}
        onChangeModel={setSelection}
        modelDisabled={isStreaming}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onNewConversation={handleNewConversation}
        onOpenConversation={handleOpenConversation}
        onRenameConversation={renameConversation}
        onDeleteConversation={handleDeleteConversation}
        // Show agents navigation only when authenticated (always true here)
        footerNavLabel="Agents"
        footerNavHref="/agents"
      />

      <div className={styles.chatArea}>
        <MessageList uiMessages={uiMessages} isStreaming={isStreaming} />
        <Composer
          input={input}
          setInput={setInput}
          isStreaming={isStreaming}
          onSubmit={onSubmit}
          onKeyDown={onKeyDown}
          onCancel={onCancel}
        />
      </div>
    </main>
  );
}