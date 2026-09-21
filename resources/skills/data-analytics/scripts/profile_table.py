#!/usr/bin/env python3
"""Profile a CSV or TSV file: size, and for each column its type, blanks, distinct values and range.

Usage: python profile_table.py FILE [--delimiter ,] [--max-rows N]

Use it before any analysis to see what the data really holds: columns that look
numeric but carry text, dates in more than one format, blanks, and suspicious
duplicates. Standard library only; nothing is changed.
"""
import argparse
import csv
import re
import statistics
import sys
from collections import Counter

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$|^\d{1,2}/\d{1,2}/\d{2,4}$")


def number(text):
    cleaned = text.replace(",", "").replace("%", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser(description="Profile a delimited text table.")
    parser.add_argument("file")
    parser.add_argument("--delimiter", help="field separator (default: guessed)")
    parser.add_argument("--max-rows", type=int, default=0, help="read at most this many rows (0: all)")
    args = parser.parse_args()
    with open(args.file, newline="", encoding="utf-8-sig", errors="replace") as handle:
        sample = handle.read(65536)
        handle.seek(0)
        delimiter = args.delimiter
        if not delimiter:
            try:
                delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
            except csv.Error:
                delimiter = "\t" if args.file.lower().endswith(".tsv") else ","
        reader = csv.reader(handle, delimiter=delimiter)
        header = next(reader, None)
        if header is None:
            print("empty file")
            return 1
        columns = [[] for _ in header]
        rows = 0
        ragged = 0
        seen_rows = Counter()
        for row in reader:
            if args.max_rows and rows >= args.max_rows:
                break
            rows += 1
            if len(row) != len(header):
                ragged += 1
            seen_rows[tuple(row)] += 1
            for index in range(len(header)):
                columns[index].append(row[index] if index < len(row) else "")
    duplicates = sum(count - 1 for count in seen_rows.values() if count > 1)
    print(f"rows: {rows}   columns: {len(header)}   delimiter: {delimiter!r}")
    if ragged:
        print(f"rows with a different number of fields than the header: {ragged}")
    if duplicates:
        print(f"exact duplicate rows: {duplicates}")
    print()
    for name, values in zip(header, columns):
        filled = [value for value in values if value.strip()]
        blanks = len(values) - len(filled)
        numbers = [n for n in (number(value) for value in filled) if n is not None]
        dates = [value for value in filled if DATE.match(value.strip())]
        distinct = Counter(filled)
        if filled and len(numbers) == len(filled):
            kind = "number"
        elif filled and len(dates) == len(filled):
            kind = "date"
        elif numbers and len(numbers) >= 0.8 * len(filled):
            kind = f"mostly number ({len(filled) - len(numbers)} non-numeric)"
        else:
            kind = "text"
        print(f"## {name}")
        print(f"  type: {kind}   blanks: {blanks}   distinct: {len(distinct)}")
        if numbers:
            spread = f"  min {min(numbers):g}   max {max(numbers):g}   mean {statistics.fmean(numbers):g}"
            if len(numbers) > 1:
                spread += f"   median {statistics.median(numbers):g}"
            print(spread)
        common = ", ".join(f"{value!r} x{count}" for value, count in distinct.most_common(5))
        if common:
            print(f"  most common: {common}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
