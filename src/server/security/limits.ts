// The fixed numbers of the security layer: the timeouts of the scanners, and
// how long things are kept. None of them is a setting.

// --- Scanners (scan.ts)
/**
 * How long the scans of a tool result may take, together. The guard scans one
 * text at a time (GUARD_MAX_CONCURRENCY), so this includes the wait behind the
 * scans of other tool calls.
 */
export const TOOL_SCAN_TIMEOUT_MS = 20_000;
/** How long the virus scan of a file may take */
export const UPLOAD_VIRUS_TIMEOUT_MS = 30_000;
/** How long the injection scan of the start of a download's text, which the model gets with it, may take; tools/guard stops by itself just before */
export const FILE_GUARD_TIMEOUT_MS = 180_000;
/** How many injection verdicts are remembered, by the hash of their text */
export const VERDICT_CACHE_SIZE = 500;

// --- Dialogs and drafts
/** A paused reply stops by itself after this long without an answer */
export const PAUSE_TIMEOUT_MS = 10 * 60 * 1000;
/** A file that was attached but never sent is deleted after this long */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Attached files checked at once, as many as the files server converts at once */
export const MAX_UPLOADS_AT_ONCE = 2;
