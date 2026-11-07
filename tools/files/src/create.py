"""Making files: text files as given, documents from markdown with Pandoc
(Typst for PDF), and Excel workbooks with openpyxl."""

import io
import json
import os
import re
import subprocess
import tempfile

from mcp.server.mcpserver.exceptions import ToolError
from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

from common import extension, file_result, is_text, size_text

PANDOC_TIMEOUT_S = 90
MAX_SHEETS = 50
MAX_CELLS = 1_000_000
MAX_COLUMN_WIDTH = 60

# Markdown without raw HTML, TeX or other raw blocks: they could hand Typst code
# to the PDF engine, and do nothing useful in Word or PowerPoint
PANDOC_FROM = "markdown-raw_html-raw_tex-raw_attribute"

# Numbers that models send as text; "007" stays text
NUMBER = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$")
SHEET_NAME_FORBIDDEN = re.compile(r"[\[\]:*?/\\]")


def create_text(name: str, content: str) -> list:
    if not is_text(name):
        raise ToolError(f"{name} is not a text file.")
    ext = extension(name)
    if ext in ("json", "ipynb"):
        try:
            json.loads(content)
        except json.JSONDecodeError as err:
            raise ToolError(f"The content is not valid JSON: {err.msg} at line {err.lineno}, column {err.colno}.")
    if ext == "jsonl":
        for number, line in enumerate(content.splitlines(), 1):
            if line.strip():
                try:
                    json.loads(line)
                except json.JSONDecodeError as err:
                    raise ToolError(f"Line {number} is not valid JSON: {err.msg}.")
    data = content.encode("utf-8")
    return file_result(name, data, f"Created {name} ({size_text(len(data))}).")


def create_document(name: str, markdown: str) -> list:
    ext = extension(name)
    if ext not in ("docx", "pdf", "pptx"):
        raise ToolError("A document must end in .docx, .pdf or .pptx.")
    with tempfile.TemporaryDirectory() as folder:
        source = os.path.join(folder, "input.md")
        output = os.path.join(folder, f"output.{ext}")
        with open(source, "w", encoding="utf-8") as f:
            f.write(markdown)
        # --sandbox: Pandoc reads and writes only the files named here, so
        # links and images in the markdown cannot read files or fetch URLs
        args = ["pandoc", "--sandbox", "-f", PANDOC_FROM, "-o", output, source]
        if ext == "pdf":
            args += ["--pdf-engine=typst", "-V", "papersize=a4"]
        if ext == "pptx":
            args += ["--slide-level=2"]
        try:
            run = subprocess.run(
                args,
                cwd=folder,
                capture_output=True,
                text=True,
                timeout=PANDOC_TIMEOUT_S,
                env={"PATH": os.environ.get("PATH", ""), "HOME": folder, "TMPDIR": folder},
            )
        except subprocess.TimeoutExpired:
            raise ToolError("Making the document took too long.")
        if run.returncode != 0 or not os.path.exists(output):
            detail = (run.stderr or run.stdout).strip().splitlines()
            raise ToolError("The document could not be made" + (f": {detail[-1][:300]}" if detail else "."))
        with open(output, "rb") as f:
            data = f.read()
    return file_result(name, data, f"Created {name} ({size_text(len(data))}).")


def cell_value(value):
    """A cell from what the model sent: numbers in text become numbers, text that starts with = is a formula."""
    if value is None or isinstance(value, bool) or isinstance(value, (int, float)):
        return value
    text = ILLEGAL_CHARACTERS_RE.sub("", str(value))
    if NUMBER.match(text.strip()):
        number = float(text)
        return int(number) if number.is_integer() and "." not in text and "e" not in text.lower() else number
    return text


def _sheet_title(raw: str, used: set[str]) -> str:
    title = SHEET_NAME_FORBIDDEN.sub("", raw).strip().strip("'")[:31] or "Sheet"
    candidate, n = title, 2
    while candidate.lower() in used:
        suffix = f" ({n})"
        candidate, n = title[: 31 - len(suffix)] + suffix, n + 1
    used.add(candidate.lower())
    return candidate


def create_spreadsheet(name: str, sheets: list[dict]) -> list:
    if extension(name) != "xlsx":
        raise ToolError("A workbook must end in .xlsx.")
    if not sheets:
        raise ToolError("Give at least one sheet.")
    if len(sheets) > MAX_SHEETS:
        raise ToolError(f"At most {MAX_SHEETS} sheets.")
    cells = sum(len(row) for sheet in sheets for row in sheet.get("rows", []) if isinstance(row, list))
    if cells > MAX_CELLS:
        raise ToolError("The workbook has too many cells.")

    workbook = Workbook()
    workbook.remove(workbook.active)
    used: set[str] = set()
    for index, sheet in enumerate(sheets, 1):
        rows = sheet.get("rows") or []
        worksheet = workbook.create_sheet(_sheet_title(str(sheet.get("name") or f"Sheet{index}"), used))
        widths: dict[int, int] = {}
        for row in rows:
            values = [cell_value(v) for v in (row if isinstance(row, list) else [row])]
            worksheet.append(values)
            for column, value in enumerate(values, 1):
                shown = len(str(value)) if value is not None and not str(value).startswith("=") else 8
                widths[column] = max(widths.get(column, 0), shown)
        if rows:
            for cell in worksheet[1]:
                cell.font = Font(bold=True)
            if len(rows) > 1:
                worksheet.freeze_panes = "A2"
        for column, width in widths.items():
            worksheet.column_dimensions[get_column_letter(column)].width = min(MAX_COLUMN_WIDTH, max(8, width + 2))
    buffer = io.BytesIO()
    workbook.save(buffer)
    data = buffer.getvalue()
    return file_result(name, data, f"Created {name} with {len(sheets)} sheet{'s' if len(sheets) != 1 else ''} ({size_text(len(data))}).")
