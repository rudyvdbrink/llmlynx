"""Editing files in place: text replacements in text files, and in the text of
Word (python-docx), PowerPoint (python-pptx) and Excel (openpyxl) files,
whose formatting stays as it is. Excel cells can also be set.

Each edit's text must occur exactly once, unless the edit says `all`. The
edits are checked before anything is written: a call with one bad edit makes
no file.
"""

import io
import re
import zipfile

from docx import Document
from mcp.server.mcpserver.exceptions import ToolError
from openpyxl import load_workbook
from openpyxl.utils.cell import coordinate_from_string
from pptx import Presentation

from common import decode_text, extension, file_result, is_text, size_text
from create import cell_value

# What markdown adds that the file itself does not have: the model often copies
# text from the markdown it read, so a find that does not occur is tried without it
MARKDOWN_ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>~])")
MARKDOWN_EMPHASIS = re.compile(r"(\*\*|__|\*|_|`)(.+?)\1")


def _variants(find: str) -> list[str]:
    plain = MARKDOWN_ESCAPE.sub(r"\1", find)
    bare = MARKDOWN_EMPHASIS.sub(r"\2", plain)
    return list(dict.fromkeys([find, plain, bare]))


class _Runs:
    """The text of one paragraph, made of runs that each have their own formatting."""

    def __init__(self, runs):
        self.runs = list(runs)

    def text(self) -> str:
        return "".join(r.text for r in self.runs)

    def replace(self, find: str, replace: str, limit: int | None) -> int:
        """Replaces `find`; the new text takes the formatting of the run where the match starts."""
        done = 0
        start = 0
        while limit is None or done < limit:
            texts = [r.text for r in self.runs]
            full = "".join(texts)
            at = full.find(find, start)
            if at < 0:
                break
            end = at + len(find)  # exclusive
            position = 0
            first = last = None
            for i, t in enumerate(texts):
                if first is None and at < position + len(t):
                    first = (i, at - position)
                if end <= position + len(t):
                    last = (i, end - position)
                    break
                position += len(t)
            if first is None or last is None:  # an empty find, or text the runs do not hold
                break
            (fi, fo), (li, lo) = first, last
            if fi == li:
                self.runs[fi].text = texts[fi][:fo] + replace + texts[fi][lo:]
            else:
                self.runs[fi].text = texts[fi][:fo] + replace
                for i in range(fi + 1, li):
                    self.runs[i].text = ""
                self.runs[li].text = texts[li][lo:]
            start = at + len(replace)
            done += 1
        return done


def _docx_paragraphs(document):
    def from_cells(tables):
        for table in tables:
            for row in table.rows:
                for cell in row.cells:
                    yield from cell.paragraphs
                    yield from from_cells(cell.tables)

    yield from document.paragraphs
    yield from from_cells(document.tables)
    for section in document.sections:
        for part in (section.header, section.footer, section.first_page_header, section.first_page_footer):
            if part.is_linked_to_previous:
                continue
            yield from part.paragraphs
            yield from from_cells(part.tables)


def _pptx_paragraphs(presentation):
    def from_shapes(shapes):
        for shape in shapes:
            if shape.shape_type == 6:  # a group
                yield from from_shapes(shape.shapes)
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                yield from shape.text_frame.paragraphs
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        yield from cell.text_frame.paragraphs

    for slide in presentation.slides:
        yield from from_shapes(slide.shapes)
        if slide.has_notes_slide:
            yield from slide.notes_slide.notes_text_frame.paragraphs


def _check(number: int, find: str, count: int, all_of_them: bool):
    if count == 0:
        raise ToolError(
            f"Edit {number}: this text was not found: {find[:120]!r}. Copy the text exactly as the file has it"
            " (without markdown formatting), within one paragraph or cell."
        )
    if count > 1 and not all_of_them:
        raise ToolError(
            f"Edit {number}: this text occurs {count} times: {find[:120]!r}. Give more of the text around it,"
            " or set all to true to replace every occurrence."
        )


def _apply(edits: list[dict], paragraphs: list) -> int:
    """Makes the edits in `paragraphs` (each a _Runs or _CellText), in order. Returns how many replacements were made."""
    made = 0
    for number, edit in enumerate(edits, 1):
        all_of_them = bool(edit.get("all"))
        find = edit["find"]
        count = 0
        for variant in _variants(find):
            count = sum(p.text().count(variant) for p in paragraphs)
            if count:
                find = variant
                break
        _check(number, edit["find"], count, all_of_them)
        left = None if all_of_them else 1
        for paragraph in paragraphs:
            done = paragraph.replace(find, edit["replace"], left)
            made += done
            if left is not None:
                left -= done
                if left <= 0:
                    break
    return made


def _edit_text(raw: bytes, edits: list[dict]) -> bytes:
    text = decode_text(raw)
    for number, edit in enumerate(edits, 1):
        find = edit["find"]
        count = text.count(find)
        if count == 0:
            # Line ends in the file may be \r\n where the model wrote \n
            crlf = find.replace("\n", "\r\n")
            if "\r\n" in text and text.count(crlf):
                find, count = crlf, text.count(crlf)
        _check(number, edit["find"], count, bool(edit.get("all")))
        replace = edit["replace"].replace("\n", "\r\n") if find != edit["find"] else edit["replace"]
        text = text.replace(find, replace, -1 if edit.get("all") else 1)
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    return bom + text.encode("utf-8")


def _set_cells(workbook, cells: list[dict]) -> int:
    for item in cells:
        ref = str(item.get("cell") or "").strip()
        sheet_name, _, address = ref.rpartition("!")
        sheet_name = sheet_name.strip("'")
        if sheet_name:
            matches = [ws for ws in workbook.worksheets if ws.title.lower() == sheet_name.lower()]
            if not matches:
                names = ", ".join(ws.title for ws in workbook.worksheets)
                raise ToolError(f"There is no sheet named {sheet_name}. The sheets are: {names}.")
            worksheet = matches[0]
        else:
            worksheet = workbook.worksheets[0]
        try:
            coordinate_from_string(address.upper())
        except ValueError:
            raise ToolError(f"Not a cell: {ref!r}. Use a cell such as B3 or Sheet1!B3.")
        worksheet[address.upper()].value = cell_value(item.get("value"))
    return len(cells)


def edit_file(name: str, raw: bytes, edits: list[dict], cells: list[dict], new_name: str | None) -> list:
    ext = extension(name)
    target = new_name or name
    notes = []
    if is_text(name):
        if cells:
            raise ToolError("cells only work on Excel (.xlsx) files.")
        data = _edit_text(raw, edits)
        summary = f"{len(edits)} edit{'s' if len(edits) != 1 else ''}"
    elif ext == "docx":
        document = Document(io.BytesIO(raw))
        made = _apply(edits, [_Runs(p.runs) for p in _docx_paragraphs(document)])
        buffer = io.BytesIO()
        document.save(buffer)
        data, summary = buffer.getvalue(), f"{made} replacement{'s' if made != 1 else ''}"
    elif ext == "pptx":
        presentation = Presentation(io.BytesIO(raw))
        made = _apply(edits, [_Runs(p.runs) for p in _pptx_paragraphs(presentation)])
        buffer = io.BytesIO()
        presentation.save(buffer)
        data, summary = buffer.getvalue(), f"{made} replacement{'s' if made != 1 else ''}"
    elif ext == "xlsx":
        workbook = load_workbook(io.BytesIO(raw))
        text_cells = [
            _CellText(cell)
            for worksheet in workbook.worksheets
            for row in worksheet.iter_rows()
            for cell in row
            if isinstance(cell.value, str)
        ]
        made = _apply(edits, text_cells) if edits else 0
        set_count = _set_cells(workbook, cells)
        buffer = io.BytesIO()
        workbook.save(buffer)
        data = buffer.getvalue()
        parts = [f"{made} replacement{'s' if made != 1 else ''}"] if edits else []
        if cells:
            parts.append(f"{set_count} cell{'s' if set_count != 1 else ''} set")
        summary = ", ".join(parts)
        # openpyxl does not keep charts and pictures of a workbook it opens
        with zipfile.ZipFile(io.BytesIO(raw)) as original:
            if any(n.startswith(("xl/charts/", "xl/drawings/", "xl/media/")) for n in original.namelist()):
                notes.append("Note: the workbook's charts and pictures could not be kept in the new version; tell the user.")
    else:
        raise ToolError(f"{name} cannot be edited.")
    text = f"Edited {name}: {summary}. The new version is {target} ({size_text(len(data))})."
    return file_result(target, data, " ".join([text, *notes]))


class _CellText:
    """An Excel cell's text, edited like a paragraph of one run."""

    def __init__(self, cell):
        self.cell = cell

    def text(self) -> str:
        return self.cell.value

    def replace(self, find: str, replace: str, limit: int | None) -> int:
        value = self.cell.value
        count = value.count(find) if limit is None else min(value.count(find), limit)
        if count:
            self.cell.value = value.replace(find, replace, -1 if limit is None else count)
        return count
