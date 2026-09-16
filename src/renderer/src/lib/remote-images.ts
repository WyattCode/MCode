/*
 * Pictures on the web in replies load only once the reader asks (the user's
 * 2026-09-16 decision). The renderer leaves a placeholder button for each
 * (markdown.ts, `remoteImageHtml`); a click swaps it for the picture, and the
 * address is remembered for this window so a redrawn reply keeps showing it.
 */

const allowed = new Set<string>()

export function allowRemoteImage(address: string): void {
  allowed.add(address)
}

/** Swaps each placeholder under `host` whose address the reader has allowed for the picture itself. */
export function showAllowedRemoteImages(host: ParentNode, tip: string): void {
  for (const holder of host.querySelectorAll<HTMLElement>("[data-remote-src]")) {
    const address = holder.dataset.remoteSrc ?? ""
    if (!/^https?:\/\//i.test(address) || !allowed.has(address)) continue
    const image = document.createElement("img")
    image.className = holder.classList.contains("md-img-link") ? "md-img md-img-link" : "md-img"
    image.alt = holder.dataset.remoteAlt ?? ""
    image.title = tip
    image.loading = "lazy"
    image.dataset.previewSrc = address
    if (holder.dataset.fallbackHref) image.dataset.fallbackHref = holder.dataset.fallbackHref
    // Sent without the page's address, as the reply's own links are.
    image.referrerPolicy = "no-referrer"
    image.src = address
    holder.replaceWith(image)
  }
}
