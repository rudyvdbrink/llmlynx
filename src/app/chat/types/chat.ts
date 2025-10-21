export type Role = "user" | "assistant" | "system";

export type ChatMessage = { role: Role; content: string };

export type UiMessage = { sender: "user" | "bot"; text: string };

export type User = { id: string; email: string } | null;

export type ConversationSummary = {
  id: string;
  title: string | null;
  model: string | null; // stores "agent:<id>" or "model:<name>" (legacy plain still supported)
  createdAt: string;
  updatedAt: string;
};

export type ConversationWithMessages = {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messages: { id: string; role: Role; content: string; createdAt: string }[];
};