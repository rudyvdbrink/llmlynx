// What the security rules know about a conversation: the URLs that came from
// the user or from a tool, and whether text that looked like instructions
// aimed at the model has reached it. It is built from the stored conversation
// only, never from the client, and kept up to date in memory while a reply runs.

import { collapse, extractUrls } from "./urls";

export type SecurityContext = {
  /** Every URL in the user's messages, in their files and in the tool results, normalized (see urls.ts). */
  knownUrls: Set<string>;
  /** Flagged text is in the conversation, or was withheld from it. Never goes back to false. */
  tainted: boolean;
  /** The chat has web_search, which the model is pointed to when a URL is blocked. */
  webSearch: boolean;
  /** The user's messages and file texts in collapsed form, for the shared-text signal. Made on first use. */
  sharedText(): string;
  /** Adds what the user wrote, or the text of a file they attached. */
  addUserText(text: string): void;
  /** Adds the result of a tool call as the model got it. */
  addToolResult(text: string): void;
};

/** An empty context; `webSearch` says whether the chat has that tool. */
export function createSecurityContext(webSearch = false): SecurityContext {
  const userTexts: string[] = [];
  let shared: string | null = null;
  const context: SecurityContext = {
    knownUrls: new Set(),
    tainted: false,
    webSearch,
    sharedText() {
      // A line break between the texts, which no collapsed URL holds: a run cannot span two of them
      shared ??= userTexts.map(collapse).join("\n");
      return shared;
    },
    addUserText(text) {
      if (!text) return;
      for (const url of extractUrls(text)) context.knownUrls.add(url);
      userTexts.push(text);
      shared = null;
    },
    addToolResult(text) {
      for (const url of extractUrls(text)) context.knownUrls.add(url);
    },
  };
  return context;
}

/** A stored step of a conversation, as the context is built from it: a user message or a tool result. */
export type StoredStep = {
  role: string;
  content: string;
  metadata: unknown;
  attachments: { text: string | null }[];
};

/**
 * The context of a conversation with these stored steps. The conversation is
 * tainted when a tool result was flagged as a prompt injection.
 */
export function contextFromSteps(steps: StoredStep[], webSearch = false): SecurityContext {
  const context = createSecurityContext(webSearch);
  for (const step of steps) {
    if (step.role === "tool") {
      context.addToolResult(step.content);
      const flag = (step.metadata as { security?: { flag?: unknown } } | null)?.security?.flag;
      if (flag === "injection") context.tainted = true;
      continue;
    }
    if (step.role !== "user") continue;
    context.addUserText(step.content);
    for (const file of step.attachments) if (file.text) context.addUserText(file.text);
  }
  return context;
}
