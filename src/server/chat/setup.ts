// Request setups: what a model is given besides the conversation, stored once
// per user and distinct contents (see the RequestSetup model).

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";

export type RequestSetupInput = {
  systemPrompt?: string;
  options?: unknown; // generation options, such as an agent's settings
  tools?: unknown; // tool definitions the model can call
};

// JSON with object keys sorted, so that equal setups always get the same hash
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const toJson = (value: unknown) => (value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

/** Returns the id of the user's setup with these contents, storing it first if there is none yet. */
export async function saveRequestSetup(
  tx: Prisma.TransactionClient,
  userId: string,
  setup: RequestSetupInput
): Promise<string> {
  const { systemPrompt = null, options = null, tools = null } = setup;
  const hash = createHash("sha256").update(canonicalJson({ systemPrompt, options, tools })).digest("hex");
  const { id } = await tx.requestSetup.upsert({
    where: { userId_hash: { userId, hash } },
    create: { userId, hash, systemPrompt, options: toJson(options), tools: toJson(tools) },
    update: {},
    select: { id: true },
  });
  return id;
}

/** Deletes the user's setups that no message uses anymore, such as after a conversation is deleted. */
export async function deleteUnusedSetups(userId: string) {
  await prisma.requestSetup.deleteMany({ where: { userId, messages: { none: {} } } });
}
