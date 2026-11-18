/**
 * The browser tab's rules, kept apart from Electron so they can be tested
 * without a window: where a page's popup goes, what its right-click menu
 * offers, which keys pressed inside it belong to the app, how zoom steps, how
 * a failed load is explained, and how a local server is named.
 *
 * Every rule here is MiMo's, measured from its bundle; the few places MCode
 * differs say why beside them.
 */

/* ------------------------------------------------------------------ popups */

export type OpenRoute = { type: "newtab"; url: string } | { type: "external"; url: string } | { type: "deny" }

/**
 * Where a page's `window.open` or target=_blank goes.
 *
 * MiMo opens the web in a new tab of the panel and hands mailto, tel and file
 * to the system. file: is refused here: a page from the internet asking the
 * system to open a local path is how an executable gets started, and this
 * panel's pages are strangers.
 */
export function routeWindowOpen(input: string): OpenRoute {
  const raw = String(input ?? "").trim()
  if (!raw) return { type: "deny" }
  let protocol = ""
  try {
    protocol = new URL(raw).protocol.toLowerCase()
  } catch {
    return { type: "deny" }
  }
  if (protocol === "http:" || protocol === "https:") return { type: "newtab", url: raw }
  if (protocol === "mailto:" || protocol === "tel:") return { type: "external", url: raw }
  return { type: "deny" }
}

/* ------------------------------------------------------------ context menu */

export type PageMenuItem =
  | "openLinkNewTab"
  | "copyLink"
  | "copyImage"
  | "copyImageUrl"
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "back"
  | "forward"
  | "reload"

export interface PageMenuParams {
  isEditable?: boolean
  selectionText?: string
  editFlags?: { canCopy?: boolean; canCut?: boolean; canPaste?: boolean; canSelectAll?: boolean }
  linkURL?: string
  srcURL?: string
  mediaType?: string
  canGoBack?: boolean
  canGoForward?: boolean
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

/* The editing rows: only what can be done, never greyed. */
function editItems(params: PageMenuParams): PageMenuItem[] {
  const flags = params.editFlags ?? {}
  const editable = Boolean(params.isEditable)
  const selected = hasText(params.selectionText)
  const out: PageMenuItem[] = []
  if (flags.canCopy ?? selected) out.push("copy")
  if (editable) {
    if (flags.canCut ?? selected) out.push("cut")
    if (flags.canPaste ?? true) out.push("paste")
  }
  // A field always offers select all, as MiMo does; Chromium reports canSelectAll false for an empty one.
  if (editable || selected) out.push("selectAll")
  return out
}

function isWeb(url: string): boolean {
  try {
    const protocol = new URL(url).protocol.toLowerCase()
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/**
 * MiMo's page menu, as groups a separator goes between: the link, the image,
 * the editing rows, and - only when none of those applies - back, forward and
 * reload, where back and forward are greyed rather than hidden.
 */
export function pageMenuGroups(params: PageMenuParams): { id: PageMenuItem; enabled: boolean }[][] {
  const groups: { id: PageMenuItem; enabled: boolean }[][] = []
  const link = String(params.linkURL ?? "").trim()
  if (link) {
    const row: { id: PageMenuItem; enabled: boolean }[] = []
    if (isWeb(link)) row.push({ id: "openLinkNewTab", enabled: true })
    row.push({ id: "copyLink", enabled: true })
    groups.push(row)
  }
  if (params.mediaType === "image" && hasText(params.srcURL)) {
    groups.push([
      { id: "copyImage", enabled: true },
      { id: "copyImageUrl", enabled: true },
    ])
  }
  const edits = editItems(params)
  if (edits.length) groups.push(edits.map((id) => ({ id, enabled: true })))
  if (!groups.length) {
    groups.push([
      { id: "back", enabled: Boolean(params.canGoBack) },
      { id: "forward", enabled: Boolean(params.canGoForward) },
      { id: "reload", enabled: true },
    ])
  }
  return groups
}

/* -------------------------------------------------------------------- keys */

/** What `before-input-event` hands over, reduced to the fields read here. */
export interface PageKeyInput {
  type: string
  key: string
  code: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/**
 * Chords the page keeps even when the app has them: find, copy, select all and
 * paste belong to the text in the page (MiMo's `BQ`).
 */
export const PAGE_KEEPS: readonly string[] = ["Ctrl+F", "Ctrl+C", "Ctrl+A", "Ctrl+V"]

/* A key's unshifted US-layout character, for chords held with Shift or typed on another layout. */
const CODE_CHAR: Record<string, string> = {
  Period: ".", Comma: ",", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backslash: "\\", Tab: "Tab",
  NumpadAdd: "NumpadAdd", NumpadSubtract: "NumpadSubtract",
}

function mainKey(key: string): string {
  if (key === " ") return "Space"
  if (key === "ArrowUp") return "↑"
  if (key === "ArrowDown") return "↓"
  if (key === "ArrowLeft") return "←"
  if (key === "ArrowRight") return "→"
  return key.length === 1 ? key.toUpperCase() : key
}

function codeKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  return CODE_CHAR[code]
}

/**
 * The chord a key press spells, by what it typed and by where the key sits.
 * As in the window, the command key is Ctrl on macOS and the Control key is
 * Meta there; elsewhere Ctrl is Ctrl and the Windows or Super key is Meta.
 */
export function chordsOfInput(input: PageKeyInput, platform = ""): string[] {
  const mac = platform === "darwin"
  const parts: string[] = []
  if (mac ? input.meta : input.control) parts.push("Ctrl")
  if (input.alt) parts.push("Alt")
  if (input.shift) parts.push("Shift")
  if (mac ? input.control : input.meta) parts.push("Meta")
  if (["Control", "Alt", "Shift", "Meta"].includes(input.key)) return []
  const prefix = parts.length ? `${parts.join("+")}+` : ""
  const out = [`${prefix}${mainKey(input.key)}`]
  const byCode = codeKey(input.code)
  if (byCode && !out.includes(`${prefix}${byCode}`)) out.unshift(`${prefix}${byCode}`)
  return out
}

export type PageKeyAction = { kind: "none" } | { kind: "reload"; force: boolean } | { kind: "forward" }

/** Dispatches using the owning window's effective shortcuts, with editing keys kept by the page. */
export function pageKeyAction(input: PageKeyInput, bound: ReadonlyMap<string, string>, platform = ""): PageKeyAction {
  if (input.type !== "keyDown") return { kind: "none" }
  const chords = chordsOfInput(input, platform)
  if (chords.some((chord) => PAGE_KEEPS.includes(chord))) return { kind: "none" }
  for (const chord of chords) {
    const command = bound.get(chord)
    if (!command) continue
    if (command === "browser.reload" || command === "browser.forceReload") {
      return { kind: "reload", force: command === "browser.forceReload" }
    }
    return { kind: "forward" }
  }
  return { kind: "none" }
}

/* -------------------------------------------------------------------- zoom */

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 3

/** MiMo's zoom step: ten whole percent at a time, within 25%-300%. */
export function stepZoom(current: number, direction: number): number {
  const clamp = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
  const base = clamp(Number.isFinite(current) ? current : 1)
  const next = Math.round(base * 100) + Math.sign(direction) * 10
  return clamp(next / 100)
}

/* ------------------------------------------------------------------ errors */

export type LoadErrorKind = "dns" | "offline" | "connection" | "generic"

/** Chromium's network errors sorted into MiMo's four explanations, by number or by name. */
export function loadErrorKind(code: number, description = ""): LoadErrorKind {
  if (code === -105 || code === -137 || /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(description)) return "dns"
  if (code === -106 || /ERR_INTERNET_DISCONNECTED/.test(description)) return "offline"
  if (
    [-101, -102, -104, -109, -118, -7, -21].includes(code) ||
    /ERR_CONNECTION|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ERR_SOCKET/.test(description)
  ) {
    return "connection"
  }
  return "generic"
}

/* ---------------------------------------------------------- the tab face */

/**
 * The icon a browser tab draws for its page: the first address the page names
 * that is http(s) or an inline image, as MiMo keeps. Anything else is not the
 * window's to load.
 */
export function pageFavicon(favicons: readonly unknown[]): string | undefined {
  for (const entry of favicons) {
    if (typeof entry !== "string") continue
    const url = entry.trim()
    if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url)) return url
  }
  return undefined
}

/**
 * A browser tab's face from what the main process reports of its page: the
 * favicon, and the title that MiMo names the tab by. A tab that has been
 * nowhere has neither, and keeps the globe and the tool's name.
 */
export function browserTabFace(page: { url?: string; title?: string; favicon?: string }): { faviconUrl?: string; pageTitle?: string } {
  const url = String(page.url ?? "").trim()
  if (!url || url === "about:blank") return { faviconUrl: undefined, pageTitle: undefined }
  const title = String(page.title ?? "").replace(/\s+/g, " ").trim()
  return { faviconUrl: pageFavicon([page.favicon]), pageTitle: title || undefined }
}

/* --------------------------------------------------------------- the bar */

/**
 * MiMo's three bar widths: under 300 mini, under 380 compact, else full.
 *
 * A width that is not a positive number is the full bar, as MiMo's own guard
 * has it: a tab measured before it is shown reports 0, and without this the
 * bar would flash its mini form for a frame on every reveal.
 */
export function barMode(width: number): "mini" | "compact" | "full" {
  if (!Number.isFinite(width) || width <= 0) return "full"
  if (width < 300) return "mini"
  if (width < 380) return "compact"
  return "full"
}

/* ---------------------------------------------------------- local servers */

export interface LocalProbe {
  status: number
  contentType: string
  server: string
  body: string
}

/**
 * A development server's card, or nothing for an answer that is not one.
 *
 * AirPlay answers on 5000 and 7000 on a Mac, and a 4xx that is not a page is a
 * service rather than a site; both are left out, as MiMo leaves them.
 */
export function localServerOf(port: number, probe: LocalProbe): { port: number; url: string; title: string; name: string; label: string } | undefined {
  if (/AirTunes|AirPlay|AirReceiver/i.test(probe.server)) return undefined
  const html = /html/i.test(probe.contentType)
  if (probe.status >= 400 && !html) return undefined
  const label = `localhost:${port}`
  const raw = html ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(probe.body)?.[1] ?? "") : ""
  const title = raw.replace(/\s+/g, " ").trim()
  const name = title ? (title.length > 60 ? `${title.slice(0, 60)}…` : title) : label
  return { port, url: `http://localhost:${port}`, title, name, label }
}
