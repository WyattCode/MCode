/**
 * Round 8: the keyboard and assistive-technology barriers audited as A1-A15.
 *
 * Kept apart from smoke.ts the way rounds five to seven are, and called with
 * its check and section. These are read from the source: what they guard is
 * markup and wiring that only a window can exercise, and the window side is
 * measured by the round-eight probe. Each check names the one rule a later
 * edit could quietly undo.
 */
import fs from "node:fs"
import path from "node:path"
import type { Check } from "./smoke-round5"

const RENDERER = path.join("src", "renderer", "src")

function read(file: string): string {
  return fs.readFileSync(path.join(RENDERER, file), "utf8")
}

function sources(directory: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(vue|ts)$/.test(entry.name) && entry.name !== "i18n.ts") out.push(full)
  }
  return out
}

/**
 * Whether a clipboard write at `line` is answered when it is refused: a
 * `.catch(` on the same statement, or an open `try {` above it in the same
 * function. A refusal nobody catches reaches the window's fatal handler.
 */
function guarded(lines: string[], line: number): boolean {
  if (/\.catch\(|\.then\([^)]*,/.test(lines[line])) return true
  // Walk out through the enclosing blocks until a try or the function itself.
  let depth = 0
  for (let at = line - 1; at >= Math.max(0, line - 40); at--) {
    const text = lines[at]
    depth += (text.match(/\}/g) ?? []).length - (text.match(/\{/g) ?? []).length
    if (depth >= 0) continue
    if (/\btry\s*\{\s*$/.test(text)) return true
    if (/\bfunction\b|=>\s*\{\s*$/.test(text)) return false
    depth = 0
  }
  return false
}

export async function roundEightAccessChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("round 8 access: a refused clipboard is a notice")
  {
    const unguarded: string[] = []
    for (const file of sources(RENDERER)) {
      // The one helper that throws on purpose; its callers are checked through it.
      if (file.endsWith(path.join("lib", "diagram.ts"))) continue
      const lines = fs.readFileSync(file, "utf8").split("\n")
      lines.forEach((text, index) => {
        if (/navigator\.clipboard\??\.write(Text)?\(/.test(text) && !guarded(lines, index)) unguarded.push(`${path.relative(RENDERER, file)}:${index + 1}`)
      })
    }
    check("every clipboard write in the window catches a refusal", unguarded.length === 0, unguarded)
    const stream = read("components/MessageStream.vue")
    check("a reply's copy says 复制失败 when the clipboard refuses", /async function copyToClipboard[\s\S]{0,200}catch \{\s*notifyFailure\(t\("code\.copyFailed"\)\)/.test(stream))
  }
}
