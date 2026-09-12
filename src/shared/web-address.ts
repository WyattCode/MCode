/**
 * What an address bar should do with what was typed.
 *
 * Kept apart from the panel that uses it because it is pure string work with
 * two security decisions in it, and those are worth testing without starting
 * a window: only http and https are ever returned, and a port means http.
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
 * A `file://` in the address bar would turn a browser panel into a reader for
 * every file its user can open, and an app's own internal scheme is not
 * something a page gets to ask for.
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

/**
 * Something that parses as a host is opened; anything else is a search, which
 * is what every address bar has done for fifteen years and what a reader
 * typing three words expects.
 */
export function addressToURL(input: string): string | undefined {
  const raw = input.trim()
  if (!raw) return undefined
  const looksLikeHost =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||
    /^[^\s/]+\.[^\s/]{2,}(\/|$|:)/.test(raw) ||
    /^localhost(:\d+)?(\/|$)/i.test(raw) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)
  if (looksLikeHost) return safeURL(raw)
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`
}
