// Tests of the frame route of HTML artifacts: it serves the page to frames,
// also over plain http, where browsers send no Sec-Fetch-Dest, and refuses a
// request that says it is not for a frame.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { addMessage, newConversation, newUser } from "@/test/db";
import { GET } from "./route";

let currentUser: { id: string } | null = null;
vi.mock("@/server/auth/session", () => ({ getCurrentUser: async () => currentUser }));

async function htmlFile(): Promise<string> {
  const userId = await newUser();
  currentUser = { id: userId };
  const conversationId = await newConversation(userId);
  const messageId = await addMessage(conversationId, { role: "tool", content: "", toolName: "create_file" });
  const data = Buffer.from("<!doctype html><p>chart</p>");
  const file = await prisma.messageAttachment.create({
    data: { messageId, name: "chart.html", mimeType: "text/html", data, size: data.length },
  });
  return file.id;
}

const get = (id: string, dest?: string) =>
  GET(new Request(`http://pi:3000/api/attachments/${id}/frame`, { headers: dest ? { "sec-fetch-dest": dest } : {} }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  currentUser = null;
});

describe("the frame of an HTML artifact", () => {
  it("serves a frame, also without Sec-Fetch-Dest, and refuses another destination", async () => {
    const id = await htmlFile();
    expect((await get(id, "iframe")).status).toBe(200);
    expect((await get(id, "document")).status).toBe(403);
    const plain = await get(id);
    expect(plain.status).toBe(200);
    // The page stops itself when it is not in a frame, before anything of it runs
    const html = await plain.text();
    expect(html.startsWith("<!doctype html><script>(()=>{if(window.top===window){")).toBe(true);
    expect(html).toContain("<plaintext hidden>");
    expect(html.endsWith("<p>chart</p>")).toBe(true);
  });

  it("serves only the user's own files", async () => {
    const id = await htmlFile();
    currentUser = { id: await newUser() };
    expect((await get(id, "iframe")).status).toBe(404);
    currentUser = null;
    expect((await get(id, "iframe")).status).toBe(401);
  });
});
