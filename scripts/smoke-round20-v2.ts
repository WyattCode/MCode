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

  // ------------------------------------------------------------------ R20-V2-3
  section("Round 20 (V2-3): the title menu in MiMo's muted colour, the panel toggles in its Windows title-bar colour")
  {
    const shell = code(await read("src/renderer/src/App.vue"))
    check("the … button is the muted text (--text-base), not the dim one", /\.ico\.options \{[^}]*color: var\(--text-base\);/.test(header))
    check("the header's panel toggles are #2b2b2b on light Windows", /\n\.app\[data-platform="win32"\] \.ico:not\(\.options\) \{\s*color: #2b2b2b;/.test(header))
    check(
      "and #ececec on dark Windows, both for the system and the chosen scheme",
      /:root:not\(\[data-theme="light"\]\) \.app\[data-platform="win32"\] \.ico:not\(\.options\) \{\s*color: #ececec;/.test(header) &&
        /:root\[data-theme="dark"\] \.app\[data-platform="win32"\] \.ico:not\(\.options\) \{\s*color: #ececec;/.test(header),
    )
    check("the side panel toggle is #2b2b2b on light Windows", /\.app\[data-platform="win32"\] \.side-panel-toggle,\s*\.app\[data-platform="win32"\] \.home-bottom:not\(:disabled\) \{\s*color: #2b2b2b;/.test(shell))
    check(
      "and #ececec on dark Windows",
      /:root\[data-theme="dark"\] \.app\[data-platform="win32"\] \.side-panel-toggle,[^{]*\{\s*color: #ececec;/.test(shell) &&
        /:root:not\(\[data-theme="light"\]\) \.app\[data-platform="win32"\] \.side-panel-toggle,[^{]*\{\s*color: #ececec;/.test(shell),
    )
  }

  const composer = code(await read("src/renderer/src/components/Composer.vue"))
  const styles = composer.slice(composer.indexOf("<style"))
  /** Every rule written for exactly this selector, in order - the last one is what wins. */
  const rules = (selector: string) => {
    const found: string[] = []
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    for (const match of styles.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped} \\{([^}]*)\\}`, "g"))) found.push(match[1])
    return found
  }

  // ------------------------------------------------------------------ R20-V2-4
  section("Round 20 (V2-4): the plus and the microphone have no edge and no fill, as MiMo's #plus-btn and #mic-btn")
  {
    const round = /\.attach,\s*\.mic \{([^}]*)\}/.exec(styles)?.[1] ?? ""
    check("no border", /border: 0;/.test(round) && !/border: 1px/.test(round), round)
    check("no fill", /background: transparent;/.test(round), round)
    check("the hover fill is kept", /\.attach:hover,\s*\.attach\.open,\s*\.mic:not\(\.on\):hover \{[^}]*background: var\(--surface-hover\)/.test(styles))
  }
}
