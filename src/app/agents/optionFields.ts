import type { AgentSettings } from "@/lib/agentSettings";

// One row in the "Generation options" grid and its entry in the help dialog.
export type OptionField = {
  key: keyof AgentSettings;
  label: string;
  help: string;
  integer?: boolean;
  // Shown as a dropdown instead of slider + number box
  choices?: { value: number; label: string }[];
  slider?: { min: number; max: number; step: number };
  number?: { min?: number; max?: number; step: number };
  // Store 0 when the number box is cleared, instead of NaN
  zeroWhenEmpty?: boolean;
};

export const OPTION_FIELDS: OptionField[] = [
  {
    key: "mirostat",
    label: "Mirostat",
    help: "Enable Mirostat sampling for controlling perplexity. (Off, Mirostat, Mirostat 2.0)",
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
    help: "Learning rate for Mirostat; higher is more responsive. Default 0.1.",
    slider: { min: 0, max: 1, step: 0.01 },
    number: { min: 0, max: 1, step: 0.01 },
  },
  {
    key: "mirostat_tau",
    label: "Mirostat τ",
    help: "Balance coherence vs. diversity; lower = more focused. Default 5.0.",
    slider: { min: 0, max: 10, step: 0.1 },
    number: { min: 0, max: 10, step: 0.1 },
  },
  {
    key: "num_ctx",
    label: "Context window (tokens)",
    help: "Context window size in tokens. Default 2048.",
    integer: true,
    slider: { min: 256, max: 32768, step: 256 },
    number: { min: 1, step: 1 },
    zeroWhenEmpty: true,
  },
  {
    key: "repeat_last_n",
    label: "Repetition lookback (last n)",
    help: "Lookback window for repetition penalty. 0=disabled, -1=num_ctx. Default 64.",
    integer: true,
    slider: { min: -1, max: 4096, step: 1 },
    number: { min: -1, step: 1 },
  },
  {
    key: "repeat_penalty",
    label: "Repetition penalty",
    help: "Strength of repetition penalty; higher penalizes more. Default 1.1.",
    slider: { min: 0, max: 3, step: 0.05 },
    number: { min: 0, max: 3, step: 0.05 },
  },
  {
    key: "temperature",
    label: "Temperature",
    help: "Creativity of the model; higher = more diverse outputs. Default 0.8.",
    slider: { min: 0, max: 2, step: 0.05 },
    number: { min: 0, max: 2, step: 0.05 },
  },
  {
    key: "seed",
    label: "Random number seed",
    help: "Same seed yields repeatable output. Default 0.",
    integer: true,
    number: { step: 1 },
    zeroWhenEmpty: true,
  },
  {
    key: "num_predict",
    label: "Max tokens to generate",
    help: "Max tokens to generate. -1 for no limit. Default -1.",
    integer: true,
    slider: { min: -1, max: 8192, step: 1 },
    number: { step: 1 },
  },
  {
    key: "top_k",
    label: "Top‑k",
    help: "Sample from top‑k tokens; higher = more diverse. Default 40.",
    integer: true,
    slider: { min: 0, max: 1000, step: 1 },
    number: { min: 0, step: 1 },
  },
  {
    key: "top_p",
    label: "Top‑p",
    help: "Nucleus sampling; higher = more diverse. Default 0.9.",
    slider: { min: 0, max: 1, step: 0.01 },
    number: { min: 0, max: 1, step: 0.01 },
  },
  {
    key: "min_p",
    label: "Min‑p",
    help: "Minimum probability threshold relative to the max token probability. Default 0.0.",
    slider: { min: 0, max: 1, step: 0.01 },
    number: { min: 0, max: 1, step: 0.01 },
  },
];

export function parseOptionValue(field: OptionField, raw: string, fromNumberBox: boolean): number {
  const n = field.integer ? parseInt(raw, 10) : parseFloat(raw);
  return fromNumberBox && field.zeroWhenEmpty ? n || 0 : n;
}
