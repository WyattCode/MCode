/**
 * Round 20, lane V2: the conversation header, the composer and the info card
 * against MiMo 26.920 (items 1 to 13 of the visual review, and the header's
 * in-place rename).
 *
 * Read from the source: each value was measured in MiMo's bundle and then in a
 * real MCode window (dark and light, win32) through the lane's Electron probe.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** The declarations of the first rule written exactly as `selector {`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  if (at === -1) return ""
  const open = css.indexOf("{", at)
  return css.slice(open + 1, css.indexOf("}", open))
}

export async function roundTwentyV2Checks(check: Check, section: (name: string) => void): Promise<void> {
  const header = code(await read("src/renderer/src/components/SessionHeader.vue"))

  // ------------------------------------------------------------------ R20-V2-1
  section("Round 20 (V2-1): the open-location chip only where MiMo can draw it")
  {
    const tag = /<div v-if="([^"]+)" class="open-with">/.exec(header)?.[1] ?? ""
    check("the chip waits on a darwin-only condition, as MiMo's .app scan finds nothing elsewhere", /openShown/.test(tag) && /app\.platform === "darwin"/.test(header), tag)
    check("its face shows the chosen app's own icon when one is known", /<img v-if="openIcon" class="open-icon"/.test(header))
  }

  // ------------------------------------------------------------------ R20-V2-2
  section("Round 20 (V2-2): the title starts 18 in, MiMo's pl-[18px]")
  {
    const head = rule(header, ".head")
    check("the header's start inset is 18px", /padding-inline:\s*18px\b/.test(head), head)
    check("the folded rail's insets are kept (129 on macOS, 72 elsewhere)", /\.head\.after-rail \{\s*padding-inline-start: 129px;/.test(header) && /\.head\.after-rail \{\s*padding-inline-start: 72px;/.test(header))
  }
}
