import { NextRequest } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { getDefaultSystemPrompt } from "@/server/config";
import { getApiConfig, getOllamaUrl } from "@/server/providers";
import { stopAttempt, trackAttempt } from "@/server/chat/attempts";
import {
  createAssistantReply,
  loadHistory,
  messageFiles,
  resolveConversation,
  saveUserMessage,
  type NewFile,
} from "@/server/chat/conversation";
import { getModelInfo, usesResponsesApi } from "@/server/chat/models";
import { streamOllamaChat } from "@/server/chat/ollama";
import { apiRequestParams, streamOpenAIChat } from "@/server/chat/openai";
import type { RequestSetupInput } from "@/server/chat/setup";
import { addToLastMessage } from "@/server/chat/toolLoop";
import { fileTextBudget, filesNote } from "@/server/files/history";
import { prepareMessageFiles } from "@/server/files/prepare";
import { conversationFiles } from "@/server/files/store";
import { textBudget, toFunctionTools } from "@/server/tools/definitions";
import { attachAccept, hasFileTools, toolGuidance, toolsFor } from "@/server/tools/policy";
import { normalizeSelection, parseBaseModel, parseSelection, toSelection } from "@/lib/selection";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/providers";
import { DEFAULT_MAX_TOOL_CALLS } from "@/lib/agentTools";
import { cleanFileName, fileProblem, MAX_FILES_PER_MESSAGE, mimeTypeOf } from "@/lib/files";

export const runtime = "nodejs";

// POST /api/chat
// body: { message: string, model?: string, agentId?: string, conversationId?: string, requestId?: string }
// `message` is the user's new message; the rest of the conversation is read from
// the database, so the model always gets the conversation as stored.
// `model` is a selection ("ollama:<name>" | "openai:<name>" | "openrouter:<name>")
// or a plain Ollama model name. Each user's own Ollama server and API keys are used.
// `requestId` (32 hex characters) identifies the send: a re-send with the same id
// replaces the attempt before it, see server/chat/attempts.ts.
// A message with files comes as multipart/form-data: the body as JSON in the
// "payload" field, and each file in a "file" field. Only agents take files (see
// attachAccept in server/tools/policy.ts). The stream then starts with a
// { userFiles: FileCard[] } line, the cards of the stored files, and
// { status: "reading" } while they are read, before the model answers.
// Responds with an NDJSON stream, which ends with an { end: true } line, and the
// conversation id in X-Conversation-Id. X-Tools is "1" when the model can call tools.

const REQUEST_ID = /^[0-9a-f]{32}$/;

// For the text budget of an agent's tools, when its provider does not say how long its context is
const UNKNOWN_CONTEXT = 32768;

const encoder = new TextEncoder();
const ndjsonLine = (obj: object) => encoder.encode(JSON.stringify(obj) + "\n");

type Target = {
  kind: ProviderId;
  modelKey: string;
  model: string;
  systemPrompt: string | null; // null: the model gets none (plain OpenAI and OpenRouter models)
  agent: { settings: unknown; tools: unknown; maxToolCalls: number } | null; // set when the user chats with an agent
};

/** Works out which backend and model to use. Returns null if the agent is not the user's. */
async function resolveTarget(userId: string, model: unknown, agentId: unknown): Promise<Target | null> {
  if (typeof agentId === "string" && agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId } });
    const base = parseBaseModel(agent?.baseModel);
    if (!agent || !base) return null;
    return {
      kind: base.provider,
      modelKey: toSelection("agent", agent.id),
      model: base.model,
      systemPrompt: agent.systemPrompt?.trim() || getDefaultSystemPrompt(),
      agent: { settings: agent.settings, tools: agent.tools, maxToolCalls: agent.maxToolCalls },
    };
  }

  const selection = normalizeSelection(typeof model === "string" ? model : undefined);
  const { kind, value } = parseSelection(selection);
  if (kind === "agent") return null; // agents are chosen with agentId
  return {
    kind,
    modelKey: selection,
    model: value,
    systemPrompt: kind === "ollama" ? getDefaultSystemPrompt() : null,
    agent: null,
  };
}

/** The request body, and the files of a multipart request. Null when it cannot be read. */
async function readBody(req: NextRequest): Promise<{ body: Record<string, unknown>; uploads: File[] } | null> {
  try {
    if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const body: unknown = JSON.parse(String(form.get("payload") ?? ""));
      const uploads = form.getAll("file").filter((f): f is File => typeof f !== "string");
      return body && typeof body === "object" ? { body: body as Record<string, unknown>, uploads } : null;
    }
    const body: unknown = await req.json();
    return body && typeof body === "object" ? { body: body as Record<string, unknown>, uploads: [] } : null;
  } catch {
    return null;
  }
}

/**
 * A chat's NDJSON stream that starts with the `first` lines, then gets the
 * rest of its work done (`start`, such as reading the user's files) before the
 * reply itself streams. Cancelling it stops that work, or cancels the reply.
 */
function afterPreparing(
  first: object[],
  start: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>
): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of first) controller.enqueue(ndjsonLine(line));
      try {
        const reply = await start(abort.signal);
        if (abort.signal.aborted) return void (await reply.cancel());
        reader = reply.getReader();
      } catch (err) {
        if (abort.signal.aborted) return;
        console.error(`Preparing the chat failed: ${(err as Error)?.message || err}`);
        controller.enqueue(ndjsonLine({ error: "The attached files could not be read." }));
        controller.close();
      }
    },
    async pull(controller) {
      if (!reader) return controller.close();
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      abort.abort();
      await reader?.cancel(reason);
    },
  });
}

export async function POST(req: NextRequest) {
  // Require authentication for all chat calls
  const user = await getCurrentUser().catch(() => null);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const read = await readBody(req);
  if (!read) return new Response("Invalid request body", { status: 400 });
  const { body, uploads } = read;

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message && !uploads.length) return new Response("message required", { status: 400 });
  if (uploads.length > MAX_FILES_PER_MESSAGE) {
    return new Response(`At most ${MAX_FILES_PER_MESSAGE} files per message.`, { status: 400 });
  }

  const target = await resolveTarget(user.id, body.model, body.agentId);
  if (!target) return new Response("Agent not found", { status: 404 });
  if (!target.model) return new Response("No model selected", { status: 400 });
  const { agent } = target;
  if (uploads.length && !agent) return new Response("Only agents take files.", { status: 400 });

  const apiConfig = target.kind === "ollama" ? null : await getApiConfig(user.id, target.kind);
  if (target.kind !== "ollama" && !apiConfig) {
    return new Response(`No ${PROVIDER_LABELS[target.kind]} API key. Add one on the account page.`, { status: 403 });
  }

  // What the model can do decides its tools, the files it takes and, on OpenAI and OpenRouter, which options it gets
  const modelInfo = agent ? await getModelInfo(user.id, target.kind, target.model) : null;
  const capabilities = modelInfo?.capabilities ?? null;
  const problem = uploads
    .map((f) => fileProblem(attachAccept(capabilities), { name: cleanFileName(f.name), size: f.size }))
    .find(Boolean);
  if (problem) return new Response(problem, { status: 400 });
  const files: NewFile[] = await Promise.all(
    uploads.map(async (f) => {
      const name = cleanFileName(f.name);
      return { name, mimeType: mimeTypeOf(name), data: Buffer.from(await f.arrayBuffer()) };
    })
  );

  const conversationId = await resolveConversation(
    user.id,
    typeof body.conversationId === "string" ? body.conversationId : undefined,
    target.modelKey
  );
  if (!conversationId) return new Response("Conversation not found", { status: 404 });

  const requestId = typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
  const attemptKey = requestId && `${user.id}:${requestId}`;
  if (attemptKey) await stopAttempt(attemptKey);

  const { messageId } = await saveUserMessage(conversationId, message, target.modelKey, requestId, files);
  const userFiles = await messageFiles(messageId);
  // The tools the model can call: only agents get them, see server/tools/policy.ts
  const tools = toolsFor(agent, capabilities);
  const vision = !!capabilities?.includes("vision");
  const contextTokens =
    target.kind === "ollama"
      ? (agent?.settings as { num_ctx?: unknown } | undefined)?.num_ctx
      : (modelInfo?.contextLength ?? UNKNOWN_CONTEXT);
  const maxToolCalls = agent?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const systemPrompt =
    target.systemPrompt !== null && tools.length
      ? `${target.systemPrompt}\n\n${toolGuidance(tools, maxToolCalls)}`
      : target.systemPrompt;
  const system = systemPrompt !== null ? [{ role: "system" as const, content: systemPrompt }] : [];
  const apiParams =
    agent && target.kind !== "ollama"
      ? apiRequestParams(target.kind, agent.settings, modelInfo)
      : undefined;
  // Everything the model gets besides the conversation, which is stored with the reply
  const setup: RequestSetupInput = {
    ...(systemPrompt !== null ? { systemPrompt } : {}),
    ...(agent ? { options: apiParams ?? agent.settings } : {}),
    ...(tools.length ? { tools: toFunctionTools(tools) } : {}),
  };
  const reply = createAssistantReply({
    conversationId,
    userId: user.id,
    modelKey: target.modelKey,
    model: toSelection(target.kind, target.model),
    setup,
  });

  const toolRun = {
    tools,
    maxToolCalls,
    forAgent: !!agent,
    toolContext: { userId: user.id, textBudget: textBudget(contextTokens), conversationId, vision },
  };
  const { kind, model } = target;
  const baseUrl = kind === "ollama" ? await getOllamaUrl(user.id) : "";
  const has = (name: string) => tools.some((t) => t.name === name);

  const startReply = async (signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
    if (userFiles.length) await prepareMessageFiles(messageId, vision, signal);
    // The conversation so far, ending with the new message. Like the system
    // prompt, it comes from the server, never from the client.
    let history = await loadHistory(
      conversationId,
      agent
        ? { vision, textBudget: fileTextBudget(contextTokens), readFile: has("read_file"), viewPages: has("view_pdf_pages") }
        : undefined
    );
    // An agent with file tools refers to the files by name
    const note = hasFileTools(tools) ? filesNote(await conversationFiles(conversationId)) : null;
    if (note) history = addToLastMessage(history, note);
    const messages = [...system, ...history];

    return kind !== "ollama"
      ? streamOpenAIChat(
          {
            ...toolRun,
            provider: kind,
            model,
            messages,
            params: apiParams,
            useResponses: !!agent && usesResponsesApi(kind, modelInfo),
          },
          apiConfig!,
          reply
        )
      : streamOllamaChat({ ...toolRun, baseUrl, model, messages, options: agent?.settings }, reply);
  };

  const stream = afterPreparing(userFiles.length ? [{ userFiles }, { status: "reading" }] : [], startReply);

  return new Response(trackAttempt(attemptKey, stream, req.signal), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Conversation-Id": conversationId,
      ...(tools.length ? { "X-Tools": "1" } : {}),
    },
  });
}
