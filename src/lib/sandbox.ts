// The chat's sandbox as the sandbox panel shows it, from
// GET /api/conversations/:id/sandbox. Shared by that route and the panel.

/** A version of a file; a deletion holds no data. */
export type SandboxVersion = { id: string; size: number; createdAt: string; deleted: boolean; origin: string };

/** A file of the sandbox, its newest version first in `versions`. */
export type SandboxFile = { path: string; mimeType: string; versions: SandboxVersion[] };

/** A run of code or an install of packages; its code and output come with GET .../sandbox/runs/:id. */
export type SandboxRunSummary = {
  id: string;
  toolCallId: string;
  kind: "run" | "install";
  language: string;
  status: string;
  durationMs: number;
  files: { changed: string[]; deleted: string[] } | null;
  createdAt: string;
};

export type SandboxPackageRow = { ecosystem: string; name: string; version: string; requested: boolean; installedAt: string };

export type SandboxView = {
  files: SandboxFile[];
  runs: SandboxRunSummary[];
  packages: SandboxPackageRow[];
  notes: string | null; // the task notes the model keeps (update_notes)
  bytes: number; // the newest versions together
  limit: number;
};
