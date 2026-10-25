"use client";

import { useState } from "react";
import styles from "./Chat.module.css";
import AppShell from "@/components/AppShell";
import { DEFAULT_SELECTION } from "@/lib/selection";
import type { SessionUser } from "@/lib/types";
import { useConversations } from "./hooks/useConversations";
import { useChat } from "./hooks/useChat";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";

export default function ChatClientPage({ user }: { user: SessionUser }) {
  // Selection can be "model:<name>", "agent:<id>" or "remote:<name>"
  const [selection, setSelection] = useState<string>(DEFAULT_SELECTION);
  // Bumped to remount the composer, which clears its draft.
  const [composerKey, setComposerKey] = useState(0);

  // Conversations (list + active + CRUD)
  const {
    conversations,
    activeConversationId,
    refreshConversations,
    ensureConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    newConversation,
  } = useConversations(selection, setSelection);

  // Chat state (messages + streaming)
  const { messages, isStreaming, send, cancel, loadHistory, reset } = useChat({
    selection,
    ensureConversation,
    refreshConversations,
  });

  function clearChat() {
    reset();
    setComposerKey((k) => k + 1);
  }

  // Handlers bridging conversations <> chat
  async function handleOpenConversation(id: string) {
    if (isStreaming) return;
    try {
      loadHistory(await openConversation(id));
    } catch {
      // ignore
    }
  }

  function handleNewConversation() {
    if (isStreaming) return;
    newConversation();
    clearChat();
  }

  async function handleDeleteConversation(id: string) {
    if (await deleteConversation(id)) clearChat();
  }

  return (
    <AppShell
      sidebar={{
        user,
        model: selection,
        onChangeModel: setSelection,
        modelDisabled: isStreaming,
        conversations,
        activeConversationId,
        onNewConversation: handleNewConversation,
        onOpenConversation: handleOpenConversation,
        onRenameConversation: renameConversation,
        onDeleteConversation: handleDeleteConversation,
        footerNavLabel: "Agents",
        footerNavHref: "/agents",
      }}
    >
      <div className={styles.chatArea}>
        <MessageList messages={messages} isStreaming={isStreaming} />
        <div className={styles.composerDock}>
          <Composer key={composerKey} isStreaming={isStreaming} onSend={send} onCancel={cancel} />
        </div>
      </div>
    </AppShell>
  );
}
