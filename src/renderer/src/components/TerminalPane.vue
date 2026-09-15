<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import "@xterm/xterm/css/xterm.css"
import { typedInput } from "@shared/terminal-input"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { isPasteKey, terminalPalette } from "../lib/terminal"

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
 * engine - its font, its option values, its focus behaviour. What stays
 * different is narrow and written down: Unicode widths follow 11 rather than
 * 15.1, Legacy Computing sextants stay uncovered, the scrollbar is the
 * platform's styled to MiMo's overlay slider, and XTPUSHSGR is unsupported.
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
/*
 * `used`: something was typed into the shell, now or before this pane - MiMo
 * asks before closing such a terminal. `attached`: a shell came back and its
 * state is known, so the owner can decide whether to start it again elsewhere.
 */
const emit = defineEmits<{ opened: [shellID: string, cwd: string]; used: []; attached: [] }>()

const app = useApp()

const host = ref<HTMLElement>()
const menu = ref<{ x: number; y: number }>()
const shellID = ref<string>()
/* MiMo's text in place of a terminal that cannot start; red only for a real failure. */
const failure = ref<{ text: string; error: boolean }>()
/* Set while the viewport scrolls, so the slider shows as MiMo's overlay one does. */
const scrolling = ref(false)
let terminal: Terminal | undefined
let fit: FitAddon | undefined
let resized: ResizeObserver | undefined
let offEvents: (() => void) | undefined
let offTheme: (() => void) | undefined
let webgl: WebglAddon | undefined
let scrollTimer: ReturnType<typeof setTimeout> | undefined

defineExpose({
  focus: () => terminal?.focus(),
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

/* MiMo's colours on the app's own surface, which a custom palette may have changed. */
function palette() {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--surface-raised").trim()
  return terminalPalette(background || "#ffffff")
}

function reason(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function onScroll() {
  scrolling.value = true
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => (scrolling.value = false), 800)
}

onMounted(async () => {
  if (!host.value || (!props.sessionID && !props.directory)) return

  const client = app.client
  if (!client) {
    failure.value = { text: t("term.notReady"), error: false }
    return
  }

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
    let back: { data: string; alive: boolean; used: boolean }
    try {
      back = await client.request({ type: "shell.attach", shellID: props.shellID })
    } catch (err) {
      failure.value = { text: t("term.startFailed", { reason: reason(err) }), error: true }
      return
    }
    shellID.value = props.shellID
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
    // Typed into before this pane existed still counts, as MiMo's never resets.
    if (back.used) {
      used = true
      emit("used")
    }
    if (!back.alive) shellID.value = undefined
    // Its size is whatever the last pane left it at, which is not this one's.
    else void client.request({ type: "shell.resize", shellID: props.shellID, cols: terminal.cols, rows: terminal.rows })
    emit("attached")
  } else {
    /*
     * The grid is measured before the shell is asked for, so the very first
     * prompt is printed against the real width. Sending the size afterwards
     * cannot rewrap a prompt that has already been drawn.
     */
    try {
      const result = await client.request({
        type: "shell.open",
        ...(props.sessionID ? { sessionID: props.sessionID } : { directory: props.directory }),
        cols: terminal.cols,
        rows: terminal.rows,
      })
      shellID.value = result.shellID
      emit("opened", result.shellID, result.cwd)
    } catch (err) {
      failure.value = { text: t("term.startFailed", { reason: reason(err) }), error: true }
      return
    }
  }

  /*
   * A shell that ends leaves no mark, as in MiMo: no line in the scrollback
   * and nothing on the tab. Its last output stays readable until it is closed.
   */
  offEvents = client.on((event) => {
    if (event.type === "shell.data" && event.shellID === shellID.value) terminal?.write(event.data)
    else if (event.type === "shell.exit" && event.shellID === shellID.value) shellID.value = undefined
  })

  // The shell is attached or open from here, so the start-up window counts from now.
  quietUntil = Date.now() + 3000
  terminal.onData((data) => {
    if (replaying || !shellID.value) return
    if (Date.now() < quietUntil && /^\x1b\[\?[\d;]*c$/.test(data)) return
    if (!used && typedInput(data)) {
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
   * Paste keys. Ctrl+V (⌘V on a Mac) pastes as MiMo's does - otherwise xterm
   * sends ^V, which only a shell that binds it turns into a paste. Ctrl+Shift+V
   * stays for anyone used to it. Every other key, Ctrl+C included, reaches the
   * shell.
   *
   * Both halves matter. Returning false keeps xterm from sending the keystroke
   * on; preventing the default keeps Chromium from pasting into the textarea
   * xterm reads from, which would paste a second time.
   */
  terminal.attachCustomKeyEventHandler((event) => {
    const shiftPaste = event.type === "keydown" && event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "v"
    if (!shiftPaste && !isPasteKey(event, app.platform === "darwin")) return true
    event.preventDefault()
    void pasteClipboard()
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

/* The usable items of MiMo's native menu over a terminal: copy, paste, select all. */
const menuItems = computed<MenuItem[]>(() => [
  { key: "copy", label: t("edit.copy"), enabled: Boolean(terminal?.hasSelection()) },
  { key: "paste", label: t("edit.paste") },
  { key: "selectAll", label: t("edit.selectAll") },
])

function pickMenu(key: string) {
  if (key === "copy") copySelection()
  else if (key === "selectAll") terminal?.selectAll()
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
  clearTimeout(scrollTimer)
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
  <div
    v-show="active && !failure"
    ref="host"
    class="term"
    :class="{ scrolling }"
    data-terminal-pane
    @scroll.capture="onScroll"
    @contextmenu.prevent.stop="openMenu"
  />
  <div v-if="active && failure" class="term-host" :class="{ error: failure.error }" data-terminal-failure>{{ failure.text }}</div>

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

/*
 * MiMo's xterm 6 slider, drawn on the platform scrollbar: 14 wide, square, in
 * the foreground at 20%, 40% under the pointer and 50% while dragged, and not
 * there at all until the terminal is scrolled or pointed at.
 */
.term :deep(.xterm-viewport::-webkit-scrollbar) {
  width: 14px;
  height: 14px;
}

.term :deep(.xterm-viewport::-webkit-scrollbar-thumb) {
  background: transparent;
  border: 0;
  border-radius: 0;
}

.term.scrolling :deep(.xterm-viewport::-webkit-scrollbar-thumb),
.term :deep(.xterm-viewport:hover::-webkit-scrollbar-thumb) {
  background: #1f1f1f33;
}

.term :deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
  background: #1f1f1f66;
}

.term :deep(.xterm-viewport::-webkit-scrollbar-thumb:active) {
  background: #1f1f1f80;
}

:root[data-theme="dark"] .term.scrolling :deep(.xterm-viewport::-webkit-scrollbar-thumb),
:root[data-theme="dark"] .term :deep(.xterm-viewport:hover::-webkit-scrollbar-thumb) {
  background: #ececec33;
}

:root[data-theme="dark"] .term :deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
  background: #ececec66;
}

:root[data-theme="dark"] .term :deep(.xterm-viewport::-webkit-scrollbar-thumb:active) {
  background: #ececec80;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .term.scrolling :deep(.xterm-viewport::-webkit-scrollbar-thumb),
  :root:not([data-theme="light"]) .term :deep(.xterm-viewport:hover::-webkit-scrollbar-thumb) {
    background: #ececec33;
  }

  :root:not([data-theme="light"]) .term :deep(.xterm-viewport::-webkit-scrollbar-thumb:hover) {
    background: #ececec66;
  }

  :root:not([data-theme="light"]) .term :deep(.xterm-viewport::-webkit-scrollbar-thumb:active) {
    background: #ececec80;
  }
}

/* MiMo's .term-host: 14px text in the strong colour on a 12px inset, red only for an error. */
.term-host {
  flex: 1;
  min-height: 0;
  padding: 12px;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  overflow-wrap: anywhere;
}

.term-host.error {
  color: var(--error);
}
</style>
