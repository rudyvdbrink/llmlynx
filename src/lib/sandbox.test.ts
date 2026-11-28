// Tests of what the client and the server share about the chat's sandbox:
// paths, which files show in the chat, tables in previews, the tools an agent
// can check, and the context window an Ollama agent starts with.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultContextWindow } from "./agentSettings";
import { validateAgentTools } from "./agentTools";
import { parseDelimited } from "./delimited";
import { baseName, cleanFilePath, isArtifact, shownInChat, TEXT_EXTENSIONS, withFileCards, type FileCard } from "./files";

const card = (name: string, mimeType: string): FileCard => ({ id: name, name, mimeType, size: 1 });

describe("paths in the sandbox", () => {
  it("keeps folders, and drops what climbs out or names nothing", () => {
    expect(cleanFilePath("out/plot.png")).toBe("out/plot.png");
    expect(cleanFilePath("/sandbox/out/./plot.png")).toBe("out/plot.png");
    expect(cleanFilePath("data\\sales.csv")).toBe("data/sales.csv");
    expect(cleanFilePath("../secret.txt")).toBeNull();
    expect(cleanFilePath("a/../../b")).toBeNull();
    expect(cleanFilePath("   ")).toBeNull();
    expect(cleanFilePath("a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q.txt")).toBeNull();
    expect(cleanFilePath('re<po>rt?.md')).toBe("report.md");
    expect(baseName("out/plot.png")).toBe("plot.png");
  });

  it("keeps the dots of dotfiles and the depth of a repository, and never takes a .git folder", () => {
    expect(cleanFilePath("repo/.gitignore")).toBe("repo/.gitignore");
    expect(cleanFilePath(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
    expect(cleanFilePath("repo/src/main/java/org/example/app/model/Thing.java")).toBe("repo/src/main/java/org/example/app/model/Thing.java");
    expect(cleanFilePath("repo/.git/config")).toBeNull();
    expect(cleanFilePath(".GIT/hooks/pre-commit")).toBeNull();
    expect(cleanFilePath("repo/.gitmodules")).toBe("repo/.gitmodules");
  });
});

describe("files in the chat", () => {
  it("shows what a file tool made but source code, and nothing that a run made or was downloaded", () => {
    const made = [card("a.png", "image/png"), card("b.svg", "image/svg+xml"), card("c.html", "text/html"), card("d.csv", "text/csv")];
    const code = [card("src/main.py", "text/plain"), card("app.TS", "text/plain"), card("Dockerfile", "text/plain"), card("pyproject.toml", "text/plain")];
    expect(shownInChat("run_code", made)).toEqual([]);
    expect(shownInChat("create_file", [...made, ...code]).map((f) => f.name)).toEqual(["a.png", "b.svg", "c.html", "d.csv"]);
    expect(shownInChat("edit_file", code)).toEqual([]);
    expect(shownInChat("web_fetch", made)).toEqual([]);
    expect(shownInChat("git", made)).toEqual([]);
    expect(isArtifact("application/pdf")).toBe(false);
  });

  it("shows each file once, as its newest version, where it first showed", () => {
    const version = (id: string, name: string): FileCard => ({ id, name, mimeType: "text/plain", size: 1 });
    const cards = withFileCards([version("1", "a.py"), version("2", "b.csv")], [version("3", "A.py"), version("4", "c.png")]);
    expect(cards.map((f) => f.id)).toEqual(["3", "2", "4"]);
    expect(withFileCards(cards, [version("4", "c.png")]).map((f) => f.id)).toEqual(["3", "2", "4"]);
  });
});

describe("tables", () => {
  it("reads quoted fields, both kinds of line ends, and stops at the most rows", () => {
    expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\n1,2', ",", 10)).toEqual({
      rows: [
        ["a", "b"],
        ["x, y", 'say "hi"'],
        ["1", "2"],
      ],
      more: false,
    });
    expect(parseDelimited("a\tb\n1\t2\n", "\t", 10).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    const long = Array.from({ length: 30 }, (_, i) => `${i}`).join("\n");
    expect(parseDelimited(long, ",", 5)).toEqual({ rows: [["0"], ["1"], ["2"], ["3"], ["4"]], more: true });
  });
});

describe("the agents page", () => {
  it("keeps install_packages only together with run_code", () => {
    expect(validateAgentTools(["install_packages"])).toEqual({ ok: true, value: [] });
    expect(validateAgentTools(["install_packages", "run_code", "web_fetch"])).toEqual({
      ok: true,
      value: ["web_fetch", "run_code", "install_packages"],
    });
    expect(validateAgentTools(["share_file"])).toEqual({ ok: false, message: "Unknown tool: share_file" });
  });

  it("starts an Ollama agent with half of what its model supports, or 2048 when that is not known", () => {
    expect(defaultContextWindow(131072)).toBe(65536);
    expect(defaultContextWindow(40961)).toBe(20480);
    expect(defaultContextWindow(null)).toBe(2048);
    expect(defaultContextWindow(undefined)).toBe(2048);
  });
});

describe("text files", () => {
  it("are the same extensions for the app and the files server", () => {
    // TEXT_EXTENSIONS = { "txt", "md", ... } in tools/files/src/common.py
    const python = fs.readFileSync(path.join(import.meta.dirname, "../../tools/files/src/common.py"), "utf8");
    const set = /^TEXT_EXTENSIONS = \{([^}]*)\}/m.exec(python)![1];
    const server = [...set.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...server].sort()).toEqual([...TEXT_EXTENSIONS].sort());
  });
});
