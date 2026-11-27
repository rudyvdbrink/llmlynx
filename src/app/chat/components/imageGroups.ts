// Images that stand alone in a reply's text. A run of paragraphs that hold
// only images (with line breaks and empty lines between them) becomes one
// <figure>, which MarkdownMessage shows as one image with its caption, or as
// a carousel when it holds two or more (see ImageFigure.tsx). So do two or
// more images that are all a table cell holds: a row of a table is one line,
// so they stand side by side in it. Markdown makes no <figure> of its own.
// Images from the web are left as they are: they show as links (see
// ImageLink.tsx), and so does a paragraph that holds one.
//
// A <br> tag in the text is a line break too. Other HTML shows as the text
// it is, but models write <br> in table cells, where a line break of the
// markdown would end the row.

import type { Element, ElementContent, Root, RootContent } from "hast";
import { isWebRef } from "@/lib/inlineImages";

type Node = RootContent | ElementContent;

const isWhitespace = (node: Node) => node.type === "text" && !node.value.trim();

const isBreak = (node: Node) => node.type === "element" && node.tagName === "br";

/** An image whose source can be a file of the sandbox. */
const isFileImage = (node: Node): node is Element =>
  node.type === "element" && node.tagName === "img" && typeof node.properties.src === "string" && !isWebRef(node.properties.src);

/** The images of an element that holds only such images and line breaks, or null. */
function onlyImages(node: Element): Element[] | null {
  const images: Element[] = [];
  for (const child of node.children) {
    if (isFileImage(child)) images.push(child);
    else if (!isWhitespace(child) && !isBreak(child)) return null;
  }
  return images.length ? images : null;
}

/** The images of a paragraph that holds only such images and line breaks, or null. */
const imagesOf = (node: Node) => (node.type === "element" && node.tagName === "p" ? onlyImages(node) : null);

const isCell = (node: Node): node is Element => node.type === "element" && (node.tagName === "td" || node.tagName === "th");

const BR_TAG = /^<br\s*\/?>$/i;

/** Makes each <br> tag of the text among the children of `parent`, and in theirs, a line break. */
function breaks(parent: Root | Element) {
  parent.children.forEach((child, i) => {
    if (child.type === "raw" && BR_TAG.test(child.value.trim())) {
      parent.children[i] = { type: "element", tagName: "br", properties: {}, children: [] };
    } else if (child.type === "element") breaks(child);
  });
}

const figureOf = (images: Element[]): Element => ({
  type: "element",
  tagName: "figure",
  properties: { dataLayout: images.length > 1 ? "carousel" : "single" },
  children: images,
});

/** Groups the runs among the children of `parent`, and in theirs, but not in code. */
function group(parent: Root | Element) {
  const out: Node[] = [];
  // The images of the run so far, and the white space after it, which stays when the run ends
  let run: Element[] = [];
  let gap: Node[] = [];
  const endRun = () => {
    if (run.length) out.push(figureOf(run), ...gap);
    run = [];
    gap = [];
  };
  for (const child of parent.children as Node[]) {
    const images = imagesOf(child);
    if (images) {
      run.push(...images);
      gap = [];
      continue;
    }
    if (run.length && isWhitespace(child)) {
      gap.push(child);
      continue;
    }
    endRun();
    const cellImages = isCell(child) ? onlyImages(child) : null;
    if (isCell(child) && cellImages && cellImages.length > 1) child.children = [figureOf(cellImages)];
    else if (child.type === "element" && child.tagName !== "pre" && child.tagName !== "code") group(child);
    out.push(child);
  }
  endRun();
  parent.children = out as typeof parent.children;
}

/** The rehype plugin. */
export default function rehypeImageGroups() {
  return (tree: Root) => {
    breaks(tree);
    group(tree);
  };
}
