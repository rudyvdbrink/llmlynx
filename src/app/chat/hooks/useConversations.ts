"use client";

import { useCallback, useState } from "react";
import { useConversationList } from "@/hooks/useConversationList";
import { normalizeSelection } from "@/lib/selection";
import type { ChatMessage, ConversationWithMessages } from "@/lib/types";

/** Conversation list plus the active conversation and its CRUD actions. */
export function useConversations(selection: string, setSelection: (val: string) => void) {
  const { conversations, refresh: refreshConversations } = useConversationList();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  /** Returns the active conversation id, creating a conversation first if there is none. */
  const ensureConversation = useCallback(async (): Promise<string> => {
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
  }, [activeConversationId, selection, refreshConversations]);

  /** Makes `id` the active conversation and returns its messages. */
  const openConversation = useCallback(
    async (id: string): Promise<ChatMessage[]> => {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) throw new Error("Failed to open conversation");
      const { conversation } = (await res.json()) as { conversation: ConversationWithMessages };

      setActiveConversationId(conversation.id);
      setSelection(normalizeSelection(conversation.model));
      return conversation.messages.map((m) => ({ role: m.role, content: m.content }));
    },
    [setSelection]
  );

  const renameConversation = useCallback(
    async (id: string, newTitle: string) => {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      }).catch(() => {});
      refreshConversations();
    },
    [refreshConversations]
  );

  /** Deletes a conversation. Returns true if it was the active one. */
  const deleteConversation = useCallback(
    async (id: string): Promise<boolean> => {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
      const wasActive = id === activeConversationId;
      if (wasActive) setActiveConversationId(null);
      refreshConversations();
      return wasActive;
    },
    [activeConversationId, refreshConversations]
  );

  const newConversation = useCallback(() => {
    setActiveConversationId(null);
  }, []);

  return {
    conversations,
    activeConversationId,
    refreshConversations,
    ensureConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    newConversation,
  };
}
