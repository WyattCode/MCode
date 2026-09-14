<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import "@xterm/xterm/css/xterm.css"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

/**
 * One shell, and the xterm showing it.
 *
 * Split out of the drawer so several can be open at once: the drawer owns the
 * row of tabs, and each pane owns exactly one process. Panes stay mounted when
 * they are not the visible one - unmounting would close the shell and throw
 * away the scrollback, which is the opposite of what switching tabs means.
 *
 * WHY xterm AND NOT ghostty-web, since the reference uses ghostty-web.
 *
 * This was measured rather than assumed, and the answer is not "too much work"
 * - it is that the swap does not buy the thing it looks like it buys.
 *
 * The reference's terminal is genuinely ghostty-web (a WASM build of Ghostty's
 * Zig core plus a canvas front end; its bundle contains no xterm at all), and
 * its one real rendering advantage is Ghostty's sprite rasterizer, which draws
 * 1085 codepoints - box drawing, blocks, braille, powerline, Legacy Computing
 * - at exact device-pixel cell size, so frames join seamlessly and need no
 * font coverage. But no published build of ghostty-web has that path: every
 * npm version through 0.4.0-next.20 has zero sprite code and a 424KB wasm
 * against the reference's 967KB. The reference builds from something not on
 * npm. Swapping would therefore cost the migration and still draw every box
 * character with fillText, exactly as today.
 *
 * Three of the things it would cost are worse than the difference it closes:
 * ghostty-web's handleCompositionUpdate is an empty function and its preedit
 * text lands in a contenteditable container rather than over the cursor, which
 * for anyone typing Chinese is a downgrade, not a variation; EditMenu's
 * terminal detection breaks twice, once because the helper textarea loses its
 * class and once because the container becomes contenteditable; and its render
 * loop schedules a frame unconditionally forever, where xterm schedules one
 * only when something changed.
 *
 * So: keep xterm, and take everything from the reference that is not the
 * engine - its font, its option values, its colour derivations, its focus
 * behaviour. What stays different is narrow and written down: Unicode widths
 * follow 11 rather than 15.1, Legacy Computing sextants stay uncovered, the
 * scrollbar is the platform's rather than a fading canvas overlay, and
 * XTPUSHSGR is unsupported.
 */
const props = defineProps<{
  active: boolean
  height: number
  /** A shell the backend is already holding, to come back to instead of starting one. */
  shellID?: string
  /** The conversation this terminal belongs to; absent on the home screen. */
  sessionID?: string
  /** On the home screen, the project folder picked there, which the shell starts in. */
  directory?: string
}>()
/* `used`: something was typed into the shell for the first time, which MiMo asks about before closing it. */
const emit = defineEmits<{ exited: []; opened: [shellID: string, cwd: string]; used: [] }>()

const app = useApp()

const host = ref<HTMLElement>()
const menu = ref<{ x: number; y: number }>()
const shellID = ref<string>()
let terminal: Terminal | undefined
let fit: FitAddon | undefined
let resized: ResizeObserver | undefined
let offEvents: (() => void) | undefined
let offTheme: (() => void) | undefined
let webgl: WebglAddon | undefined

/** Whether the process is still running, which the drawer marks on the tab. */
defineExpose({
  focus: () => terminal?.focus(),
  alive: () => Boolean(shellID.value),
  /** Types a command into the shell and runs it, as if it had been typed. */
  run: (command: string) => {
    // False while the shell is still starting, so the caller can wait rather
    // than dropping the first command typed after the drawer appears.
    if (!shellID.value) return false
    void app.client?.request({
      type: "shell.input",
      shellID: shellID.value,
      data: command + "\n",
    })
    return true
  },
})

/** Whether a colour is dark enough to be a dark theme's background. */
function isDark(colour: string): boolean {
  const hex = colour.trim().replace("#", "")
  if (hex.length < 6) return true
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16))
  if ([r, g, b].some((part) => Number.isNaN(part))) return true
  // Rec. 601 luma, which is what "is this dark" means to an eye.
  return (r * 299 + g * 587 + b * 114) / 1000 < 128
}

/**
 * The sixteen colours a program picks from when it colours its own output.
 *
 * These are the reference's own `terminal.ansi*` values. They are not derived
 * from the theme and do not change with it: its `getTerminalColors` resolves
 * only four colours from theme tokens - background, foreground, cursor and
 * selection - and these sit underneath as fixed defaults. Deriving them from
 * this app's semantic tokens instead was the tempting alternative and the wrong
 * one: --error and --success are UI colours, muted for reading paragraphs
 * against, and a build tool's red would have come out washed rather than red.
 *
 * Every bright slot repeats its normal one, which is what the reference ships;
 * black is the terminal's own background, so a program that paints "black" text
 * disappears into it exactly as it does there.
 *
 * Without these, xterm fell back to its built-in palette - a different red, a
 * different green - so ls, git and every build tool were the wrong colours.
 */
const ANSI = {
  black: "#141415",
  red: "#ff2e3f",
  green: "#0dbe4e",
  yellow: "#ffca00",
  blue: "#008cff",
  magenta: "#c635e4",
  cyan: "#08c0ef",
  white: "#c6c6c8",
  brightBlack: "#141415",
  brightRed: "#ff2e3f",
  brightGreen: "#0dbe4e",
  brightYellow: "#ffca00",
  brightBlue: "#008cff",
  brightMagenta: "#c635e4",
  brightCyan: "#08c0ef",
  brightWhite: "#c6c6c8",
} as const

/**
 * The four colours xterm is given.
 *
 * Shaped after the reference's own getTerminalColors, which resolves the
 * theme's tokens and then derives the rest rather than looking each up:
 * `{ background, foreground: text, cursor: text, selectionBackground:
 * withAlpha(text, alpha) }`. Two of those derivations MCode did not make.
 *
 * The cursor was --primary, an accent - orange on the default theme - where
 * the reference draws it in the text colour. And the selection came from
 * --surface-selected, a flat opaque token, where the reference tints the
 * foreground at 25% over dark and 20% over light so whatever is under it still
 * reads through. The fallbacks are the reference's own DEFAULT_TERMINAL_COLORS
 * (main-8t-QUXax.js:5426288).
 */
function palette() {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback

  const background = read("--surface-raised", "#191515")
  const dark = isDark(background)
  const foreground = read("--text-strong", dark ? "#d4d4d4" : "#211e1e")
  const alpha = dark ? 0.25 : 0.2

  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: withAlpha(foreground, alpha),
    ...ANSI,
  }
}

/** A colour with an alpha channel appended, the way the reference's withAlpha does. */
function withAlpha(colour: string, alpha: number): string {
  const hex = colour.trim().replace("#", "")
  if (hex.length !== 6) return colour
  const channel = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")
  return `#${hex}${channel}`
}

onMounted(async () => {
  if (!host.value || (!props.sessionID && !props.directory)) return

  terminal = new Terminal({
    // Its own variable, so a terminal face can differ from the code face.
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim() ||
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
      "monospace",
    /*
     * MiMo's bottom terminal: 12px text on xterm's own line height, the default
     * block cursor blinking, and no cursor at all once the terminal loses focus -
     * an outline left in an idle pane reads as something waiting. An opaque
     * background, and no newline translation: a pty already sends CRLF, so
     * converting again doubles it.
     */
    fontSize: 12,
    cursorBlink: true,
    cursorInactiveStyle: "none",
    allowTransparency: false,
    convertEol: false,
    /*
     * Required before `unicode.activeVersion` may be assigned below. Without
     * it that assignment throws, and because it throws inside onMounted the
     * whole renderer goes down with it - measured: the drawer never appeared
     * and every pill in the composer vanished with the rest of the tree.
     */
    allowProposedApi: true,
    theme: palette(),
    scrollback: 10000,
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)

  /*
   * Refit whenever the pane itself changes size, not only when the drawer is
   * dragged. A notice above the terminal takes rows away while the drawer
   * stays the same height, and xterm otherwise goes on drawing the rows it no
   * longer has room for below the clip.
   */
  resized = new ResizeObserver(() => {
    if (!props.active) return
    requestAnimationFrame(() => fit?.fit())
  })
  resized.observe(host.value)

  /*
   * Wider character widths, before anything is written.
   *
   * xterm defaults to Unicode 6 wcwidth, under which a ZWJ emoji sequence or
   * an Indic cluster is measured as the wrong number of cells and every column
   * after it on that line is off by the difference. Version 11 is as far as the
   * addon goes - the reference's engine reports 15.1 - but it is what moves
   * emoji and CJK onto the widths they are actually drawn at.
   */
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = "11"

  /*
   * Links. Terminal output is full of them - a dev server address, a failing
   * test's docs link, a CI run - and every one of them was dead text.
   *
   * A modifier is required, exactly as the reference requires one: a bare click
   * in a terminal is how you place a selection, and stealing it to launch a
   * browser would make selecting a URL impossible. Alt is excluded because
   * alt-drag is a block selection. Only http and https are offered to the main
   * process, and it checks the scheme again on its own side.
   */
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      const wanted = event.ctrlKey || event.metaKey || event.shiftKey
      if (!wanted || event.altKey) return
      if (!uri.startsWith("http://") && !uri.startsWith("https://")) return
      window.mcode.openExternal(uri)
    }),
  )

  /*
   * No SerializeAddon, though the reference has one.
   *
   * It exists there to carry a terminal's contents across a remount while the
   * pty behind it keeps running. That situation does not arise here: App.vue
   * mounts this drawer under `v-if`, so closing it unmounts every pane, and a
   * pane's unmount closes its shell. Restoring a buffer would therefore replay
   * the output of a process that is already dead. The addon goes back in the
   * day the drawer stops killing its shells - see the note in the drawer.
   */
  terminal.open(host.value)

  /*
   * The GPU renderer, for the glyphs a font cannot be relied on for.
   *
   * This is the one place the gap against the reference's Ghostty renderer
   * actually narrows: measured, the addon carries its own drawings for 176
   * codepoints - all 160 of U+2500..259F plus 16 powerline separators - where
   * xterm's core has 12. Those are exactly the characters TUIs draw frames
   * with, and drawn from the font they leave hairline seams between cells.
   *
   * Loaded after open() because it needs a canvas to attach to, and guarded:
   * a GPU driver reset loses the context, and an addon left attached after
   * that paints nothing at all. Disposing falls back to the DOM renderer,
   * which is only slower.
   */
  try {
    webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      webgl?.dispose()
      webgl = undefined
    })
    terminal.loadAddon(webgl)
  } catch {
    /* No WebGL here - the DOM renderer draws the same text, without the glyphs. */
  }

  fit.fit()

  const client = app.client
  if (!client) return

  /* True while replayed output is being parsed; see the attach below. */
  let replaying = false
  /*
   * Until when a device-attributes answer is held back. The console host asks
   * for one as a shell starts, and xterm's answer reaches it only after the
   * output has crossed to this window - by which time the host has stopped
   * waiting and hands the answer to the shell as typed text: "[?1;2c" at the
   * very first prompt. A program asking later, once the shell is up, is
   * answered as usual.
   */
  let quietUntil = Date.now() + 3000
  let used = false

  if (props.shellID) {
    /*
     * Coming back to a shell that kept running while the drawer was away.
     * Its output is replayed before anything else is wired up, so the pane
     * redraws to the state the process is actually in rather than to a blank
     * screen with a live prompt somewhere below it.
     */
    shellID.value = props.shellID
    const back = await client.request({ type: "shell.attach", shellID: props.shellID })
    /*
     * The replay holds the shell's opening queries - a device-attributes
     * request among them - and xterm answers every one it reads. Those answers
     * belong to a start-up long past, so none is sent while the replay is
     * parsed: the shell would take them as typed text, "[?1;2c" at the prompt.
     */
    if (back.data) {
      replaying = true
      terminal.write(back.data, () => {
        replaying = false
      })
    }
    if (!back.alive) {
      shellID.value = undefined
      emit("exited")
    } else {
      // Its size is whatever the last pane left it at, which is not this one's.
      void client.request({ type: "shell.resize", shellID: props.shellID, cols: terminal.cols, rows: terminal.rows })
    }
  } else {
    /*
     * The grid is measured before the shell is asked for, so the very first
     * prompt is printed against the real width. Sending the size afterwards
     * cannot rewrap a prompt that has already been drawn.
     */
    const result = await client.request({
      type: "shell.open",
      ...(props.sessionID ? { sessionID: props.sessionID } : { directory: props.directory }),
      cols: terminal.cols,
      rows: terminal.rows,
    })
    shellID.value = result.shellID
    emit("opened", result.shellID, result.cwd)
  }

  offEvents = client.on((event) => {
    if (event.type === "shell.data" && event.shellID === shellID.value) terminal?.write(event.data)
    else if (event.type === "shell.exit" && event.shellID === shellID.value) {
      terminal?.write(
        `\r\n\x1b[90m[process exited${event.code === null ? "" : ` with code ${event.code}`}]\x1b[0m\r\n`,
      )
      shellID.value = undefined
      emit("exited")
    }
  })

  // The shell is attached or open from here, so the start-up window counts from now.
  quietUntil = Date.now() + 3000
  terminal.onData((data) => {
    if (replaying || !shellID.value) return
    if (Date.now() < quietUntil && /^\x1b\[\?[\d;]*c$/.test(data)) return
    // Focus reports are the terminal talking, not the reader.
    if (!used && data !== "\x1b[I" && data !== "\x1b[O") {
      used = true
      emit("used")
    }
    void client.request({ type: "shell.input", shellID: shellID.value, data })
  })

  /*
   * Tell the shell when the grid changes. xterm raises this only when the
   * count of cells actually differs, so dragging the drawer sends one message
   * per column crossed rather than one per pixel. A shell that is never told
   * keeps wrapping at the width it started with.
   */
  terminal.onResize(({ cols, rows }) => {
    if (shellID.value) void client.request({ type: "shell.resize", shellID: shellID.value, cols, rows })
  })

  /*
   * Ctrl+C in a terminal interrupts, so copying takes the shift as it does in
   * every other terminal. Returning false keeps the keystroke from also
   * reaching the shell.
   */
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true
    const key = event.key.toLowerCase()
    if (key !== "c" && key !== "v") return true

    /*
     * Both halves matter. Returning false keeps xterm from sending the
     * keystroke on to the shell; preventing the default keeps Chromium from
     * acting on it as well - Ctrl+Shift+V is its own paste-as-plain-text, which
     * would land in the textarea xterm reads from and paste a second time.
     */
    event.preventDefault()
    if (key === "c") copySelection()
    else void pasteClipboard()
    return false
  })

  offTheme = watchTheme()
  if (props.active) terminal.focus()
})

function copySelection() {
  // Written in the main process for the same reason the paste reads there: the
  // renderer's clipboard is refused whenever the document is not focused.
  const text = terminal?.getSelection()
  if (text) window.mcode.setClipboardText(text)
}

async function pasteClipboard() {
  // Read in the main process: the renderer's clipboard read is permission-gated
  // and returns nothing when it is refused, which would look like an empty paste.
  const text = await window.mcode.clipboardText()
  if (text) terminal?.paste(text)
}

function openMenu(event: MouseEvent) {
  menu.value = { x: event.clientX, y: event.clientY }
}

const menuItems = computed<MenuItem[]>(() => [
  { key: "copy", label: t("edit.copy"), enabled: Boolean(terminal?.hasSelection()) },
  { key: "paste", label: t("edit.paste") },
])

function pickMenu(key: string) {
  if (key === "copy") copySelection()
  else void pasteClipboard()
  menu.value = undefined
  terminal?.focus()
}

/**
 * xterm holds its own colour table, so it does not follow the CSS the way the
 * rest of the app does. Under the default "system" theme the OS can flip while
 * the app is open, which would otherwise leave a dark terminal inside a light
 * window - so watch both the media query and the explicit attribute.
 */
function watchTheme() {
  const apply = () => {
    if (terminal) terminal.options.theme = palette()
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  media.addEventListener("change", apply)
  const observer = new MutationObserver(apply)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  return () => {
    media.removeEventListener("change", apply)
    observer.disconnect()
  }
}

onBeforeUnmount(() => {
  offTheme?.()
  offEvents?.()
  resized?.disconnect()
  /*
   * The GPU renderer goes first, and by hand.
   *
   * Letting Terminal.dispose() take it down threw `Cannot read properties of
   * undefined (reading '_isDisposed')` out of the addon and killed the whole
   * renderer - measured every time the drawer was put away, which is now an
   * ordinary thing to do rather than a rare one. The addon reaches back into
   * services the core has already torn down, so it has to be let go first.
   */
  try {
    webgl?.dispose()
  } catch {
    /* Already gone with its context; nothing to release. */
  }
  webgl = undefined
  /*
   * The shell is deliberately left running. Unmounting is not the reader
   * saying "end this" - App.vue mounts the drawer under v-if, so collapsing
   * the panel or stepping to the home screen unmounts every pane, and this
   * line used to kill a dev server for each. Ending a shell is the tab's
   * close button, and the backend sweeps whatever is left when the window
   * that opened it goes away.
   */
  terminal?.dispose()
})

/*
 * A hidden pane has no size, so xterm cannot lay itself out while it is behind
 * another tab. Refit when it comes forward, and whenever the drawer is dragged.
 */
watch(
  () => [props.height, props.active] as const,
  () => {
    if (!props.active) return
    requestAnimationFrame(() => {
      fit?.fit()
      terminal?.focus()
    })
  },
)
</script>

<template>
  <div v-show="active" ref="host" class="term" @contextmenu.prevent.stop="openMenu" />

  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="menuItems"
    @pick="pickMenu"
    @close="menu = undefined"
  />
</template>

<style scoped>
.term {
  flex: 1;
  min-height: 0;
  /*
   * The terminal measures a character by parking a span some hundred thousand
   * pixels off to one side. Past the origin that span is simply unreachable,
   * but a mirrored document counts the same distance as somewhere to scroll to,
   * and the window grows a horizontal scrollbar the width of the measurement.
   * Clipping it here leaves it where it was meant to be - out of reach.
   */
  overflow: hidden;
}

/*
 * The inset sits on xterm's own element rather than on the box above. The fit
 * addon sizes the grid from that box's height and takes off only the padding
 * of xterm's element; with border-box sizing, padding on the box was counted as
 * room for rows, so the last row ran past the bottom whenever the height came
 * close to a whole row - which a notice above the terminal made the usual case.
 */
/* MiMo's terminal body: 6 above, 8 either side, 12 below. */
.term :deep(.xterm) {
  padding: 6px 8px 12px;
}
</style>
