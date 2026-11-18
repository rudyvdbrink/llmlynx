// What a run of tests found, read from what the test runner left: a JUnit XML
// report or a Jest or Vitest JSON report the run wrote to a file, or else
// pytest's own summary in the output. run_code lists the failing tests with
// the first place in the sandbox each one points to ("path:line"), so that the
// model can read that line rather than search the log. A failed test is kept
// apart from an error (a test that could not be set up, a module that is
// missing, a file that could not be collected).

export type TestProblem = { kind: "failed" | "error"; name: string; where?: string; message?: string };

export type TestReport =
  | { runner: string; passed: number; failed: number; errors: number; skipped: number; problems: TestProblem[] }
  | { runner: string; unreadable: string };

// Most problems a result lists, and the most characters of a message
const MAX_PROBLEMS = 10;
const MAX_MESSAGE = 200;

// "path:line", as most runners write it, and Python's 'File "path", line 12'
const LOCATION = /(?:^|[\s("'`[])((?:\/sandbox\/)?(?:\.\/)?[\w.@+-][\w.@+/-]*\.[A-Za-z0-9]+):(\d+)/g;
const PYTHON_LOCATION = /File "([^"]+)", line (\d+)/g;

/**
 * The first place in `text` that names a file of the sandbox and a line,
 * as "path:line" with the path in the sandbox. Paths may be relative to the
 * folder the run ran in (`cwd`).
 */
export function firstLocation(text: string, exists: (path: string) => boolean, cwd: string): string | undefined {
  const matches = [...text.matchAll(LOCATION), ...text.matchAll(PYTHON_LOCATION)].sort((a, b) => a.index - b.index);
  for (const match of matches) {
    const raw = match[1].replace(/^\/sandbox\//, "").replace(/^\.\//, "");
    for (const path of cwd ? [`${cwd}/${raw}`, raw] : [raw]) {
      if (exists(path)) return `${path}:${match[2]}`;
    }
  }
  return undefined;
}

const oneLine = (text: string | undefined) => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line || undefined;
};

const unescapeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const attribute = (attrs: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match ? unescapeXml(match[1]) : undefined;
};

/** A JUnit XML report: <testcase> elements with <failure>, <error> or <skipped> in them. */
function readJUnit(xml: string, exists: (path: string) => boolean, cwd: string): TestReport {
  const report = { runner: "JUnit report", passed: 0, failed: 0, errors: 0, skipped: 0, problems: [] as TestProblem[] };
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  if (!cases.length) return { runner: report.runner, unreadable: "it lists no test cases" };
  for (const [, attrs, body = ""] of cases) {
    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!problem) {
      if (/<skipped\b/.test(body)) report.skipped++;
      else report.passed++;
      continue;
    }
    const kind = problem[1] === "failure" ? "failed" : "error";
    if (kind === "failed") report.failed++;
    else report.errors++;
    const name = [attribute(attrs, "classname"), attribute(attrs, "name")].filter(Boolean).join("::") || "a test";
    const details = unescapeXml(problem[3] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    const file = attribute(attrs, "file");
    const line = attribute(attrs, "line");
    const where =
      firstLocation(details, exists, cwd) ?? (file && line ? firstLocation(` ${file}:${line}`, exists, cwd) : undefined);
    // The exception, such as a ModuleNotFoundError, says more than a message such as "collection failure"
    const exception = details
      .split("\n")
      .map((l) => l.replace(/^E\s+/, "").trim())
      .find((l) => /^[\w.]+(Error|Exception):/.test(l));
    const stated = attribute(problem[2], "message");
    const message = oneLine(
      stated && exception && !stated.includes(exception) ? `${stated}: ${exception}` : (stated ?? exception ?? details.split("\n").find((l) => l.trim()))
    );
    report.problems.push({ kind, name, ...(where ? { where } : {}), ...(message ? { message } : {}) });
  }
  return report;
}

type JestJson = {
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: { fullName?: string; title?: string; status?: string; failureMessages?: string[] }[];
  }[];
};

/** A Jest or Vitest JSON report (--json, or --reporter=json, with an output file). */
function readJestJson(json: JestJson, exists: (path: string) => boolean, cwd: string): TestReport {
  const report = { runner: "Jest/Vitest report", passed: 0, failed: 0, errors: 0, skipped: 0, problems: [] as TestProblem[] };
  for (const suite of json.testResults ?? []) {
    const file = (suite.name ?? "").replace(/^\/sandbox\//, "");
    const tests = suite.assertionResults ?? [];
    // A test file that failed without a failing test could not be run: an error, not a failure
    if (suite.status === "failed" && !tests.some((t) => t.status === "failed")) {
      report.errors++;
      const where = firstLocation(suite.message ?? "", exists, cwd);
      report.problems.push({ kind: "error", name: file || "a test file", ...(where ? { where } : {}), message: oneLine(suite.message) });
    }
    for (const test of tests) {
      if (test.status === "passed") report.passed++;
      else if (test.status === "failed") {
        report.failed++;
        const details = (test.failureMessages ?? []).join("\n");
        const where = firstLocation(details, exists, cwd);
        const message = oneLine(details.split("\n").find((l) => l.trim()));
        report.problems.push({
          kind: "failed",
          name: `${file ? `${file} > ` : ""}${test.fullName ?? test.title ?? "a test"}`,
          ...(where ? { where } : {}),
          ...(message ? { message } : {}),
        });
      } else report.skipped++;
    }
  }
  return report;
}

/** pytest's output: the counts of its last line, and the failures and errors of its short summary. */
function readPytest(output: string, exists: (path: string) => boolean, cwd: string): TestReport | null {
  // pytest -q leaves out the header and writes its last line without "=" around it
  const finals = [...output.matchAll(/^(?:=+ )?((?:\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s(?: \([^)]*\))?(?: =+)?$/gm)];
  if (!/^=+ test session starts =+$/m.test(output) && !/^=+ short test summary info =+$/m.test(output) && !finals.length) return null;
  const runner = "pytest";
  const counts = finals.length ? finals[finals.length - 1][1] : "";
  const count = (word: RegExp) => {
    const match = new RegExp(`(\\d+) ${word.source}`).exec(counts);
    return match ? Number(match[1]) : 0;
  };
  const report = {
    runner,
    passed: count(/passed/),
    failed: count(/failed/),
    errors: count(/errors?/),
    skipped: count(/skipped/),
    problems: [] as TestProblem[],
  };
  if (!counts) return { runner, unreadable: "pytest did not finish its summary" };
  if (!report.failed && !report.errors) return report;

  // The sections of the failures and errors: "____ test_name ____" and what follows, up to the next one
  const sections = new Map<string, string>();
  const headers = [...output.matchAll(/^_{3,} (.+?) _{3,}$/gm)];
  headers.forEach((h, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].index : output.length;
    sections.set(h[1].trim(), output.slice(h.index, end));
  });
  // Up to the last line, which -q writes without "=" around it
  const summary = /^=+ short test summary info =+$([\s\S]*)/m.exec(output)?.[1] ?? "";
  for (const line of summary.split("\n")) {
    const match = /^(FAILED|ERROR) (\S+)(?: - (.*))?$/.exec(line.trim());
    if (!match) continue;
    const kind = match[1] === "FAILED" ? "failed" : "error";
    const id = match[2];
    const test = id.split("::").slice(1).join(".");
    const section =
      [...sections.entries()].find(([title]) => (test && (title === test || title.endsWith(`.${test}`) || title.endsWith(` ${test}`))) || title.endsWith(id.split("::")[0]))?.[1] ?? "";
    const where = firstLocation(section, exists, cwd) ?? firstLocation(` ${id.split("::")[0]}:1`, exists, cwd);
    const message = oneLine(match[3]);
    report.problems.push({ kind, name: id, ...(where ? { where } : {}), ...(message ? { message } : {}) });
  }
  if (!report.problems.length) return { runner, unreadable: "its short test summary is missing (it was run with -q or -r options that leave it out?)" };
  return report;
}

/**
 * The test results of a run: from a report file it wrote (`files`: what it
 * made or changed), else from pytest's output. null when the run ran no test
 * runner this reads. `exists` says whether a path is a file of the sandbox.
 */
export function readTestResults(
  output: string,
  files: { name: string; data: Buffer }[],
  exists: (path: string) => boolean,
  cwd: string
): TestReport | null {
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".xml")) {
      const text = file.data.toString("utf8");
      if (/<testsuites?\b/.test(text)) return readJUnit(text, exists, cwd);
    }
    if (lower.endsWith(".json")) {
      const text = file.data.toString("utf8");
      if (!/"testResults"/.test(text) || !/"numFailedTests"/.test(text)) continue;
      try {
        return readJestJson(JSON.parse(text) as JestJson, exists, cwd);
      } catch {
        return { runner: "Jest/Vitest report", unreadable: `${file.name} is not valid JSON` };
      }
    }
  }
  return readPytest(output, exists, cwd);
}

/** The results for the model: the counts, then each failure and error with where it points to. */
export function describeTestResults(report: TestReport): string {
  if ("unreadable" in report) return `Tests (${report.runner}): the results could not be read: ${report.unreadable}. See the output.`;
  const counts = [
    report.failed && `${report.failed} failed`,
    report.errors && `${report.errors} error${report.errors === 1 ? "" : "s"}`,
    `${report.passed} passed`,
    report.skipped && `${report.skipped} skipped`,
  ].filter(Boolean);
  const lines = [`Tests (${report.runner}): ${counts.join(", ")}.`];
  for (const p of report.problems.slice(0, MAX_PROBLEMS)) {
    const kind = p.kind === "failed" ? "failed" : "error (not a failed assertion: setup, collection or import)";
    lines.push(`- ${kind}: ${p.name}${p.where ? `, at ${p.where}` : ""}${p.message ? `: ${p.message}` : ""}`);
  }
  if (report.problems.length > MAX_PROBLEMS) lines.push(`- and ${report.problems.length - MAX_PROBLEMS} more`);
  if (report.problems.some((p) => /ModuleNotFoundError|No module named|Cannot find (module|package)/.test(p.message ?? ""))) {
    lines.push("A module is missing: install it with install_packages if it is a package, then run the tests again.");
  }
  return lines.join("\n");
}
