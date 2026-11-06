import type { AgentSettings, OptionFamily, OptionValue } from "@/lib/agentSettings";
import { DEFAULT_SETTINGS, MAX_STOP_SEQUENCES } from "@/lib/agentSettings";
import type { BaseModelInfo } from "@/lib/types";

// One row in the "Generation options" panel and its entry in the help dialog.
export type OptionField = {
  key: string;
  label: string;
  help: string;
  integer?: boolean;
  // Shown as a dropdown instead of slider + number box
  choices?: { value: OptionValue; label: string }[];
  // A dropdown with what the model's reasoning can be set to
  reasoningChoices?: boolean;
  slider?: { min: number; max: number; step: number };
  // A slider over contextStops(), up to this limit of the model, instead of an even scale
  doublingSliderTo?: "contextLength" | "maxOutput";
  // What to say when the value is above that limit
  limitHint?: (model: string, limit: number) => string;
  number?: { min?: number; max?: number; step: number };
  // A text box with one entry per line
  lines?: { placeholder: string };
  // OpenAI and OpenRouter: the API's documented default, for models that do not state their own
  usual?: OptionValue;
  // What the number box says when there is no default value to show
  noDefault?: string;
};

export type OptionGroup = { title?: string; fields: OptionField[] };

const MAX_TOKENS_HELP = "About 750 words is 1000 tokens. A reply that reaches the limit stops mid-sentence.";

// One group without a title: Ollama's options keep their flat grid, in this order
const OLLAMA_GROUPS: OptionGroup[] = [
  {
    fields: [
      {
        key: "mirostat",
        label: "Mirostat",
        help:
          "Another way to control randomness: it keeps the text at a steady level of surprise, in place of Top-k, " +
          "Top-p and Min-p. Most agents can leave it off. Turn it on as its first or newer second version. Default off.",
        integer: true,
        choices: [
          { value: 0, label: "Off" },
          { value: 1, label: "Mirostat" },
          { value: 2, label: "Mirostat 2.0" },
        ],
      },
      {
        key: "mirostat_eta",
        label: "Mirostat η",
        help: "How quickly Mirostat reacts to the text so far. Higher reacts faster. Default 0.1.",
        slider: { min: 0, max: 1, step: 0.01 },
        number: { min: 0, max: 1, step: 0.01 },
      },
      {
        key: "mirostat_tau",
        label: "Mirostat τ",
        help: "The level of surprise Mirostat aims for. Lower is more focused, higher more varied. Default 5.",
        slider: { min: 0, max: 10, step: 0.1 },
        number: { min: 0, max: 10, step: 0.1 },
      },
      {
        key: "num_ctx",
        label: "Context window (tokens)",
        help:
          "How much the model can see at once: the system prompt, the conversation, tool results and the reply " +
          "together. What does not fit is cut off. Larger windows need more GPU memory; when the model no longer " +
          "fits, Ollama runs part of it on the CPU, which is much slower. Default 2048.",
        integer: true,
        doublingSliderTo: "contextLength",
        limitHint: (model, limit) => `${model} supports up to ${limit} tokens, so Ollama uses ${limit}.`,
        number: { min: 1, step: 1 },
      },
      {
        key: "repeat_last_n",
        label: "Repetition lookback (last n)",
        help: "How many of the latest tokens the repetition penalty looks at. 0 turns the penalty off; -1 looks at the whole context window. Default 64.",
        integer: true,
        slider: { min: -1, max: 4096, step: 1 },
        number: { min: -1, step: 1 },
      },
      {
        key: "repeat_penalty",
        label: "Repetition penalty",
        help: "Makes words the model already used less likely to come back. 1 turns this off. Above 1 means less repetition; too high makes the text awkward. Default 1.1.",
        slider: { min: 0, max: 3, step: 0.05 },
        number: { min: 0, max: 3, step: 0.05 },
      },
      {
        key: "temperature",
        label: "Temperature",
        help:
          "How predictable the replies are. Low values (up to 0.3) suit facts and code. High values (1 and up) " +
          "suit brainstorming and stories, but bring more mistakes. Default 0.8.",
        slider: { min: 0, max: 2, step: 0.05 },
        number: { min: 0, max: 2, step: 0.05 },
      },
      {
        key: "seed",
        label: "Random number seed",
        help: "The starting point of the model's random choices. The same seed, prompt and options give the same reply. Default 0.",
        integer: true,
        number: { step: 1 },
      },
      {
        key: "num_predict",
        label: "Max tokens to generate",
        help: `The longest a reply can be. ${MAX_TOKENS_HELP} -1 means no limit. Default -1.`,
        integer: true,
        slider: { min: -1, max: 8192, step: 1 },
        number: { step: 1 },
      },
      {
        key: "top_k",
        label: "Top‑k",
        help: "The model picks each next word from only this many of the likeliest ones. Lower is more predictable. 0 turns this off. Default 40.",
        integer: true,
        slider: { min: 0, max: 1000, step: 1 },
        number: { min: 0, step: 1 },
      },
      {
        key: "top_p",
        label: "Top‑p",
        help: "The model picks each next word from the likeliest ones that together reach this probability: 0.9 leaves out the unlikeliest tenth. Lower is more predictable. 1 turns this off. Default 0.9.",
        slider: { min: 0, max: 1, step: 0.01 },
        number: { min: 0, max: 1, step: 0.01 },
      },
      {
        key: "min_p",
        label: "Min‑p",
        help: "Leaves out words far less likely than the likeliest one: 0.05 drops anything under 5% of its probability. 0 turns this off. Default 0.",
        slider: { min: 0, max: 1, step: 0.01 },
        number: { min: 0, max: 1, step: 0.01 },
      },
    ],
  },
];

const API_GROUPS: OptionGroup[] = [
  {
    title: "Reasoning",
    fields: [
      {
        key: "reasoning",
        label: "Reasoning effort",
        help: "How much the model thinks before it answers. More effort helps with hard questions, but is slower and costs more, because reasoning tokens are billed.",
        reasoningChoices: true,
      },
    ],
  },
  {
    title: "Length",
    fields: [
      {
        key: "max_tokens",
        label: "Max output tokens",
        help: `The longest a reply can be. ${MAX_TOKENS_HELP} On models that reason, the reasoning counts too, so leave room for it.`,
        integer: true,
        doublingSliderTo: "maxOutput",
        limitHint: (model, limit) => `${model} writes at most ${limit} tokens per reply.`,
        number: { min: 1, step: 1 },
        noDefault: "Model limit",
      },
      {
        key: "verbosity",
        label: "Verbosity",
        help: "How long and detailed the reply is, from short to thorough. This changes how the model writes; it does not set a limit.",
        choices: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        usual: "medium",
      },
      {
        key: "stop",
        label: "Stop sequences",
        help: `The model stops as soon as it would write one of these. One per line, at most ${MAX_STOP_SEQUENCES}. Rarely needed in a chat.`,
        lines: { placeholder: "One per line" },
      },
    ],
  },
  {
    title: "Creativity",
    fields: [
      {
        key: "temperature",
        label: "Temperature",
        help:
          "How predictable the replies are. Low values (up to 0.3) suit facts and code. High values (1 and up) " +
          "suit brainstorming and stories, but bring more mistakes.",
        slider: { min: 0, max: 2, step: 0.05 },
        number: { min: 0, max: 2, step: 0.05 },
        usual: 1,
      },
      {
        key: "top_p",
        label: "Top‑p",
        help: "The model picks each next word from the likeliest ones that together reach this probability: 0.9 leaves out the unlikeliest tenth. Lower is more predictable. Change this or Temperature, not both.",
        slider: { min: 0, max: 1, step: 0.01 },
        number: { min: 0, max: 1, step: 0.01 },
        usual: 1,
      },
      {
        key: "top_k",
        label: "Top‑k",
        help: "The model picks each next word from only this many of the likeliest ones. Lower is more predictable. 0 turns this off.",
        integer: true,
        slider: { min: 0, max: 1000, step: 1 },
        number: { min: 0, step: 1 },
        usual: 0,
      },
      {
        key: "min_p",
        label: "Min‑p",
        help: "Leaves out words far less likely than the likeliest one: 0.05 drops anything under 5% of its probability. 0 turns this off.",
        slider: { min: 0, max: 1, step: 0.01 },
        number: { min: 0, max: 1, step: 0.01 },
        usual: 0,
      },
      {
        key: "top_a",
        label: "Top‑a",
        help: "Keeps only words close in probability to the likeliest one, so the choice narrows when the model is sure. Higher is stricter. 0 turns this off.",
        slider: { min: 0, max: 1, step: 0.01 },
        number: { min: 0, max: 1, step: 0.01 },
        usual: 0,
      },
    ],
  },
  {
    title: "Repetition",
    fields: [
      {
        key: "frequency_penalty",
        label: "Frequency penalty",
        help: "Makes a word less likely the more often it has appeared. Positive means less repetition, negative more. 0 turns this off.",
        slider: { min: -2, max: 2, step: 0.05 },
        number: { min: -2, max: 2, step: 0.05 },
        usual: 0,
      },
      {
        key: "presence_penalty",
        label: "Presence penalty",
        help: "Makes any word that has appeared less likely, however often it did, which nudges the model toward new topics. Negative does the opposite. 0 turns this off.",
        slider: { min: -2, max: 2, step: 0.05 },
        number: { min: -2, max: 2, step: 0.05 },
        usual: 0,
      },
      {
        key: "repetition_penalty",
        label: "Repetition penalty",
        help: "Makes words the model already used less likely to come back. 1 turns this off. Above 1 means less repetition; too high makes the text awkward.",
        slider: { min: 0, max: 2, step: 0.05 },
        number: { min: 0, max: 2, step: 0.05 },
        usual: 1,
      },
    ],
  },
  {
    title: "Repeatable replies",
    fields: [
      {
        key: "seed",
        label: "Random number seed",
        help: "The starting point of the model's random choices. The same seed, prompt and options should give about the same reply, though providers do not promise it. Without a seed, each reply starts somewhere else.",
        integer: true,
        number: { step: 1 },
        noDefault: "Random",
      },
    ],
  },
];

const OPTION_GROUPS: Record<OptionFamily, OptionGroup[]> = { ollama: OLLAMA_GROUPS, api: API_GROUPS };

// Offered when it is not known what an OpenAI or OpenRouter model takes
const BASIC_API_OPTIONS = ["max_tokens"];

/** The options to show for a model: of Ollama all, of the others what the model takes. */
export function optionGroupsFor(family: OptionFamily, info: BaseModelInfo | null): OptionGroup[] {
  const keys = family === "ollama" ? null : (info?.options ?? BASIC_API_OPTIONS);
  return OPTION_GROUPS[family]
    .map((group) => ({ ...group, fields: group.fields.filter((f) => !keys || keys.includes(f.key)) }))
    .filter((group) => group.fields.length > 0);
}

/** What an option holds for this model. A reasoning level the model does not have counts as not set. */
export function currentValue(field: OptionField, settings: AgentSettings, info: BaseModelInfo | null) {
  const value = settings[field.key];
  const known = !field.reasoningChoices || !info?.reasoning || info.reasoning.includes(String(value));
  return known ? value : undefined;
}

/**
 * The value an option has while it is not set: llmlynx's default for Ollama; for
 * the others the model's own if its provider states it, otherwise the API's usual
 * default. Undefined when there is none to show.
 */
export function defaultValueOf(field: OptionField, family: OptionFamily, info: BaseModelInfo | null) {
  const known = DEFAULT_SETTINGS[family][field.key] ?? info?.defaults[field.key];
  if (known !== undefined) return known;
  if (field.doublingSliderTo === "maxOutput") {
    const limit = info?.maxOutput ?? info?.contextLength;
    if (limit) return limit;
  }
  return field.usual;
}

const REASONING_ORDER = ["none", "off", "on", "minimal", "low", "medium", "high", "xhigh", "max"];
const REASONING_LABELS: Record<string, string> = {
  none: "None",
  off: "Off",
  on: "On",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** What the model's reasoning option can be set to, from least to most. */
export function reasoningOptions(choices: string[] | null): { value: string; label: string }[] {
  return REASONING_ORDER.filter((value) => choices?.includes(value)).map((value) => ({
    value,
    label: REASONING_LABELS[value],
  }));
}

// The doubling slider ends at this limit of the base model, or here while that
// is not known (or the provider does not say).
export const DEFAULT_CONTEXT_MAX = 32768;

/**
 * The values a doubling slider stops at: powers of two from 256, then `max`,
 * the most the base model supports (often a power of two itself).
 * Evenly spaced stops keep the small values as easy to pick as the large ones.
 */
export function contextStops(max: number): number[] {
  const stops: number[] = [];
  for (let n = 256; n < max; n *= 2) stops.push(n);
  return [...stops, max];
}

/** What a typed number or a slider position holds, or undefined when the box is empty. */
export function parseOptionValue(field: OptionField, raw: string): number | undefined {
  const n = field.integer ? parseInt(raw, 10) : parseFloat(raw);
  return Number.isNaN(n) ? undefined : n;
}
