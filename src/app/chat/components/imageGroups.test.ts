// Tests of how the images in a reply's text show: through the markdown of a
// reply, rendered to HTML, with the image files of a sandbox.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FileCard } from "@/lib/files";
import { resolveImage } from "@/lib/inlineImages";
import MarkdownMessage from "./MarkdownMessage";
import { ReplyImagesContext } from "./ReplyImages";

const FILES: FileCard[] = [
  { id: "a", name: "a.png", mimeType: "image/png", size: 1 },
  { id: "b", name: "pics/b.jpg", mimeType: "image/jpeg", size: 1 },
  { id: "c", name: "c.webp", mimeType: "image/webp", size: 1 },
];

/** The HTML of `markdown` in a reply with FILES in its sandbox. */
function render(markdown: string, live = false): string {
  const value = { resolve: (src: string) => resolveImage(src, FILES), open: () => {}, live };
  return renderToStaticMarkup(createElement(ReplyImagesContext.Provider, { value }, createElement(MarkdownMessage, { content: markdown })));
}

const carousels = (html: string) => html.match(/aria-roledescription="carousel"/g)?.length ?? 0;
const slides = (html: string) => html.match(/aria-roledescription="slide"/g)?.length ?? 0;
const images = (html: string) => [...html.matchAll(/<img src="\/api\/attachments\/(\w+)"/g)].map((m) => m[1]);

describe("images in a reply's text", () => {
  it("shows an image that stands alone with its caption", () => {
    const html = render("Here it is:\n\n![The first](a.png)\n\nNice.");
    expect(carousels(html)).toBe(0);
    expect(images(html)).toEqual(["a"]);
    expect(html).toMatch(/<figure[^>]*><a[^>]*><img src="\/api\/attachments\/a" alt="The first"[^>]*><\/a><figcaption[^>]*>The first<\/figcaption><\/figure>/);
    expect(html).not.toMatch(/<p><figure/);
  });

  it("shows images on lines right after each other as one carousel", () => {
    const html = render("![one](a.png)\n![two](pics/b.jpg)\n![three](c.webp)");
    expect(carousels(html)).toBe(1);
    expect(slides(html)).toBe(3);
    // Each image in its slide, then a thumbnail of each, with the first one current
    expect(images(html)).toEqual(["a", "b", "c", "a", "b", "c"]);
    expect(html.match(/aria-label="Image \d: [^"]+" aria-current="(true|false)"/g)).toEqual([
      'aria-label="Image 1: one" aria-current="true"',
      'aria-label="Image 2: two" aria-current="false"',
      'aria-label="Image 3: three" aria-current="false"',
    ]);
    expect(html).toContain("1 / 3");
    // Nothing before the first image
    expect(html).toMatch(/<button[^>]*aria-label="Previous image" disabled=""/);
    expect(html).not.toMatch(/<button[^>]*aria-label="Next image" disabled=""/);
  });

  it("shows images with empty lines between them as one carousel too", () => {
    const html = render("Look:\n\n![one](a.png)\n\n![two](b.jpg)\n\nThat is all.");
    expect(carousels(html)).toBe(1);
    expect(slides(html)).toBe(2);
    expect(html).toContain("<p>Look:</p>");
    expect(html).toContain("<p>That is all.</p>");
  });

  it("makes two carousels of images that text stands between", () => {
    const html = render("![one](a.png)\n![two](b.jpg)\n\nBetween.\n\n![three](c.webp)\n![one again](a.png)");
    expect(carousels(html)).toBe(2);
  });

  it("shows an image within a line of text in that line", () => {
    const html = render("The logo ![small](a.png) is here.");
    expect(carousels(html)).toBe(0);
    expect(html).toMatch(/<p>The logo <a[^>]*><img src="\/api\/attachments\/a"[^>]*><\/a> is here\.<\/p>/);
  });

  it("shows an image in a table cell", () => {
    const html = render("| Name | Picture |\n|---|---|\n| A | ![a](a.png) |");
    expect(html).toMatch(/<td><a[^>]*><img src="\/api\/attachments\/a"/);
  });

  it("shows images side by side in a table cell as a carousel in that cell", () => {
    const html = render("| Name | Pictures |\n|---|---|\n| A | ![one](a.png) ![two](b.jpg) |\n| B | ![three](c.webp)<br>![one again](a.png) |");
    expect(html.match(/<td><figure[^>]*aria-roledescription="carousel"/g)?.length).toBe(2);
    expect(slides(html)).toBe(4);
    expect(html).not.toContain("&lt;br&gt;");
  });

  it("leaves one image, and images with text, in their table cell as they are", () => {
    const html = render("| A | B |\n|---|---|\n| ![one](a.png) | Look: ![two](b.jpg) ![three](c.webp) |");
    expect(carousels(html)).toBe(0);
    expect(images(html)).toEqual(["a", "b", "c"]);
  });

  it("makes a <br> tag a line break, and leaves other HTML as its text", () => {
    const html = render("| A |\n|---|\n| one<br>two<br/>three |\n\nAnd <b>this</b>.");
    expect(html).toContain("<td>one<br/>two<br/>three</td>");
    expect(html).toContain("And &lt;b&gt;this&lt;/b&gt;.");
  });

  it("shows an image from the web as a link, also among images of the sandbox", () => {
    const html = render("![web](https://a.example/x.png)\n![one](a.png)");
    expect(carousels(html)).toBe(0);
    expect(html).toContain('<a href="https://a.example/x.png" target="_blank" rel="nofollow noopener noreferrer">Image: web</a>');
    expect(html).not.toMatch(/<img src="https/);
  });

  it("takes a file name with a scheme a model puts before it", () => {
    expect(images(render("![one](sandbox:/mnt/data/a.png)"))).toEqual(["a"]);
  });

  it("shows the label of a name that matches no file once the reply is over, and leaves it out of the carousel", () => {
    const html = render("![one](a.png)\n![gone](missing.png)\n![two](b.jpg)");
    expect(slides(html)).toBe(2);
    expect(html).toContain("<p>Image: gone</p>");
    const single = render("![gone](missing.png)");
    expect(single).toContain("<p>Image: gone</p>");
    expect(single).not.toContain("<figure");
  });

  it("holds the place of a name that matches no file yet while the reply streams in", () => {
    const html = render("![one](a.png)\n![coming](new.png)", true);
    expect(slides(html)).toBe(2);
    expect(html).toMatch(/role="img" aria-label="coming"/);
    expect(render("Text ![coming](new.png)", true)).toMatch(/role="img" aria-label="coming"/);
  });

  it("shows no image outside a reply", () => {
    const html = renderToStaticMarkup(createElement(MarkdownMessage, { content: "![one](a.png)" }));
    expect(images(html)).toEqual([]);
    expect(html).toContain("Image: one");
  });
});
