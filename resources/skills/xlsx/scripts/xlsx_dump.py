#!/usr/bin/env python3
"""List a workbook's sheets and cells, showing formulas beside their cached values.

Usage: python xlsx_dump.py FILE.xlsx [--sheet NAME] [--max-cells N]

Each sheet is printed with its size, then one line per non-empty cell:
"B4 = 1250" or "B5 = 3750   [=SUM(B2:B4)]". A formula with no cached value shows
"(not calculated)", which is what a file written by a library looks like until a
spreadsheet program recalculates it. Standard library only; nothing is changed.
"""
import argparse
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def text_of(node):
    return "".join(t.text or "" for t in node.iter(MAIN + "t"))


def sheets_of(archive):
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {rel.get("Id"): rel.get("Target") for rel in rels.iter(PKG + "Relationship")}
    for sheet in workbook.iter(MAIN + "sheet"):
        target = targets.get(sheet.get(REL + "id"), "")
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        yield sheet.get("name"), path, sheet.get("state", "visible")


def main():
    parser = argparse.ArgumentParser(description="List a workbook's sheets and cells.")
    parser.add_argument("file")
    parser.add_argument("--sheet", help="only this sheet")
    parser.add_argument("--max-cells", type=int, default=300, help="cells shown per sheet (default 300)")
    args = parser.parse_args()
    try:
        archive = zipfile.ZipFile(args.file)
    except (zipfile.BadZipFile, OSError) as error:
        print(f"cannot open {args.file}: {error}", file=sys.stderr)
        return 1
    with archive:
        names = set(archive.namelist())
        shared = []
        if "xl/sharedStrings.xml" in names:
            shared = [text_of(item) for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).iter(MAIN + "si")]
        for name, path, state in sheets_of(archive):
            if args.sheet and name != args.sheet:
                continue
            if path not in names:
                print(f"## {name}: part {path} is missing")
                continue
            root = ET.fromstring(archive.read(path))
            size = root.find(MAIN + "dimension")
            print(f"## {name}" + (f" ({state})" if state != "visible" else "") + (f"  range {size.get('ref')}" if size is not None else ""))
            shown = 0
            total = 0
            for cell in root.iter(MAIN + "c"):
                formula = cell.find(MAIN + "f")
                value = cell.find(MAIN + "v")
                kind = cell.get("t", "n")
                if kind == "inlineStr":
                    text = text_of(cell)
                elif value is None:
                    text = "(not calculated)" if formula is not None else ""
                elif kind == "s":
                    text = shared[int(value.text)] if value.text and int(value.text) < len(shared) else "?"
                elif kind == "b":
                    text = "TRUE" if value.text == "1" else "FALSE"
                else:
                    text = value.text or ""
                if not text and formula is None:
                    continue
                total += 1
                if shown >= args.max_cells:
                    continue
                line = f"{cell.get('r')} = {text}"
                if formula is not None:
                    line += f"   [={formula.text or '(shared formula)'}]"
                print(line)
                shown += 1
            if total > shown:
                print(f"... {total - shown} more cells (raise --max-cells to see them)")
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
