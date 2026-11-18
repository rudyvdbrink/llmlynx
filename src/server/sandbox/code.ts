// The code container (tools/code): it runs code in a jail of its own per run,
// with a copy of the chat's files, installs packages per chat, and runs git on
// the chat's repositories. It keeps none of a chat's files between runs: each
// run sends them and gets back what changed; a repository's .git folder comes
// and goes the same way (SandboxRepo). A chat's packages are listed in the
// database (SandboxLock), so the container can install them again after it
// removed them.

import { prisma } from "@/server/db/prisma";
import { getToolServer } from "@/server/tools/config";
import { callMcpTool, type ToolFile } from "@/server/tools/mcp";

export const ECOSYSTEMS = ["pypi", "npm"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/** What a run did, as the code container reports it. `files` are the files it made or changed. */
export type RunOutcome = {
  status: "ok" | "error" | "timeout" | "stopped";
  exitCode: number | null;
  reason: "timeout" | "memory" | "processes" | "output" | null;
  output: string;
  printedBytes: number;
  durationMs: number;
  deleted: string[];
  skipped: { path: string; reason: string }[];
  reinstalled: string[];
  files: ToolFile[];
};

/** What an install did. A failed one installed nothing; `error` says why, for the model. */
export type InstallOutcome = {
  ok: boolean;
  error?: string;
  report: string;
  lock?: string;
  packages?: { name: string; version: string; requested: boolean }[];
  // What clamd found in the files the install downloaded: a file in the cache was scanned before
  scans: { file: string; hash: string; status: "clean" | "virus" | "unchecked"; signature?: string; ms: number }[];
  durationMs: number;
};

/** A chat's packages per ecosystem: what the model asked for, and exactly what that installed. */
export type ChatLocks = Partial<Record<Ecosystem, { requested: string[]; lock: string }>>;

// A run may wait for its turn behind runs of other chats (see CODE_MAX_CONCURRENCY)
export const RUN_TIMEOUT_MS = 300_000;
export const INSTALL_TIMEOUT_MS = 420_000;

export async function chatLocks(conversationId: string): Promise<ChatLocks> {
  const rows = await prisma.sandboxLock.findMany({ where: { conversationId } });
  const locks: ChatLocks = {};
  for (const row of rows) {
    if (row.ecosystem !== "pypi" && row.ecosystem !== "npm") continue;
    const requested = Array.isArray(row.requested) ? row.requested.filter((r): r is string => typeof r === "string") : [];
    locks[row.ecosystem] = { requested, lock: row.lock };
  }
  return locks;
}

// A call that fails sooner than this never reached the container (it is starting, or its
// proxy has not found its new address yet): it is tried once more, after RETRY_AFTER_MS
const FAST_FAILURE_MS = 3_000;
const RETRY_AFTER_MS = 3_000;

/** Calls `tool` on the code container, once more when the first call failed at once. */
async function callCode(tool: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number) {
  const started = Date.now();
  try {
    return await callMcpTool(getToolServer("code"), tool, args, { signal, timeoutMs });
  } catch (err) {
    if (signal.aborted || Date.now() - started > FAST_FAILURE_MS) throw err;
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    return callMcpTool(getToolServer("code"), tool, args, { signal, timeoutMs });
  }
}

/** An error the code container returned, without the prefix the MCP SDK adds ("Error executing tool x: ..."). */
const serverError = (text: string) => text.replace(/^error( executing tool [\w-]+)?:\s*/i, "").trim();

/**
 * Runs `code` in the chat's sandbox with its `files` (paths and contents), in its folder `cwd`.
 * Returns what the run did, or an error text for the model when the
 * container could not run it. Throws only when `signal` aborts.
 */
export async function runInSandbox({
  conversationId,
  language,
  code,
  cwd = "",
  files,
  locks,
  signal,
}: {
  conversationId: string;
  language: string;
  code: string;
  cwd?: string; // the folder of the sandbox it runs in; "" for the sandbox folder itself
  files: { path: string; data: Buffer }[];
  locks: ChatLocks;
  signal: AbortSignal;
}): Promise<RunOutcome | { error: string }> {
  try {
    const out = await callCode(
      "code_run",
      {
        chat: conversationId,
        language,
        code,
        ...(cwd ? { cwd } : {}),
        files: files.map((f) => ({ path: f.path, data: f.data.toString("base64") })),
        locks,
      },
      signal,
      RUN_TIMEOUT_MS
    );
    if (out.isError) return { error: serverError(out.text) || "the sandbox could not run the code." };
    const summary = JSON.parse(out.text) as {
      status: RunOutcome["status"];
      exit_code: number | null;
      reason: RunOutcome["reason"];
      output: string;
      printed_bytes: number;
      duration_ms: number;
      deleted: string[];
      skipped: RunOutcome["skipped"];
      reinstalled: string[];
    };
    return {
      status: summary.status,
      exitCode: summary.exit_code,
      reason: summary.reason,
      output: summary.output,
      printedBytes: summary.printed_bytes,
      durationMs: summary.duration_ms,
      deleted: summary.deleted ?? [],
      skipped: summary.skipped ?? [],
      reinstalled: summary.reinstalled ?? [],
      files: out.files,
    };
  } catch (err) {
    if (signal.aborted) throw err;
    console.error(`run_code failed: ${(err as Error)?.message || err}`);
    return { error: "the sandbox did not answer. It may be down; try again later." };
  }
}

/**
 * Installs the chat's packages of `ecosystem`: everything in `requested`
 * (what the chat asked for so far, resolved together). Throws only when
 * `signal` aborts; a container that does not answer gives a failed outcome.
 */
export async function installInSandbox({
  conversationId,
  ecosystem,
  requested,
  signal,
}: {
  conversationId: string;
  ecosystem: Ecosystem;
  requested: string[];
  signal: AbortSignal;
}): Promise<InstallOutcome> {
  const failed = (error: string): InstallOutcome => ({ ok: false, error, report: "", scans: [], durationMs: 0 });
  try {
    const out = await callCode("code_install", { chat: conversationId, ecosystem, requested }, signal, INSTALL_TIMEOUT_MS);
    if (out.isError) return failed(serverError(out.text) || "the packages could not be installed.");
    const answer = JSON.parse(out.text) as {
      ok: boolean;
      error?: string;
      report?: string;
      lock?: string;
      packages?: InstallOutcome["packages"];
      scans?: InstallOutcome["scans"];
      duration_ms?: number;
    };
    return {
      ok: answer.ok,
      ...(answer.error ? { error: answer.error } : {}),
      report: answer.report ?? "",
      ...(answer.lock !== undefined ? { lock: answer.lock } : {}),
      ...(answer.packages ? { packages: answer.packages } : {}),
      scans: answer.scans ?? [],
      durationMs: answer.duration_ms ?? 0,
    };
  } catch (err) {
    if (signal.aborted) throw err;
    console.error(`install_packages failed: ${(err as Error)?.message || err}`);
    return failed("the sandbox did not answer. It may be down; try again later.");
  }
}

/**
 * What a git command did, as the code container reports it. `files` are the
 * work tree's files it made or changed, by their path in the repository;
 * `git` is the repository's .git folder (a gzipped tar, base64) when it is
 * new or changed.
 */
export type GitOutcome = {
  status: "ok" | "error" | "timeout" | "stopped";
  exitCode: number | null;
  reason: RunOutcome["reason"];
  output: string;
  durationMs: number;
  deleted: string[];
  skipped: { path: string; reason: string }[];
  repo: "none" | "new" | "changed" | "same";
  files: ToolFile[];
  git: string | null;
};

// A download may take 3 minutes, and the command 2 more, after waiting for its turn
export const GIT_TIMEOUT_MS = 420_000;

// How the code container sends the .git folder (see tools/code/src/server.py)
const GIT_RESOURCE = "git:///repo.tar.gz";

/**
 * Runs the git command `argv` (without "git") on the repository in `folder`,
 * whose work tree is `files` (paths in the repository) and whose .git folder
 * is `git` (null for clone and init). Returns what it did, or an error text
 * for the model. Throws only when `signal` aborts.
 */
export async function gitInSandbox({
  conversationId,
  argv,
  folder,
  files,
  git,
  signal,
}: {
  conversationId: string;
  argv: string[];
  folder: string;
  files: { path: string; data: Buffer }[];
  git: Buffer | null;
  signal: AbortSignal;
}): Promise<GitOutcome | { error: string }> {
  try {
    const out = await callCode(
      "code_git",
      {
        chat: conversationId,
        argv,
        folder,
        files: files.map((f) => ({ path: f.path, data: f.data.toString("base64") })),
        git: git ? git.toString("base64") : null,
      },
      signal,
      GIT_TIMEOUT_MS
    );
    if (out.isError) return { error: serverError(out.text) || "git could not run." };
    const summary = JSON.parse(out.text) as {
      status: GitOutcome["status"];
      exit_code: number | null;
      reason: GitOutcome["reason"];
      output: string;
      duration_ms: number;
      deleted: string[];
      skipped: GitOutcome["skipped"];
      repo: GitOutcome["repo"];
    };
    return {
      status: summary.status,
      exitCode: summary.exit_code,
      reason: summary.reason,
      output: summary.output,
      durationMs: summary.duration_ms,
      deleted: summary.deleted ?? [],
      skipped: summary.skipped ?? [],
      repo: summary.repo,
      files: out.files.filter((f) => f.name !== GIT_RESOURCE),
      git: out.files.find((f) => f.name === GIT_RESOURCE)?.data ?? null,
    };
  } catch (err) {
    if (signal.aborted) throw err;
    console.error(`git failed: ${(err as Error)?.message || err}`);
    return { error: "the sandbox did not answer. It may be down; try again later." };
  }
}

/** Removes the packages the code container installed for these chats, once they are deleted. Never throws. */
export async function forgetPackages(conversationIds: string[]): Promise<void> {
  if (!conversationIds.length) return;
  try {
    await callMcpTool(getToolServer("code"), "code_forget", { chats: conversationIds }, {
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
    });
  } catch (err) {
    // They go after 30 days without use anyway
    console.error(`Removing the packages of deleted chats failed: ${(err as Error)?.message || err}`);
  }
}
