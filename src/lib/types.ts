// Types shared by the client and the API routes.

export type Role = "user" | "assistant" | "system";

export type ChatMessage = { role: Role; content: string };

// A message as shown in the chat view. `reasoning` is what the model thought
// before its reply, and `error` says why its reply failed.
export type DisplayMessage = ChatMessage & { reasoning?: string; error?: string };

// What a model is busy with before its reply starts, sent as { status } lines by /api/chat.
export type ReplyStatus = "loading" | "thinking";

export type SessionUser = { id: string; email: string };

export type ConversationSummary = {
  id: string;
  title: string | null;
  model: string | null; // a selection string, see lib/selection.ts
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationWithMessages = ConversationSummary & {
  messages: { id: string; role: Role; content: string; reasoning: string | null; createdAt: string }[];
};

export type AgentSummary = {
  id: string;
  name: string;
  baseModel: string;
  systemPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
};
