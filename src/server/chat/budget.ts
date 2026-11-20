// The context budget: how a model's context window is divided, and how long
// the conversation is for the model. Sizes are measured where a provider
// reports them (the tokens a request took), and estimated from characters for
// what was added since.
//
// The window has a fixed head (the system prompt and the tool descriptions),
// the history, and a reserve for the reply and the next round of tool
// results. The history is reduced when a request would pass the start mark,
// and then by a lot at once, so that the start of the requests stays the same
// for a long time: that is what prompt caches need.

import type { ContextFill } from "@/lib/types";
import type { ToolDefinition } from "@/server/tools/definitions";
import { toFunctionTools } from "@/server/tools/definitions";
import type { ViewMessage } from "./view";

// A larger window counts as this: beyond it several providers charge more per token, and answers get worse
export const MAX_COUNTED_WINDOW = 200_000;
// The window of a model on OpenAI or OpenRouter whose provider does not say how long its context is
export const UNKNOWN_WINDOW = 100_000;

// The share of the window a request may take before the history is reduced
const START_SHARE = 0.7;
// The reserve is the rest: this share for the results of one round of tool calls, and the remainder for the reply
const ROUND_SHARE = 0.2;
// What may be attached again after a checkpoint: the files used last
const ATTACH_SHARE = 0.15;
// No request may be longer than this share of the window, whatever is protected: the rest is for the reply
const HARD_SHARE = 0.9;

// About this many characters make a token, until a request says how many it took
const DEFAULT_CHARS_PER_TOKEN = 3.5;
const MIN_CHARS_PER_TOKEN = 2;
const MAX_CHARS_PER_TOKEN = 6;
// What is added while a reply runs is mostly tool results: web pages, code and logs take more tokens
// for their length than prose. This many characters make a token of them, until two requests say
const ADDED_CHARS_PER_TOKEN = 3;
// Fewer added characters than this between two requests say too little about them
const MIN_MEASURED_CHARS = 1_500;
// What an image counts as, in tokens: providers differ, and this is on the safe side for most
const IMAGE_TOKENS = 1_000;
// What a message costs besides its text, in characters
const MESSAGE_OVERHEAD = 12;

// The limits of one tool result, in characters (see textBudget in server/tools/definitions.ts)
const MAX_RESULT_CHARS = 12_000;
const MIN_RESULT_CHARS = 1_500;
// A call that comes when its round's share is used up still gets this much, to say how to read the rest
const LEAST_RESULT_CHARS = 500;

/** What a request took, as its provider reports it. */
export type Usage = { input: number; output: number };

export type { ContextFill };

/** The length of a message's text for the model, in characters. */
function messageChars(message: ViewMessage): number {
  let chars = message.content.length + MESSAGE_OVERHEAD;
  if (message.role === "assistant") {
    for (const call of message.calls ?? []) chars += call.name.length + JSON.stringify(call.arguments).length + MESSAGE_OVERHEAD;
  }
  return chars;
}

const messageImages = (message: ViewMessage) => (message.role === "user" || message.role === "tool" ? (message.images?.length ?? 0) : 0);

/** The length of the view's text, in characters, and how many images it has. */
export function viewSize(view: ViewMessage[]): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  for (const message of view) {
    chars += messageChars(message);
    images += messageImages(message);
  }
  return { chars, images };
}

/**
 * The budget of a chat on a model whose context window is `window` tokens,
 * with `tools` offered. It keeps count of how long the view is: `measured`
 * takes what a request reported, and `tokens` adds an estimate of what
 * changed since.
 */
export function createBudget(window: number, tools: ToolDefinition[]) {
  const counted = Math.min(window, MAX_COUNTED_WINDOW);
  const toolChars = tools.length ? JSON.stringify(toFunctionTools(tools)).length : 0;
  let charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  // How many characters make a token of what was added since the request before
  let addedCharsPerToken = ADDED_CHARS_PER_TOKEN;
  // The last request: what it took, and what was sent
  let anchor: { tokens: number; chars: number; images: number } | null = null;
  // The view was reduced since that request: what was added since cannot be told from what was taken away
  let reducedSince = false;
  // The characters the results of the round that is running took
  let roundChars = 0;

  const start = Math.floor(counted * START_SHARE);

  function tokens(view: ViewMessage[]): number {
    const { chars, images } = viewSize(view);
    if (!anchor) return Math.ceil((chars + toolChars) / charsPerToken) + images * IMAGE_TOKENS;
    return Math.max(0, Math.ceil(anchor.tokens + (chars - anchor.chars) / addedCharsPerToken + (images - anchor.images) * IMAGE_TOKENS));
  }

  /** The tokens of the fixed head: the system prompt and the tools. */
  function headTokens(view: ViewMessage[]): number {
    const system = view[0]?.role === "system" ? messageChars(view[0]) : 0;
    return Math.ceil((system + toolChars) / charsPerToken);
  }

  return {
    window: counted,
    /** A request that would be longer than this starts a reduction. */
    start,
    /** How long the view is for the model, in tokens. */
    tokens,
    headTokens,
    /** How long the view may be after a reduction: the head, and half of the room the history has. */
    target(view: ViewMessage[]): number {
      const head = headTokens(view);
      return head + Math.max(0, Math.floor((start - head) / 2));
    },
    /** How much of what remains after a reduction is protected recent work: half of it. */
    protectedTokens(view: ViewMessage[]): number {
      return Math.max(0, Math.floor((start - headTokens(view)) / 4));
    },
    /** No request may be longer than this, whatever is protected. */
    hardLimit: Math.floor(counted * HARD_SHARE),
    /** How many tokens of files may be attached again after a checkpoint. */
    attachTokens: Math.floor(counted * ATTACH_SHARE),
    /** How long `messages`, a part of the view, are for the model, in tokens. */
    partTokens(messages: ViewMessage[]): number {
      const { chars, images } = viewSize(messages);
      return Math.ceil(chars / Math.min(charsPerToken, addedCharsPerToken)) + images * IMAGE_TOKENS;
    },
    /** Characters of tool results for `count` tokens, as far as the requests so far tell. */
    chars: (count: number) => Math.floor(count * Math.min(charsPerToken, addedCharsPerToken)),
    /** The request for `view` took `usage`: from here on, only what changes is estimated. */
    measured(view: ViewMessage[], usage: Usage) {
      if (!(usage.input > 0)) return;
      const { chars, images } = viewSize(view);
      const textTokens = usage.input - images * IMAGE_TOKENS;
      if (textTokens > 0) {
        charsPerToken = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, (chars + toolChars) / textTokens));
      }
      // What was added since the request before, when nothing was taken away meanwhile. Never counted
      // as lighter than prose: an estimate that is too low lets a request pass the window
      if (anchor && !reducedSince && images === anchor.images && chars - anchor.chars >= MIN_MEASURED_CHARS && usage.input > anchor.tokens) {
        const measured = (chars - anchor.chars) / (usage.input - anchor.tokens);
        addedCharsPerToken = Math.min(DEFAULT_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, measured));
      }
      anchor = { tokens: usage.input, chars, images };
      reducedSince = false;
    },
    /** The view was reduced: the next request does not say how long what was added since the last one is. */
    reduced() {
      reducedSince = true;
    },
    /** A round of tool calls starts: its results share the reserve for one round. */
    startRound() {
      roundChars = 0;
    },
    /**
     * The most characters the next result of the round may have: the limit of
     * one result (a quarter of the window, within limits), or what is left of
     * the round's share when that is less.
     */
    resultChars(): number {
      const one = Math.round(Math.min(MAX_RESULT_CHARS, Math.max(MIN_RESULT_CHARS, counted * 0.25 * DEFAULT_CHARS_PER_TOKEN)));
      const left = Math.floor(counted * ROUND_SHARE * Math.min(charsPerToken, addedCharsPerToken)) - roundChars;
      return Math.max(LEAST_RESULT_CHARS, Math.min(one, left));
    },
    /** A result of the round took `chars` characters. */
    addResult(chars: number) {
      roundChars += chars;
    },
    /** How full the window is, for the indicator, after a request that took `usage`. */
    fill: (usage: Usage): ContextFill => ({ used: usage.input + usage.output, full: start }),
  };
}

export type Budget = ReturnType<typeof createBudget>;
