#!/usr/bin/env python3
"""Print a Word document's text with its structure, as Markdown-like lines.

Usage: python docx_text.py FILE.docx [--max-chars N]

Headings (Heading 1-6 and Title styles) become #-lines, list paragraphs become
"- " lines, tables become rows of cells joined with " | ", and the style of any
other styled paragraph is shown in brackets so a template's styles can be seen.
Standard library only; it reads the document part directly and changes nothing.
"""
import argparse
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def paragraph_text(paragraph):
    pieces = []
    for node in paragraph.iter():
        if node.tag == W + "t":
            pieces.append(node.text or "")
        elif node.tag == W + "tab":
            pieces.append("\t")
        elif node.tag in (W + "br", W + "cr"):
            pieces.append("\n")
    return "".join(pieces)


def style_of(paragraph):
    style = paragraph.find(f"{W}pPr/{W}pStyle")
    return style.get(W + "val", "") if style is not None else ""


def lines_of(body):
    for child in body:
        if child.tag == W + "p":
            text = paragraph_text(child)
            style = style_of(child)
            heading = re.match(r"(?i)^heading\s*([1-6])$", style)
            if heading:
                yield "#" * int(heading.group(1)) + " " + text
            elif style.lower() == "title":
                yield "# " + text
            elif child.find(f"{W}pPr/{W}numPr") is not None:
                yield "- " + text
            elif text.strip():
                yield f"[{style}] {text}" if style else text
            else:
                yield ""
        elif child.tag == W + "tbl":
            for row in child.iter(W + "tr"):
                cells = [" ".join(paragraph_text(p) for p in cell.iter(W + "p")).strip() for cell in row.iter(W + "tc")]
                yield "| " + " | ".join(cells) + " |"
            yield ""


def main():
    parser = argparse.ArgumentParser(description="Print a .docx file's text with its structure.")
    parser.add_argument("file")
    parser.add_argument("--max-chars", type=int, default=0, help="stop after this many characters (0: no limit)")
    args = parser.parse_args()
    try:
        with zipfile.ZipFile(args.file) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
    except (KeyError, zipfile.BadZipFile, OSError) as error:
        print(f"cannot read {args.file} as a Word document: {error}", file=sys.stderr)
        return 1
    body = root.find(W + "body")
    written = 0
    for line in lines_of(body if body is not None else []):
        if args.max_chars and written + len(line) > args.max_chars:
            print(f"... (stopped at {args.max_chars} characters)")
            break
        print(line)
        written += len(line) + 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
