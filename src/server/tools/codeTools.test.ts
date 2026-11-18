// Tests of the coding tools with stand-ins for the tool servers and scanners
// (src/test/fakes.ts): search_workspace, read_file by lines, versioned edits
// (edit_file and edit_files, also when a file changes between the tool and
// storing its result), undo of a changeset, run_code's header, folder and test
// results, and read_run_log.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/prisma";
import { createAssistantReply } from "@/server/chat/conversation";
import { lineDiff } from "@/server/files/diff";
import { pathMatcher } from "@/server/files/source";
import { contentVersion, conversationFiles, fileData, sandboxHistory } from "@/server/files/store";
import { applyTextEdits } from "@/server/files/textEdit";
import { readTestResults, describeTestResults } from "@/server/sandbox/testResults";
import { clipLines, workingFolder } from "@/server/sandbox/runCode";
import { createAuditLog } from "@/server/security/audit";
import { createSecurityContext } from "@/server/security/context";
import { WITHHELD_NOTICE, type SecuritySession } from "@/server/security/engine";
import { resetScanners } from "@/server/security/scan";
import { getToolDefinition, type Args, type ToolResult } from "@/server/tools/definitions";
import { toList } from "@/server/tools/args";
import { runTool } from "@/server/tools/run";
import { addMessage, newConversation, newUser } from "@/test/db";
import { fakes, INJECTION } from "@/test/fakes";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

type Chat = {
  conversationId: string;
  security: SecuritySession;
  /** Runs a tool and stores its result, as a reply does; `stored` is the text the model gets after storing. */
  call: (name: string, args: Args, budget?: number) => Promise<ToolResult & { stored: string; storedError: boolean }>;
  /** Runs a tool, then `meanwhile`, then stores its result. */
  callWith: (name: string, args: Args, meanwhile: () => Promise<void>) => Promise<{ text: string; error: boolean }>;
};

/** A chat whose user attached `files`. */
async function newChat(files: Record<string, string> = {}): Promise<Chat> {
  const userId = await newUser();
  const conversationId = await newConversation(userId);
  const messageId = await addMessage(conversationId, { role: "user", content: "Files" });
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    await prisma.messageAttachment.create({ data: { messageId, name, mimeType: "text/plain", data, size: data.length } });
  }
  const security: SecuritySession = { userId, context: createSecurityContext(), audit: createAuditLog(userId, conversationId) };
  const reply = createAssistantReply({ conversationId, userId, modelKey: "agent:test", model: "ollama:test", setup: {} });
  const store = async (name: string, args: Args, result: ToolResult) => {
    const step = { id: randomUUID(), name, arguments: args };
    const saved = await reply.saveToolResult({ ...result, call: step, content: result.text, label: "" });
    // As the tool loop does: a run whose output the model did not get is withheld
    if (result.run) await reply.saveSandboxRun(step.id, result.security ? { ...result.run, status: "withheld" } : result.run);
    return saved.failure ? { text: saved.failure.text, error: true } : { text: result.text, error: result.error };
  };
  const run = (name: string, args: Args, budget = 8000) =>
    runTool(getToolDefinition(name)!, args, { userId, textBudget: budget, conversationId, vision: false, security, signal: new AbortController().signal });
  return {
    conversationId,
    security,
    async call(name, args, budget) {
      const result = await run(name, args, budget);
      const stored = await store(name, args, result);
      return { ...result, stored: stored.text, storedError: stored.error };
    },
    async callWith(name, args, meanwhile) {
      const result = await run(name, args);
      await meanwhile();
      return store(name, args, result);
    },
  };
}

const read = async (chat: Chat, name: string) => {
  const file = (await conversationFiles(chat.conversationId)).find((f) => f.name === name);
  return file ? (await fileData(file.id)).toString() : null;
};
const versionOf = (text: string) => contentVersion(Buffer.from(text));
/** Changes a file as a run of code would, with a run that did nothing else. */
const change = async (chat: Chat, files: Record<string, string>) => {
  fakes.run = { changed: files };
  await chat.call("run_code", { language: "python", code: "x" });
};

const POLICY = [
  "import { TOOL_DEFINITIONS } from \"./definitions\";",
  "",
  "/** The tools a chat can call. */",
  "export function toolsFor(agent, capabilities) {",
  "  if (!agent) return [];",
  "  return TOOL_DEFINITIONS;",
  "}",
  "",
].join("\n");
const POLICY_TEST = ["import { toolsFor } from \"./policy\";", "", "it(\"gets tools\", () => {", "  expect(toolsFor(null, [])).toEqual([]);", "});", ""].join("\n");

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

describe("search_workspace", () => {
  it("finds files by glob, by part of a path, and goes on after its limit", async () => {
    const chat = await newChat({ "src/a.ts": "a", "src/b.test.ts": "b", "docs/c.md": "c", "README": "r" });
    const globbed = await chat.call("search_workspace", { mode: "paths", pattern: "src/**/*.ts" });
    expect(globbed.text).toBe("2 files match src/**/*.ts:\nsrc/a.ts\nsrc/b.test.ts");
    expect((await chat.call("search_workspace", { mode: "paths", pattern: "*.test.ts" })).text).toContain("src/b.test.ts");
    expect((await chat.call("search_workspace", { mode: "paths", pattern: "docs" })).text).toBe("1 file matches docs:\ndocs/c.md");
    expect((await chat.call("search_workspace", { mode: "paths", pattern: "*.py" })).text).toBe("No files match *.py.");
    const after = await chat.call("search_workspace", { mode: "paths", pattern: "**", after: "docs/c.md" });
    expect(after.text.split("\n").slice(1)).toEqual(["src/a.ts", "src/b.test.ts"]);
  });

  it("finds text with each file's path and version and each line's number, then read_file reads those lines", async () => {
    const chat = await newChat({ "src/server/tools/policy.ts": POLICY, "src/server/tools/policy.test.ts": POLICY_TEST, "notes.md": "toolsFor is documented" });
    // Shell-free navigation: find the definition, read it, then find its tests
    const found = await chat.call("search_workspace", { mode: "text", pattern: "function toolsFor" });
    expect(found.text).toBe(
      `1 match of "function toolsFor" in 1 file:\nsrc/server/tools/policy.ts (version ${versionOf(POLICY)})\n` +
        "  4| export function toolsFor(agent, capabilities) {\n[All 3 text files searched. Read around a match with read_file start_line.]"
    );
    const lines = await chat.call("read_file", { file: "src/server/tools/policy.ts", start_line: 3, end_line: 7 });
    expect(lines.text).toBe(
      `src/server/tools/policy.ts, version ${versionOf(POLICY)}, lines 3 to 7 of 7:\n` +
        "3| /** The tools a chat can call. */\n4| export function toolsFor(agent, capabilities) {\n5|   if (!agent) return [];\n" +
        "6|   return TOOL_DEFINITIONS;\n7| }"
    );
    const tests = await chat.call("search_workspace", { mode: "text", pattern: "toolsFor(", path: "**/*.test.ts" });
    expect(tests.text).toContain("src/server/tools/policy.test.ts");
    expect(tests.text).toContain("4|   expect(toolsFor(null, [])).toEqual([]);");
    expect(tests.text).not.toContain("notes.md");
  });

  it("sees a new untracked file, and no longer one that was deleted", async () => {
    const chat = await newChat({ "src/a.ts": "const x = 1;\n" });
    await change(chat, { "tests/new.test.ts": "it('marker_xyz', () => {});\n" });
    expect((await chat.call("search_workspace", { mode: "text", pattern: "marker_xyz" })).text).toContain("tests/new.test.ts");
    fakes.run = { deleted: ["tests/new.test.ts"] };
    await chat.call("run_code", { language: "python", code: "x" });
    expect((await chat.call("search_workspace", { mode: "text", pattern: "marker_xyz" })).text).toBe(
      'No matches of "marker_xyz" in the 1 text files searched.'
    );
  });

  it("stops at its limit and says where to go on, which is not the same as no matches", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `hit ${i + 1}`).join("\n");
    const chat = await newChat({ "a.txt": text, "b.txt": "hit b" });
    const first = await chat.call("search_workspace", { mode: "text", pattern: "hit" }, 1500);
    expect(first.text).toContain("10 matches");
    expect(first.text).toContain('[The search stopped at its limit (10 matches); there may be more. Continue with after="a.txt:10".]');
    const next = await chat.call("search_workspace", { mode: "text", pattern: "hit", after: "a.txt:10" }, 1500);
    expect(next.text).toContain("11| hit 11");
    expect(next.text).not.toContain(" 10| hit 10");
    expect((await chat.call("search_workspace", { mode: "text", pattern: "HIT B", ignore_case: true })).text).toContain("1| hit b");
  });

  it("keeps the place but withholds the text of a match in an untrusted file that looks like an injection", async () => {
    const chat = await newChat();
    await change(chat, { "evil.md": `line one\nnote: ${INJECTION}\n` });
    const result = await chat.call("search_workspace", { mode: "text", pattern: "note" });
    expect(result.text).toContain("evil.md (version");
    expect(result.text).toContain("lines 2 (their text is withheld: it looked like instructions aimed at the model)");
    expect(result.text).not.toContain(INJECTION);
    expect(chat.security.context.tainted).toBe(true);
  });

  it("refuses text over more than one line", async () => {
    const chat = await newChat({ "a.txt": "a" });
    expect((await chat.call("search_workspace", { mode: "text", pattern: "a\nb" })).error).toBe(true);
  });
});

describe("read_file by lines", () => {
  it("numbers lines, says where the next part starts, and refuses characters and lines together", async () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\r\n");
    const chat = await newChat({ "big.py": text });
    const part = await chat.call("read_file", { file: "big.py", start_line: 10 }, 1500);
    expect(part.text).toMatch(/^big\.py, version [0-9a-f]{8}, lines 10 to \d+ of 50:\n10\| line 10 x/);
    const next = Number(/start_line=(\d+) for the next part/.exec(part.text)?.[1]);
    expect(next).toBeGreaterThan(11);
    expect(part.text).not.toContain("\r");
    const both = await chat.call("read_file", { file: "big.py", start: 0, start_line: 1 });
    expect(both.text).toBe("Error: Give either start (characters) or start_line and end_line (lines), not both.");
    expect((await chat.call("read_file", { file: "big.py", start_line: 51 })).text).toBe("Error: big.py has only 50 lines.");
  });

  it("goes on in a line too long to show by characters, so that reading always moves on", async () => {
    const long = "y".repeat(5000);
    const chat = await newChat({ "min.js": `first\n${long}\nlast\n` });
    const part = await chat.call("read_file", { file: "min.js", start_line: 2 }, 1500);
    const at = Number(/start=(\d+) \(characters\)/.exec(part.text)?.[1]);
    expect(at).toBe(6 + 1497);
    expect(part.text).toContain("or go on with start_line=3");
    const rest = await chat.call("read_file", { file: "min.js", start: at }, 1500);
    expect(rest.text.startsWith("y")).toBe(true);
  });

  it("gives the version of a text file read by characters too", async () => {
    const chat = await newChat({ "a.md": "# Title\n" });
    expect((await chat.call("read_file", { file: "a.md" })).text).toBe(`# Title\n\n\n[a.md is version ${versionOf("# Title\n")}.]`);
  });
});

describe("edit_file with a version", () => {
  it("refuses an edit when the file changed since that version, and changes nothing", async () => {
    const chat = await newChat({ "src/a.py": "x = 1\n" });
    const old = versionOf("x = 1\n");
    await change(chat, { "src/a.py": "x = 2\n" });
    const result = await chat.call("edit_file", { file: "src/a.py", expected_version: old, edits: [{ find: "x", replace: "y" }] });
    expect(result.text).toBe(
      `Error: stale_version: src/a.py changed since you read it (you had version ${old}; it is now ${versionOf("x = 2\n")}). ` +
        "Nothing was changed. Read it again with read_file, then make the change on what is there now."
    );
    expect(fakes.edits).toBe(0);
    expect(await read(chat, "src/a.py")).toBe("x = 2\n");
  });

  it("takes only the exact path with a version, and gives the new version", async () => {
    const chat = await newChat({ "src/a.py": "x = 1\n" });
    const guessed = await chat.call("edit_file", { file: "a.py", expected_version: versionOf("x = 1\n"), edits: [{ find: "1", replace: "2" }] });
    expect(guessed.text).toBe("Error: There is no file at a.py. Files with that name: src/a.py.");
    const done = await chat.call("edit_file", { file: "src/a.py", expected_version: versionOf("x = 1\n"), edits: [{ find: "1", replace: "2" }] });
    expect(done.text).toContain(`Its version is ${versionOf("x = 2\n")}.`);
    expect(await read(chat, "src/a.py")).toBe("x = 2\n");
  });

  it("stores nothing when the file changes between the edit and storing it", async () => {
    const chat = await newChat({ "a.py": "x = 1\n" });
    const stored = await chat.callWith("edit_file", { file: "a.py", edits: [{ find: "1", replace: "2" }] }, () =>
      change(chat, { "a.py": "x = 3\n" })
    );
    expect(stored.error).toBe(true);
    expect(stored.text).toMatch(/^Error: stale_version: a\.py changed since you read it/);
    expect(await read(chat, "a.py")).toBe("x = 3\n");
  });
});

describe("edit_files", () => {
  const TYPES = "export type Size = number;\n";
  const USE = "import type { Size } from './types';\nexport const s: Size = 1;\n";

  it("changes several files together, with one changeset and a diff, and no file cards", async () => {
    const chat = await newChat({ "src/types.ts": TYPES, "src/use.ts": USE });
    const result = await chat.call("edit_files", {
      changes: [
        { file: "src/types.ts", expected_version: versionOf(TYPES), edits: [{ find: "Size", replace: "Bytes" }] },
        { file: "src/use.ts", expected_version: versionOf(USE), edits: [{ find: "Size", replace: "Bytes", all: true }] },
      ],
    });
    expect(result.error).toBe(false);
    const changeset = /changeset (cs-[0-9a-f]{8})/.exec(result.text)?.[1];
    expect(changeset).toBeTruthy();
    expect(result.text).toContain(`src/types.ts: version ${versionOf(TYPES)} -> ${versionOf("export type Bytes = number;\n")}, +1 -1 lines`);
    expect(result.text).toContain("-export type Size = number;\n+export type Bytes = number;");
    expect(await read(chat, "src/types.ts")).toBe("export type Bytes = number;\n");
    expect(await read(chat, "src/use.ts")).toBe("import type { Bytes } from './types';\nexport const s: Bytes = 1;\n");

    // One undo puts both back
    const undo = await chat.call("undo_file", { changeset });
    expect(undo.text).toMatch(new RegExp(`^Undone changeset ${changeset}: src/types\\.ts \\(version ${versionOf(TYPES)}\\), src/use\\.ts`));
    expect([await read(chat, "src/types.ts"), await read(chat, "src/use.ts")]).toEqual([TYPES, USE]);
    expect((await chat.call("undo_file", { changeset })).text).toBe(`Error: Changeset ${changeset} was undone already.`);
  });

  it("changes no file when one of them changed since its version, or one edit does not fit", async () => {
    const chat = await newChat({ "src/types.ts": TYPES, "src/use.ts": USE });
    await change(chat, { "src/use.ts": `${USE}// changed\n` });
    const stale = await chat.call("edit_files", {
      changes: [
        { file: "src/types.ts", expected_version: versionOf(TYPES), edits: [{ find: "Size", replace: "Bytes" }] },
        { file: "src/use.ts", expected_version: versionOf(USE), edits: [{ find: "Size", replace: "Bytes", all: true }] },
      ],
    });
    expect(stale.text).toMatch(/^Error: stale_version: src\/use\.ts changed since you read it/);
    const missing = await chat.call("edit_files", {
      changes: [
        { file: "src/types.ts", expected_version: versionOf(TYPES), edits: [{ find: "Size", replace: "Bytes" }] },
        { file: "src/use.ts", expected_version: versionOf(`${USE}// changed\n`), edits: [{ find: "Nope", replace: "x" }] },
      ],
    });
    expect(missing.text).toMatch(/^Error: Nothing was changed\.\n- src\/use\.ts: Edit 1: this text was not found: "Nope"/);
    expect(await read(chat, "src/types.ts")).toBe(TYPES);
    // Only the user's files and the one run: no partial write
    expect((await sandboxHistory(chat.conversationId)).map((v) => v.length)).toEqual([1, 2]);
  });

  it("stores neither file when one changes between the edit and storing it", async () => {
    const chat = await newChat({ "src/types.ts": TYPES, "src/use.ts": USE });
    const stored = await chat.callWith(
      "edit_files",
      {
        changes: [
          { file: "src/types.ts", expected_version: versionOf(TYPES), edits: [{ find: "Size", replace: "Bytes" }] },
          { file: "src/use.ts", expected_version: versionOf(USE), edits: [{ find: "Size", replace: "Bytes", all: true }] },
        ],
      },
      () => change(chat, { "src/use.ts": "// rewritten\n" })
    );
    expect(stored.text).toMatch(/^Error: stale_version: src\/use\.ts changed since you read it/);
    expect(await read(chat, "src/types.ts")).toBe(TYPES);
    expect(await read(chat, "src/use.ts")).toBe("// rewritten\n");
  });

  it("does not undo a changeset over a newer change", async () => {
    const chat = await newChat({ "a.ts": "a\n", "b.ts": "b\n" });
    const result = await chat.call("edit_files", {
      changes: [
        { file: "a.ts", expected_version: versionOf("a\n"), edits: [{ find: "a", replace: "A" }] },
        { file: "b.ts", expected_version: versionOf("b\n"), edits: [{ find: "b", replace: "B" }] },
      ],
    });
    const changeset = /changeset (cs-[0-9a-f]{8})/.exec(result.text)![1];
    await change(chat, { "b.ts": "B2\n" });
    const undo = await chat.call("undo_file", { changeset });
    expect(undo.text).toMatch(/^Error: Not undone: b\.ts changed after changeset/);
    expect([await read(chat, "a.ts"), await read(chat, "b.ts")]).toEqual(["A\n", "B2\n"]);
  });

  it("takes the list of changes as JSON text too, as small models send it", async () => {
    const chat = await newChat({ "a.ts": "a\n" });
    const changes = JSON.stringify([{ file: "a.ts", expected_version: versionOf("a\n"), edits: [{ find: "a", replace: "b" }] }]);
    expect((await chat.call("edit_files", { changes })).error).toBe(false);
    expect(await read(chat, "a.ts")).toBe("b\n");
  });

  it("keeps a byte order mark and Windows line ends, and refuses Office files", async () => {
    const chat = await newChat({ "w.txt": "﻿one\r\ntwo\r\n", "r.docx": "PK" });
    await chat.call("edit_files", {
      changes: [{ file: "w.txt", expected_version: versionOf("﻿one\r\ntwo\r\n"), edits: [{ find: "one\ntwo", replace: "1\n2" }] }],
    });
    expect(await read(chat, "w.txt")).toBe("﻿1\r\n2\r\n");
    const office = await chat.call("edit_files", {
      changes: [{ file: "r.docx", expected_version: versionOf("PK"), edits: [{ find: "P", replace: "Q" }] }],
    });
    expect(office.text).toContain("r.docx is not a UTF-8 text or code file: change it with edit_file.");
  });
});

describe("run_code for checks", () => {
  it("runs in a folder of the sandbox, spelled as the sandbox spells it, and refuses one that is not there", async () => {
    const chat = await newChat({ "App/src/main.py": "print(1)" });
    await chat.call("run_code", { language: "shell", code: "pytest", cwd: "app" });
    expect(fakes.runs[0].cwd).toBe("App");
    expect(workingFolder("./", [])).toEqual({ cwd: "" });
    const missing = await chat.call("run_code", { language: "shell", code: "pytest", cwd: "web" });
    expect(missing.text).toBe("Error: cwd must be a folder of the sandbox that holds files; web is not one. Its folders are: App.");
    expect(fakes.runs).toHaveLength(1);
  });

  it("leaves out the middle of long output by lines, which read_run_log reads back without running again", async () => {
    const chat = await newChat();
    const output = Array.from({ length: 400 }, (_, i) => (i === 200 ? "THE USEFUL DIAGNOSTIC" : `noise ${i + 1}`)).join("\n");
    fakes.run = { status: "error", exit_code: 1, output };
    const result = await chat.call("run_code", { language: "shell", code: "npm test" }, 1500);
    const id = /^run: (run-[0-9a-f]{12})$/m.exec(result.text)![1];
    expect(result.text).not.toContain("THE USEFUL DIAGNOSTIC");
    const left = /lines (\d+) to (\d+) are left out here: read them, or find text in them, with read_run_log/.exec(result.text)!;
    expect(Number(left[1])).toBeLessThan(201);
    expect(result.text).toContain(`[... lines ${left[1]} to ${left[2]} left out ...]`);

    const found = await chat.call("read_run_log", { run: id, find: "USEFUL" });
    expect(found.text).toContain("201| THE USEFUL DIAGNOSTIC");
    const page = await chat.call("read_run_log", { run: id, start_line: 199, end_line: 202 });
    expect(page.text).toBe(`Run ${id}, lines 199 to 202 of 400:\n199| noise 199\n200| noise 200\n201| THE USEFUL DIAGNOSTIC\n202| noise 202`);
    expect(fakes.runs).toHaveLength(1);
  });

  it("says when output past the limit was never kept, and that a stopped run has no test results", async () => {
    const chat = await newChat();
    fakes.run = { status: "stopped", exit_code: -9, reason: "output", output: "============================= test session starts ==\nx\n", printed_bytes: 3 * 1024 * 1024 };
    const result = await chat.call("run_code", { language: "shell", code: "pytest" });
    expect(result.text).toContain("exit code: none (stopped)\nstopped: yes, at 1 MB of output (the limit)");
    expect(result.text).toContain("it printed 3.0 MB, but only the first 1 MB was kept: the rest is lost");
    const id = /^run: (run-[0-9a-f]{12})$/m.exec(result.text)![1];
    expect((await chat.call("read_run_log", { run: id })).text).toContain("what came after the first 1 MB was never kept and cannot be read");
  });

  it("keeps a withheld run's output withheld, and withholds a log a read part of which is flagged", async () => {
    const chat = await newChat();
    fakes.run = { output: `fine\n${INJECTION}\n` };
    const withheld = await chat.call("run_code", { language: "python", code: "x" });
    expect(withheld.text).toBe(WITHHELD_NOTICE);
    const runs = await prisma.sandboxRun.findMany({ where: { conversationId: chat.conversationId } });
    expect(runs[0].status).toBe("withheld");
    expect((await chat.call("read_run_log", { run: runs[0].id })).text).toMatch(/^Error: The output of this run was withheld/);

    // Output whose middle was never shown, and is flagged when it is read
    const output = Array.from({ length: 300 }, (_, i) => (i === 150 ? INJECTION : `noise ${i}`)).join("\n");
    fakes.guard = "up";
    const run = { id: `run-${randomUUID().slice(0, 12)}`, conversationId: chat.conversationId, toolCallId: "c", kind: "run", language: "shell", code: "x", output, status: "ok", durationMs: 1 };
    await prisma.sandboxRun.create({ data: run });
    const flagged = await chat.call("read_run_log", { run: run.id, start_line: 140, end_line: 160 });
    expect(flagged.text).toBe(WITHHELD_NOTICE);
    expect((await chat.call("read_run_log", { run: run.id, start_line: 1, end_line: 5 })).text).toMatch(/^Error: The output of this run was withheld/);
  });

  it("lists failing pytest tests apart from errors, with the line each one points to", async () => {
    const chat = await newChat({ "tests/test_a.py": "def test_add(): assert 1 + 1 == 3\n", "tests/test_b.py": "import missing\n" });
    const output = [
      "============================= test session starts ==============================",
      "collected 2 items / 1 error",
      "",
      "==================================== ERRORS ====================================",
      "_______________________ ERROR collecting tests/test_b.py ________________________",
      "tests/test_b.py:1: in <module>",
      "    import missing",
      "E   ModuleNotFoundError: No module named 'missing'",
      "=================================== FAILURES ===================================",
      "___________________________________ test_add ___________________________________",
      "",
      "    def test_add(): assert 1 + 1 == 3",
      "E   assert (1 + 1) == 3",
      "",
      "tests/test_a.py:1: AssertionError",
      "=========================== short test summary info ============================",
      "FAILED tests/test_a.py::test_add - assert (1 + 1) == 3",
      "ERROR tests/test_b.py - ModuleNotFoundError: No module named 'missing'",
      "==================== 1 failed, 2 passed, 1 error in 0.12s =====================",
    ].join("\n");
    fakes.run = { status: "error", exit_code: 1, output };
    const result = await chat.call("run_code", { language: "shell", code: "pytest" });
    expect(result.text).toContain(
      [
        "Tests (pytest): 1 failed, 1 error, 2 passed.",
        "- failed: tests/test_a.py::test_add, at tests/test_a.py:1: assert (1 + 1) == 3",
        "- error (not a failed assertion: setup, collection or import): tests/test_b.py, at tests/test_b.py:1: ModuleNotFoundError: No module named 'missing'",
        "A module is missing: install it with install_packages if it is a package, then run the tests again.",
      ].join("\n")
    );
  });
});

describe("reading test reports", () => {
  const exists = (path: string) => ["app/src/sum.test.ts", "app/tests/test_x.py"].includes(path);

  it("reads a JUnit XML report, failures apart from errors", () => {
    const xml =
      '<?xml version="1.0"?><testsuites><testsuite name="s">' +
      '<testcase classname="tests.test_x" name="test_ok"/>' +
      '<testcase classname="tests.test_x" name="test_bad"><failure message="assert 1 == 2">tests/test_x.py:7: AssertionError</failure></testcase>' +
      '<testcase classname="tests.test_x" name="test_setup"><error message="fixture &apos;db&apos; not found">E fixture</error></testcase>' +
      '<testcase classname="tests.test_x" name="test_skip"><skipped/></testcase>' +
      "</testsuite></testsuites>";
    const report = readTestResults("", [{ name: "app/report.xml", data: Buffer.from(xml) }], exists, "app");
    expect(describeTestResults(report!)).toBe(
      [
        "Tests (JUnit report): 1 failed, 1 error, 1 passed, 1 skipped.",
        "- failed: tests.test_x::test_bad, at app/tests/test_x.py:7: assert 1 == 2",
        "- error (not a failed assertion: setup, collection or import): tests.test_x::test_setup: fixture 'db' not found",
      ].join("\n")
    );
  });

  it("reads a Jest or Vitest JSON report, and says when one cannot be read", () => {
    const json = {
      numFailedTests: 1,
      testResults: [
        {
          name: "/sandbox/app/src/sum.test.ts",
          status: "failed",
          assertionResults: [
            { fullName: "sum adds", status: "failed", failureMessages: ["AssertionError: expected 3 to be 4\n    at /sandbox/app/src/sum.test.ts:5:17"] },
            { fullName: "sum zero", status: "passed" },
          ],
        },
      ],
    };
    const report = readTestResults("", [{ name: "app/r.json", data: Buffer.from(JSON.stringify(json)) }], exists, "app");
    expect(describeTestResults(report!)).toContain("- failed: app/src/sum.test.ts > sum adds, at app/src/sum.test.ts:5: AssertionError: expected 3 to be 4");
    const broken = readTestResults("", [{ name: "r.json", data: Buffer.from('{"testResults": [, "numFailedTests"') }], exists, "");
    expect(describeTestResults(broken!)).toBe("Tests (Jest/Vitest report): the results could not be read: r.json is not valid JSON. See the output.");
    expect(readTestResults("plain output", [], exists, "")).toBeNull();
  });

  it("reads pytest -q output, which has no header and a bare last line", () => {
    const output = [
      "F.                                                                       [100%]",
      "=================================== FAILURES ===================================",
      "________________________________ test_checksum _________________________________",
      "",
      "    def test_checksum():",
      ">       assert got - 1 == 42",
      "E       assert (41 - 1) == 42",
      "",
      "tests/test_x.py:10: AssertionError",
      "=========================== short test summary info ============================",
      "FAILED tests/test_x.py::test_checksum - assert (41 - 1) == 42",
      "1 failed, 1 passed in 0.05s",
    ].join("\n");
    expect(describeTestResults(readTestResults(output, [], exists, "app")!)).toBe(
      "Tests (pytest): 1 failed, 1 passed.\n- failed: tests/test_x.py::test_checksum, at app/tests/test_x.py:10: assert (41 - 1) == 42"
    );
  });
});

describe("what models send", () => {
  it("takes a list as a list, as JSON text, as JSON text without its last bracket, or as one object", () => {
    const edit = { find: "a", replace: "b" };
    expect(toList([edit])).toEqual([edit]);
    expect(toList(JSON.stringify([edit]))).toEqual([edit]);
    expect(toList(JSON.stringify([edit]).slice(0, -1))).toEqual([edit]);
    expect(toList(edit)).toEqual([edit]);
    expect(toList(JSON.stringify(edit))).toEqual([edit]);
    expect(toList(undefined)).toBeUndefined();
    expect(toList("find a, replace b")).toBeNull();
    expect(toList(42)).toBeNull();
  });

  it("edits with edits as JSON text, and says what is wrong with edits it cannot use", async () => {
    const chat = await newChat({ "a.py": "x = 1\n" });
    const text = await chat.call("edit_file", { file: "a.py", edits: '[{"find": "1", "replace": "2"}' });
    expect(text.error).toBe(false);
    expect(await read(chat, "a.py")).toBe("x = 2\n");
    expect((await chat.call("edit_file", { file: "a.py", edits: "replace 2 with 3" })).text).toBe(
      'Error: edits must be a list, such as [{"find": "old text", "replace": "new text"}]; you sent text that is not a JSON list.'
    );
    expect((await chat.call("edit_file", { file: "a.py", edits: [{ search: "2", replace: "3" }] })).text).toBe(
      "Error: Edit 1 needs find (the exact text to replace, not empty) and replace (the new text); it has search, replace."
    );
  });

  it("does not run code that is only comments, and runs a command line sent as Python as a command", async () => {
    const chat = await newChat({ "train.py": "print('trained')" });
    const comments = await chat.call("run_code", { language: "python", code: "# Run the script\n\n# later" });
    expect(comments.text).toMatch(/^Error: not run: the code has only comments, so nothing would run\. To run a file of the sandbox, use language shell/);
    expect(fakes.runs).toHaveLength(0);

    const command = await chat.call("run_code", { language: "python", code: "python train.py" });
    expect(fakes.runs[0].language).toBe("shell");
    expect(command.text).toContain("It is a command line, so it ran as one: next time, use language shell for it.");
    expect((await chat.call("run_code", { language: "python", code: "python = 3\nprint(python)" })).error).toBe(false);
    expect(fakes.runs[1].language).toBe("python");

    const imports = await chat.call("run_code", { language: "python", code: "import sys  # nothing else\n# Run the script" });
    expect(imports.text).toContain("The code only imports modules, so nothing else ran.");
  });

  it("runs code without a language as Python, or as a command when it is one", async () => {
    const chat = await newChat();
    const python = await chat.call("run_code", { code: "print(1)" });
    expect([fakes.runs[0].language, python.text.includes("language was not given, so it ran as python.")]).toEqual(["python", true]);
    await chat.call("run_code", { code: "pytest -q" });
    expect(fakes.runs[1].language).toBe("shell");
    expect((await chat.call("run_code", { language: "rust", code: "fn main() {}" })).text).toMatch(/\(python if unsure; shell for a command line/);
  });

  it("takes packages as JSON text, and does not show pip's dry run as if nothing was installed", async () => {
    const chat = await newChat();
    fakes.install = {
      ok: true,
      report: "Would install tabulate-0.9.0\nCollecting tabulate",
      lock: "tabulate==0.9.0",
      packages: [{ name: "tabulate", version: "0.9.0", requested: true }],
      scans: [],
    };
    const result = await chat.call("install_packages", { registry: "pypi", packages: '["tabulate"]' });
    expect(fakes.installs[0].requested).toEqual(["tabulate"]);
    expect(result.text).not.toContain("Would install");
    expect(result.text).toContain("What pip reported:\nCollecting tabulate");
  });
});

describe("the helpers", () => {
  it("matches paths by glob, by file name, and by part of a path", () => {
    const m = (pattern: string, path: string) => pathMatcher(pattern)!(path);
    expect(m("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(m("src/**/*.ts", "src/c.ts")).toBe(true);
    expect(m("src/*.ts", "src/a/c.ts")).toBe(false);
    expect(m("*.{ts,tsx}", "deep/x.tsx")).toBe(true);
    expect(m("server/", "src/server/x.ts")).toBe(true);
    expect(m("tests", "app/tests/x.py")).toBe(true);
  });

  it("makes text edits by the rules of edit_file, naming the lines of a text that occurs more than once", () => {
    expect(applyTextEdits("a\nb\na\n", [{ find: "a", replace: "c", all: false }])).toEqual({
      error: 'Edit 1: this text occurs 2 times: "a". Where:\n- line 1: a\n- line 3: a\nGive more of the text around the one to change, or set all to true to replace every occurrence.',
    });
    expect(applyTextEdits("a\nb\na\n", [{ find: "a", replace: "$&c", all: true }])).toEqual({ text: "$&c\nb\n$&c\n" });
  });

  it("diffs lines into hunks with context", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
    const b = ["1", "two", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
    expect(lineDiff(a, b)).toEqual({
      added: 2,
      removed: 1,
      hunks: ["@@ -1,4 +1,4 @@\n 1\n-2\n+two\n 3\n 4", "@@ -9,2 +9,3 @@\n 9\n 10\n+11"],
    });
  });

  it("clips output by whole lines", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const clipped = clipLines(text, 200);
    expect(clipped.left).toEqual({ from: 12, to: 86 });
    expect(clipped.text).toContain("line 11\n[... lines 12 to 86 left out ...]\nline 87");
  });
});
