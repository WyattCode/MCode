#!/usr/bin/env python3
"""Check that Office Open XML files (.docx, .xlsx, .pptx) are sound packages.

Usage: python check_ooxml.py FILE [FILE ...]

For each file it reports whether the zip opens, whether [Content_Types].xml is
there, every XML part that is not well-formed, and every internal relationship
that points at a part the package does not contain. Exit status is 0 only when
every file passes. Standard library only.
"""
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

RELATIONSHIPS = "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"


def problems_in(path):
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as error:
        return [f"not a readable zip package: {error}"]
    found = []
    with archive:
        names = set(archive.namelist())
        if "[Content_Types].xml" not in names:
            found.append("[Content_Types].xml is missing")
        for name in sorted(names):
            if not name.endswith((".xml", ".rels")):
                continue
            try:
                root = ET.fromstring(archive.read(name))
            except ET.ParseError as error:
                found.append(f"{name}: not well-formed XML ({error})")
                continue
            if not name.endswith(".rels"):
                continue
            # ppt/slides/_rels/slide1.xml.rels describes ppt/slides/slide1.xml, so targets start from ppt/slides/.
            base = posixpath.dirname(posixpath.dirname(name))
            for rel in root.iter(RELATIONSHIPS):
                if rel.get("TargetMode") == "External":
                    continue
                target = rel.get("Target", "")
                part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
                if part not in names:
                    found.append(f"{name}: relationship {rel.get('Id')} points at a missing part, {part}")
    return found


def main(paths):
    if not paths:
        print(__doc__.strip())
        return 2
    failed = False
    for path in paths:
        found = problems_in(path)
        if found:
            failed = True
            print(f"FAIL {path}")
            for problem in found:
                print(f"  - {problem}")
        else:
            print(f"ok   {path}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
