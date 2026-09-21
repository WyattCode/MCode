---
name: docx
description: Create, read, edit and check Microsoft Word documents (.docx, .dotx). Use whenever a Word file is the input or the deliverable - reports, letters, contracts, proposals, filled templates - or when the user wants text, headings or tables pulled out of one, a document restructured, or a Word file converted to PDF.
aliases:
  - word
---

# Word documents

**Which Python.** When the `MCODE_PYTHON` environment variable is set, use that
interpreter wherever this skill says `python`: `"$MCODE_PYTHON" scripts/...` in
bash, `& $env:MCODE_PYTHON scripts/...` in PowerShell. MCode ships it with
python-docx, python-pptx, openpyxl, pandas, pypdf, pypdfium2, reportlab, lxml and
Pillow installed, so the install checks below can be skipped. It has no pip
console scripts; run tools as modules (`-m`).

A .docx file is a zip of XML parts. Read it with the script below, write it with
python-docx, and always check the result before handing it over.

## Reading a document

Run the extractor from this skill's folder with the bash tool:

```
python scripts/docx_text.py "path/to/file.docx"
```

It prints headings as `#` lines, list items as `- ` lines, tables as `| a | b |`
rows and the style of other styled paragraphs in brackets. Add `--max-chars 20000`
for long documents. Use it before editing so you know the structure and styles.

## Writing or editing a document

1. Check that python-docx is available: `python -c "import docx"`. If it is not,
   ask before installing it (`python -m pip install python-docx`).
2. Write a short script into the project (for example `build_report.py`) and run
   it with bash. Keep the script, so the document can be rebuilt after changes.
3. When editing an existing file, open it with `docx.Document(path)` and change
   paragraphs and runs in place; save to a new name unless the user asked to
   overwrite. A template keeps its look only if you reuse its styles
   (`paragraph.style = "Heading 1"`) instead of setting fonts by hand.
4. Use real structure: heading styles for headings, `add_table` with a table
   style for tables, list styles for lists, page breaks rather than blank lines.

## Checking the result

- `python scripts/check_ooxml.py "out.docx"` confirms the package is sound.
- Run `docx_text.py` on the output and read it back against the request.
- To see the pages, convert with LibreOffice when it is installed
  (`soffice --headless --convert-to pdf out.docx`) and look at the PDF.

## Handing it over

Call `present_files` with the finished document (and the PDF, if you made one)
so the user can open it in the side panel. Say in one line what the document
contains; do not paste its text into the reply.

## Pitfalls

- Text split across runs: a phrase may be spread over several `w:r` elements, so
  search the paragraph's full text, then rewrite its runs.
- Do not build a .docx by writing XML strings unless python-docx cannot express
  the change; if you must, change a copy and run the checker.
- `.doc` (the old binary format) cannot be read this way; convert it with
  LibreOffice first.
