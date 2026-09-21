/**
 * Text handling shared by the history and memory indexes: turning a query into
 * an FTS5 expression, keeping inline media out of what is indexed and shown,
 * and cutting long text into pages a model can walk through.
 *
 * The numbers are MiMo's (history: summaries of 1,000 characters, pages of
 * 1-8,000 UTF-16 units defaulting to 4,000, a 16,000-byte ceiling per page).
 */

/** Longest a summary line in search or around may run, in characters and in bytes. */
export const SUMMARY_CHARS = 1000
export const SUMMARY_BYTES = 3000

/** A page of `get`: its default and largest length, and the byte ceiling it is cut to. */
export const PAGE_DEFAULT = 4000
export const PAGE_MAX = 8000
export const PAGE_BYTES = 16000

/**
 * Chinese, Japanese and Korean writing, which is written without spaces.
 *
 * FTS5's `unicode61` splits on anything that is not a letter or a digit, and
 * every one of these is a letter - so a whole run of them is one token, and
 * 「配置」 matched 「配置文件的路径」 only when the query was that entire run.
 */
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}"
const BETWEEN_CJK = new RegExp(`(?<=[${CJK}])(?=[${CJK}])`, "gu")
const JOINED_CJK = new RegExp(`([${CJK}])(>>)? (<<)?(?=[${CJK}])`, "gu")

/**
 * What is indexed for a body: the text with one space put between each pair of
 * neighbouring CJK characters, so each becomes a token of its own.
 *
 * A query is cut the same way and matched as a phrase, which is what makes a
 * substring of a Chinese sentence findable again - and of any length, where a
 * trigram index would need three characters and most Chinese words are two.
 * Text in a spaced script goes through unchanged, so nothing about an English
 * search - its tokens, its ranking or its cost - moves.
 */
export function searchText(text: string): string {
  return text.replace(BETWEEN_CJK, " ")
}

/**
 * What the `search_body` column holds, which is nothing at all for a body with
 * no CJK writing in it.
 *
 * The index reads that column through a view that falls back to `body`, so
 * only a body the cutting actually changed is kept twice. Storing it for every
 * row is a second copy of every message ever written: measured at 83% on top
 * of a search index over 5,000 English parts, for a history that can never
 * need it.
 */
export function searchColumn(text: string): string {
  const cut = searchText(text)
  return cut === text ? "" : cut
}

/**
 * A snippet read back out of the index, with the spaces `searchText` put in
 * taken out again - including around the markers `snippet()` wraps a match in.
 * A space someone wrote between two CJK characters themselves goes with them,
 * which nothing but the look of the line depends on.
 */
export function plainSnippet(text: string): string {
  return text.replace(JOINED_CJK, "$1$2$3")
}

/**
 * The words of a query as an FTS5 expression, or nothing when it has none.
 *
 * Only runs of letters, digits and underscores count, each quoted so an FTS
 * operator typed by the model is searched for rather than obeyed. History
 * wants every word (`AND`); memory ranks documents holding any of them (`OR`).
 * A word of CJK characters is quoted as the phrase of its characters, matching
 * the way the body was indexed.
 *
 * `prefixLast` marks the last word as a prefix, for a search that runs while
 * it is being typed: 「配」 while 「配置」 is meant, or `config` for
 * `configuration`. The model's own searches are whole words, as MiMo's are.
 */
export function ftsQuery(raw: string, joiner: "AND" | "OR", prefixLast = false): string | undefined {
  const words = raw.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (!words.length) return undefined
  return words
    .map((word, at) => `"${searchText(word.replaceAll('"', ""))}"${prefixLast && at === words.length - 1 ? "*" : ""}`)
    .join(` ${joiner} `)
}

/** How long a piece of a query must be, in characters, for the trigram index to look it up. */
export const TRIGRAM_CHARS = 3

/**
 * The pieces of a query the search overlay looks for inside the text, as
 * written: split at white space, and at the two characters a tool row's JSON
 * escapes (`"` and `\`), since the row holds `\"` where the output had `"`.
 *
 * The overlay's own matcher (shared/search-score.ts) reads the whole query as
 * one string; each piece of it is a substring of any text that matches it
 * exactly, so asking for every piece names a superset that the matcher then
 * narrows down.
 */
export function substringPieces(raw: string): string[] {
  return raw.split(/[\s"\\]+/u).filter(Boolean)
}

/**
 * A piece as a trigram phrase, which FTS5 matches anywhere inside a row,
 * ignoring case; or nothing when it is too short to have a trigram.
 */
export function trigramPhrase(piece: string): string | undefined {
  return [...piece].length >= TRIGRAM_CHARS ? `"${piece.replaceAll('"', "")}"` : undefined
}

/**
 * Inline base64 media replaced by a short marker naming its type.
 *
 * A pasted screenshot is megabytes of letters that match nothing anyone would
 * search for and would bury every real snippet, so neither the index nor a
 * summary carries it. Only well-formed `data:<type>;base64,` runs are cut.
 */
export function withoutInlineMedia(text: string): string {
  return text.replace(/(^|[^A-Za-z0-9._/+%-])data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)((?:;[^;,\s]+=[^;,\s]+)*);base64,([A-Za-z0-9+/]+={0,2})/gi, (whole, lead: string, mime: string, _params: string, payload: string) => {
    // Too short to be media: left as written.
    if (payload.length < 16) return whole
    return `${lead}[media ${mime}]`
  })
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

export interface Page {
  text: string
  offset: number
  next_offset: number
  total_length: number
  has_more: boolean
}

/**
 * One page of a long text, counted in UTF-16 units so the cursor is the one a
 * JavaScript string uses. A page never starts or ends inside a surrogate pair:
 * an offset that would is refused, and an end that would moves back one unit -
 * or forward, when the page is a single unit long and would otherwise make no
 * progress. A page whose bytes pass the ceiling is shortened until it fits.
 */
export function pageOf(text: string, offset = 0, length = PAGE_DEFAULT, bytes = PAGE_BYTES): Page {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError("offset must be a whole number from 0 to total_length")
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > PAGE_MAX) {
    throw new RangeError(`length must be a whole number from 1 to ${PAGE_MAX}`)
  }
  const splits = (at: number) => at > 0 && at < text.length && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1))
  if (splits(offset)) throw new RangeError("offset falls inside a surrogate pair; continue from next_offset")
  let end = Math.min(text.length, offset + length)
  if (splits(end)) end = end === offset + 1 ? end + 1 : end - 1
  while (end > offset + 1 && Buffer.byteLength(text.slice(offset, end)) > bytes) {
    end = offset + Math.max(1, Math.floor((end - offset) * 0.9))
    if (splits(end)) end--
  }
  return { text: text.slice(offset, end), offset, next_offset: end, total_length: text.length, has_more: end < text.length }
}

/** A text cut to a summary, saying so when it was cut. */
export function summaryOf(text: string): string {
  const page = pageOf(withoutInlineMedia(text), 0, SUMMARY_CHARS, SUMMARY_BYTES)
  return page.has_more ? `${page.text}\n[cut short; get this part_id for the rest]` : page.text
}

/**
 * Lines kept while they fit a byte budget, each counted with its newline, and
 * whether any had to be left out.
 */
export function withinBudget(lines: string[], budget: number): { lines: string[]; cut: boolean } {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1
    if (used + size > budget) return { lines: kept, cut: true }
    kept.push(line)
    used += size
  }
  return { lines: kept, cut: false }
}
