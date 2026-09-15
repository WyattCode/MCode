#!/usr/bin/env python3
"""Print a presentation's outline: each slide's title, its text, and its speaker notes.

Usage: python pptx_outline.py FILE.pptx [--no-notes]

Slides are listed in presentation order with the layout they use, so a deck's
structure and its template can be seen before it is changed. Standard library
only; nothing is changed.
"""
import argparse
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"
TITLES = {"title", "ctrTitle"}


def rels_of(archive, part):
    folder, name = posixpath.split(part)
    rels_path = posixpath.join(folder, "_rels", name + ".rels")
    if rels_path not in archive.namelist():
        return []
    root = ET.fromstring(archive.read(rels_path))
    out = []
    for rel in root.iter(PKG + "Relationship"):
        target = rel.get("Target", "")
        resolved = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(folder, target))
        out.append((rel.get("Id"), rel.get("Type", "").rsplit("/", 1)[-1], resolved))
    return out


def paragraphs(shape):
    for paragraph in shape.iter(A + "p"):
        text = "".join(run.text or "" for run in paragraph.iter(A + "t")).strip()
        if text:
            yield text


def main():
    parser = argparse.ArgumentParser(description="Print a .pptx file's outline.")
    parser.add_argument("file")
    parser.add_argument("--no-notes", action="store_true", help="leave speaker notes out")
    args = parser.parse_args()
    try:
        archive = zipfile.ZipFile(args.file)
    except (zipfile.BadZipFile, OSError) as error:
        print(f"cannot open {args.file}: {error}", file=sys.stderr)
        return 1
    with archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        targets = {rel_id: path for rel_id, _, path in rels_of(archive, "ppt/presentation.xml")}
        ids = [slide.get(R + "id") for slide in presentation.iter(P + "sldId")]
        for number, rel_id in enumerate(ids, start=1):
            part = targets.get(rel_id)
            if not part or part not in archive.namelist():
                print(f"## Slide {number}: (part missing)")
                continue
            slide = ET.fromstring(archive.read(part))
            related = rels_of(archive, part)
            layout = next((path for _, kind, path in related if kind == "slideLayout"), "")
            layout_name = ""
            if layout in archive.namelist():
                named = ET.fromstring(archive.read(layout)).find(f"{P}cSld")
                layout_name = named.get("name", "") if named is not None else ""
            title, body = "", []
            for shape in slide.iter(P + "sp"):
                placeholder = shape.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
                texts = list(paragraphs(shape))
                if placeholder is not None and placeholder.get("type") in TITLES and not title:
                    title = " ".join(texts)
                else:
                    body.extend(texts)
            for table in slide.iter(A + "tbl"):
                for row in table.iter(A + "tr"):
                    body.append("| " + " | ".join(" ".join(paragraphs(cell)) for cell in row.iter(A + "tc")) + " |")
            print(f"## Slide {number}: {title or '(no title)'}" + (f"   [layout: {layout_name}]" if layout_name else ""))
            for line in body:
                print(f"- {line}")
            if not args.no_notes:
                notes = next((path for _, kind, path in related if kind == "notesSlide"), "")
                if notes in archive.namelist():
                    said = [text for text in paragraphs(ET.fromstring(archive.read(notes))) if not text.isdigit()]
                    if said:
                        print("  notes: " + " ".join(said))
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
