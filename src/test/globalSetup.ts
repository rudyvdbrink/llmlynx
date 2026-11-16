// Runs once before the tests: makes the scratch database (DATABASE_URL in
// vitest.config.mts) with the project's migrations, and removes it afterwards.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";

export default function setup(project: TestProject) {
  const url = String(project.config.env.DATABASE_URL);
  const directory = path.dirname(url.replace(/^file:/, ""));
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  return () => fs.rmSync(directory, { recursive: true, force: true });
}
