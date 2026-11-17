// install_packages: installs packages from PyPI or npm for the chat's runs, in
// the code container (see code.ts and tools/code/src/packages.py). Only names
// from the package indexes, with versions, are taken: no URLs, paths, git
// addresses, other indexes or options. Each install resolves everything the
// chat asked for so far, so its packages fit together; the result is stored
// with the chat (SandboxLock and SandboxPackage), so that the container can
// install it again. What pip and npm report is scanned like a web page after
// the call (see checkAfterCall).

import { prisma } from "@/server/db/prisma";
import { conversationFiles, fileData, findFile } from "@/server/files/store";
import type { Args, ToolCallContext, ToolResult } from "@/server/tools/definitions";
import { chatLocks, installInSandbox, type Ecosystem } from "./code";
import { withChatLock } from "./lock";
import { notRun } from "./records";

export const REGISTRY_LABELS: Record<Ecosystem, string> = { pypi: "PyPI", npm: "npm" };

const FILE_HOSTS: Record<Ecosystem, string> = { pypi: "files.pythonhosted.org", npm: "registry.npmjs.org" };

const MAX_PACKAGES = 50;

// As in tools/code/src/packages.py, which checks them again
const PYPI_NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const PYPI_REQUIREMENT = new RegExp(
  `^\\s*${PYPI_NAME}\\s*(\\[\\s*${PYPI_NAME}(\\s*,\\s*${PYPI_NAME})*\\s*\\])?` +
    "\\s*((===?|!=|<=|>=|<|>|~=)\\s*[A-Za-z0-9.*+!_-]+\\s*(,\\s*(===?|!=|<=|>=|<|>|~=)\\s*[A-Za-z0-9.*+!_-]+\\s*)*)?" +
    "(;[A-Za-z0-9_.<>=!~'\" ()]*)?$"
);
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_RANGE = /^[0-9A-Za-z.^~<>=|*+\s-]*$/;
const NPM_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function registryOf(raw: unknown): Ecosystem | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase();
  if (name === "pypi" || name === "pip" || name === "python") return "pypi";
  if (name === "npm" || name === "node" || name === "javascript" || name === "typescript") return "npm";
  return null;
}

/** The package's name, by which a newer request replaces an older one: PyPI names are compared normalized. */
export function packageName(ecosystem: Ecosystem, spec: string): string {
  if (ecosystem === "npm") {
    const at = spec.lastIndexOf("@");
    return (at > 0 ? spec.slice(0, at) : spec).trim().toLowerCase();
  }
  return (/^\s*([A-Za-z0-9._-]+)/.exec(spec)?.[1] ?? spec).toLowerCase().replace(/[-_.]+/g, "-");
}

/** Why `spec` cannot be installed, or null when it is a package name from the index, with a version. */
export function specProblem(ecosystem: Ecosystem, spec: string): string | null {
  if (ecosystem === "pypi") {
    return PYPI_REQUIREMENT.test(spec)
      ? null
      : `${spec} cannot be installed: only package names from PyPI, with versions such as pandas==2.2.3 or numpy>=2, are allowed; no URLs, paths, git addresses or options.`;
  }
  const at = spec.lastIndexOf("@");
  const [name, wanted] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1).trim() || "latest"] : [spec, "latest"];
  const ok = NPM_NAME.test(name) && (NPM_TAG.test(wanted) || NPM_RANGE.test(wanted)) && !/[:/]/.test(wanted);
  return ok
    ? null
    : `${spec} cannot be installed: only package names from the npm registry, with a version or range such as lodash@^4.17, are allowed; no URLs, paths, git addresses or aliases.`;
}

/** The packages a requirements.txt or package.json names, or an error text. */
export function specsFromFile(ecosystem: Ecosystem, name: string, text: string): string[] | { error: string } {
  if (ecosystem === "npm") {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(text);
    } catch {
      return { error: `${name} is not a valid package.json.` };
    }
    const specs: string[] = [];
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = manifest[key];
      if (!deps || typeof deps !== "object") continue;
      for (const [dep, range] of Object.entries(deps as Record<string, unknown>)) specs.push(`${dep}@${String(range)}`);
    }
    return specs;
  }
  const specs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("-")) {
      return { error: `${name} has an option (${line.split(/\s/)[0]}); options such as -r, -e or --index-url are not allowed.` };
    }
    specs.push(line);
  }
  return specs;
}

/** "seaborn 0.13.2, tabulate 0.9.0", with how many other packages they needed. */
function installedList(packages: { name: string; version: string; requested: boolean }[]): string {
  const requested = packages.filter((p) => p.requested);
  const others = packages.length - requested.length;
  const names = requested.map((p) => `${p.name} ${p.version}`).join(", ") || "nothing new";
  return others > 0 ? `${names} and ${others} ${others === 1 ? "dependency" : "dependencies"}` : names;
}

/** The packages the model asked for, from `args.packages` and `args.file`, checked; or an error text. */
async function requestedSpecs(ecosystem: Ecosystem, args: Args, ctx: ToolCallContext): Promise<string[] | { error: string }> {
  const specs = Array.isArray(args.packages)
    ? args.packages.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim())
    : typeof args.packages === "string" && args.packages.trim()
      ? args.packages.split(/[\s,]+/).filter(Boolean)
      : [];
  if (typeof args.file === "string" && args.file.trim()) {
    const files = await conversationFiles(ctx.conversationId);
    const file = findFile(files, args.file);
    if (!file) return { error: `There is no file named ${args.file.trim()} in the sandbox.` };
    const fromFile = specsFromFile(ecosystem, file.name, (await fileData(file.id)).toString("utf8"));
    if ("error" in fromFile) return fromFile;
    specs.push(...fromFile);
  }
  if (!specs.length) return { error: "Name the packages, or a requirements.txt or package.json in the sandbox." };
  if (specs.length > MAX_PACKAGES) return { error: `At most ${MAX_PACKAGES} packages at once.` };
  for (const spec of specs) {
    const problem = specProblem(ecosystem, spec);
    if (problem) return { error: problem };
  }
  return specs;
}

/** Installs the packages the model asked for. Throws only when the chat is stopped. */
export async function installPackages(args: Args, ctx: ToolCallContext): Promise<ToolResult> {
  const failure = (text: string, status?: "blocked"): ToolResult => ({
    text: `Error: ${text}`,
    images: [],
    files: [],
    error: true,
    ...(status ? { run: notRun("install_packages", args, status, text) } : {}),
  });
  const ecosystem = registryOf(args.registry);
  if (!ecosystem) return failure("registry must be pypi (Python) or npm (JavaScript and TypeScript).");
  const specs = await requestedSpecs(ecosystem, args, ctx);
  if ("error" in specs) return failure(specs.error, "blocked");

  return withChatLock(ctx.conversationId, async () => {
    // Everything the chat asked for, so the packages are resolved together; a new request for a name replaces the old one
    const before = (await chatLocks(ctx.conversationId))[ecosystem]?.requested ?? [];
    const names = new Set(specs.map((s) => packageName(ecosystem, s)));
    const requested = [...before.filter((s) => !names.has(packageName(ecosystem, s))), ...specs];
    const outcome = await installInSandbox({ conversationId: ctx.conversationId, ecosystem, requested, signal: ctx.signal });

    for (const scan of outcome.scans) {
      ctx.security?.audit.add({
        tool: "install_packages",
        check: "virus",
        verdict: scan.status === "clean" ? "allow" : "block",
        reason: scan.status === "clean" ? "clean" : scan.status === "virus" ? "virus" : "unchecked",
        host: FILE_HOSTS[ecosystem],
        contentHash: /^[0-9a-f]{64}$/.test(scan.hash) ? scan.hash : Buffer.from(scan.hash.replace(/^sha512-/, ""), "base64").toString("hex"),
        durationMs: scan.ms,
      });
    }

    const run = {
      kind: "install" as const,
      language: ecosystem,
      code: specs.join("\n"),
      output: outcome.report,
      durationMs: outcome.durationMs,
    };
    if (!outcome.ok || outcome.lock === undefined || !outcome.packages) {
      const text = [`Error: ${outcome.error ?? "the packages could not be installed."}`, outcome.report.trim()].filter(Boolean).join("\n\n");
      return { text, images: [], files: [], error: true, run: { ...run, status: "error" as const } };
    }
    await saveInstall(ctx.conversationId, ecosystem, requested, outcome.lock, outcome.packages);

    const asked = new Set(specs.map((s) => packageName(ecosystem, s)));
    const shown = outcome.packages.map((p) => ({ ...p, requested: asked.has(packageName(ecosystem, p.name)) }));
    const list = installedList(shown);
    const text = [
      `Installed for this chat from ${REGISTRY_LABELS[ecosystem]}: ${list}. Runs of this chat can use them now.`,
      outcome.report.trim() ? `What ${ecosystem === "pypi" ? "pip" : "npm"} reported:\n${outcome.report.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      text,
      images: [],
      files: [],
      error: false,
      label: `Installed ${list}`,
      run: { ...run, status: "ok" as const },
    };
  });
}

/** Stores what the chat's packages of `ecosystem` are now; a package that stayed keeps when it was installed. */
async function saveInstall(
  conversationId: string,
  ecosystem: Ecosystem,
  requested: string[],
  lock: string,
  packages: { name: string; version: string; requested: boolean }[]
) {
  const asked = new Set(requested.map((s) => packageName(ecosystem, s)));
  const previous = await prisma.sandboxPackage.findMany({ where: { conversationId, ecosystem } });
  const since = new Map(previous.map((p) => [`${p.name}@${p.version}`, p.installedAt]));
  await prisma.$transaction([
    prisma.sandboxLock.upsert({
      where: { conversationId_ecosystem: { conversationId, ecosystem } },
      create: { conversationId, ecosystem, requested, lock },
      update: { requested, lock },
    }),
    prisma.sandboxPackage.deleteMany({ where: { conversationId, ecosystem } }),
    prisma.sandboxPackage.createMany({
      data: packages.map((p) => ({
        conversationId,
        ecosystem,
        name: p.name,
        version: p.version,
        requested: asked.has(packageName(ecosystem, p.name)),
        installedAt: since.get(`${p.name}@${p.version}`) ?? new Date(),
      })),
    }),
  ]);
}
