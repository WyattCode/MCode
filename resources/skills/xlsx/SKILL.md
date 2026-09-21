---
name: xlsx
description: Build, read, fix and check spreadsheets (.xlsx, .xlsm, .xltx, .csv, .tsv). Use whenever a workbook is the input or the deliverable - financial models, trackers, reports with totals, cleaned-up exports - or the user asks to add columns, compute with formulas, reshape messy tabular data, or turn a sheet into CSV.
aliases:
  - excel
  - spreadsheet
---

# Spreadsheets

**Which Python.** When the `MCODE_PYTHON` environment variable is set, use that
interpreter wherever this skill says `python`: `"$MCODE_PYTHON" scripts/...` in
bash, `& $env:MCODE_PYTHON scripts/...` in PowerShell. MCode ships it with
python-docx, python-pptx, openpyxl, pandas, pypdf, pypdfium2, reportlab, lxml and
Pillow installed, so the install checks below can be skipped. It has no pip
console scripts; run tools as modules (`-m`).

Read a workbook before changing it, keep calculations as formulas, and check the
file you produce.

## Reading

```
python scripts/xlsx_dump.py "book.xlsx"              # every sheet
python scripts/xlsx_dump.py "book.xlsx" --sheet Data  # one sheet
```

Run it from this skill's folder with the bash tool. It prints each cell as
`B5 = 3750   [=SUM(B2:B4)]`, so you see both values and the formulas behind them.
For CSV or TSV, read the file directly, or profile it with the data-analytics
skill's `profile_table.py`.

## Writing

1. Use openpyxl (`python -c "import openpyxl"`; ask before installing it with
   `python -m pip install openpyxl`). pandas is fine for reshaping data, but write
   the final workbook with openpyxl so formulas and formatting survive.
2. Put inputs in cells and calculations in formulas (`ws["B5"] = "=SUM(B2:B4)"`),
   never numbers you computed in Python. Someone changing an input should see the
   totals follow.
3. Keep one kind of thing per sheet: raw data, assumptions, calculations, summary.
   Give headers a bold style, freeze the header row, set sensible column widths
   and number formats (currency, percent, dates).
4. When editing a file the user gave you, load it with `openpyxl.load_workbook`
   (not `data_only=True`, which drops formulas), change only what was asked, and
   save under a new name unless told to overwrite. `.xlsm` files need
   `keep_vba=True`.

## Checking

- openpyxl does not calculate formulas. If LibreOffice is installed, recalculate
  and export a copy (`soffice --headless --convert-to xlsx --outdir checked book.xlsx`),
  then dump the copy and look for `#REF!`, `#DIV/0!`, `#NAME?` or `#VALUE!`.
- Without LibreOffice, dump the file, read every formula you wrote, and check the
  ranges point at the right rows.
- `python scripts/check_ooxml.py "book.xlsx"` confirms the package is sound.

## Handing it over

Call `present_files` with the workbook so it opens in the side panel. Summarise
what each sheet holds in a sentence or two instead of pasting the data.
