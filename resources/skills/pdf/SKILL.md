---
name: pdf
description: Read, create, combine, split, rotate and fill PDF files. Use whenever a PDF is the input or the deliverable - extracting text or tables, answering questions about a paper or a contract, merging or reordering pages, producing a report, invoice or certificate as PDF, filling a form - or when the user points at a passage in a PDF.
---

# PDF files

**Which Python.** When the `MCODE_PYTHON` environment variable is set, use that
interpreter wherever this skill says `python`: `"$MCODE_PYTHON" scripts/...` in
bash, `& $env:MCODE_PYTHON scripts/...` in PowerShell. MCode ships it with
python-docx, python-pptx, openpyxl, pandas, pypdf, pypdfium2, reportlab, lxml and
Pillow installed, so the install checks below can be skipped. It has no pip
console scripts; run tools as modules (`-m`).

## Reading

- The read tool can open a PDF directly when the model supports it; for long
  files, pull text page by page instead:
  `python scripts/pdf_tool.py text "file.pdf" --pages 1-5`
- `python scripts/pdf_tool.py info "file.pdf"` shows page count, size, metadata,
  encryption and form fields - run it first on an unfamiliar file.
- No text comes back from a scanned PDF. Say so, and offer OCR (for example
  `ocrmypdf`, if the user installs it) rather than guessing at the content.
- Tables: extracted text loses columns. When layout matters, try `pdfplumber`
  (ask before installing it) and check a few rows against the page.

Run the script from this skill's folder with the bash tool. It needs pypdf
(`python -m pip install pypdf`) and says so when it is missing - ask before
installing.

## Pointing at a passage

When your answer rests on a specific passage, call `pdf_locate` with the file, a
short fragment copied exactly as it appears in the PDF, and its page number. The
side panel opens the PDF at that place so the user can see the source.

## Changing pages

```
python scripts/pdf_tool.py merge out.pdf a.pdf b.pdf
python scripts/pdf_tool.py pages in.pdf excerpt.pdf --pages 2-5
python scripts/pdf_tool.py split in.pdf pages/
python scripts/pdf_tool.py rotate in.pdf turned.pdf --degrees 90 --pages 1,3
```

Inputs are never overwritten; write outputs under new names in the project.

## Creating a PDF

- From a document you write: build it as HTML (or Markdown turned into HTML) and
  print it with a headless browser, or write a Word file with the docx skill and
  convert it with LibreOffice (`soffice --headless --convert-to pdf`).
- From code: reportlab gives exact control over layout (ask before installing it).
- Put the generating script in the project so the PDF can be rebuilt.

## Forms

`info` lists the form fields. Fill them with pypdf's
`PdfWriter.update_page_form_field_values`, then open the result to check the
values show. A form with no fields needs text drawn onto the page instead.

## Checking and handing over

Re-run `info` and `text` on what you produced, and look at a page or two with
the read tool. Then call `present_files` with the PDF so it opens in the side
panel, and say in one line what it contains.
