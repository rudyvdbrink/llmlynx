import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";
import { getCurrentUser } from "@/server/auth/session";
import { jsonError } from "@/server/http";
import { sandboxHistory } from "@/server/files/store";
import { MAX_SANDBOX_BYTES } from "@/lib/files";
import type { SandboxView } from "@/lib/sandbox";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/conversations/:id/sandbox -> SandboxView
// The chat's sandbox for the sandbox panel: its files with their versions,
// its runs of code and installs (newest first), and its installed packages.
// Only for the user who owns the chat.
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return jsonError("Unauthorized", 401);
  const owned = await prisma.conversation.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!owned) return jsonError("Not found", 404);

  const [history, runs, packages] = await Promise.all([
    sandboxHistory(id),
    prisma.sandboxRun.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, toolCallId: true, kind: true, language: true, status: true, durationMs: true, files: true, createdAt: true },
    }),
    prisma.sandboxPackage.findMany({
      where: { conversationId: id },
      orderBy: [{ ecosystem: "asc" }, { requested: "desc" }, { name: "asc" }],
    }),
  ]);
  const view: SandboxView = {
    files: history.map((versions) => ({
      path: versions[0].name,
      mimeType: versions[0].mimeType,
      versions: versions.map((v) => ({
        id: v.id,
        size: v.size,
        createdAt: v.createdAt.toISOString(),
        deleted: v.deleted,
        origin: v.origin,
      })),
    })),
    runs: runs.map((r) => ({
      ...r,
      kind: r.kind === "install" ? "install" : "run",
      files: (r.files as { changed: string[]; deleted: string[] } | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    packages: packages.map((p) => ({
      ecosystem: p.ecosystem,
      name: p.name,
      version: p.version,
      requested: p.requested,
      installedAt: p.installedAt.toISOString(),
    })),
    bytes: history.reduce((sum, versions) => sum + versions[0].size, 0),
    limit: MAX_SANDBOX_BYTES,
  };
  return NextResponse.json(view);
}
