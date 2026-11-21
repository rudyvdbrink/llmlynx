"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./Chat.module.css";
import AppShell from "@/components/AppShell";
import { useProviderModels } from "@/hooks/useModelCatalog";
import { rememberChat } from "@/hooks/useLastChat";
import { DEFAULT_MODELS, hasModel } from "@/lib/providers";
import { parseSelection, toSelection } from "@/lib/selection";
import { SANDBOX_TOOL_NAMES } from "@/lib/agentTools";
import type { SessionUser } from "@/lib/types";
import { useConversations } from "./hooks/useConversations";
import { useChat } from "./hooks/useChat";
import { useAttachAccept } from "./hooks/useAttachAccept";
import { useComposerGlide } from "./hooks/useComposerGlide";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import SandboxPanel from "./components/sandbox/SandboxPanel";
import { SHOW_FILE_EVENT } from "./components/FileCards";

export default function ChatClientPage({
  user,
  initialConversationId,
  initialSelection,
}: {
  user: SessionUser;
  initialConversationId: string | null;
  // What the user chatted with last; null when they have not chatted yet
  initialSelection: string | null;
}) {
  // Selection can be "ollama:<name>", "openai:<name>", "openrouter:<name>" or "agent:<id>"
  const [picked, setSelection] = useState<string | null>(initialSelection);
  // Until there is a choice: an Ollama model that is on the user's server
  const { models: ollamaModels } = useProviderModels(picked ? null : "ollama");
  const firstModel =
    ollamaModels.length > 0 && !hasModel("ollama", ollamaModels, DEFAULT_MODELS.ollama)
      ? ollamaModels[0]
      : DEFAULT_MODELS.ollama;
  const selection = picked ?? toSelection("ollama", firstModel);
  // Only agents take files
  const chosen = parseSelection(selection);
  const accept = useAttachAccept(chosen.kind === "agent" ? chosen.value : null);
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
  const { messages, isStreaming, replyStatus, toolsDone, context, send, compact, undoCompact, cancel, loadHistory, reset } = useChat({
    selection,
    ensureConversation,
    refreshConversations,
    setLiveCost: conversationList.setLiveCost,
  });

  // Opens the conversation picked in the sidebar on another page (/chat?conversation=<id>),
  // and takes it out of the address, which does not follow the open conversation
  useEffect(() => {
    if (!initialConversationId) return;
    let cancelled = false;
    window.history.replaceState(null, "", "/chat");
    openConversation(initialConversationId).then(
      (opened) => !cancelled && loadHistory(opened.messages, opened.context),
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [initialConversationId, openConversation, loadHistory]);

  // The agents and account pages link back to this conversation
  useEffect(() => rememberChat(activeConversationId), [activeConversationId]);

  // The chat has a sandbox from its first run, install or download on: then its panel's chevron shows
  const hasSandbox = useMemo(
    () =>
      messages.some((m) =>
        m.trace?.some((item) => item.kind === "tool" && (SANDBOX_TOOL_NAMES as string[]).includes(item.step.name))
      ),
    [messages]
  );
  // Every chat opens with the panel collapsed
  const [sandboxOpen, setSandboxOpen] = useState(false);
  // The file a card in the chat asked to show (a version's id): the panel opens
  // on it, also in a chat that has no runs, installs or downloads
  const [shownFile, setShownFile] = useState<{ id: string } | null>(null);
  const [panelChat, setPanelChat] = useState(activeConversationId);
  if (panelChat !== activeConversationId) {
    setPanelChat(activeConversationId);
    setSandboxOpen(false);
    setShownFile(null);
  }
  const sandboxAvailable = hasSandbox || !!shownFile;

  useEffect(() => {
    if (!activeConversationId) return;
    function onShowFile(event: Event) {
      event.preventDefault();
      setShownFile({ id: (event as CustomEvent<string>).detail });
      setSandboxOpen(true);
    }
    window.addEventListener(SHOW_FILE_EVENT, onShowFile);
    return () => window.removeEventListener(SHOW_FILE_EVENT, onShowFile);
  }, [activeConversationId]);

  const dockRef = useRef<HTMLDivElement | null>(null);
  useComposerGlide(dockRef);

  function clearChat() {
    reset();
    setComposerKey((k) => k + 1);
  }

  // Handlers bridging conversations <> chat
  async function handleOpenConversation(id: string) {
    if (isStreaming) return;
    try {
      const opened = await openConversation(id);
      loadHistory(opened.messages, opened.context);
    } catch {
      // ignore
    }
  }

  /** The user's last compaction is taken back: the chat shows the conversation as it is stored then. */
  async function handleUndoCompact() {
    if (isStreaming || !activeConversationId) return;
    if (await undoCompact(activeConversationId)) await handleOpenConversation(activeConversationId);
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
      right={sandboxAvailable ? { open: sandboxOpen, onOpenChange: setSandboxOpen } : undefined}
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
      <SandboxPanel
        conversationId={activeConversationId}
        available={sandboxAvailable}
        open={sandboxOpen}
        onOpenChange={setSandboxOpen}
        tick={toolsDone}
        reveal={shownFile}
      />
      <div className={styles.chatArea}>
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          replyStatus={replyStatus}
          onUndoCompact={handleUndoCompact}
        />
        <div ref={dockRef} className={styles.composerDock}>
          <Composer
            key={composerKey}
            isStreaming={isStreaming}
            agentId={chosen.kind === "agent" ? chosen.value : null}
            accept={accept}
            context={context}
            onSend={send}
            onCompact={compact}
            onCancel={cancel}
          />
        </div>
      </div>
    </AppShell>
  );
}
