#!/usr/bin/env python3
"""Assembles the answers of a parallel build into one HTML page.

Each part's answer is a set of fenced blocks:  ```svg LAYER   (the inside of one layer),  ```css,  ```js.
This script puts each layer's content into its place in a fixed page skeleton, gives every part its own <script>
(so a syntax error in one cannot stop the others), and drives them all from one animation loop that calls
init_<part>() once and update_<part>(s) every frame inside try/catch. It is tolerant of how a model writes the fences:
the layer name on the line after the fence, an empty ```css block, a name-less fence, or a placeholder name copied from the contract.

parts.json:
  { "title": "Pelican on a bike", "canvas": [800, 450], "background": "#0f172a",
    "parts": { "bg": ["L_bg"], "bike": ["L_bikeBack", "L_bikeFront"] },
    "order": ["L_bg", "L_bikeBack", "L_bikeFront"],
    "state": "s.dist = (s.dist || 0) + 280 * s.dt;",
    "expect": [ { "kind": "shape_near", "part": "bike", "selector": "#L_bikeBack *", "size": [100, 140], "center": [250, 334] } ] }
"order" is the drawing order, back to front, of every layer. "state" is JavaScript run once per frame before the
parts' updates, on the shared object s (it keeps its fields between frames; s.t is seconds, s.dt the frame time).
"expect" lists the measurable facts of the contract as data; checks.js (copied next to the page) tests them.

Needs nothing but Python 3.
"""
import argparse
import html
import json
import re
import shutil
import sys
from pathlib import Path

FENCE = re.compile(r"```(\w+)[ \t:]*([A-Za-z_][A-Za-z0-9_]*)?[ \t]*\r?\n(.*?)(?:\r?\n)?```", re.S)
LAYER_LINE = re.compile(r"\s*(L_[A-Za-z0-9_]+)\s*\r?\n")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

PAGE = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@@TITLE@@</title>
<style>
html, body { margin: 0; height: 100%; background: @@BG@@; }
body { display: flex; align-items: center; justify-content: center; }
#stage { width: min(100vw, calc(100vh * @@W@@ / @@H@@)); height: min(100vh, calc(100vw * @@H@@ / @@W@@)); display: block; cursor: pointer; }
@@CSS@@
</style>
</head>
<body>
<svg id="stage" viewBox="0 0 @@W@@ @@H@@" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
@@GROUPS@@
</svg>
<script>window.__expect = @@EXPECT@@;</script>
@@SCRIPTS@@
<script>
(function () {
  var names = [@@NAMES@@], s = { t: 0, dt: 0 }, last = performance.now(), paused = false;
  function run(fn, arg) { try { if (window[fn]) window[fn](arg); } catch (e) { console.error(fn, e); } }
  names.forEach(function (n) { run('init_' + n); });
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000); last = now;
    s.dt = paused ? 0 : dt;
    if (!paused) { s.t += dt; try { @@STATE@@ } catch (e) { console.error('state', e); } }
    names.forEach(function (n) { run('update_' + n, s); });
    requestAnimationFrame(frame);
  }
  document.getElementById('stage').addEventListener('click', function () { paused = !paused; });
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble the answers of a parallel build into one HTML page.")
    parser.add_argument("--work", required=True, help="folder holding parts.json and parts/<part>.txt")
    parser.add_argument("--out", help="default: <work>/page.html")
    args = parser.parse_args()
    # A console on an old code page must not stop the script over a layer name it cannot print.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    work = Path(args.work).resolve()
    out = Path(args.out) if args.out else work / "page.html"
    try:
        cfg = json.loads((work / "parts.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        print(f"Could not read {work / 'parts.json'}: {error}", file=sys.stderr)
        return 1

    parts = cfg.get("parts") or {}
    order = cfg.get("order") or []
    width, height = (cfg.get("canvas") or [800, 450])[:2]
    expect = cfg.get("expect") or []

    layers: dict[str, str] = {}
    css: list[str] = []
    scripts: list[str] = []
    warnings: list[str] = []

    for part, own in parts.items():
        if not IDENTIFIER.match(part):
            warnings.append(f"{part}: this name cannot be part of a function name (update_{part}); use letters, digits and underscores")
        file = work / "parts" / f"{part}.txt"
        if not file.is_file():
            warnings.append(f"{part}: parts/{part}.txt is missing")
            continue
        raw = file.read_text(encoding="utf-8-sig")
        count = 0
        got_js = False
        found: list[str] = []
        matches = list(FENCE.finditer(raw))
        # Layers the answer names outright, so a fence with a wrong name never takes one of them.
        named = [m.group(2) for m in matches if m.group(1).lower() == "svg" and m.group(2) in own]
        for match in matches:
            kind, name, body = match.group(1).lower(), match.group(2) or "", match.group(3)
            if kind == "svg":
                line = LAYER_LINE.match(body) if not name else None
                if line:
                    name, body = line.group(1), body[line.end():]
                if not name and own:
                    name = own[min(count, len(own) - 1)]
                count += 1
                if name not in own:
                    # A model may copy the contract's placeholder (LAYER_NAME) onto the fence: the block goes to the next layer no fence has claimed.
                    free = [layer for layer in own if layer not in found and layer not in named]
                    if not free:
                        warnings.append(f"{part}: a layer named '{name}' is not one of its layers ({', '.join(own)}), and all of them are taken; ignored")
                        continue
                    print(f"NOTE {part}: fence named '{name}' taken as layer {free[0]}, by order")
                    name = free[0]
                # an answer that wrapped the layer in its own <g id="NAME"> would nest it
                wrapped = re.match(r'^\s*<g\s+id="' + re.escape(name) + r'"[^>]*>(.*)</g>\s*$', body, re.S)
                if wrapped:
                    body = wrapped.group(1)
                layers[name] = layers[name] + "\n" + body if name in layers else body
                found.append(name)
            elif kind == "css":
                css.append(body)
            elif kind in ("js", "javascript"):
                got_js = True
                if f"update_{part}" not in body:
                    warnings.append(f"{part}: its script does not mention update_{part} (the page will not animate it)")
                if "</script" in body.lower():
                    warnings.append(f"{part}: its script contains </script>, which ends the script there; write it as <\\/script>")
                scripts.append(f"<script>\n/* block {part} */\n{body}\n</script>")
        for layer in own:
            if layer not in found:
                warnings.append(f"{part}: layer {layer} was not found in its answer (left empty)")
        if not got_js:
            warnings.append(f"{part}: no js block found")
        print(f"{part:<12} layers: {', '.join(found)}; js: {'yes' if got_js else 'NO'}")

    # Only layers in "order" reach the page, so one left out would vanish with nothing to say why.
    owned = [layer for own in parts.values() for layer in own]
    for layer in owned:
        if layer not in order:
            warnings.append(f"parts.json: layer {layer} is not in \"order\", so it is not on the page")
    for layer in order:
        if layer not in owned:
            warnings.append(f"parts.json: \"order\" names {layer}, which no part owns, so it stays empty")
    # Parts that never have to meet need no parallel contract; where they do meet is what goes wrong, so its absence is worth saying.
    if len(parts) > 1 and not any(isinstance(entry, dict) and entry.get("kind") == "touches" for entry in expect):
        warnings.append("parts.json: expect has no 'touches' entry, so nothing checks that the parts meet where the contract says")

    values = {
        "TITLE": html.escape(str(cfg.get("title") or "Page")),
        "BG": str(cfg.get("background") or "#111827"),
        "W": str(width),
        "H": str(height),
        "CSS": "\n".join(css),
        "GROUPS": "\n".join(f'<g id="{layer}">{layers.get(layer, "")}</g>' for layer in order),
        # "</" is escaped so no entry can end the script.
        "EXPECT": json.dumps(expect, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"),
        "SCRIPTS": "\n".join(scripts),
        "NAMES": ", ".join(f"'{part}'" for part in parts),
        "STATE": str(cfg.get("state") or ""),
    }
    # One pass over the skeleton: text from an answer that happens to spell @@CSS@@ is left as it is.
    page = re.sub(r"@@([A-Z]+)@@", lambda m: values[m.group(1)], PAGE)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8", newline="\n")
    # The checks that read "expect" travel with the page, so verify_page can be pointed at <work>/checks.js without leaving the project.
    shutil.copyfile(Path(__file__).with_name("checks.js"), work / "checks.js")
    for warning in warnings:
        print(f"WARN {warning}")
    print(f"wrote {out} ({out.stat().st_size} bytes), {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
