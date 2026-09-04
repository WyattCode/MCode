/**
 * The changelog a release-notes popup is built from.
 *
 * Shape and rules are opencode's, function for function: `parseChangelog`,
 * `parseRelease`, `parseHighlight`, `parseMedia`, `normalizeVersion` and
 * `sliceHighlights`. The two decisions worth naming, because neither is
 * guessable from the popup:
 *
 *  - A release's highlights are grouped by `source`, and only groups whose
 *    source mentions "desktop" are read. The same feed carries entries for
 *    other surfaces, and without the filter a desktop reader is shown notes
 *    about things they do not have.
 *  - At most five are shown, however many versions were skipped.
 */

export interface Media {
  type: "image" | "video"
  src: string
  alt: string
}

export interface Highlight {
  title: string
  description: string
  media?: Media
}

export interface Release {
  tag?: string
  highlights: Highlight[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** `v1.2.3` and `1.2.3` are the same release. */
export function normalizeVersion(value?: string) {
  const text = value?.trim()
  if (!text) return undefined
  return text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text
}

function parseMedia(value: unknown, alt: string): Media | undefined {
  if (!isRecord(value)) return undefined
  const type = getText(value.type)?.toLowerCase()
  const src = getText(value.src) ?? getText(value.url)
  if (!src) return undefined
  if (type !== "image" && type !== "video") return undefined
  return { type, src, alt }
}

function parseHighlight(value: unknown): Highlight | undefined {
  if (!isRecord(value)) return undefined
  const title = getText(value.title)
  if (!title) return undefined
  const description = getText(value.description) ?? getText(value.shortDescription)
  if (!description) return undefined
  return { title, description, media: parseMedia(value.media, title) }
}

function parseRelease(value: unknown): Release | undefined {
  if (!isRecord(value)) return undefined
  const tag = getText(value.tag) ?? getText(value.tag_name) ?? getText(value.name)
  if (!Array.isArray(value.highlights)) return { tag, highlights: [] }
  const highlights = value.highlights.flatMap((group) => {
    if (!isRecord(group)) return []
    const source = getText(group.source)
    if (!source) return []
    if (!source.toLowerCase().includes("desktop")) return []
    if (Array.isArray(group.items)) {
      return group.items.map(parseHighlight).filter((item): item is Highlight => item !== undefined)
    }
    const item = parseHighlight(group)
    return item ? [item] : []
  })
  return { tag, highlights }
}

export function parseChangelog(value: unknown): Release[] | undefined {
  if (Array.isArray(value)) {
    return value.map(parseRelease).filter((release): release is Release => release !== undefined)
  }
  if (!isRecord(value)) return undefined
  if (!Array.isArray(value.releases)) return undefined
  return value.releases.map(parseRelease).filter((release): release is Release => release !== undefined)
}

function dedupeKey(highlight: Highlight) {
  return [highlight.title, highlight.description, highlight.media?.type ?? "", highlight.media?.src ?? ""].join("\n")
}

/** The most this shows at once, however far behind the reader was. */
export const MAX_HIGHLIGHTS = 5

/**
 * What changed between the version last seen and the one running.
 *
 * The feed is newest first, so the run is from the current release down to -
 * but not including - the one already seen. An unknown tag at either end
 * widens the range rather than emptying it: a reader who cannot be placed is
 * better shown the newest notes than none.
 */
export function sliceHighlights(input: { releases: Release[]; current?: string; previous?: string }) {
  const current = normalizeVersion(input.current)
  const previous = normalizeVersion(input.previous)
  const releases = input.releases

  const start = current
    ? (() => {
        const index = releases.findIndex((release) => normalizeVersion(release.tag) === current)
        return index === -1 ? 0 : index
      })()
    : 0
  const end = previous
    ? (() => {
        const index = releases.findIndex((release, i) => i >= start && normalizeVersion(release.tag) === previous)
        return index === -1 ? releases.length : index
      })()
    : releases.length

  const seen = new Set<string>()
  return releases
    .slice(start, end)
    .flatMap((release) => release.highlights)
    .filter((highlight) => {
      const key = dedupeKey(highlight)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_HIGHLIGHTS)
}

export function loadReleaseHighlights(value: unknown, current?: string, previous?: string) {
  const releases = parseChangelog(value)
  if (!releases?.length) return []
  return sliceHighlights({ releases, current, previous })
}
