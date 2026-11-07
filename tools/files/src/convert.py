"""Reading files: documents as markdown (MarkItDown), PDF pages and photos as
images a model takes (PDFium, Pillow)."""

import base64
import io
import warnings

import pypdfium2 as pdfium
from markitdown import MarkItDown, StreamInfo
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ImageContent, TextContent
from PIL import Image, ImageOps

from common import decode_text, extension, is_text

# MarkItDown's plugins and its online converters stay off: nothing leaves the server
_markitdown = MarkItDown(enable_plugins=False)

MAX_PDF_PAGES = 500
MAX_TEXT = 2_000_000  # characters of text one file gives at most
# A page with less text than this is taken for a scanned page
MIN_PAGE_TEXT = 20

# Rendered PDF pages and photos for the model: their longest side, in pixels
RENDER_SIDE = 1600
IMAGE_SIDE = 2048
# Photos up to this size, in a format every model takes, are sent as they are
IMAGE_KEEP_BYTES = 4 * 1024 * 1024
MODEL_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}
EXIF_ORIENTATION = 0x0112

# Images larger than this many pixels are refused (decompression bombs)
Image.MAX_IMAGE_PIXELS = 80_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def _open_pdf(raw: bytes) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(raw)
    except pdfium.PdfiumError:
        raise ToolError("This is not a PDF that can be read, or it has a password.")


def _markdown(raw: bytes, name: str) -> str:
    ext = extension(name)
    try:
        result = _markitdown.convert_stream(io.BytesIO(raw), stream_info=StreamInfo(extension=f".{ext}", filename=name))
    except Exception as err:  # MarkItDown raises its own errors, and those of the libraries below it
        raise ToolError(f"The file could not be read: {type(err).__name__}.")
    return (result.markdown or "").strip()


def _page_markdown(pdf: pdfium.PdfDocument, index: int) -> str:
    """One page as markdown: MarkItDown on a copy of the PDF with only that page, so tables come out as tables."""
    single = pdfium.PdfDocument.new()
    try:
        single.import_pages(pdf, [index])
        buffer = io.BytesIO()
        single.save(buffer)
    finally:
        single.close()
    return _markdown(buffer.getvalue(), "page.pdf")


def _page_text_length(page: pdfium.PdfPage) -> int:
    textpage = page.get_textpage()
    try:
        return len("".join(textpage.get_text_bounded().split()))
    finally:
        textpage.close()


def convert_pdf(raw: bytes) -> dict:
    """A PDF as markdown, page by page under '[Page n]' lines, with the pages that have no text."""
    pdf = _open_pdf(raw)
    try:
        count = len(pdf)
        parts: list[str] = []
        textless: list[int] = []
        length = 0
        for index in range(min(count, MAX_PDF_PAGES)):
            page = pdf[index]
            try:
                empty = _page_text_length(page) < MIN_PAGE_TEXT
            finally:
                page.close()
            if empty:
                textless.append(index + 1)
                parts.append(f"[Page {index + 1}: no text]")
                continue
            text = _page_markdown(pdf, index)
            parts.append(f"[Page {index + 1}]\n\n{text}")
            length += len(text)
            if length > MAX_TEXT:
                parts.append(f"[The rest, from page {index + 2}, is left out: the file has too much text.]")
                break
        if count > MAX_PDF_PAGES and length <= MAX_TEXT:
            parts.append(f"[Pages {MAX_PDF_PAGES + 1} to {count} are left out: the file has too many pages.]")
        return {"markdown": "\n\n".join(parts), "pages": count, "textless_pages": textless}
    finally:
        pdf.close()


def convert(name: str, raw: bytes) -> dict:
    """The file as the model reads it: text files as they are, documents as markdown."""
    ext = extension(name)
    if ext == "pdf":
        return convert_pdf(raw)
    if is_text(name) and ext != "ipynb":
        text = decode_text(raw)
    else:
        text = _markdown(raw, name)
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + "\n\n[The rest is left out: the file has too much text.]"
    return {"markdown": text}


def _jpeg(image: Image.Image, quality: int = 82) -> bytes:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=quality, optimize=True)
    return buffer.getvalue()


def _image_content(data: bytes, mime: str) -> ImageContent:
    return ImageContent(data=base64.b64encode(data).decode("ascii"), mime_type=mime)


def render_pdf(raw: bytes, pages: list[int]) -> list:
    """Images of `pages` (from 1) of the PDF, with a line that says which pages they show."""
    pdf = _open_pdf(raw)
    try:
        count = len(pdf)
        wanted = [p for p in dict.fromkeys(pages) if 1 <= p <= count]
        if not wanted:
            raise ToolError(f"The PDF has {count} pages; there are no pages {', '.join(map(str, pages))}.")
        images = []
        for number in wanted:
            page = pdf[number - 1]
            try:
                width, height = page.get_size()
                scale = min(RENDER_SIDE / max(width, height, 1), 4.0)
                bitmap = page.render(scale=scale)
                images.append(_image_content(_jpeg(bitmap.to_pil()), "image/jpeg"))
            finally:
                page.close()
        return [TextContent(text=f"pages: {', '.join(map(str, wanted))}"), *images]
    finally:
        pdf.close()


def prepare_image(raw: bytes) -> list:
    """The photo as a model takes it: 'unchanged', or a smaller JPEG (PNG with transparency)."""
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            rotated = opened.getexif().get(EXIF_ORIENTATION, 1) != 1
            large = max(opened.size) > IMAGE_SIDE
            if opened.format in MODEL_IMAGE_FORMATS and not large and not rotated and len(raw) <= IMAGE_KEEP_BYTES:
                return [TextContent(text="unchanged")]
            # Turned the way the camera held it, as models do not read the orientation tag
            image = ImageOps.exif_transpose(opened)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ToolError("The image is too large.")
    except OSError:
        raise ToolError("This is not an image that can be read.")
    image.thumbnail((IMAGE_SIDE, IMAGE_SIDE))
    transparent = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    if transparent:
        buffer = io.BytesIO()
        image.save(buffer, "PNG", optimize=True)
        data, mime = buffer.getvalue(), "image/png"
    else:
        data, mime = _jpeg(image, 85), "image/jpeg"
    return [TextContent(text=f"resized to {image.width}x{image.height}"), _image_content(data, mime)]
