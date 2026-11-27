// Images a model shows in the text of its reply: markdown images whose source
// is the name of an image file of the conversation's sandbox, such as
// ![A red panda](pandas/panda.jpg). An image URL from the web is never shown
// as an image (see ImageLink.tsx). Models write file names in many ways, so a
// name is matched leniently. The server matches the names of each step it
// stores (server/chat/conversation.ts), and the chat view those of the reply
// it shows (Reply.tsx), with the same function, so both show the same file.

import { baseName, isInlineImage, isSvg, type FileCard } from "./files";

/** An image file, which the chat shows as an image: the same test as the file cards. */
export const isImageFile = (file: { mimeType: string }) => isInlineImage(file.mimeType) || isSvg(file.mimeType);

/** A source that is not a file of the sandbox: a web URL, a data URL or such. */
export const isWebRef = (src: string) => /^\s*<?\s*(?:\/\/|(?:https?|ftp|data|blob|javascript|mailto):)/i.test(src);

/**
 * The file name in an image's source, as the model wrote it: without angle
 * brackets, URL escapes, a "sandbox:", "file:" or "attachment:" scheme, and a
 * leading /mnt/data/, /sandbox/, ./ or /.
 */
export function normalizeRef(src: string): string {
  let ref = src.trim();
  if (ref.startsWith("<") && ref.endsWith(">")) ref = ref.slice(1, -1).trim();
  try {
    ref = decodeURIComponent(ref);
  } catch {
    // A lone % is part of the name
  }
  return ref
    .replace(/^(?:sandbox|file|attachment):/i, "")
    .replace(/^\/*(?:mnt\/data\/|sandbox\/)/i, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .trim();
}

/**
 * The image file of `files` that the image source `src` names, or null: the
 * file with that path (without case), or else the only image file with that
 * base name.
 */
export function resolveImage<File extends { name: string; mimeType: string }>(src: string, files: readonly File[]): File | null {
  if (isWebRef(src)) return null;
  const ref = normalizeRef(src).toLowerCase();
  if (!ref) return null;
  const images = files.filter(isImageFile);
  const exact = images.find((f) => f.name.toLowerCase() === ref);
  if (exact) return exact;
  const base = baseName(ref);
  const same = images.filter((f) => baseName(f.name).toLowerCase() === base);
  return same.length === 1 ? same[0] : null;
}

/** How a file name goes in a markdown image, such as ![caption](<my chart.png>): in angle brackets when it has spaces or brackets. */
export const markdownRef = (name: string) => (/[\s()<>]/.test(name) ? `<${name}>` : name);

/** An image in markdown text: its source and its alt text. */
export type ImageRef = { src: string; alt: string };

const IMAGE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/**
 * The images of markdown text, in order, without those in code: fenced
 * blocks (also one that is not closed yet, as while a reply streams in) and
 * inline code.
 */
export function imageRefs(markdown: string): ImageRef[] {
  const text = markdown
    .replace(/^[ \t]*(```+|~~~+)[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, "")
    .replace(/`+[^`\n]*`+/g, "");
  return [...text.matchAll(IMAGE)].map((m) => ({ alt: m[1].trim(), src: m[2] }));
}

/** An image the chat view shows for a reply: its file, and its name in the viewer. */
export type ShownImage = { file: FileCard; name: string };

/**
 * What a reply shows of images. `viewer`: the images its text shows, in
 * order and each file once, then the images among its file cards, as the
 * viewer goes through them. `cards`: its file cards, without the files its
 * text shows. `texts` are the reply's texts, `images` the image files their
 * names are matched against, and `files` the reply's file cards.
 */
export function replyImages(
  texts: readonly string[],
  images: readonly FileCard[],
  files: readonly FileCard[]
): { viewer: ShownImage[]; cards: FileCard[] } {
  const inline: ShownImage[] = [];
  for (const ref of texts.flatMap(imageRefs)) {
    const file = resolveImage(ref.src, images);
    if (file && !inline.some((shown) => shown.file.id === file.id)) inline.push({ file, name: ref.alt || baseName(file.name) });
  }
  const shownNames = new Set(inline.map((shown) => shown.file.name.toLowerCase()));
  const cards = files.filter((f) => !shownNames.has(f.name.toLowerCase()));
  const cardImages = cards.filter(isImageFile).map((file) => ({ file, name: baseName(file.name) }));
  return { viewer: [...inline, ...cardImages], cards };
}
