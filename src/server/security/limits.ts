// The fixed numbers of the security layer: the thresholds of the URL rules,
// the timeouts of the scanners, and how long things are kept. None of them is
// a setting.

// --- URL rules (urls.ts): what makes an unknown URL look like it carries data out
/** A query string longer than this many characters */
export const MAX_QUERY_LENGTH = 256;
/** A path segment or query value of at least this many characters that is encoded data or random looking */
export const ENCODED_MIN_LENGTH = 40;
/** Bits per character above which such a segment or value counts as random looking */
export const MAX_ENTROPY_BITS = 4.0;
/** Base64 changes between lower case, upper case and digits from one character to the next at least this often; words do not */
export const BASE64_MIN_CHANGES = 0.3;
/** A run of this many letters and digits that also occurs in the user's messages or files */
export const SHARED_RUN_LENGTH = 32;

// --- Scanners (scan.ts)
/** How long the scans of a tool result may take, together */
export const TOOL_SCAN_TIMEOUT_MS = 8_000;
/** How long the virus scan of a file may take */
export const UPLOAD_VIRUS_TIMEOUT_MS = 30_000;
/** How long the injection scan of the whole text of a file from the internet may take; tools/guard stops by itself just before */
export const FILE_GUARD_TIMEOUT_MS = 180_000;
/** After a scan failed or timed out, its scanner is skipped for this long */
export const BREAKER_MS = 30_000;
/** How many injection verdicts are remembered, by the hash of their text */
export const VERDICT_CACHE_SIZE = 500;

// --- Dialogs and drafts
/** A paused reply stops by itself after this long without an answer */
export const PAUSE_TIMEOUT_MS = 10 * 60 * 1000;
/** A file that was attached but never sent is deleted after this long */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Attached files checked at once, as many as the files server converts at once */
export const MAX_UPLOADS_AT_ONCE = 2;
