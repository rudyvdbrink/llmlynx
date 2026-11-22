// Tests of what a checkpoint's summary says the model did with tools: the
// steps grouped with their result numbers, files by their names, commands by
// their program, failures apart, and the newest steps in their order.

import { describe, expect, it } from "vitest";
import type { ConversationFile } from "@/server/files/store";
import { getToolDefinition, type Args } from "@/server/tools/definitions";
import { toolFacts, type ToolStep } from "./toolFacts";

const HEAD = "What you did with tools (%s steps), as llmlynx recorded it.";
const RECALL = " The numbers in square brackets are result numbers: give one to read_result to get that tool result back in full.";

const sandbox = (...names: string[]) =>
  names.map((name, i) => ({ id: `f${i}`, name, mimeType: "text/plain", size: 1, origin: "code", text: null, info: null, createdAt: new Date() })) as ConversationFile[];

/** A step as stored: its label is the tool's own, with a note after it as the chat view shows it. */
function step(position: number, toolName: string, args: Args, how: { error?: boolean; note?: string; runStatus?: string; label?: string } = {}): ToolStep {
  const own = getToolDefinition(toolName)!.label(args, how.error ? "error" : "done");
  return {
    position,
    toolName,
    args,
    label: how.label ?? (how.note ? `${own} (${how.note})` : own),
    error: how.error ?? false,
    runStatus: how.runStatus ?? null,
  };
}

const shell = (code: string) => ({ language: "shell", code });

describe("the facts about the steps", () => {
  it("group the steps by what they did and to what, list failures apart, and the newest steps in order", () => {
    const both = { changes: [{ file: "proj/src/pipeline/cleaning.py" }, { file: "proj/src/search/grids.py" }] };
    const steps = [
      step(2, "read_file", { file: "proj/src/pipeline/cleaning.py" }),
      // By its name only: the file of the sandbox with that name
      step(4, "read_file", { file: "cleaning.py" }),
      step(6, "search_workspace", { mode: "text", pattern: "def fit" }),
      step(8, "edit_files", both, { error: true, note: "files changed meanwhile" }),
      step(10, "edit_files", both),
      step(12, "run_code", shell("cd proj && PYTHONPATH=src python verify.py"), { runStatus: "ok" }),
      step(14, "run_code", shell("cd proj && timeout 300 python verify.py --fast\necho done"), { runStatus: "error", note: "exit code 1" }),
      step(16, "git", { command: "diff -U3" }),
      step(18, "run_code", shell("git diff"), { runStatus: "ok" }),
      step(20, "install_packages", { registry: "pypi", packages: ["seaborn", "tabulate"] }, { label: "Installed seaborn 0.13.2 and 2 dependencies", runStatus: "ok" }),
      step(22, "update_notes", { notes: "Goal: fix it." }),
      step(24, "read_file", { file: "proj/src/search/grids.py" }),
      step(26, "run_code", shell("timeout 60 python verify.py"), { runStatus: "ok" }),
    ];
    expect(toolFacts(steps, sandbox("proj/src/pipeline/cleaning.py", "proj/src/search/grids.py"), true)).toEqual([
      HEAD.replace("%s", "13") + RECALL,
      "- Read: grids.py [24]; cleaning.py [2, 4]",
      '- Searched: "def fit" [6]',
      "- Edited: cleaning.py [10]; grids.py [10]",
      "- Installed: seaborn, tabulate [20]",
      "- Ran: `python verify.py` [12, 26]; `git diff` [16, 18]",
      "- Updated your notes [22]",
      "- Failed: run `timeout 300 python verify.py --fast` and more lines (exit code 1) [14]; edit cleaning.py, grids.py (files changed meanwhile) [8]",
      "- Your last steps, in order:",
      "  - Ran `PYTHONPATH=src python verify.py` [12]",
      "  - Ran `timeout 300 python verify.py --fast` and more lines (exit code 1) [14]",
      "  - Ran `git diff -U3` [16]",
      "  - Ran `git diff` [18]",
      "  - Installed seaborn, tabulate [20]",
      "  - Updated your notes [22]",
      "  - Read grids.py [24]",
      "  - Ran `timeout 60 python verify.py` [26]",
    ]);
  });

  it("name files with the folders that tell them apart, and list only the newest numbers of a target", () => {
    const steps = [
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => step(n, "read_file", { file: "a/utils.py" })),
      step(8, "read_file", { file: "b/utils.py" }),
      step(9, "web_read", { url: "https://www.a.example/page/" }),
    ];
    const lines = toolFacts(steps, sandbox("a/utils.py", "b/utils.py"), false);
    // Without read_result, nothing about it
    expect(lines[0]).toBe(HEAD.replace("%s", "9"));
    expect(lines[1]).toBe("- Read: a.example/page [9]; b/utils.py [8]; a/utils.py [3, 4, 5, 6, 7, and 2 earlier]");
  });

  it("list a few steps in their order, without groups", () => {
    const steps = [step(1, "create_file", { name: "notes.md", content: "x" }), step(2, "edit_file", { file: "notes.md" }, { error: true, note: "files changed meanwhile" })];
    expect(toolFacts(steps, sandbox("notes.md"), true)).toEqual([
      HEAD.replace("%s", "2") + RECALL,
      "- Created notes.md [1]",
      "- Could not edit notes.md (files changed meanwhile) [2]",
    ]);
  });
});
