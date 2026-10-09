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
    check("the folded rail's insets are kept (152 on macOS, 72 elsewhere)", /\.head\.after-rail \{\s*padding-inline-start: 152px;/.test(header) && /\.head\.after-rail \{\s*padding-inline-start: 72px;/.test(header))
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

  // ------------------------------------------------------------------ R20-V2-5
  section("Round 20 (V2-5): the placeholder in MiMo's colours")
  {
    const light = rules(".input::placeholder").at(-1) ?? ""
    check("light: the muted text, #151c1399 (--text-base)", /color: var\(--text-base\);/.test(light), light)
    check(
      "dark: #a0a0a0, for the system and the chosen scheme",
      /:root:not\(\[data-theme="light"\]\) \.input::placeholder \{\s*color: #a0a0a0;/.test(styles) && /:root\[data-theme="dark"\] \.input::placeholder \{\s*color: #a0a0a0;/.test(styles),
    )
  }

  // ------------------------------------------------------------------ R20-V2-6
  section("Round 20 (V2-6): the context ring is MiMo's - 18px, drawn in 16 units, r 6, stroke 2.4")
  {
    const ring = code(await read("src/renderer/src/components/ContextRing.vue"))
    check("a 16-unit square", /viewBox="0 0 16 16"/.test(ring))
    check("radius 6 about the centre, for both circles", (ring.match(/cx="8"\s+cy="8"\s+r="6"/g) ?? []).length === 2)
    check("stroke 2.4 by default, and the composer mounts it at 18", /stroke: 2\.4/.test(ring) && /<ContextRing :percent="contextUsage\.percent" :size="18" :stroke="2\.4" \/>/.test(composer))
    check("the track is the weak border on light and #2e2e2e on dark", /\.ring-track \{\s*stroke: var\(--border-weak\);/.test(ring) && /:root\[data-theme="dark"\] \.ring-track \{\s*stroke: #2e2e2e;/.test(ring))
    check("the arc is the muted text", /\.ring-arc \{\s*stroke: var\(--text-base\);/.test(ring))
    const ctx = rules(".ctx").at(-1) ?? ""
    check("the button around it has no margin of its own", !/margin/.test(ctx), ctx)
  }

  // ------------------------------------------------------------------ R20-V2-7
  section("Round 20 (V2-7): the stop square is MiMo's 9px on a 1.5 corner; send and stop in MiMo's colours")
  {
    const stop = /<svg v-if="stopping"[^>]*>\s*<rect[^>]*\/>/.exec(composer)?.[0] ?? ""
    check("a 9px square", /width="9" height="9" viewBox="0 0 9 9"/.test(stop) && /<rect width="9" height="9"/.test(stop), stop)
    check("on a 1.5 corner", /rx="1\.5"/.test(stop), stop)
    const send = rules(".send").filter((body) => /background/.test(body)).at(-1) ?? ""
    check("light: white on #151c13", /color: #fff;/.test(send) && /background: #151c13;/.test(send), send)
    check(
      "dark: #0d0d0d on #ececec, leaving the empty and disabled look alone",
      /:root\[data-theme="dark"\] \.send:not\(\.empty\):not\(:disabled\) \{\s*color: #0d0d0d;\s*background: #ececec;/.test(styles) &&
        /:root:not\(\[data-theme="light"\]\) \.send:not\(\.empty\):not\(:disabled\) \{\s*color: #0d0d0d;\s*background: #ececec;/.test(styles),
    )
  }

  // ------------------------------------------------------------------ R20-V2-8
  section("Round 20 (V2-8): the send arrow is MiMo's stroked shaft and chevron, 2.2 in a 24 square at 18px")
  {
    const arrow = /<svg v-else width="18" height="18" viewBox="0 0 24 24"[^>]*>\s*<path([^>]*)\/>/.exec(composer)?.[1] ?? ""
    check("stroked, not filled", /stroke="currentColor"/.test(arrow) && /stroke-width="2\.2"/.test(arrow) && !/fill="currentColor"/.test(arrow), arrow)
    const d = /d="([^"]+)"/.exec(arrow)?.[1] ?? ""
    check("a shaft 14 units tall (10.5px at 18) under a chevron meeting at its top", d === "M12 19V5m-7 7 7-7 7 7", d)
  }

  // ------------------------------------------------------------------ R20-V2-9
  section("Round 20 (V2-9): no focus ring on the composer card; MiMo's edge and shadow in each theme")
  {
    check("no :focus-within rule draws on the card", !/\.box:focus-within/.test(styles))
    check("the keyboard's own outline is kept", /:root\[data-focus-key\] \.box:has\(\.input:focus\) \{\s*outline: 2px solid var\(--interactive\);/.test(styles))
    const box = rules(".box").filter((body) => /box-shadow/.test(body)).at(-1) ?? ""
    check("light: a #151c130f edge", /border: 0\.5px solid var\(--border-input\);/.test(box), box)
    check("light: MiMo's two-step shadow", /box-shadow: var\(--shadow-composer\);/.test(box), box)
    check(
      "dark: a #2e2e2e edge, the dark drop now carried by --shadow-composer, and a dropped file's ring still wins",
      /:root\[data-theme="dark"\] \.box:not\(\.dropping\) \{\s*border-color: #2e2e2e;\s*\}/.test(styles) &&
        /:root:not\(\[data-theme="light"\]\) \.box:not\(\.dropping\) \{\s*border-color: #2e2e2e;/.test(styles),
    )
  }

  // ------------------------------------------------------------------ R20-V2-10
  section("Round 20 (V2-10): the full-access chip gives up its orange on hover, as MiMo's does")
  {
    check("the orange is written only for the chip at rest", /\.pill\.access\.full:not\(:hover\) \{\s*color: #fb8147;/.test(styles))
    check("no rule keeps it orange while hovered", !/\.pill\.access\.full:hover/.test(styles))
  }

  // ------------------------------------------------------------------ R20-V2-11
  section("Round 20 (V2-11): the access marks at MiMo's sizes - the hand 16px, the pencil 12 wide in an 18px mark")
  {
    const table = /const ACCESS_ICONS[^=]*= \{([\s\S]*?)\n\}/.exec(composer)?.[1] ?? ""
    const entry = (name: string) => new RegExp(`${name}: \\{[\\s\\S]*?box: (\\d+),\\s*stroke: ([\\d.]+)`).exec(table)
    check("the hand is drawn at 16", entry("ask")?.[1] === "16", entry("ask")?.slice(1))
    check("the pencil and the shield at 18", entry("auto")?.[1] === "18" && entry("full")?.[1] === "18")
    /* The pencil's extent in its own units is its extent on the chip, since the chip draws it at its box. */
    const pencil = /auto: \{[^}]*paths: \[([^\]]*)\]/.exec(table)?.[1] ?? ""
    const xs = [...pencil.matchAll(/M([\d.]+) [\d.]+h([\d.]+)/g)].flatMap((m) => [Number(m[1]), Number(m[1]) + Number(m[2])])
    const body = /"M([\d.]+) [\d.]+a[^"]*L[\d.]+ [\d.]+ ([\d.]+) /.exec(pencil)
    const left = body ? Number(body[2]) : NaN
    const width = Math.max(...xs) - left
    check("the pencil spans 12px, from its tip to the end of its underline", Math.abs(width - 12) < 0.1, { left, xs, width })
    check("the chip's mark takes the drawing's own size", /:width="ACCESS_ICONS\[access\]\.box"/.test(composer) && /:viewBox="`0 0 \$\{ACCESS_ICONS\[access\]\.box\}/.test(composer))
    const hand = /ask: \{[^}]*paths: \[([\s\S]*?)\]/.exec(table)?.[1] ?? ""
    check("the hand has four fingers", (hand.match(/a\.76\.76 0 0 1 1\.5\d 0/g) ?? []).length === 4, hand)
  }

  // ------------------------------------------------------------------ R20-V2-12
  section("Round 20 (V2-12): typed text #f4f4f5 on dark, MiMo's filled microphone, a subgroup head that does not brighten")
  {
    check(
      "the text being written is #f4f4f5 on dark, not white",
      /:root\[data-theme="dark"\] \.input \{\s*color: #f4f4f5;/.test(styles) && /:root:not\(\[data-theme="light"\]\) \.input \{\s*color: #f4f4f5;/.test(styles),
    )
    const mic = /<svg v-else width="18" height="18" viewBox="0 0 18 18"[^>]*>\s*<path([^>]*)\/>\s*<\/svg>/.exec(composer)?.[1] ?? ""
    check("the microphone is one filled path, capsule and cradle, with no stand", /fill="currentColor"/.test(mic) && /fill-rule="evenodd"/.test(mic) && !/stroke/.test(mic), mic)
    const sub = code(await read("src/renderer/src/components/InfoSubgroup.vue"))
    check("the info card's subgroup head has no hover colour", !/\.head:hover/.test(sub))
  }

  // ------------------------------------------------------------------ R20-V2-rename
  section("Round 20 (V2-rename): one click on the header title renames it in place, as MiMo 26.920 does")
  {
    const title = /<h1\s[^>]*class="title"[^>]*\/?>/.exec(header)?.[0] ?? ""
    check("a click on the title starts the edit; there is no double-click dialog", /@click="beginEdit"/.test(title) && !/dblclick/.test(header), title)
    check("Enter, leaving and typing are wired to the title itself", /@keydown="onTitleKey"/.test(title) && /@blur="finishEdit"/.test(title) && /@input="clampInput"/.test(title))
    check("the header asks the app for no dialog", !/rename: \[\]/.test(header) && !/emit\("rename"\)|emit\('rename'\)/.test(header))
    const begin = /function beginEdit\(\) \{([\s\S]*?)\n\}/.exec(header)?.[1] ?? ""
    check("editing turns the title itself editable and selects all of it", /contentEditable = "true"/.test(begin) && /selectNodeContents/.test(begin) && /addRange/.test(begin), begin)
    const finish = /function finishEdit\(\) \{([\s\S]*?)\n\}/.exec(header)?.[1] ?? ""
    check("saving trims, falls back to the untitled name, caps at 80 and renames", /trim\(\) \|\| t\("session\.untitled"\)/.test(finish) && /clampTitle/.test(finish) && /app\.rename\(/.test(finish) && /TITLE_MAX = 80/.test(header), finish)
    const key = /function onTitleKey\(event: KeyboardEvent\) \{([\s\S]*?)\n\}/.exec(header)?.[1] ?? ""
    check("Enter saves unless an IME is composing; Escape cancels", /event\.key === "Enter" && !\(event\.isComposing \|\| event\.keyCode === 229\)/.test(key) && /finishEdit\(\)/.test(key) && /event\.key === "Escape"/.test(key) && /cancelEdit\(\)/.test(key), key)
    check("its card stays shut while it is being edited", /v-tip="card && !editing \?/.test(title))
    check("MiMo's editing field: 100 wide at least, 8 in, a 7px corner", /\.title\.editing \{[^}]*min-width: 100px;[^}]*padding: 0 8px;[^}]*border-radius: 7px;/.test(header))
    check("the header lends its editor to the app", /defineExpose\(\{ beginEdit \}\)/.test(header))

    const shell = code(await read("src/renderer/src/App.vue"))
    check("the app mounts the header by ref and no longer listens for a rename event", /<SessionHeader\s+ref="sessionHeader"/.test(shell) && !/<SessionHeader[^>]*@rename=/.test(shell))
    check("the rename command and its Ctrl+Alt+R chord edit the header", /id: "session\.rename",[\s\S]{0,200}run: \(\) => renameInHeader\(\)/.test(shell) && /letter === "r"\) \{[\s\S]{0,200}renameInHeader\(\)/.test(shell))
    check("a side-column row's 重命名 opens MiMo's dialog for that row without opening it", /if \(key === "session\.rename" && !header\) \{\s*beginRename\(target\)/.test(shell))
    check("a row's double-click still opens the same dialog, as MiMo's does", /function renameFromSide\(sessionID: string\) \{\s*beginRename\(sessionID\)/.test(shell) && /<RenameDialog\s+v-if="renamingSession"/.test(shell))
  }
}
