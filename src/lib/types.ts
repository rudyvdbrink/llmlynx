// Types shared by the client and the API routes.

export type Role = "user" | "assistant" | "system";

export type ChatMessage = { role: Role; content: string };

// A message as shown in the chat view. `error` marks a reply whose stream failed.
export type DisplayMessage = ChatMessage & { error?: boolean };

export type SessionUser = { id: string; email: string };

export type ConversationSummary = {
  id: string;
  title: string | null;
  model: string | null; // a selection string, see lib/selection.ts
  createdAt: string;
  updatedAt: string;
};

export type ConversationWithMessages = ConversationSummary & {
  messages: { id: string; role: Role; content: string; createdAt: string }[];
};

export type AgentSummary = {
  id: string;
  name: string;
  baseModel: string;
  systemPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
};
