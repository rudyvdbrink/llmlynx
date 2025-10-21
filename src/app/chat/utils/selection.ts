export function isAgentSelection(sel: string | null | undefined): sel is string {
    return !!sel && sel.startsWith("agent:");
  }
  
  export function isModelSelection(sel: string | null | undefined): sel is string {
    return !!sel && sel.startsWith("model:");
  }
  
  export function normalizeSelection(sel: string | null | undefined, fallback = "model:gemma3:1b") {
    if (!sel) return fallback;
    if (isAgentSelection(sel) || isModelSelection(sel)) return sel;
    // legacy plain value -> wrap as model:<name>
    return `model:${sel}`;
  }