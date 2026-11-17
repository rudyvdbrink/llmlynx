// What a file's bytes are, whatever its name says, for the types a name can
// get wrong: a web page saved as photo.jpg, or a WebP image as photo.png.

export type SniffedType = "png" | "jpg" | "gif" | "webp" | "pdf" | "html";

/** What `data` is, as an extension: an image, a PDF or a web page; null for anything else. */
export function sniffType(data: Buffer): SniffedType | null {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString("latin1");
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 1024).includes("%PDF-")) return "pdf";
  const start = data.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (/^(<!--[\s\S]*?-->\s*)*(<!doctype html|<html|<head)/.test(start)) return "html";
  return null;
}
