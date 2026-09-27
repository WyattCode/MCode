import argparse

from . import store


def render(item):
    mark = "x" if item["done"] else " "
    return f"[{mark}] {item['id']} {item['text']}"


def main(argv):
    parser = argparse.ArgumentParser(prog="todo")
    parser.add_argument("--file", default="data.json")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add")
    add.add_argument("text")
    done = commands.add_parser("done")
    done.add_argument("id", type=int)
    commands.add_parser("list")
    args = parser.parse_args(argv)

    items = store.load(args.file)
    if args.command == "add":
        item = {"id": store.next_id(items), "text": args.text, "done": False}
        items.append(item)
        store.save(args.file, items)
        print(f"added {item['id']}")
    elif args.command == "done":
        for item in items:
            if item["id"] == args.id:
                item["done"] = True
        store.save(args.file, items)
    elif args.command == "list":
        for item in sorted(items, key=lambda item: item["id"]):
            print(render(item))
    return 0
