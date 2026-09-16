/**
 * MiMo's search rule for short lists - the settings pages, by name or by the
 * words listed for them.
 *
 * A query with Chinese or Japanese in it has no spaces to find words by, so it
 * matches anywhere, ignoring case. Anything else is taken word by word, and
 * every word typed has to begin some word of the text. The text's words are
 * split at anything that is not a letter or a digit, and a camelCase word
 * counts both whole and as its parts, so "accel" finds "hardwareAcceleration".
 */

/* Kana, the CJK ideographs and their compatibility block, and half-width katakana. */
const UNSPACED = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/
const BETWEEN_WORDS = /[^\p{L}\p{N}]+/u
/* Before a capital that follows a small letter or a digit, and before the last capital of a run followed by a small letter. */
const CAMEL_BREAK = /(?<=\p{Ll}|\p{N})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u

function wordsOf(text: string): string[] {
  return text.split(BETWEEN_WORDS).filter(Boolean)
}

/** Every word of the text in lower case, a camelCase word followed by its parts. */
export function searchWords(text: string): string[] {
  const out: string[] = []
  for (const word of wordsOf(text)) {
    out.push(word.toLowerCase())
    const parts = word.split(CAMEL_BREAK)
    if (parts.length > 1) for (const part of parts) out.push(part.toLowerCase())
  }
  return out
}

/**
 * The entries an @ menu query keeps, by name.
 *
 * MiMo's @ menu and its settings search share one matcher, and the menu
 * narrows what the folder already listed rather than asking the backend again
 * for every keystroke. An empty query keeps everything, as the matcher does.
 */
export function matchingNames<T extends { name: string }>(entries: readonly T[], query: string): T[] {
  return entries.filter((entry) => wordMatch(entry.name, query))
}

/** Whether the text answers the query. An empty query answers everything. */
export function wordMatch(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = text.toLowerCase()
  if (UNSPACED.test(needle)) return haystack.includes(needle)
  const typed = wordsOf(needle)
  // Nothing but punctuation: there are no words to begin, so it is looked for as it is.
  if (!typed.length) return haystack.includes(needle)
  const words = searchWords(text)
  return typed.every((word) => words.some((candidate) => candidate.startsWith(word)))
}
