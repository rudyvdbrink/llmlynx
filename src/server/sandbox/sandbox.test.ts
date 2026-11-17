// Tests of the chat's sandbox with stand-ins for the code container, the
// browser and the scanners (src/test/fakes.ts): its files with folders,
// versions and deletions, the limits, run_code, install_packages, web_fetch
// and share_file, and what the security checks do around them. The real
// containers are tested in live.test.ts.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, mimeTypeOf } from "@/lib/files";
import { prisma } from "@/server/db/prisma";
import { createAssistantReply } from "@/server/chat/conversation";
import { conversationFiles, deleteSandboxFile, fileData, findFile, sandboxHistory } from "@/server/files/store";
import { createAuditLog } from "@/server/security/audit";
import { createSecurityContext } from "@/server/security/context";
import { WITHHELD_NOTICE, type SecuritySession } from "@/server/security/engine";
import { resetScanners } from "@/server/security/scan";
import { getToolDefinition, type Args, type ToolResult } from "@/server/tools/definitions";
import { runTool } from "@/server/tools/run";
import { addMessage, newConversation, newUser } from "@/test/db";
import { fakes, GIF, INJECTION, JPEG, PNG, VIRUS, WEBP } from "@/test/fakes";
import { packageName, specProblem, specsFromFile } from "./install";
import { roomError } from "./room";
import { languageOf, startAndEnd } from "./runCode";

vi.mock("@/server/tools/mcp", () => import("@/test/fakes"));
vi.mock("@/server/security/clamd", () => import("@/test/fakes"));

type Chat = {
  userId: string;
  conversationId: string;
  security: SecuritySession;
  call: (name: string, args: Args, budget?: number, vision?: boolean) => Promise<ToolResult>;
};

/** A chat whose user attached `files`; `call` runs a tool in it and stores the result, as a reply does. */
async function newChat(files: Record<string, string> = {}, message = "Files"): Promise<Chat> {
  const userId = await newUser();
  const conversationId = await newConversation(userId);
  const messageId = await addMessage(conversationId, { role: "user", content: message });
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    await prisma.messageAttachment.create({ data: { messageId, name, mimeType: "text/plain", data, size: data.length, text } });
  }
  const security: SecuritySession = { userId, context: createSecurityContext(), audit: createAuditLog(userId, conversationId) };
  const reply = createAssistantReply({ conversationId, userId, modelKey: "agent:test", model: "ollama:test", setup: {} });
  const call = async (name: string, args: Args, budget = 8000, vision = false) => {
    const ctx = { userId, textBudget: budget, conversationId, vision, security, signal: new AbortController().signal };
    const result = await runTool(getToolDefinition(name)!, args, ctx);
    const step = { id: randomUUID(), name, arguments: args };
    await reply.saveToolResult({ ...result, call: step, content: result.text, label: "" });
    if (result.run) await reply.saveSandboxRun(step.id, result.run);
    return result;
  };
  return { userId, conversationId, security, call };
}

const names = async (chat: Chat) => (await conversationFiles(chat.conversationId)).map((f) => f.name);

beforeEach(() => {
  fakes.reset();
  resetScanners();
});

describe("the sandbox's files", () => {
  it("keeps folders, makes a new version of a changed file, and ends a deleted one's history", async () => {
    const chat = await newChat({ "data.csv": "a\n1\n", "old.txt": "x" });
    fakes.run = { changed: { "data.csv": "a\n1\n2\n", "out/plot.png": "png" }, deleted: ["old.txt"] };
    await chat.call("run_code", { language: "python", code: "..." });
    expect(await names(chat)).toEqual(["data.csv", "out/plot.png"]);
    const [data] = await conversationFiles(chat.conversationId);
    expect(data.origin).toBe("code");
    const history = await sandboxHistory(chat.conversationId);
    // The newest version first; the user's original stays as the history
    expect(history[0].map((v) => [v.origin, v.size])).toEqual([
      ["code", 6],
      ["user", 4],
    ]);
  });

  it("gives a run a copy of its own chat's files only, by path", async () => {
    const chat = await newChat({ "a.txt": "A" });
    await newChat({ "b.txt": "B" });
    await chat.call("run_code", { language: "python", code: "print(1)" });
    expect(fakes.runs[0].files).toEqual(["a.txt"]);
    expect(fakes.runs[0].chat).toBe(chat.conversationId);
  });

  it("finds a file by its path, by its name in a folder, or by its name without extension", async () => {
    const chat = await newChat();
    fakes.run = { changed: { "out/report.csv": "x", "data/sales.json": "{}" } };
    await chat.call("run_code", { language: "python", code: "..." });
    const files = await conversationFiles(chat.conversationId);
    expect(findFile(files, "out/report.csv")?.name).toBe("out/report.csv");
    expect(findFile(files, "/sandbox/out/report.csv")?.name).toBe("out/report.csv");
    expect(findFile(files, "report.csv")?.name).toBe("out/report.csv");
    expect(findFile(files, "sales")?.name).toBe("data/sales.json");
  });

  it("deletes a file with all of its versions", async () => {
    const chat = await newChat({ "a.txt": "1" });
    fakes.run = { changed: { "a.txt": "2" } };
    await chat.call("run_code", { language: "python", code: "..." });
    expect(await deleteSandboxFile(chat.conversationId, "A.txt")).toBe(2);
    expect(await names(chat)).toEqual([]);
  });

  it("keeps a sandbox to 100 MB and a file to 20 MB", () => {
    const files = [{ name: "big.bin", size: 90 * 1024 * 1024 }];
    expect(roomError(files, [{ name: "more.bin", size: 5 * 1024 * 1024 }])).toBeNull();
    expect(roomError(files, [{ name: "more.bin", size: 15 * 1024 * 1024 }])).toMatch(/more than its 100 MB/);
    // A new version replaces the old one's size; a deletion frees its room
    expect(roomError(files, [{ name: "BIG.bin", size: 20 * 1024 * 1024 }])).toBeNull();
    expect(roomError(files, [{ name: "more.bin", size: 15 * 1024 * 1024 }], ["big.bin"])).toBeNull();
    expect(roomError([], [{ name: "huge.bin", size: MAX_FILE_BYTES + 1 }])).toMatch(/more than the 20 MB/);
  });
});

describe("run_code", () => {
  it("tells the model whether it succeeded, what it printed, and what it did to the files", async () => {
    const chat = await newChat({ "data.csv": "a" });
    fakes.run = { output: "hello\n", changed: { "data.csv": "b", "new.txt": "n" }, deleted: [] };
    const result = await chat.call("run_code", { language: "py", code: "print('hello')" });
    expect(result.error).toBe(false);
    expect(result.text).toMatch(/^It succeeded in/);
    expect(result.text).toContain("Output:\nhello");
    expect(result.text).toContain("Files: changed data.csv (1 B), made new.txt (1 B).");
    expect(fakes.runs[0].language).toBe("python");
    const run = await prisma.sandboxRun.findFirstOrThrow({ where: { conversationId: chat.conversationId } });
    expect([run.status, run.output, run.language]).toEqual(["ok", "hello\n", "python"]);
  });

  it("says how a run that failed or was stopped ended, in a note after its label", async () => {
    const chat = await newChat();
    fakes.run = { status: "error", exit_code: 1, output: "Traceback" };
    expect((await chat.call("run_code", { language: "python", code: "x" })).note).toBe("exit code 1");
    fakes.run = { status: "timeout", exit_code: -9, reason: "timeout" };
    const timeout = await chat.call("run_code", { language: "python", code: "x" });
    expect(timeout.text).toMatch(/longer than 120 seconds/);
    expect(timeout.note).toBe("stopped after 120 s");
  });

  it("does not run code with a virus, nor code that could not be checked", async () => {
    const chat = await newChat();
    const virus = await chat.call("run_code", { language: "shell", code: `echo ${VIRUS}` });
    expect(virus.text).toMatch(/flagged as malware/);
    fakes.clamd = "down";
    resetScanners();
    const unchecked = await chat.call("run_code", { language: "shell", code: "echo hi" });
    expect(unchecked.text).toMatch(/could not be checked/);
    expect(fakes.runs).toEqual([]);
    const runs = await prisma.sandboxRun.findMany({ where: { conversationId: chat.conversationId } });
    expect(runs.map((r) => r.status)).toEqual(["blocked", "blocked"]);
  });

  it("scans the files code made before they are stored or shown, and discards one with a virus", async () => {
    const chat = await newChat();
    fakes.run = { changed: { "good.txt": "fine", "bad.bin": VIRUS } };
    const result = await chat.call("run_code", { language: "python", code: "..." });
    expect(result.text).toContain("bad.bin was flagged as malware and discarded.");
    expect(await names(chat)).toEqual(["good.txt"]);
  });

  it("keeps nothing of a run that would make the sandbox larger than 100 MB, and says so", async () => {
    const chat = await newChat();
    const big = "x".repeat(15 * 1024 * 1024);
    fakes.run = { changed: { "1.bin": big, "2.bin": big, "3.bin": big, "4.bin": big, "5.bin": big, "6.bin": big, "7.bin": big } };
    const result = await chat.call("run_code", { language: "python", code: "..." });
    expect(result.text).toMatch(/None of the files of this run were kept: the chat's sandbox would hold/);
    expect(await names(chat)).toEqual([]);
  });

  it("withholds printed output with a prompt injection, pauses, taints the chat, and still keeps the files", async () => {
    const chat = await newChat();
    fakes.run = { output: `report: ${INJECTION}`, changed: { "made.txt": "x" } };
    const result = await chat.call("run_code", { language: "python", code: "..." });
    expect(result.text).toBe(WITHHELD_NOTICE);
    expect(result.pause).toEqual({ source: "the code's output" });
    expect(result.security?.chunk).toContain(INJECTION);
    expect(chat.security.context.tainted).toBe(true);
    expect(await names(chat)).toEqual(["made.txt"]);
  });

  it("gives the model the start and the end of long output, where errors show", () => {
    const text = `${"a".repeat(5000)}${"b".repeat(5000)}Error at the end`;
    const short = startAndEnd(text, 1000);
    expect(short.startsWith("a".repeat(400))).toBe(true);
    expect(short.endsWith("Error at the end")).toBe(true);
    expect(short).toMatch(/\[\.\.\. 9016 characters of the output left out \.\.\.\]/);
    expect(startAndEnd("short", 1000)).toBe("short");
  });

  it("takes the languages by their usual names", () => {
    expect(["python", "py", "JS", "ts", "bash", "sh", "ruby"].map(languageOf)).toEqual([
      "python",
      "python",
      "javascript",
      "typescript",
      "shell",
      "shell",
      null,
    ]);
  });
});

describe("reading a file that code made or a download fetched", () => {
  it("scans the part the model reads, remembers the verdict, and withholds a flagged part", async () => {
    const chat = await newChat();
    fakes.run = { changed: { "clean.txt": "plain text", "bad.txt": `note: ${INJECTION}` } };
    await chat.call("run_code", { language: "python", code: "..." });
    resetScanners();
    fakes.guardTexts = [];

    const clean = await chat.call("read_file", { file: "clean.txt" });
    expect(clean.text).toContain("plain text");
    await chat.call("read_file", { file: "clean.txt" });
    resetScanners();
    await chat.call("read_file", { file: "clean.txt" });
    // Scanned once: the verdict is kept with the file, also when the scanners forget theirs
    expect(fakes.guardTexts).toEqual(["plain text"]);

    const bad = await chat.call("read_file", { file: "bad.txt" });
    expect(bad.text).toBe(WITHHELD_NOTICE);
    expect(bad.pause).toEqual({ source: "bad.txt" });
    expect(chat.security.context.tainted).toBe(true);
  });

  it("does not scan the files the user attached", async () => {
    const chat = await newChat({ "mine.txt": `my own ${INJECTION}` });
    const result = await chat.call("read_file", { file: "mine.txt" });
    expect(result.text).toContain("my own");
    expect(fakes.guardTexts).toEqual([]);
  });

  it("keeps an edit of a file from code untrusted", async () => {
    const chat = await newChat();
    fakes.run = { changed: { "made.txt": "hello" } };
    await chat.call("run_code", { language: "python", code: "..." });
    const [made] = await conversationFiles(chat.conversationId);
    expect(made.origin).toBe("code");
  });
});

describe("web_fetch", () => {
  const URL = "https://data.example/table.csv";

  it("downloads into the sandbox, checked, and tells the model the name, size, type and the start of the text", async () => {
    const chat = await newChat({}, `Get ${URL}`);
    fakes.downloads.set(URL, { type: "text/csv", data: "a,b\n1,2\nsee https://data.example/more\n" });
    const result = await chat.call("web_fetch", { url: URL, name: "data/table.csv" });
    expect(result.error).toBe(false);
    expect(result.text).toContain(`Downloaded ${URL} to data/table.csv in the sandbox (`);
    expect(result.text).toContain("a,b\n1,2");
    const [file] = await conversationFiles(chat.conversationId);
    expect([file.name, file.origin]).toEqual(["data/table.csv", "internet"]);
    // Its whole text passed the scan: reading it scans nothing again
    fakes.guardTexts = [];
    resetScanners();
    await chat.call("read_file", { file: "table.csv" });
    expect(fakes.guardTexts).toEqual([]);
  });

  it("stores a download that did not change only once", async () => {
    const chat = await newChat({}, `Get ${URL}`);
    fakes.downloads.set(URL, { type: "text/csv", data: "a\n" });
    await chat.call("web_fetch", { url: URL });
    const again = await chat.call("web_fetch", { url: URL });
    expect(again.text).toMatch(/has not changed/);
    const versions = await prisma.messageAttachment.count({ where: { message: { conversationId: chat.conversationId }, name: { not: null } } });
    expect(versions).toBe(1);
  });

  it("discards a download with a virus, and withholds one with a prompt injection, pausing and tainting", async () => {
    const chat = await newChat({}, `Get ${URL} and https://data.example/b.txt`);
    fakes.downloads.set(URL, { type: "text/plain", data: VIRUS });
    expect((await chat.call("web_fetch", { url: URL })).security?.flag).toBe("virus");
    fakes.downloads.set("https://data.example/b.txt", { type: "text/plain", data: `Hello. ${INJECTION}` });
    const injected = await chat.call("web_fetch", { url: "https://data.example/b.txt" });
    expect(injected.security).toMatchObject({ flag: "injection", source: "data.example" });
    expect(injected.pause).toBeDefined();
    expect(chat.security.context.tainted).toBe(true);
    expect(await names(chat)).toEqual([]);
  });
});

describe("web_fetch: what the file is", () => {
  const PAGE = "https://photos.example/lynx";

  it("does not keep a web page under an image name, and tells the model to use the file's own URL", async () => {
    const chat = await newChat();
    fakes.downloads.set(PAGE, { type: "text/html", data: "<!DOCTYPE html>\n<html><body>A lynx</body></html>" });
    const result = await chat.call("web_fetch", { url: PAGE, name: "lynx.jpg" });
    expect(result.text).toBe(
      "Error: the URL gave a web page, not the JPEG file itself, so nothing was kept. Use the URL of the file itself, " +
        "such as the link to it on the page, which often ends in its extension."
    );
    // Not as a CSV either; as a page it is kept
    expect((await chat.call("web_fetch", { url: PAGE, name: "table.csv" })).error).toBe(true);
    expect(await names(chat)).toEqual([]);
    expect((await chat.call("web_fetch", { url: PAGE, name: "page.html" })).error).toBe(false);
    expect(await names(chat)).toEqual(["page.html"]);
  });

  it("does not keep a file that is not the image or PDF its name says", async () => {
    const chat = await newChat();
    fakes.downloads.set("https://docs.example/report.pdf", { type: "text/plain", data: "Not found" });
    const result = await chat.call("web_fetch", { url: "https://docs.example/report.pdf" });
    expect(result.text).toMatch(/^Error: the URL gave a file of type text\/plain, not the PDF file itself, so nothing was kept\./);
    expect(await names(chat)).toEqual([]);
  });

  it("gives an image the extension of what it is, and one without an extension gets it", async () => {
    const chat = await newChat();
    fakes.downloads.set("https://photos.example/a.jpg", { type: "image/jpeg", data: WEBP });
    fakes.downloads.set("https://photos.example/b", { type: "application/octet-stream", data: PNG });
    expect((await chat.call("web_fetch", { url: "https://photos.example/a.jpg" })).text).toContain("to a.webp in the sandbox");
    expect((await chat.call("web_fetch", { url: "https://photos.example/b", name: "pics/b" })).text).toContain("to pics/b.png in the sandbox");
    const files = await conversationFiles(chat.conversationId);
    expect(files.map((f) => [f.name, f.mimeType])).toEqual([
      ["a.webp", "image/webp"],
      ["pics/b.png", "image/png"],
    ]);
  });

  it("keeps an image as it is, and points a model that can see to view_image", async () => {
    const chat = await newChat();
    fakes.downloads.set("https://photos.example/lynx.jpeg", { type: "image/jpeg", data: JPEG });
    const result = await chat.call("web_fetch", { url: "https://photos.example/lynx.jpeg" }, 8000, true);
    expect(result.text).toContain("It is an image: look at it with view_image.");
    const [file] = await conversationFiles(chat.conversationId);
    expect(file.name).toBe("lynx.jpeg");
    expect(await fileData(file.id)).toEqual(JPEG);
  });
});

describe("view_image", () => {
  /** A chat with `data` in its sandbox under `name`, as a download stored it. */
  async function withImage(name: string, data: Buffer) {
    const chat = await newChat();
    const messageId = await addMessage(chat.conversationId, { role: "tool", content: "Downloaded" });
    await prisma.messageAttachment.create({ data: { messageId, name, mimeType: mimeTypeOf(name), data: new Uint8Array(data), size: data.length, origin: "internet" } });
    return chat;
  }

  it("shows the model an image of the sandbox", async () => {
    const chat = await withImage("photos/lynx.png", PNG);
    const result = await chat.call("view_image", { file: "lynx.png" }, 8000, true);
    expect(result).toMatchObject({ text: "photos/lynx.png:", error: false });
    expect(result.images).toEqual([{ mimeType: "image/png", data: PNG.toString("base64") }]);
  });

  it("gives the type the bytes are, not the one the name says", async () => {
    const chat = await withImage("old.jpg", PNG);
    expect((await chat.call("view_image", { file: "old.jpg" }, 8000, true)).images[0].mimeType).toBe("image/png");
  });

  it("shows a GIF as the files server's copy", async () => {
    const chat = await withImage("anim.gif", GIF);
    expect((await chat.call("view_image", { file: "anim.gif" }, 8000, true)).images).toEqual([
      { mimeType: "image/png", data: PNG.toString("base64") },
    ]);
  });

  it("says why it cannot show a file", async () => {
    const chat = await withImage("broken.jpg", Buffer.from("<html>not an image</html>"));
    expect((await chat.call("view_image", { file: "broken.jpg" }, 8000, true)).text).toBe(
      "Error: broken.jpg cannot be shown: This is not an image that can be read."
    );
    expect((await chat.call("view_image", { file: "broken.jpg" })).text).toBe("Error: broken.jpg is an image, and you cannot see images.");
    fakes.run = { changed: { "data.csv": "a,b" } };
    await chat.call("run_code", { language: "python", code: "..." });
    expect((await chat.call("view_image", { file: "data.csv" }, 8000, true)).text).toBe(
      "Error: data.csv is not an image (PNG, JPEG, WebP or GIF)."
    );
  });
});

describe("share_file", () => {
  it("gives the user a file of the sandbox, without making or fetching it again", async () => {
    const chat = await newChat();
    fakes.run = { changed: { "out/result.csv": "x" } };
    await chat.call("run_code", { language: "python", code: "..." });
    const result = await chat.call("share_file", { file: "result.csv" });
    const [file] = await conversationFiles(chat.conversationId);
    expect(result.shared).toEqual([{ id: file.id, name: "out/result.csv", mimeType: file.mimeType, size: 1 }]);
    expect(fakes.runs).toHaveLength(1);
    const missing = await chat.call("share_file", { file: "nope.txt" });
    expect(missing.text).toMatch(/The files of this conversation are: out\/result.csv/);
  });
});

describe("install_packages", () => {
  it("takes only package names from the index, with versions", () => {
    expect(specProblem("pypi", "pandas==2.2.3")).toBeNull();
    expect(specProblem("pypi", "requests[socks]>=2,<3 ; python_version >= '3.8'")).toBeNull();
    for (const bad of ["requests @ https://x.example/r.whl", "git+https://github.com/a/b", "./local", "-e .", "--index-url=https://x"]) {
      expect(specProblem("pypi", bad)).toMatch(/no URLs, paths, git addresses or options/);
    }
    expect(specProblem("npm", "lodash@^4.17")).toBeNull();
    expect(specProblem("npm", "@types/node")).toBeNull();
    for (const bad of ["git+https://github.com/a/b.git", "lodash@github:lodash/lodash", "x@file:../x", "y@npm:z", "z@https://x.example/z.tgz"]) {
      expect(specProblem("npm", bad)).toMatch(/no URLs, paths, git addresses or aliases/);
    }
  });

  it("reads a requirements.txt and a package.json, and refuses options in them", () => {
    expect(specsFromFile("pypi", "requirements.txt", "# libs\nnumpy>=2\n\ntabulate==0.9.0  # tables\n")).toEqual(["numpy>=2", "tabulate==0.9.0"]);
    expect(specsFromFile("pypi", "requirements.txt", "--extra-index-url https://x\nnumpy")).toEqual({
      error: "requirements.txt has an option (--extra-index-url); options such as -r, -e or --index-url are not allowed.",
    });
    const manifest = JSON.stringify({ dependencies: { a: "^1" }, devDependencies: { b: "2.0.0" } });
    expect(specsFromFile("npm", "package.json", manifest)).toEqual(["a@^1", "b@2.0.0"]);
  });

  it("installs everything the chat asked for together, and keeps the lock and the packages with the chat", async () => {
    const chat = await newChat();
    fakes.install = {
      ok: true,
      report: "Would install tabulate-0.9.0",
      lock: "tabulate==0.9.0",
      packages: [{ name: "tabulate", version: "0.9.0", requested: true }],
      scans: [{ file: "tabulate-0.9.0-py3-none-any.whl", hash: "a".repeat(64), status: "clean", ms: 5 }],
    };
    const first = await chat.call("install_packages", { registry: "pypi", packages: ["tabulate==0.9.0"] });
    expect(first.label).toBe("Installed tabulate 0.9.0");
    fakes.install = {
      ok: true,
      report: "",
      lock: "tabulate==0.9.0\nwcwidth==0.2.13",
      packages: [
        { name: "tabulate", version: "0.9.0", requested: true },
        { name: "seaborn", version: "0.13.2", requested: true },
        { name: "wcwidth", version: "0.2.13", requested: false },
      ],
      scans: [],
    };
    const second = await chat.call("install_packages", { registry: "pip", packages: ["seaborn"] });
    expect(fakes.installs[1].requested).toEqual(["tabulate==0.9.0", "seaborn"]);
    expect(second.label).toBe("Installed seaborn 0.13.2 and 2 dependencies");
    const rows = await prisma.sandboxPackage.findMany({ where: { conversationId: chat.conversationId }, orderBy: { name: "asc" } });
    expect(rows.map((r) => [r.name, r.requested])).toEqual([
      ["seaborn", true],
      ["tabulate", true],
      ["wcwidth", false],
    ]);
    const lock = await prisma.sandboxLock.findUniqueOrThrow({ where: { conversationId_ecosystem: { conversationId: chat.conversationId, ecosystem: "pypi" } } });
    expect(lock.lock).toBe("tabulate==0.9.0\nwcwidth==0.2.13");
    // The next run gets the lock, so the container can install the packages again when it removed them
    await chat.call("run_code", { language: "python", code: "import seaborn" });
    expect(fakes.runs[0].locks).toEqual({ pypi: { requested: ["tabulate==0.9.0", "seaborn"], lock: "tabulate==0.9.0\nwcwidth==0.2.13" } });
    // Every file the install scanned is in the audit log, with its hash
    await chat.security.audit.flush();
    const events = await prisma.securityEvent.findMany({ where: { conversationId: chat.conversationId, host: "files.pythonhosted.org" } });
    expect(events.map((e) => [e.tool, e.check, e.verdict, e.contentHash])).toEqual([["install_packages", "virus", "allow", "a".repeat(64)]]);
  });

  it("installs nothing when the container refuses, and the model gets why", async () => {
    const chat = await newChat();
    fakes.install = { ok: false, error: "pip could not install these packages. Only packages with a ready-built wheel ...", report: "ERROR: no wheel", scans: [] };
    const result = await chat.call("install_packages", { registry: "pypi", packages: ["pycrypto"] });
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/ready-built wheel[\s\S]*ERROR: no wheel/);
    expect(await prisma.sandboxLock.count({ where: { conversationId: chat.conversationId } })).toBe(0);
  });

  it("compares PyPI names as the index does", () => {
    expect(packageName("pypi", "Scikit_Learn>=1")).toBe(packageName("pypi", "scikit-learn"));
    expect(packageName("npm", "@types/node@20")).toBe("@types/node");
  });
});
