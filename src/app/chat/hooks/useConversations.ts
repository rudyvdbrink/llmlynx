"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  ConversationSummary,
  ConversationWithMessages,
  ChatMessage,
  User,
} from "../types/chat";
import { normalizeSelection } from "../utils/selection";

export function useConversations(
  user: User,
  selection: string,
  setSelection: (val: string) => void
) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  const refreshConversations = useCallback(() => {
    if (!user) {
      setConversations([]);
      return;
    }
    fetch("/api/conversations")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setConversations(data.conversations ?? []))
      .catch(() => setConversations([]));
  }, [user]);

  useEffect(() => {
    refreshConversations();
    if (!user) {
      setActiveConversationId(null);
    }
  }, [user, refreshConversations]);

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    if (activeConversationId) return activeConversationId;
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: selection }),
    });
    if (!res.ok) throw new Error("Failed to create conversation");
    const data = await res.json();
    const id = data.conversation.id as string;
    setActiveConversationId(id);
    refreshConversations();
    return id;
  }, [user, activeConversationId, selection, refreshConversations]);

  const openConversation = useCallback(
    async (id: string): Promise<{ convo: ConversationWithMessages; messages: ChatMessage[] }> => {
      if (!user) throw new Error("Not authenticated");
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) throw new Error("Failed to open conversation");
      const data = (await res.json()) as { conversation: ConversationWithMessages };
      const convo = data.conversation;

      const msgs: ChatMessage[] = convo.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      setActiveConversationId(convo.id);
      setSelection(normalizeSelection(convo.model, "model:gemma3:1b"));
      return { convo, messages: msgs };
    },
    [user, setSelection]
  );

  const renameConversation = useCallback(async (id: string, newTitle: string) => {
    if (!user) return;
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    }).catch(() => {});
    refreshConversations();
  }, [user, refreshConversations]);

  const deleteConversation = useCallback(async (id: string): Promise<boolean> => {
    if (!user) return false;
    let deletedActive = false;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" })
      .then((r) => {
        if (!r.ok && r.status !== 204) throw new Error("Delete failed");
      })
      .catch(() => {});
    if (id === activeConversationId) {
      setActiveConversationId(null);
      deletedActive = true;
    }
    refreshConversations();
    return deletedActive;
  }, [user, activeConversationId, refreshConversations]);

  const newConversation = useCallback(() => {
    setActiveConversationId(null);
  }, []);

  return {
    conversations,
    activeConversationId,
    setActiveConversationId,
    refreshConversations,
    ensureConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    newConversation,
  };
}