// Types shared by the client and the API routes.

import type { ToolIcon } from "./agentTools";

export type Role = "user" | "assistant" | "system";

export type ChatMessage = { role: Role; content: string };

// A tool the model called while working on a reply, as the chat view shows it.
// /api/chat sends these as { tool } lines; `label` says what the tool does or did.
export type ToolStep = {
  id: string;
  name: string;
  label: string;
  icon: ToolIcon;
  state: "running" | "done" | "error";
  attachmentId?: string; // a screenshot, served by /api/attachments/:id
};

// What a model did before its answer, in order: its reasoning (and any text it
// wrote before calling a tool), and the tools it called. See lib/trace.ts.
export type TraceItem = { kind: "reasoning"; text: string } | { kind: "tool"; step: ToolStep };

// A message as shown in the chat view. `trace` is what the model did before
// its reply, and `error` says why its reply failed.
export type DisplayMessage = ChatMessage & { trace?: TraceItem[]; error?: string };

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
  // The user's messages and the replies; a reply that used tools is one message
  // whose trace holds its reasoning and tool calls in order
  messages: { id: string; role: Role; content: string; trace?: TraceItem[]; createdAt: string }[];
};

export type AgentSummary = {
  id: string;
  name: string;
  baseModel: string;
  systemPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
};
