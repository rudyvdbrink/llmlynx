// Files users attach to their messages, and files agents create: which kinds
// there are, the limits, and how the chat view shows them. Shared by the
// chat API (validation), the composer and the file cards.

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
// All of a chat's files together: its sandbox (the newest version of each file)
export const MAX_SANDBOX_BYTES = 100 * 1024 * 1024;

// "text": read as it is. "document": converted to text. "image": shown to models that can see images.
export type FileKind = "text" | "document" | "image";

/** What an agent's chat accepts, as GET /api/agents/:id/accepts returns it. */
export type AttachAccept = { documents: boolean; images: boolean };

/** A file as the chat view shows it. `url` is set on a file of a message that is still being sent. */
export type FileCard = { id: string; name: string; mimeType: string; size: number; url?: string };

// The same list as TEXT_EXTENSIONS in tools/files/src/common.py (a test checks it)
export const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
  "html", "htm", "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "ipynb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "swift", "sh", "bash", "zsh", "ps1", "bat", "sql", "r", "lua",
  "pl", "scala", "dart", "vue", "svelte", "tex", "bib", "srt", "vtt", "dockerfile", "makefile", "gitignore", "env",
  "svg",
];

const DOCUMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  svg: "image/svg+xml",
};

/** "Report.Final.PDF" -> "pdf"; a name without a dot is its own extension ("Dockerfile" -> "dockerfile"). */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return (dot >= 0 ? base.slice(dot + 1) : base).toLowerCase();
}

/** What kind of file `name` is, by its extension; null when it is not supported. */
export function fileKind(name: string): FileKind | null {
  const ext = extensionOf(name);
  if (ext in IMAGE_TYPES) return "image";
  if (ext in DOCUMENT_TYPES) return "document";
  if (TEXT_EXTENSIONS.includes(ext)) return "text";
  return null;
}

/** The type to store and serve a file as. Browsers do not agree on these, so it goes by the extension. */
export function mimeTypeOf(name: string): string {
  const ext = extensionOf(name);
  return IMAGE_TYPES[ext] ?? DOCUMENT_TYPES[ext] ?? TEXT_TYPES[ext] ?? (fileKind(name) === "text" ? "text/plain" : "application/octet-stream");
}

/** Whether a chat that accepts `accept` takes a file of `kind`. */
export function accepts(accept: AttachAccept, kind: FileKind | null): boolean {
  if (kind === "image") return accept.images;
  return kind !== null && accept.documents;
}

/** The file input's accept attribute for `accept`. */
export function acceptAttribute(accept: AttachAccept): string {
  const extensions = [
    ...(accept.documents ? [...TEXT_EXTENSIONS, ...Object.keys(DOCUMENT_TYPES)] : []),
    ...(accept.images ? Object.keys(IMAGE_TYPES) : []),
  ];
  return extensions.map((ext) => `.${ext}`).join(",");
}

/** Why a chat that accepts `accept` cannot take the file, or null when it can. */
export function fileProblem(accept: AttachAccept, file: { name: string; size: number }): string | null {
  const kind = fileKind(file.name);
  if (kind === "image" && !accept.images) return `${file.name}: this agent's model cannot see images`;
  if (!accepts(accept, kind)) return `${file.name}: this kind of file is not supported`;
  if (file.size > MAX_FILE_BYTES) return `${file.name}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`;
  if (file.size === 0) return `${file.name}: the file is empty`;
  return null;
}

/** Images the browser may show inline. Everything else is only ever downloaded, or shown sandboxed (see isArtifact). */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function isInlineImage(mimeType: string): boolean {
  return INLINE_IMAGE_TYPES.includes(mimeType);
}

/** SVG shows as an image, in which its scripts do not run. */
export const isSvg = (mimeType: string) => mimeType === "image/svg+xml";

/** HTML shows in a sandboxed frame (see /api/attachments/:id/frame). */
export const isHtml = (mimeType: string) => mimeType === "text/html";

/** Files that show in the chat as what they are, rather than as a card to download: images, SVG and HTML. */
export function isArtifact(mimeType: string): boolean {
  return isInlineImage(mimeType) || isSvg(mimeType) || isHtml(mimeType);
}

/** 1234567 -> "1.2 MB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What the file card says the file is: "PDF", "Word", "Python", ... */
export function typeLabel(name: string): string {
  const ext = extensionOf(name);
  const labels: Record<string, string> = {
    pdf: "PDF", docx: "Word", xlsx: "Excel", xls: "Excel", pptx: "PowerPoint", md: "Markdown", markdown: "Markdown",
    txt: "Text", csv: "CSV", tsv: "TSV", json: "JSON", py: "Python", js: "JavaScript", ts: "TypeScript", go: "Go",
    html: "HTML", png: "PNG", jpg: "JPEG", jpeg: "JPEG", webp: "WebP", gif: "GIF",
  };
  return labels[ext] ?? ext.toUpperCase();
}

/**
 * A name that is not taken yet in `taken`: "photo.jpg", then "photo (2).jpg".
 * Compared without case, as the model refers to files by name.
 */
export function uniqueName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

const MAX_NAME_LENGTH = 120;
// Deep and long enough for the files of a cloned repository
const MAX_PATH_DEPTH = 16;
const MAX_PATH_LENGTH = 400;

/** A part of a sandbox path: a safe name (see cleanFileName) that keeps its leading dots, as in ".gitignore". */
function cleanPathPart(part: string): string {
  const dots = /^\.*/.exec(part)![0];
  const name = cleanFileName(part);
  return dots.length < part.length ? dots + name : name;
}

/**
 * A path in a chat's sandbox, such as "out/plot.png": folders separated by
 * "/", each part a safe name (see cleanPathPart). A leading "/" or "./" and
 * the sandbox folder ("/sandbox/") are dropped. Null when it climbs out with
 * "..", is in a .git folder (only the git tool keeps those, apart from the
 * sandbox's files), is too deep or too long, or names nothing.
 */
export function cleanFilePath(raw: string): string | null {
  const parts = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/?sandbox\//, "")
    .split("/")
    .filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..") || parts.length > MAX_PATH_DEPTH) return null;
  if (parts.some((part) => part.toLowerCase() === ".git")) return null;
  const path = parts.map(cleanPathPart).join("/");
  return path.length <= MAX_PATH_LENGTH ? path : null;
}

/** "out/plot.png" -> "plot.png" */
export const baseName = (path: string) => path.split("/").pop() ?? path;

// Source code, and the files that build and set it up: work in the sandbox, not something to give the user
const CODE_EXTENSIONS = new Set([
  "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cc",
  "cs", "rb", "php", "swift", "sh", "bash", "zsh", "ps1", "bat", "sql", "r", "lua", "pl", "scala", "dart", "vue",
  "svelte", "dockerfile", "makefile", "gitignore", "env", "toml", "ini", "cfg", "conf",
]);

/** "src/main.py" -> true, "notes.md" -> false */
export const isCode = (name: string) => CODE_EXTENSIONS.has(extensionOf(name));

/**
 * Which of the files a tool call stored show in the chat, as cards below the
 * reply: those that a file tool made or changed, but no source code. Nothing
 * that a run of code made (a run of tests can make many charts and pages),
 * that was downloaded, that git checked out, or that edit_files changed (its
 * diff says what changed). Those stay in the sandbox panel. The model shows
 * an image in its reply's text, and gives any file with share_file.
 */
export function shownInChat(toolName: string, files: FileCard[]): FileCard[] {
  if (["run_code", "web_fetch", "install_packages", "git", "edit_files"].includes(toolName)) return [];
  return files.filter((f) => !isCode(f.name));
}

/**
 * The cards below a reply with `added` put in: each file shows once, as its
 * newest version, in the place where it first showed. A file is a name in the
 * sandbox (without case), so an edit or a run that changes a file, or sharing
 * one that shows already, does not add a card.
 */
export function withFileCards(cards: FileCard[], added: FileCard[]): FileCard[] {
  const out = [...cards];
  for (const card of added) {
    const i = out.findIndex((c) => c.name.toLowerCase() === card.name.toLowerCase());
    if (i >= 0) out[i] = card;
    else out.push(card);
  }
  return out;
}

/** A file name that is safe to store and show: no folders, control characters or reserved characters. */
export function cleanFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  const name = base.replace(/^\.+/, "") || "file";
  if (name.length <= MAX_NAME_LENGTH) return name;
  const ext = extensionOf(name);
  return `${name.slice(0, MAX_NAME_LENGTH - ext.length - 1)}.${ext}`;
}
