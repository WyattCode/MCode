#!/usr/bin/env python3
"""Check a skill folder before it is used or shared.

Usage: python check_skill.py SKILL_FOLDER

Checks that SKILL.md exists and opens with frontmatter; that name and description
are there; that the name is lowercase words joined by hyphens and matches the
folder; that the description is not too long and says when to use the skill;
that the body is not empty; and that every scripts/, references/ or assets/ path
the body mentions exists. Exit status is 0 when nothing is wrong (warnings allowed).
Standard library only.
"""
import os
import re
import sys

NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
MENTIONED = re.compile(r"(?<![\w/.-])((?:scripts|references|assets)/[\w./-]+[\w])")


def frontmatter(text):
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end < 0:
        return None, text
    block = text[3:end].strip("\r\n")
    body = text[end + 4 :].lstrip("\r\n")
    data = {}
    key = None
    for line in block.splitlines():
        match = re.match(r"^([A-Za-z_][\w.-]*):\s*(.*)$", line)
        if match:
            key = match.group(1)
            data[key] = match.group(2).strip().strip("'\"")
        elif key and line.startswith((" ", "\t")) and data.get(key) in ("", ">", ">-", "|", "|-"):
            data[key] = (data[key].lstrip(">|-") + " " + line.strip()).strip()
    return data, body


def main(argv):
    if len(argv) != 1:
        print(__doc__.strip())
        return 2
    folder = os.path.abspath(argv[0])
    errors, warnings = [], []
    path = os.path.join(folder, "SKILL.md")
    if not os.path.isfile(path):
        print(f"FAIL {folder}: there is no SKILL.md")
        return 1
    with open(path, encoding="utf-8") as handle:
        text = handle.read().lstrip("﻿")
    data, body = frontmatter(text)
    if data is None:
        errors.append("SKILL.md must open with a --- frontmatter block")
        data = {}
    name = data.get("name", "")
    description = data.get("description", "")
    if not name:
        errors.append("frontmatter has no name")
    elif not NAME.match(name):
        errors.append(f"name {name!r} should be lowercase words joined by hyphens")
    elif name != os.path.basename(folder):
        warnings.append(f"name {name!r} does not match the folder {os.path.basename(folder)!r}")
    if not description:
        errors.append("frontmatter has no description (skills without one are not loaded)")
    else:
        if len(description) > 1024:
            warnings.append(f"description is {len(description)} characters; keep it under 1024")
        if not re.search(r"\b(use|when|whenever)\b", description, re.IGNORECASE):
            warnings.append("description does not say when to use the skill")
        if "<" in description or ">" in description:
            warnings.append("description contains angle brackets, which read as markup in the prompt")
    if len(body.strip()) < 40:
        errors.append("the body is empty or nearly so")
    for mentioned in sorted(set(MENTIONED.findall(body))):
        if not os.path.exists(os.path.join(folder, mentioned)):
            errors.append(f"the body mentions {mentioned}, which does not exist")
    for line in errors:
        print(f"error: {line}")
    for line in warnings:
        print(f"warning: {line}")
    print(("FAIL " if errors else "ok   ") + folder)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
