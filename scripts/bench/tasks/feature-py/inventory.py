import csv
import sys


def load(path):
    with open(path, newline="", encoding="utf-8") as handle:
        return [{"name": row["name"], "qty": int(row["qty"])} for row in csv.DictReader(handle)]


def main(argv):
    items = load(argv[1])
    for item in items:
        print(f"{item['name']}: {item['qty']}")


if __name__ == "__main__":
    main(sys.argv)
