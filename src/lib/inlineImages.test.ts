// Tests of how the names of images in a reply's text are matched to the
// image files of the sandbox.

import { describe, expect, it } from "vitest";
import type { FileCard } from "./files";
import { imageRefs, isWebRef, markdownRef, normalizeRef, replyImages, resolveImage } from "./inlineImages";

const card = (id: string, name: string, mimeType = "image/png"): FileCard => ({ id, name, mimeType, size: 1 });

const FILES = [
  card("panda", "pandas/Red Panda.jpg", "image/jpeg"),
  card("chart", "out/chart.png"),
  card("chart2", "old/chart.png"),
  card("logo", "logo.svg", "image/svg+xml"),
  card("notes", "notes.png.txt", "text/plain"),
  card("report", "report.pdf", "application/pdf"),
];

describe("matching an image's source to a file", () => {
  it("takes the ways models write a file name", () => {
    for (const src of [
      "pandas/Red Panda.jpg",
      "PANDAS/red panda.JPG",
      "./pandas/Red Panda.jpg",
      "/pandas/Red Panda.jpg",
      "sandbox:/mnt/data/pandas/Red Panda.jpg",
      "file:///mnt/data/pandas/Red Panda.jpg",
      "attachment:pandas/Red Panda.jpg",
      "/sandbox/pandas/Red Panda.jpg",
      "pandas/Red%20Panda.jpg",
      "<pandas/Red Panda.jpg>",
      "  pandas/Red Panda.jpg  ",
    ]) {
      expect(resolveImage(src, FILES)?.id, src).toBe("panda");
    }
  });

  it("takes a base name that only one image file has, but not one that two have", () => {
    expect(resolveImage("Red Panda.jpg", FILES)?.id).toBe("panda");
    expect(resolveImage("logo.svg", FILES)?.id).toBe("logo");
    expect(resolveImage("chart.png", FILES)).toBeNull();
    expect(resolveImage("out/chart.png", FILES)?.id).toBe("chart");
  });

  it("matches only image files", () => {
    expect(resolveImage("report.pdf", FILES)).toBeNull();
    expect(resolveImage("notes.png.txt", FILES)).toBeNull();
    expect(resolveImage("missing.png", FILES)).toBeNull();
    expect(resolveImage("", FILES)).toBeNull();
  });

  it("never takes a URL from the web for a file", () => {
    for (const src of ["https://a.example/out/chart.png", "http://a.example/logo.svg", "//a.example/logo.svg", "data:image/png;base64,AAAA", "javascript:alert(1)"]) {
      expect(isWebRef(src), src).toBe(true);
      expect(resolveImage(src, FILES), src).toBeNull();
    }
    expect(isWebRef("sandbox:/mnt/data/a.png")).toBe(false);
    expect(isWebRef("out/chart.png")).toBe(false);
  });

  it("keeps a lone % in a name", () => {
    expect(normalizeRef("100%.png")).toBe("100%.png");
  });

  it("writes a name with spaces or brackets in angle brackets", () => {
    expect(markdownRef("chart.png")).toBe("chart.png");
    expect(markdownRef("my chart.png")).toBe("<my chart.png>");
    expect(markdownRef("chart(1).png")).toBe("<chart(1).png>");
  });
});

describe("the images of markdown text", () => {
  it("are found in order, with their alt text, and with a title or angle brackets", () => {
    const text = 'Look: ![A panda](pandas/panda.jpg) and ![ Chart ](<out/my chart.png> "The chart")\n\n![](logo.svg)';
    expect(imageRefs(text)).toEqual([
      { alt: "A panda", src: "pandas/panda.jpg" },
      { alt: "Chart", src: "<out/my chart.png>" },
      { alt: "", src: "logo.svg" },
    ]);
  });

  it("are not taken from code, also from a block that is not closed yet", () => {
    const text = [
      "![one](a.png)",
      "```markdown",
      "![two](b.png)",
      "```",
      "Write `![three](c.png)` for an image.",
      "~~~",
      "![four](d.png)",
      "~~~",
      "![five](e.png)",
      "```",
      "![six](f.png)",
    ].join("\n");
    expect(imageRefs(text).map((ref) => ref.alt)).toEqual(["one", "five"]);
  });
});

describe("what a reply shows of images", () => {
  const images = [card("panda", "pandas/panda.jpg", "image/jpeg"), card("chart", "chart.png")];

  it("goes through the text's images in order, each once, then the image cards, and leaves the shown files out of the cards", () => {
    const files = [card("chart", "chart.png"), card("plot", "plot.png"), card("data", "data.csv", "text/csv")];
    const { viewer, cards } = replyImages(["![The chart](chart.png)\n\n![A panda](panda.jpg) ![again](chart.png)"], images, files);
    expect(viewer.map((shown) => [shown.file.id, shown.name])).toEqual([
      ["chart", "The chart"],
      ["panda", "A panda"],
      ["plot", "plot.png"],
    ]);
    expect(cards.map((f) => f.id)).toEqual(["plot", "data"]);
  });

  it("leaves a card out by its name, also as a newer version than the one the text shows", () => {
    const { cards } = replyImages(["![](chart.png)"], images, [card("chart-new", "Chart.png")]);
    expect(cards).toEqual([]);
  });

  it("names an image without alt text by its file's base name", () => {
    const { viewer } = replyImages(["![](pandas/panda.jpg)"], images, []);
    expect(viewer[0].name).toBe("panda.jpg");
  });
});
