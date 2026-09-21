---
name: data-analytics
description: Analyse data to answer a question with evidence - data quality checks, metric breakdowns, KPI reports, trend and cohort analysis, charts, dashboards, and a written finding with a recommendation. Use when the user hands over a CSV, spreadsheet or database export and asks what it shows, why a number moved, or for a report built from it.
aliases:
  - analytics
  - data-analysis
---

# Data analysis

**Which Python.** When the `MCODE_PYTHON` environment variable is set, use that
interpreter wherever this skill says `python`: `"$MCODE_PYTHON" scripts/...` in
bash, `& $env:MCODE_PYTHON scripts/...` in PowerShell. MCode ships it with
python-docx, python-pptx, openpyxl, pandas, pypdf, pypdfium2, reportlab, lxml and
Pillow installed, so the install checks below can be skipped. It has no pip
console scripts; run tools as modules (`-m`).

Work from the question to the evidence, and show every number's source.

## 1. Pin down the question

Restate what is being asked in one sentence, which metric answers it, over which
period and population. If a definition is genuinely ambiguous ("active user",
"revenue" gross or net), ask with the question tool before computing anything.

## 2. Look at the data before trusting it

```
python scripts/profile_table.py "data.csv"
```

Run it from this skill's folder with the bash tool. Note blanks, columns that are
mostly but not entirely numeric, mixed date formats, duplicates and ragged rows.
For .xlsx inputs, use the xlsx skill's dump script first, or read the sheet with
pandas. Write down each cleaning decision you make; it goes into the report.

## 3. Compute in a script

- Write the analysis as a Python script in the project (pandas when available;
  ask before installing it) and run it with bash. Keep the script: it is the
  audit trail and lets the numbers be regenerated.
- Check totals against the raw data (row counts, sums) after every join or filter.
- Compare like with like: same period length, same population, and say when a
  difference is too small or the sample too thin to mean much.

## 4. Chart what matters

- One chart per finding. Bar charts for comparisons, lines for time, scatter for
  relationships; no pies beyond three slices, no 3D.
- Title each chart with the finding, label axes with units, start value axes at
  zero for bars.
- Save charts as PNG or SVG files with matplotlib; small diagrams can go straight
  into the reply as a ```mermaid or ```svg block (see the visualizer skill).

## 5. Write it up

Lead with the answer, then the two or three findings that support it, each with
its number and chart, then caveats (data gaps, assumptions, cleaning), then what
to do next. If a deliverable file was asked for, produce it (Markdown, HTML, or a
workbook via the xlsx skill) and call `present_files` with it.

For multi-step work, track the steps with the task tool.
