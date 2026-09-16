---
name: pptx
description: Create, read, edit and check PowerPoint presentations (.pptx). Use whenever a deck is the input or the deliverable - pitch decks, reviews, training slides, a presentation filled from a template - or the user wants a deck's text or notes pulled out, slides reordered or restyled, or a presentation converted to PDF or images.
aliases:
  - powerpoint
  - slides
  - deck
---

# Presentations

**Which Python.** When the `MCODE_PYTHON` environment variable is set, use that
interpreter wherever this skill says `python`: `"$MCODE_PYTHON" scripts/...` in
bash, `& $env:MCODE_PYTHON scripts/...` in PowerShell. MCode ships it with
python-docx, python-pptx, openpyxl, pandas, pypdf, pypdfium2, reportlab, lxml and
Pillow installed, so the install checks below can be skipped. It has no pip
console scripts; run tools as modules (`-m`).

Plan the story first, then build slides with python-pptx, then look at what you
built. A deck is judged by its pages, so checking visually matters here.

## Reading a deck

```
python scripts/pptx_outline.py "deck.pptx"
```

Run it from this skill's folder with the bash tool. It lists every slide's title,
text, tables, layout name and speaker notes (`--no-notes` leaves notes out).

## Planning

Before writing code, write the outline in your reply or in a scratch file: one
line per slide saying the point it makes. Aim for one idea per slide, a title
that states the takeaway ("Costs fell 12% after the move", not "Costs"), and
roughly 10-15 slides unless told otherwise. When the design matters, load the
design-blueprint skill first.

## Building

1. Check python-pptx (`python -c "import pptx"`); ask before installing it with
   `python -m pip install python-pptx`.
2. Write the build script into the project and run it with bash; keep it so the
   deck can be rebuilt.
3. With a template, open it (`Presentation("template.pptx")`) and add slides from
   its layouts (`prs.slide_layouts`), filling placeholders rather than drawing
   free text boxes, so the template's fonts and colours carry through.
4. Without a template, set 16:9 (`prs.slide_width = Inches(13.333)`,
   `prs.slide_height = Inches(7.5)`), pick two fonts and a small palette, and use
   them on every slide.
5. Keep text short: at most about six bullets of a line each. Put detail in the
   speaker notes (`slide.notes_slide.notes_text_frame.text`).
6. Charts: use python-pptx's native charts (`add_chart`) so they stay editable;
   images only for photos and diagrams.

## Checking

- `python scripts/check_ooxml.py "deck.pptx"` confirms the package is sound.
- Run the outline script on the result and compare it with your plan.
- If LibreOffice is installed, export a PDF
  (`soffice --headless --convert-to pdf deck.pptx`) and read pages with the read
  tool to catch text running off slides or overlapping shapes. Fix and rebuild.

## Handing it over

Call `present_files` with the deck (and the PDF if you made one). Give the user
the outline in a few lines, not the slide text.
