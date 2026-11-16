import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { getModelInfo } from "@/server/chat/models";
import { receiveUpload } from "@/server/files/uploads";
import { jsonError } from "@/server/http";
import { checkRateLimit } from "@/server/limits/rateLimit";
import { attachAccept } from "@/server/tools/policy";
import { cleanFileName, fileProblem } from "@/lib/files";
import { parseBaseModel } from "@/lib/selection";

export const runtime = "nodejs";

// POST /api/uploads
// body: multipart/form-data with the file in "file" and the chat's agent in "agentId"
// -> UploadOutcome (see server/files/uploads.ts)
// The composer sends each file as soon as it is attached. The file is checked
// here, while the user types: scanned for viruses and converted to text in
// parallel. The request stays open until that is done. A clean file is stored
// as a draft and answers with its id, which the message is then sent with; a
// file with a virus, or one that could not be checked, is not stored. Only
// agents take files, and the same kinds and sizes as /api/chat.
export async function POST(req: Request) {
  const user = await getCurrentUser().catch(() => null);
  if (!user) return jsonError("Unauthorized", 401);
  if (!checkRateLimit("uploads", user.id).allowed) {
    return jsonError("Too many files in the last few minutes. Try again later.", 429);
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const agentId = form?.get("agentId");
  if (!file || typeof file === "string") return jsonError("file required", 400);
  if (typeof agentId !== "string" || !agentId) return jsonError("Only agents take files.", 400);

  const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: user.id }, select: { baseModel: true } });
  const base = parseBaseModel(agent?.baseModel);
  if (!agent || !base) return jsonError("Agent not found", 404);
  const info = await getModelInfo(user.id, base.provider, base.model);
  const name = cleanFileName(file.name);
  const problem = fileProblem(attachAccept(info.capabilities), { name, size: file.size });
  if (problem) return jsonError(problem, 400);

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    return NextResponse.json(await receiveUpload({ userId: user.id, name, data, signal: req.signal }));
  } catch (err) {
    // The user removed the file again while it was checked
    if (req.signal.aborted) return new NextResponse(null, { status: 204 });
    console.error(`Checking ${name} failed: ${(err as Error)?.message || err}`);
    return jsonError("The file could not be checked; try again in a moment", 500);
  }
}
