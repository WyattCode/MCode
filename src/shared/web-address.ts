/**
 * What an address bar should do with what was typed.
 *
 * Kept apart from the panel that uses it because it is pure string work with
 * security decisions in it, and those are worth testing without starting a
 * window: a page may only ever be sent to http or https, a port means http,
 * and the one other thing the address bar itself accepts is a local file.
 */

/**
 * Hosts that are this machine, or a machine on the same network.
 *
 * They decide the scheme when none was typed. A development server on a port
 * is http far more often than not, and guessing https there fails with an
 * empty panel and nothing on screen to explain why.
 */
const LOCAL_HOST =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/i

/*
 * A scheme, and not a port.
 *
 * "localhost:3000" parses as the scheme "localhost:" by the ordinary rule, so
 * this app refused to open the most common development address there is. What
 * follows the colon decides: digits are a port, anything else is a scheme.
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i

function withScheme(raw: string): string {
  if (HAS_SCHEME.test(raw)) return raw
  const host = raw.split("/")[0]
  const name = host.replace(/:\d+$/, "")
  const hasPort = /:\d+$/.test(host)
  return `${LOCAL_HOST.test(name) || hasPort ? "http" : "https"}://${raw}`
}

/**
 * http and https, and nothing else.
 *
 * This is what a page is allowed to navigate to. An app's own internal scheme
 * is not something a page gets to ask for, and a page from the web reaching for
 * a local file is refused here as well as by Chromium.
 */
export function safeURL(input: string): string | undefined {
  const raw = input.trim()
  if (!raw) return undefined
  try {
    const url = new URL(withScheme(raw))
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/*
 * Local files in the address bar.
 *
 * The user chose (2026-09-15) to let the panel open local files as MiMo's does,
 * accepting that it becomes a viewer for anything they type the path of. The
 * rule is kept to MiMo's: an absolute path - one starting with "/" or a drive
 * letter - or a typed file:// address. Two things are narrower than MiMo on
 * purpose: a network path ("\\server\share", "//server", file://server/) is
 * refused, because Windows answers one by offering the user's credentials to
 * that server; and nothing but the address bar produces a file address.
 */
const DRIVE_PATH = /^[a-z]:[\\/]/i

/** MiMo's encoding of a path: forward slashes, encodeURI, and `#` and `?` kept as part of the name. */
export function localPathToURL(path: string): string {
  const encoded = encodeURI(path.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F")
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`
}

/** A file address on this machine, normalised, or nothing - a network share is not this machine. */
export function localFileURL(input: string): string | undefined {
  try {
    const url = new URL(input)
    if (url.protocol !== "file:") return undefined
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") return undefined
    // "file:////server/share" has no host but is a network path all the same.
    if (url.pathname.startsWith("//")) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Whether a page on `from` may go to `to` by itself (a link, a form, script).
 *
 * The web is always allowed. A file only from a file: a local page's links to
 * its neighbours work, as they do in MiMo, while a page from the web still
 * cannot move the panel onto a local file.
 */
export function pageMayNavigate(from: string, to: string): boolean {
  if (safeURL(to)) return true
  if (!localFileURL(to)) return false
  return Boolean(localFileURL(from))
}

/**
 * Something that parses as a host is opened; anything else is a search, which
 * is what every address bar has done for fifteen years and what a reader
 * typing three words expects. An absolute path or a file address opens that
 * file.
 */
export function addressToURL(input: string): string | undefined {
  const raw = input.trim()
  if (!raw) return undefined
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return undefined
  if (raw.startsWith("/") || DRIVE_PATH.test(raw)) return localFileURL(localPathToURL(raw))
  if (/^file:/i.test(raw)) return localFileURL(raw)
  const looksLikeHost =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||
    /^[^\s/]+\.[^\s/]{2,}(\/|$|:)/.test(raw) ||
    /^localhost(:\d+)?(\/|$)/i.test(raw) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)
  if (looksLikeHost) return safeURL(raw)
  // MiMo's search engine.
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`
}
