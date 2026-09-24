/**
 * SVG helpers that need no DOM, so the markdown check can run them in node.
 *
 * stripSvgHazards is defence in depth only: DOMPurify, run by the diagram
 * component, is what actually decides what an SVG may keep. This pass removes
 * the obvious hazards first, so a DOMPurify misconfiguration cannot be the
 * only thing standing between a reply and a script.
 */

export function stripSvgHazards(svg: string, keepForeignObject = false): string {
  let out = svg.replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, "").replace(/<\/?script\b[^>]*>/gi, "")
  /*
   * A `<style>` inside an inline SVG is not scoped to the drawing - it is CSS
   * for the whole document. A reply could therefore hide the permission rows,
   * or paint over the window, with no script and nothing DOMPurify objects to:
   * it does not clean CSS text, and `style` is on its SVG tag list (R26-A2).
   * The ABC score's own sanitiser has forbidden `style` all along, which is the
   * same knowledge not carried across to this path.
   *
   * A drawing that needs styling has `fill`, `stroke` and the rest on its own
   * elements, which stay.
   */
  out = out.replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, "").replace(/<\/?style\b[^>]*>/gi, "")
  if (!keepForeignObject) {
    out = out.replace(/<foreignObject\b[\s\S]*?(?:<\/foreignObject\s*>|$)/gi, "").replace(/<\/?foreignObject\b[^>]*>/gi, "")
  }
  // Addresses before handlers: a handler's text inside an address would otherwise cut the address's quotes apart.
  return out
    .replace(/\s+(?:xlink:)?href\s*=\s*(?:"\s*(?:javascript|data|vbscript):[^"]*"|'\s*(?:javascript|data|vbscript):[^']*'|(?:javascript|data|vbscript):[^\s>]+)/gi, "")
    .replace(/<(?!a[\s/>])[a-zA-Z][\w:-]*\b[^>]*>/g, (tag) => tag.replace(REMOTE_HREF, ""))
    .replace(STYLE_ATTRIBUTE, (attribute) => attribute.replace(REMOTE_IN_CSS, ""))
    .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
}

/*
 * A drawing that fetches from the web would load the moment it is shown, which
 * is the same silent channel a web picture in a reply is (those wait for a
 * click). So a drawing's own pictures, patterns and styles never name a web
 * address; a link (`<a>`) is left alone, since following it takes a click.
 */
/*
 * `http:/host/x` and even `http:host/x` reach the same host as `http://host/x`
 * - the URL parser is forgiving about how many slashes a special scheme is
 * written with. Both of these asked for two, so a reply could name a web
 * address with one and the drawing fetched it the moment it was shown, which
 * is the silent channel this pair exists to close (R26-A1). The scheme is what
 * matters, so the slashes are optional here; a scheme-relative `//host/x` is
 * still caught by the second half.
 */
const REMOTE = String.raw`(?:https?:\/{0,2}|\/\/)`
const REMOTE_HREF = new RegExp(String.raw`\s+(?:xlink:)?href\s*=\s*(?:"\s*${REMOTE}[^"]*"|'\s*${REMOTE}[^']*'|${REMOTE}[^\s>]+)`, "gi")
/*
 * A web address inside CSS. `url(` itself can be written with escapes -
 * `\75 rl(...)` is `url(...)` - so matching the function name is not enough;
 * what is matched is the address, and only where CSS can appear. A drawing's
 * `<style>` element is removed outright above, which leaves the `style`
 * attribute, handled here. An address in a `<text>` element is words on a
 * picture and stays; an `<a href>` stays too, because following it takes a
 * click - stripping either was this pass reaching past its own purpose.
 */
const REMOTE_IN_CSS = new RegExp(String.raw`${REMOTE}[^)"'\s]*`, "gi")
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi

/** MiMo's test for a picture path that gets the SVG file card: .svg, before any query or fragment. */
export function isSvgFile(path: string): boolean {
  return /\.svg(?:[?#].*)?$/i.test(path)
}

const OPEN_TAG = /<svg\b[^>]*>/i

/** An SVG's own size: its width and height in pixels, else its viewBox, else 800 by 600 - as MiMo measures it. */
export function svgSize(svg: string, fallback = { w: 800, h: 600 }): { w: number; h: number } {
  const tag = OPEN_TAG.exec(svg)?.[0] ?? ""
  const pixels = (value: string | undefined) => {
    const match = value ? /^\s*([\d.]+)\s*(?:px)?\s*$/i.exec(value) : null
    const number = match ? Number.parseFloat(match[1]) : Number.NaN
    return Number.isFinite(number) && number > 0 ? number : undefined
  }
  const w = pixels(/\bwidth\s*=\s*"([^"]*)"/.exec(tag)?.[1])
  const h = pixels(/\bheight\s*=\s*"([^"]*)"/.exec(tag)?.[1])
  if (w && h) return { w, h }
  const box = /\bviewBox\s*=\s*"([^"]*)"/.exec(tag)?.[1]
  if (box) {
    const parts = box.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { w: parts[2], h: parts[3] }
  }
  return { ...fallback }
}
