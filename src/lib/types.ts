// Types shared by the client and the API routes.

import type { AgentSettings } from "./agentSettings";
import type { ToolAvailability, ToolIcon } from "./agentTools";
import type { FileCard } from "./files";

export type Role = "user" | "assistant" | "system";

// `images` (on the server only) are the images the model gets with the message, base64
export type ChatMessage = { role: Role; content: string; images?: { mimeType: string; data: string }[] };

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
// its reply, `files` the files the user attached or the agent created, and
// `error` says why its reply failed.
export type DisplayMessage = ChatMessage & { trace?: TraceItem[]; files?: FileCard[]; error?: string };

// What a model is busy with before its reply starts, sent as { status } lines by /api/chat.
// "reading": the files the user attached are read first.
export type ReplyStatus = "reading" | "loading" | "thinking";

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
  messages: { id: string; role: Role; content: string; trace?: TraceItem[]; files?: FileCard[]; createdAt: string }[];
};

export type AgentSummary = {
  id: string;
  name: string;
  baseModel: string;
  systemPrompt?: string | null;
  createdAt: string;
  updatedAt: string;
};

// What an agent can have with its base model, as GET /api/agents/base-model returns it.
export type BaseModelInfo = {
  tools: ToolAvailability[];
  contextLength: number | null; // the longest context window the model supports; null when unknown
  maxOutput: number | null; // the most tokens one reply can have; null when unknown
  options: string[] | null; // the keys of the options the model takes (lib/agentSettings.ts); null when unknown
  reasoning: string[] | null; // what its reasoning option can be set to; null when it has no such option
  defaults: AgentSettings; // the model's own values for its options, as far as they are known
};

// Whether an agent can be used now, as GET /api/agents/status returns it per agent.
export type AgentStatus = {
  unavailable: string | null; // why it cannot be used now, such as "Ollama cannot be reached"
  expiresOn: string | null; // YYYY-MM-DD when its provider has announced the end of its base model
};
