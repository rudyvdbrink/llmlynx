// What the sandbox panel lists of the runs of code and the installs of
// packages (the SandboxRun model), also of those that did not run.

import type { Args, RunRecord } from "@/server/tools/definitions";

/** The language of a run, or the registry of an install, as the model asked for it. */
export function runLanguage(args: Args): string {
  const value = typeof args.language === "string" ? args.language : typeof args.registry === "string" ? args.registry : "";
  return value.trim().toLowerCase() || "unknown";
}

/** What the model asked to run or install, as the panel shows it. */
export function runCode(toolName: string, args: Args): string {
  if (toolName !== "install_packages") return typeof args.code === "string" ? args.code : "";
  const packages = Array.isArray(args.packages) ? args.packages.filter((p): p is string => typeof p === "string") : [];
  return [...packages, ...(typeof args.file === "string" && args.file.trim() ? [`from ${args.file.trim()}`] : [])].join("\n");
}

/** The record of a run or install that did not run: `status` says why. */
export function notRun(toolName: string, args: Args, status: "blocked" | "skipped", output = ""): RunRecord {
  return {
    kind: toolName === "install_packages" ? "install" : "run",
    language: runLanguage(args),
    code: runCode(toolName, args),
    output,
    status,
    durationMs: 0,
  };
}
