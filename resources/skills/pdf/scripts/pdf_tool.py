#!/usr/bin/env python3
"""Everyday PDF work on top of pypdf: info, text, merge, split, rotate, extract pages.

Usage:
  python pdf_tool.py info FILE
  python pdf_tool.py text FILE [--pages 1-3,7]
  python pdf_tool.py merge OUT FILE [FILE ...]
  python pdf_tool.py split FILE OUTDIR
  python pdf_tool.py pages FILE OUT --pages 2-5
  python pdf_tool.py rotate FILE OUT --degrees 90 [--pages 1,3]

Page numbers start at 1. Needs pypdf (python -m pip install pypdf); the script
says so and stops when it is missing. Input files are never modified.
"""
import argparse
import os
import sys

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    PdfReader = PdfWriter = None


def page_numbers(spec, count):
    if not spec:
        return list(range(count))
    chosen = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            first, last = int(start or 1), int(end or count)
            chosen.extend(range(first - 1, min(last, count)))
        elif part:
            chosen.append(int(part) - 1)
    return [index for index in chosen if 0 <= index < count]


def main():
    if PdfReader is None:
        print("pypdf is not installed. Install it with: python -m pip install pypdf", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(description="PDF helper built on pypdf.")
    commands = parser.add_subparsers(dest="command", required=True)
    info = commands.add_parser("info")
    info.add_argument("file")
    text = commands.add_parser("text")
    text.add_argument("file")
    text.add_argument("--pages")
    merge = commands.add_parser("merge")
    merge.add_argument("out")
    merge.add_argument("files", nargs="+")
    split = commands.add_parser("split")
    split.add_argument("file")
    split.add_argument("outdir")
    pages = commands.add_parser("pages")
    pages.add_argument("file")
    pages.add_argument("out")
    pages.add_argument("--pages", required=True)
    rotate = commands.add_parser("rotate")
    rotate.add_argument("file")
    rotate.add_argument("out")
    rotate.add_argument("--degrees", type=int, required=True, choices=[90, 180, 270])
    rotate.add_argument("--pages")
    args = parser.parse_args()

    if args.command == "info":
        reader = PdfReader(args.file)
        print(f"pages: {len(reader.pages)}")
        print(f"encrypted: {reader.is_encrypted}")
        for key, value in (reader.metadata or {}).items():
            print(f"{key.lstrip('/')}: {value}")
        first = reader.pages[0].mediabox if reader.pages else None
        if first is not None:
            print(f"page size (points): {float(first.width):.0f} x {float(first.height):.0f}")
        fields = reader.get_fields() or {}
        if fields:
            print(f"form fields: {len(fields)} ({', '.join(list(fields)[:10])}{'...' if len(fields) > 10 else ''})")
        return 0

    if args.command == "text":
        reader = PdfReader(args.file)
        found_text = False
        for index in page_numbers(args.pages, len(reader.pages)):
            content = reader.pages[index].extract_text() or ""
            found_text = found_text or bool(content.strip())
            print(f"===== page {index + 1} =====")
            print(content)
        if not found_text:
            print("(no text layer: this may be a scanned PDF that needs OCR)", file=sys.stderr)
        return 0

    writer = PdfWriter()
    if args.command == "merge":
        for path in args.files:
            for page in PdfReader(path).pages:
                writer.add_page(page)
        target = args.out
    elif args.command == "split":
        reader = PdfReader(args.file)
        os.makedirs(args.outdir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(args.file))[0]
        for index, page in enumerate(reader.pages, start=1):
            single = PdfWriter()
            single.add_page(page)
            with open(os.path.join(args.outdir, f"{stem}-{index:03d}.pdf"), "wb") as handle:
                single.write(handle)
        print(f"wrote {len(reader.pages)} files to {args.outdir}")
        return 0
    elif args.command == "pages":
        reader = PdfReader(args.file)
        for index in page_numbers(args.pages, len(reader.pages)):
            writer.add_page(reader.pages[index])
        target = args.out
    else:
        reader = PdfReader(args.file)
        turn = set(page_numbers(args.pages, len(reader.pages)))
        for index, page in enumerate(reader.pages):
            if index in turn:
                page.rotate(args.degrees)
            writer.add_page(page)
        target = args.out
    with open(target, "wb") as handle:
        writer.write(handle)
    print(f"wrote {target} ({len(writer.pages)} pages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
