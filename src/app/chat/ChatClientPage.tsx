"use client";

import { useEffect, useState } from "react";
import styles from "./Chat.module.css";
import AppShell from "@/components/AppShell";
import { DEFAULT_SELECTION } from "@/lib/selection";
import type { SessionUser } from "@/lib/types";
import { useConversations } from "./hooks/useConversations";
import { useChat } from "./hooks/useChat";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";

export default function ChatClientPage({
  user,
  initialConversationId,
}: {
  user: SessionUser;
  initialConversationId: string | null;
}) {
  // Selection can be "ollama:<name>", "openai:<name>", "openrouter:<name>" or "agent:<id>"
  const [selection, setSelection] = useState<string>(DEFAULT_SELECTION);
  // Bumped to remount the composer, which clears its draft.
  const [composerKey, setComposerKey] = useState(0);

  // Conversations (list + active + CRUD)
  const {
    conversationList,
    activeConversationId,
    refreshConversations,
    ensureConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    newConversation,
  } = useConversations(selection, setSelection);

  // Chat state (messages + streaming)
  const { messages, isStreaming, replyStatus, send, cancel, loadHistory, reset } = useChat({
    selection,
    ensureConversation,
    refreshConversations,
  });

  // Opens the conversation picked in the sidebar on another page (/chat?conversation=<id>),
  // and takes it out of the address, which does not follow the open conversation
  useEffect(() => {
    if (!initialConversationId) return;
    let cancelled = false;
    window.history.replaceState(null, "", "/chat");
    openConversation(initialConversationId).then(
      (msgs) => !cancelled && loadHistory(msgs),
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [initialConversationId, openConversation, loadHistory]);

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
        conversationList,
        activeConversationId,
        onNewConversation: handleNewConversation,
        onOpenConversation: handleOpenConversation,
        onRenameConversation: renameConversation,
        onDeleteConversation: handleDeleteConversation,
        footerNavLabel: "Agents",
        footerNavHref: "/agents",
      }}
    >
      {/* Inside the page, so it stays centered on the space beside the sidebar */}
      <div className={styles.fixedCenterLogo} aria-hidden="true" />
      <div className={styles.chatArea}>
        <MessageList messages={messages} isStreaming={isStreaming} replyStatus={replyStatus} />
        <div className={styles.composerDock}>
          <Composer key={composerKey} isStreaming={isStreaming} onSend={send} onCancel={cancel} />
        </div>
      </div>
    </AppShell>
  );
}
