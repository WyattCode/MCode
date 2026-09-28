import json
import os


def load(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save(path, items):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(items, handle, ensure_ascii=False, indent=2)


def next_id(items):
    return max((item["id"] for item in items), default=0) + 1
