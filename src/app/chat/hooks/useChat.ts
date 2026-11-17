"use client";

import { useCallback, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import { parseSelection } from "@/lib/selection";
import type { FileCard } from "@/lib/files";
import type { DisplayMessage, ReplyStatus } from "@/lib/types";
import { endReply, isFileList, isToolLine, NEW_REPLY, readReplyLine, shownText, type StreamedReply } from "./streamedReply";

const isReplyStatus = (value: unknown): value is ReplyStatus =>
  value === "reading" || value === "loading" || value === "thinking";

/**
 * A file of a message that is being sent: the browser's copy, and the id of
 * the draft the server stored when it was attached (see POST /api/uploads).
 */
export type SentFile = { id: string; file: File };

/** Cards for files that are still being sent, which show from the browser's copy. */
const localCards = (files: SentFile[]): FileCard[] =>
  files.map(({ file }, i) => ({
    id: `local-${i}`,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    url: URL.createObjectURL(file),
  }));

// A failed connection is a TypeError, with wording of each browser's own ("Failed to fetch", "Load failed", ...)
const SERVER_UNREACHABLE = "Could not reach the server. Check your connection and send your message again.";
const CONNECTION_LOST = "The connection was lost before the reply finished. Send your message again to retry.";

// crypto.randomUUID only exists on HTTPS and localhost, and the app is also used over plain HTTP
const newRequestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export function useChat({
  selection,
  ensureConversation,
  refreshConversations,
  setLiveCost,
}: {
  selection: string;
  ensureConversation: () => Promise<string>;
  refreshConversations: () => Promise<void>;
  // Shows what the conversation cost so far while the reply streams, until the list has it (null)
  setLiveCost: (live: { id: string; cost: number } | null) => void;
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // What the model is doing until its reply starts; null until the server says
  const [replyStatus, setReplyStatus] = useState<ReplyStatus | null>(null);
  // True once the reply's answer shows, and again false while the model uses a tool
  const [answering, setAnswering] = useState(false);
  // Goes up each time a tool call of a reply ends, so the sandbox panel loads again
  const [toolsDone, setToolsDone] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // The send that failed, if the last one did. Sending the same text (and
  // files) again retries it under its request id, so the server does not store it twice.
  const failedSendRef = useRef<{ content: string; files: string; requestId: string } | null>(null);

  // Patch the assistant reply that is being streamed (always the last message).
  const updateReply = useCallback((patch: Partial<DisplayMessage>) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role !== "assistant") return prev;
      // Nothing that shows changed, such as while text is held back
      if (Object.entries(patch).every(([key, value]) => last[key as keyof DisplayMessage] === value)) return prev;
      return [...prev.slice(0, -1), { ...last, ...patch }];
    });
  }, []);

  // Patch the user message of the reply that is being streamed (the one before it).
  const updateUserMessage = useCallback((patch: Partial<DisplayMessage>) => {
    setMessages((prev) => {
      const user = prev[prev.length - 2];
      if (user?.role !== "user") return prev;
      return [...prev.slice(0, -2), { ...user, ...patch }, prev[prev.length - 1]];
    });
  }, []);

  const send = useCallback(
    async (text: string, files: SentFile[] = []) => {
      const content = text.trim();
      if ((!content && !files.length) || isStreaming) return;

      const cards = localCards(files);
      setMessages((prev) => [
        ...prev,
        { role: "user", content, ...(cards.length ? { files: cards } : {}) },
        { role: "assistant", content: "" },
      ]);
      setIsStreaming(true);
      setReplyStatus(null);
      setAnswering(false);

      const controller = new AbortController();
      abortRef.current = controller;

      const failedSend = failedSendRef.current;
      const fileKey = files.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
      const requestId =
        failedSend?.content === content && failedSend.files === fileKey ? failedSend.requestId : newRequestId();
      failedSendRef.current = null;
      let failed = false;
      let connected = false;
      let reply: StreamedReply = NEW_REPLY;
      const show = () => {
        updateReply({
          content: shownText(reply),
          ...(reply.trace.length ? { trace: reply.trace } : {}),
          ...(reply.files.length ? { files: reply.files } : {}),
          ...(reply.error ? { error: reply.error } : {}),
        });
        setAnswering(reply.shown);
      };

      try {
        const conversationId = await ensureConversation();
        const { kind, value } = parseSelection(selection);

        // Only the new message: the server reads the rest of the conversation from the
        // database, and has the files already, as drafts
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: content,
            conversationId,
            requestId,
            ...(files.length ? { uploads: files.map((f) => f.id) } : {}),
            ...(kind === "agent" ? { agentId: value } : { model: selection }),
          }),
          signal: controller.signal,
        });
        connected = true;
        if (!res.ok || !res.body) {
          throw new Error((await res.text().catch(() => "")) || `Request failed (status ${res.status})`);
        }

        const mayCallTools = res.headers.get("X-Tools") === "1";
        await readNdjson(res.body, (obj) => {
          const line = obj as { status?: unknown; userFiles?: unknown; tool?: unknown; cost?: unknown };
          if (isReplyStatus(line?.status)) setReplyStatus(line.status);
          if (typeof line?.cost === "number") setLiveCost({ id: conversationId, cost: line.cost });
          // The stored copies of the files the user sent replace the browser's
          if (isFileList(line?.userFiles)) {
            for (const card of cards) if (card.url) URL.revokeObjectURL(card.url);
            updateUserMessage({ files: line.userFiles });
          }
          const next = readReplyLine(reply, obj, mayCallTools);
          if (next !== reply) {
            reply = next;
            show();
          }
          if (isToolLine(line?.tool) && (line.tool.state === "done" || line.tool.state === "error")) setToolsDone((n) => n + 1);
        });
        // Some browsers report a cut-off stream as a normal end
        if (!reply.ended) {
          failed = true;
          updateReply({ error: CONNECTION_LOST });
        }
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          failed = true;
          const connectionError = connected ? CONNECTION_LOST : SERVER_UNREACHABLE;
          updateReply({ error: err instanceof TypeError ? connectionError : (err as Error)?.message || "Stream error" });
        }
      } finally {
        // Ollama and the OpenAI-compatible providers report a failed chat as an { error } line
        if (failed || reply.error) failedSendRef.current = { content, files: fileKey, requestId };
        reply = endReply(reply);
        show();
        setIsStreaming(false);
        abortRef.current = null;
        // Also after a stop: the steps the model finished cost what they cost
        refreshConversations().then(() => setLiveCost(null));
      }
    },
    [isStreaming, selection, ensureConversation, refreshConversations, setLiveCost, updateReply, updateUserMessage]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback((msgs: DisplayMessage[]) => {
    setMessages(msgs);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  return { messages, isStreaming, replyStatus, answering, toolsDone, send, cancel, loadHistory, reset };
}
