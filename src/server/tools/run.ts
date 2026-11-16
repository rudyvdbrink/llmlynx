// Runs one tool call of a chat. Failures become an error text for the model,
// so it can try something else or tell the user, rather than ending the reply.
// The chat's security checks run around the call (see server/security/engine.ts).

import { checkRateLimit } from "@/server/limits/rateLimit";
import { checkAfterCall, checkBeforeCall } from "@/server/security/engine";
import { getToolServer } from "./config";
import { callMcpTool } from "./mcp";
import type { Args, ToolCallContext, ToolDefinition, ToolResult } from "./definitions";

export type { ToolResult };

// Images a model may get and the chat view may show; tools/browser sends JPEG
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;

const failure = (text: string): ToolResult => ({ text: `Error: ${text}`, images: [], files: [], error: true });

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[Cut off after ${max} characters.]` : text;
}

const LIMITED = "too many tool calls in the last few minutes. Answer with what you have.";

/**
 * Calls the MCP tool behind `def`, or lets a tool that does more run itself.
 * `answered` is false when the call was not made or the tool did not answer:
 * the result is then an error text llmlynx wrote itself.
 */
async function callTool(
  def: ToolDefinition,
  args: Args,
  ctx: ToolCallContext
): Promise<{ result: ToolResult; answered: boolean }> {
  const unanswered = (text: string) => ({ result: failure(text), answered: false });
  if (def.run) {
    if (!checkRateLimit("tools", ctx.userId).allowed) return unanswered(LIMITED);
    try {
      const result = await def.run(args, ctx);
      // Room for the notes such a tool adds to a part of its text budget
      return { result: { ...result, text: clip(result.text, ctx.textBudget + 2_000) }, answered: true };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      console.error(`Tool ${def.name} failed: ${(err as Error)?.message || err}`);
      return unanswered(`the ${def.name} tool failed. Try again, or answer without it.`);
    }
  }

  const call = def.toMcpCall(args, ctx.textBudget);
  if ("error" in call) return unanswered(call.error);
  const server = getToolServer(def.server);
  if (!checkRateLimit("tools", ctx.userId).allowed) return unanswered(LIMITED);

  try {
    const out = await callMcpTool(server, call.name, call.arguments, { signal: ctx.signal, timeoutMs: def.timeoutMs });
    const images = out.images.filter((i) => IMAGE_TYPES.includes(i.mimeType) && i.data.length <= MAX_IMAGE_BASE64);
    // finish() gets the text as the server cut it, so it can tell where the next part starts
    let text = clip(out.text, ctx.textBudget);
    if (!out.isError && def.finish) text = def.finish(text, args, ctx.textBudget);
    text = text.trim();
    return {
      result: { text: text || (images.length ? "" : "(The tool returned nothing.)"), images, files: [], error: out.isError },
      answered: true,
    };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    console.error(`Tool ${def.name} failed: ${(err as Error)?.message || err}`);
    return unanswered(`the ${def.name} tool did not answer. It may be down; try again later or answer without it.`);
  }
}

/**
 * Runs the tool `def` with the model's `args`. With `ctx.security`, the call
 * is checked first and may be blocked, with an error text that tells the
 * model how to go on; what the tool then returns is checked before the model
 * gets it. Throws only when the chat was stopped (`signal` aborted).
 */
export async function runTool(def: ToolDefinition, args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const security = ctx.security;
  if (!security) return (await callTool(def, args, ctx)).result;

  const blocked = checkBeforeCall(def, args, security);
  if (blocked) return blocked;
  const { result, answered } = await callTool(def, args, ctx);
  // An error llmlynx wrote itself holds nothing from the tool to check
  return answered ? checkAfterCall(def, args, result, security, ctx.signal) : result;
}
