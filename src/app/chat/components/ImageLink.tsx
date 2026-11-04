import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";

/**
 * Markdown images in what a model writes, shown as links instead. Showing the
 * image would make the browser fetch its URL, and a page an agent read could
 * get the model to write an image URL that carries conversation text to
 * someone else's server. A link is only fetched when the user clicks it.
 */
export default function ImageLink({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  const label = alt?.trim() ? `Image: ${alt.trim()}` : "Image";
  if (typeof src !== "string" || !src) return <>{label}</>;
  return (
    <a href={src} target="_blank" rel="nofollow noopener noreferrer">
      {label}
    </a>
  );
}
