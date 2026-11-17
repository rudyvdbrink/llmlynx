"use client";

import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import chatStyles from "../../Chat.module.css";
import styles from "./Sandbox.module.css";
import MarkdownMessage from "../MarkdownMessage";
import { HtmlFrame } from "../FileCards";
import { DownloadIcon } from "@/components/icons";
import { parseDelimited } from "@/lib/delimited";
import { baseName, extensionOf, fileKind, formatSize, isHtml, isInlineImage, isSvg, typeLabel } from "@/lib/files";

// How much text one part of a long file is, and the most rows a table shows
const PART_CHARS = 200_000;
const MAX_ROWS = 1000;
const PDF_PAGES_AT_ONCE = 3;

const LANGUAGES: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript",
  tsx: "typescript", json: "json", jsonl: "json", html: "xml", htm: "xml", xml: "xml", svg: "xml", css: "css",
  scss: "scss", sh: "bash", bash: "bash", zsh: "bash", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  cfg: "ini", sql: "sql", go: "go", rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  cc: "cpp", cs: "csharp", rb: "ruby", php: "php", swift: "swift", r: "r", lua: "lua", pl: "perl", md: "markdown",
  dockerfile: "dockerfile", makefile: "makefile", ps1: "powershell", diff: "diff",
};

type TextPart = { id: string; text: string; total: number; pages?: number; error?: string };

/** A part of a file's text, from `start`. */
async function fetchText(id: string, start: number): Promise<TextPart> {
  try {
    const res = await fetch(`/api/attachments/${id}/text?start=${start}&length=${PART_CHARS}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.message || "The file could not be read");
    return { id, text: body.text, total: body.total, pages: body.pages };
  } catch (err) {
    return { id, text: "", total: 0, error: (err as Error).message };
  }
}

/** A file's text, a part at a time: `more` loads the next part. */
function useText(id: string) {
  const [state, setState] = useState<TextPart | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchText(id, 0).then((part) => !cancelled && setState(part));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const current = state?.id === id ? state : null;
  async function loadMore(from: TextPart) {
    setLoading(true);
    const part = await fetchText(id, from.text.length);
    setState((prev) => (prev?.id === id && !part.error ? { ...part, text: prev.text + part.text } : prev));
    setLoading(false);
  }
  const more = current && current.text.length < current.total ? () => loadMore(current) : null;
  return { text: current, loading, more };
}

function MoreButton({ onClick, loading, left }: { onClick: () => void; loading: boolean; left: number }) {
  return (
    <button type="button" className={styles.moreButton} onClick={onClick} disabled={loading}>
      {loading ? "Loading…" : `Load more (${left.toLocaleString()} characters left)`}
    </button>
  );
}

/** Text and code with line numbers and syntax colours; long lines scroll sideways. */
function CodeView({ id, name }: { id: string; name: string }) {
  const { text, loading, more } = useText(id);
  const language = LANGUAGES[extensionOf(name)];
  const content = text?.text ?? "";
  const html = useMemo(() => {
    if (!content) return "";
    try {
      return language ? hljs.highlight(content, { language, ignoreIllegals: true }).value : hljs.highlightAuto(content).value;
    } catch {
      return null;
    }
  }, [content, language]);
  if (!text) return <p className={styles.note}>Loading…</p>;
  if (text.error) return <p className={styles.note}>{text.error}</p>;
  const lines = text.text.split("\n").length;
  return (
    <div className={styles.codeScroll}>
      <div className={styles.code}>
        <pre className={styles.gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
        </pre>
        {html === null ? (
          <pre className={styles.codeText}>{text.text}</pre>
        ) : (
          // highlight.js escapes the text; its output only adds its own spans
          <pre className={`${styles.codeText} hljs`} dangerouslySetInnerHTML={{ __html: html || " " }} />
        )}
      </div>
      {more && <MoreButton onClick={more} loading={loading} left={text.total - text.text.length} />}
    </div>
  );
}

/** Plain text, wrapped: Word and PowerPoint files as the model sees them. */
function PlainView({ id }: { id: string }) {
  const { text, loading, more } = useText(id);
  if (!text) return <p className={styles.note}>Loading…</p>;
  if (text.error) return <p className={styles.note}>{text.error}</p>;
  return (
    <div className={styles.scroll}>
      <pre className={styles.plain}>{text.text || "(No text.)"}</pre>
      {more && <MoreButton onClick={more} loading={loading} left={text.total - text.text.length} />}
    </div>
  );
}

function MarkdownView({ id }: { id: string }) {
  const { text, loading, more } = useText(id);
  if (!text) return <p className={styles.note}>Loading…</p>;
  if (text.error) return <p className={styles.note}>{text.error}</p>;
  return (
    <div className={styles.scroll}>
      <div className={`${chatStyles.bubble} ${styles.markdown}`}>
        <MarkdownMessage content={text.text} />
      </div>
      {more && <MoreButton onClick={more} loading={loading} left={text.total - text.text.length} />}
    </div>
  );
}

function Table({ rows, more }: { rows: (string | number | boolean | null)[][]; more: boolean }) {
  if (!rows.length) return <p className={styles.note}>This sheet is empty.</p>;
  const [head, ...body] = rows;
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th key={i}>{cell === null ? "" : String(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i}>{cell === null ? "" : String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more && <p className={styles.note}>The first {MAX_ROWS.toLocaleString()} rows.</p>}
    </div>
  );
}

function CsvView({ id, delimiter }: { id: string; delimiter: string }) {
  const { text } = useText(id);
  const content = text?.text ?? "";
  const table = useMemo(() => (content ? parseDelimited(content, delimiter, MAX_ROWS) : null), [content, delimiter]);
  if (!text) return <p className={styles.note}>Loading…</p>;
  if (text.error) return <p className={styles.note}>{text.error}</p>;
  return <Table rows={table?.rows ?? []} more={!!table?.more || text.text.length < text.total} />;
}

type Sheets = { sheets: { name: string; rows: (string | number | boolean | null)[][]; more: boolean }[] };

/** An Excel workbook: a tab per sheet, each as a table. */
function SheetsView({ id }: { id: string }) {
  const [data, setData] = useState<{ id: string; sheets?: Sheets["sheets"]; error?: string } | null>(null);
  const [sheet, setSheet] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/attachments/${id}/sheets`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.message || "The workbook could not be read");
        return body as Sheets;
      })
      .then(
        (body) => !cancelled && setData({ id, sheets: body.sheets }),
        (err) => !cancelled && setData({ id, error: (err as Error).message })
      );
    return () => {
      cancelled = true;
    };
  }, [id]);
  const current = data?.id === id ? data : null;
  if (!current) return <p className={styles.note}>Loading…</p>;
  if (current.error || !current.sheets) return <p className={styles.note}>{current.error}</p>;
  const shown = current.sheets[Math.min(sheet, current.sheets.length - 1)];
  return (
    <div className={styles.sheets}>
      {current.sheets.length > 1 && (
        <div className={styles.sheetTabs} role="tablist" aria-label="Sheets">
          {current.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={s === shown}
              className={`${styles.sheetTab} ${s === shown ? styles.sheetTabActive : ""}`}
              onClick={() => setSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {shown ? <Table rows={shown.rows} more={shown.more} /> : <p className={styles.note}>The workbook has no sheets.</p>}
    </div>
  );
}

/** A PDF's pages as images, a few at a time, made by the files server's PDF renderer. */
function PdfView({ id }: { id: string }) {
  const { text } = useText(id);
  const [shown, setShown] = useState(PDF_PAGES_AT_ONCE);
  if (!text) return <p className={styles.note}>Loading…</p>;
  const pages = text.pages ?? 1;
  return (
    <div className={styles.scroll}>
      {Array.from({ length: Math.min(shown, pages) }, (_, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset
        <img key={i} className={styles.pdfPage} src={`/api/attachments/${id}/page?n=${i + 1}`} alt={`Page ${i + 1}`} loading="lazy" />
      ))}
      {shown < pages && (
        <button type="button" className={styles.moreButton} onClick={() => setShown((n) => n + PDF_PAGES_AT_ONCE)}>
          Show more pages ({pages - shown} left)
        </button>
      )}
    </div>
  );
}

function HtmlView({ id, name }: { id: string; name: string }) {
  const [source, setSource] = useState(false);
  return (
    <div className={styles.htmlView}>
      <div className={styles.switch} role="tablist" aria-label="Show">
        <button type="button" role="tab" aria-selected={!source} className={!source ? styles.switchActive : ""} onClick={() => setSource(false)}>
          Preview
        </button>
        <button type="button" role="tab" aria-selected={source} className={source ? styles.switchActive : ""} onClick={() => setSource(true)}>
          Source
        </button>
      </div>
      {source ? <CodeView id={id} name={name} /> : <HtmlFrame id={id} title={name} className={styles.frame} />}
    </div>
  );
}

/**
 * A preview of a version of a file, by its type: text and code with line
 * numbers and colours, markdown rendered, CSV and Excel as tables, images and
 * SVG as images, HTML in a sandboxed frame (with its source), PDF pages as
 * images, Word and PowerPoint as their text; anything else as what it is.
 */
export default function FilePreview({ id, name, mimeType, size }: { id: string; name: string; mimeType: string; size: number }) {
  const ext = extensionOf(name);
  if (isInlineImage(mimeType) || isSvg(mimeType)) {
    // eslint-disable-next-line @next/next/no-img-element -- an authenticated API image, not a static asset
    return <div className={`${styles.scroll} ${styles.imageScroll}`}><img className={styles.image} src={`/api/attachments/${id}`} alt={baseName(name)} /></div>;
  }
  if (isHtml(mimeType)) return <HtmlView id={id} name={name} />;
  if (ext === "md" || ext === "markdown") return <MarkdownView id={id} />;
  if (ext === "csv" || ext === "tsv") return <CsvView id={id} delimiter={ext === "tsv" ? "\t" : ","} />;
  if (ext === "xlsx" || ext === "xls") return <SheetsView id={id} />;
  if (ext === "pdf") return <PdfView id={id} />;
  if (ext === "docx" || ext === "pptx") return <PlainView id={id} />;
  if (fileKind(name) === "text") return <CodeView id={id} name={name} />;
  return (
    <div className={styles.other}>
      <p className={styles.otherName}>{baseName(name)}</p>
      <p className={styles.note}>
        {typeLabel(name)} · {formatSize(size)}
      </p>
      <a className={styles.otherDownload} href={`/api/attachments/${id}?download=1`} download={baseName(name)}>
        <DownloadIcon size={14} /> Download
      </a>
    </div>
  );
}

/** Where a preview opens full size, for images, SVG and HTML; null for other files. */
export function fullSizeUrl(id: string, mimeType: string): string | null {
  if (isInlineImage(mimeType) || isSvg(mimeType)) return `/api/attachments/${id}`;
  return isHtml(mimeType) ? `/view/${id}` : null;
}

