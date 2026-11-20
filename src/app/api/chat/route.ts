import { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { stopAttempt, trackAttempt } from "@/server/chat/attempts";
import type { ContextConfig } from "@/server/chat/context";
import { createAssistantReply, messageFiles, resolveConversation, saveMemory, saveUserMessage } from "@/server/chat/conversation";
import { memoryInView, workingMemory } from "@/server/chat/memory";
import { streamOllamaChat } from "@/server/chat/ollama";
import { streamOpenAIChat } from "@/server/chat/openai";
import { chatSetup, chatView, resolveTarget } from "@/server/chat/target";
import { prepareMessageFiles } from "@/server/files/prepare";
import { conversationFiles } from "@/server/files/store";
import { roomError } from "@/server/sandbox/room";
import { UploadRefused } from "@/server/files/uploads";
import { createAuditLog } from "@/server/security/audit";
import { openSecurity } from "@/server/security/engine";
import { textBudget } from "@/server/tools/definitions";
import { attachAccept } from "@/server/tools/policy";
import { toSelection } from "@/lib/selection";
import { fileProblem, MAX_FILES_PER_MESSAGE } from "@/lib/files";

export const runtime = "nodejs";

// POST /api/chat
// body: { message: string, model?: string, agentId?: string, conversationId?: string, requestId?: string, uploads?: string[] }
// `message` is the user's new message; the rest of the conversation is read from
// the database, so the model always gets the conversation as stored: every
// step of it, the tool calls and their results included, as far as its context
// window holds them (see server/chat/view.ts and context.ts).
// `model` is a selection ("ollama:<name>" | "openai:<name>" | "openrouter:<name>")
// or a plain Ollama model name. Each user's own Ollama server and API keys are used.
// `requestId` (32 hex characters) identifies the send: a re-send with the same id
// replaces the attempt before it, see server/chat/attempts.ts.
// `uploads` are the ids of the message's files: drafts, which were checked and
// stored when the user attached them (POST /api/uploads). Only agents take
// files (see attachAccept in server/tools/policy.ts). A draft that is not the
// user's is refused. The stream then starts with a { userFiles: FileCard[] }
// line, the cards of the stored files, and { status: "reading" } while they
// are made ready, before the model answers.
// Responds with an NDJSON stream, which ends with an { end: true } line, and the
// conversation id in X-Conversation-Id.
// A { pause: { id, tool, source } } line says the reply waits for the user's
// choice about flagged content, sent with POST /api/chat/pauses/:id.
// On OpenAI and OpenRouter, { cost } lines say what the conversation cost so far
// in US dollars: an estimate while a request streams, exact once it ends.
// { context: { used, full } } lines say how full the model's context window is
// after each request, and a { checkpoint } line that older steps were
// summarised for the model, while { status: "compacting" } shows.

const REQUEST_ID = /^[0-9a-f]{32}$/;

const encoder = new TextEncoder();
const ndjsonLine = (obj: object) => encoder.encode(JSON.stringify(obj) + "\n");

/** The request body. Null when it cannot be read. */
async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
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

  const body = await readBody(req);
  if (!body) return new Response("Invalid request body", { status: 400 });
  const uploads = Array.isArray(body.uploads) ? body.uploads.filter((id): id is string => typeof id === "string" && !!id) : [];

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

  const setup = await chatSetup(user.id, target);
  if ("error" in setup) return new Response(setup.error, { status: setup.status });
  const { tools, vision, maxToolCalls } = setup;
  const accept = attachAccept(setup.capabilities);

  const conversationId = await resolveConversation(
    user.id,
    typeof body.conversationId === "string" ? body.conversationId : undefined,
    target.modelKey
  );
  if (!conversationId) return new Response("Conversation not found", { status: 404 });

  const requestId = typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
  // One reply at a time per conversation: one still running, such as the attempt before a re-send, is stopped
  // and what it wrote stored before the new message gets its place, so the two never interleave
  const attemptKey = conversationId;
  await stopAttempt(attemptKey);

  // The drafts move into the message, unless one may not be sent: decided here, not by the client
  let messageId: string;
  try {
    const problem = (file: { name: string; size: number }) => fileProblem(accept, file);
    // The chat's sandbox holds 100 MB at most, attached files included
    const current = uploads.length ? await conversationFiles(conversationId) : [];
    const room = (files: { name: string; size: number }[]) => roomError(current, files);
    const sent = uploads.length ? { userId: user.id, ids: uploads, problem, room } : null;
    ({ messageId } = await saveUserMessage(conversationId, message, target.modelKey, requestId, sent));
  } catch (err) {
    if (err instanceof UploadRefused) return new Response(err.message, { status: 400 });
    throw err;
  }
  const userFiles = await messageFiles(messageId);
  const reply = createAssistantReply({
    conversationId,
    userId: user.id,
    modelKey: target.modelKey,
    model: toSelection(target.kind, target.model),
    setup: setup.stored,
  });

  // What the security checks log is written in one go when the reply ends
  const audit = createAuditLog(user.id, conversationId);
  const { kind, model } = target;

  const startReply = async (signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
    if (userFiles.length) await prepareMessageFiles(messageId, vision, signal);
    // The security checks of this request (see server/security/engine.ts): built
    // from the stored conversation, before the model gets any of it
    const security = agent ? await openSecurity({ userId: user.id, conversationId, tools, audit }) : null;
    const toolRun = {
      tools,
      maxToolCalls,
      forAgent: !!agent,
      toolContext: { userId: user.id, textBudget: textBudget(setup.contextTokens), conversationId, vision, security },
    };
    // The working memory goes out with the user's message, and stays with it. A message only gets a
    // copy when it changed: the model has the one before in view
    const memory = await workingMemory(conversationId, tools);
    await saveMemory(messageId, memory && memory !== (await memoryInView(conversationId, messageId)) ? memory : null);
    // The conversation so far, ending with the new message
    const view = await chatView(conversationId, setup);
    const context: ContextConfig = { conversationId, tools, security, window: setup.window };

    return kind !== "ollama"
      ? streamOpenAIChat(
          { ...toolRun, provider: kind, model, view, context, params: setup.apiParams, useResponses: setup.useResponses },
          setup.apiConfig!,
          reply
        )
      : streamOllamaChat({ ...toolRun, baseUrl: setup.baseUrl, model, view, context, options: setup.ollamaParams }, reply);
  };

  const stream = afterPreparing(userFiles.length ? [{ userFiles }, { status: "reading" }] : [], startReply);

  return new Response(trackAttempt(attemptKey, stream, req.signal, audit.flush), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Conversation-Id": conversationId,
    },
  });
}
