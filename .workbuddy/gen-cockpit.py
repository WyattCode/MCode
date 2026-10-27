"""Regenerate src/server/remote/cockpit-html.ts from cockpit.html.

The generated module exists so the gateway can serve its page without a bundler
loader at runtime, and its own header says to edit the HTML and re-run the
generator - but no generator was ever committed, so the two had already begun to
drift. This is that generator: read the HTML, JSON-quote it, write the module in
the same shape the file already had.
"""
import json
from pathlib import Path

root = Path(r"D:/Documents/Claude Code/MCode")
html = (root / "src/server/remote/cockpit.html").read_text(encoding="utf-8")
out = root / "src/server/remote/cockpit-html.ts"

# Exactly the shape the file already had: the payload is a JSON string literal
# (quotes and backslashes escaped) parsed at import time.
payload = json.dumps(html, ensure_ascii=False)
out.write_text(
    "// Generated from cockpit.html - edit that file and re-run the generator.\n"
    "export const cockpitHtml =\n"
    f"  JSON.parse({json.dumps(payload, ensure_ascii=False)})\n",
    encoding="utf-8",
)
print(f"wrote {out} ({out.stat().st_size} bytes) from {len(html)} chars of HTML")
