/**
 * The link service pdf.js's annotation layer talks to (its IPDFLinkService),
 * cut down to what a page's annotations call, and the rules for what a click
 * on one of its anchors may do.
 *
 * MiMo 26.920 renders react-pdf's annotation layer: links, highlights, notes
 * with their popups, form fields drawn on the canvas (renderForms off). Its
 * outbound rule is the one kept here: only the web, mail and phone go out,
 * through the app's own external-open path. Where MCode goes further is inside
 * the document: MiMo's capture-phase click handler swallows every anchor,
 * including the "#" ones react-pdf's service binds to a destination, so its
 * table-of-contents links do nothing; here they scroll to the page and point.
 *
 * Nothing in this file touches the DOM beyond setting fields on the anchor it
 * is handed, so the smoke run exercises it as it is.
 */

/** What a click on an annotation anchor may do, read from its href alone. */
export type PdfLinkAction = "internal" | "external" | "blocked"

export function pdfLinkAction(href: string): PdfLinkAction {
  // Destinations, named actions and attachments are bound as "#" with a click handler of pdf.js's own.
  if (href.startsWith("#")) return "internal"
  // As MiMo: the web, mail and phone; the main process then lets only the web through to a browser.
  if (/^(https?:|mailto:|tel:)/i.test(href)) return "external"
  return "blocked"
}

/** Where an explicit destination points on its page: its top edge in PDF user space, or null for "the page" (Fit, FitV, a missing top). */
export function destinationTop(explicit: readonly unknown[]): { left: number | null; top: number | null } {
  const kind = (explicit[1] as { name?: unknown } | undefined)?.name
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)
  switch (kind) {
    case "XYZ":
      return { left: num(explicit[2]), top: num(explicit[3]) }
    case "FitH":
    case "FitBH":
      return { left: null, top: num(explicit[2]) }
    case "FitR":
      return { left: num(explicit[2]), top: num(explicit[5]) }
    default:
      return { left: null, top: null }
  }
}

/** The part of a PDF document a destination is resolved against. */
export interface PdfDestinationSource {
  numPages: number
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: { num: number; gen: number }): Promise<number>
}

export interface ResolvedDestination {
  /** Zero-based. */
  pageIndex: number
  left: number | null
  top: number | null
}

/** A named or explicit destination as a page and a point on it, or null when it leads nowhere in this document. */
export async function resolveDestination(pdf: PdfDestinationSource, dest: unknown): Promise<ResolvedDestination | null> {
  let explicit: unknown = dest
  try {
    if (typeof dest === "string") explicit = await pdf.getDestination(dest)
  } catch {
    return null
  }
  if (!Array.isArray(explicit) || !explicit.length) return null
  const ref = explicit[0]
  let pageIndex: number | null = null
  if (Number.isInteger(ref)) pageIndex = ref as number
  else if (ref && typeof ref === "object") {
    try {
      pageIndex = await pdf.getPageIndex(ref as { num: number; gen: number })
    } catch {
      return null
    }
  }
  if (pageIndex === null || pageIndex < 0 || pageIndex >= pdf.numPages) return null
  return { pageIndex, ...destinationTop(explicit) }
}

/** The page a named action goes to, as pdf.js's viewer reads them, or null for one that is not about pages. */
export function namedActionPage(action: string, current: number, count: number): number | null {
  if (count < 1) return null
  switch (action) {
    case "FirstPage":
      return 1
    case "LastPage":
      return count
    case "NextPage":
      return Math.min(current + 1, count)
    case "PrevPage":
      return Math.max(current - 1, 1)
    default:
      return null
  }
}

/** The anchor fields pdf.js asks the service to set on an outbound link. */
export interface LinkLike {
  href: string
  rel: string
  target: string
}

/**
 * pdf.js's IPDFLinkService, as far as the annotation layer calls it. Clicks
 * on outbound anchors never reach the anchor (the view takes them in the
 * capture phase), so the attributes set here are for hovering and reading.
 */
export class PdfLinkService {
  /* No sandbox runs, so nothing listens for its events. */
  readonly eventBus = undefined
  externalLinkEnabled = true

  constructor(private readonly hooks: { goTo(dest: unknown): void; named(action: string): void }) {}

  addLinkAttributes(link: LinkLike, url: string, _newWindow = false): void {
    // As react-pdf's service, which MiMo runs: no title of its own.
    link.href = url
    link.rel = "noopener noreferrer nofollow"
    link.target = ""
  }

  getDestinationHash(_dest?: unknown): string {
    return "#"
  }

  getAnchorUrl(_hash?: string): string {
    return "#"
  }

  goToDestination(dest: unknown): void {
    this.hooks.goTo(dest)
  }

  executeNamedAction(action: string): void {
    this.hooks.named(action)
  }

  /* Optional-content layers are not switched: the canvas is drawn once per scale. */
  executeSetOCGState(_action: unknown): void {}
}
