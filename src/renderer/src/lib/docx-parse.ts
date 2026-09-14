import JSZip from "jszip"

/*
 * What MiMo reads out of a .docx beside docx-preview's drawing: tracked
 * insertions and deletions in document order, comments with where they hang,
 * the East-Asian theme fonts, and the paragraph texts used to describe and
 * follow an edit.
 */

export interface Revision {
  domIndex: number
  type: "ins" | "del"
  author: string
  date: string
  text: string
}

export interface DocComment {
  id: string
  author: string
  date: string
  text: string
  paragraphIndex: number
  referenceIndex: number
  rangeText: string
}

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

const attrOf = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? ""
const textsOf = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<w:${tag}\\b[^>]*>([\\s\\S]*?)</w:${tag}>`, "g"))].map((match) => match[1]).join("")

export function loadDocx(bytes: Uint8Array) {
  return JSZip.loadAsync(bytes)
}

export async function partOf(zip: JSZip, name: string): Promise<string> {
  return (await zip.file(name)?.async("string")) ?? ""
}

/* The end of a w:ins / w:del opened at `from`, counting nested ones of the same name. */
function closeOf(xml: string, tag: string, from: number): number {
  const pattern = new RegExp(`<w:${tag}\\b[^>]*?(/?)>|</w:${tag}>`, "g")
  pattern.lastIndex = from
  let depth = 1
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    if (match[0].startsWith("</")) {
      depth -= 1
      if (depth === 0) return match.index
    } else if (!match[1]) depth += 1
  }
  return xml.length
}

export function parseRevisions(documentXml: string): Revision[] {
  let xml = documentXml.replace(/<w:(pPrChange|rPrChange)\b[^>]*\/>/g, "").replace(/<w:(pPrChange|rPrChange)\b[\s\S]*?<\/w:\1>/g, "")
  xml = xml.replace(/<w:(ins|del)\b[^>]*\/>/g, "")
  const out: Revision[] = []
  const opening = /<w:(ins|del)\b([^>]*)>/g
  for (let match = opening.exec(xml); match; match = opening.exec(xml)) {
    const type = match[1] as "ins" | "del"
    const start = match.index + match[0].length
    const inner = xml.slice(start, closeOf(xml, type, start))
    out.push({
      domIndex: out.length,
      type,
      author: decodeXml(attrOf(match[2], "w:author")),
      date: attrOf(match[2], "w:date"),
      text: decodeXml(type === "ins" ? textsOf(inner, "t") : textsOf(inner, "delText")),
    })
  }
  return out
}

export function parseComments(commentsXml: string, documentXml: string): DocComment[] {
  const out: DocComment[] = []
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const id = attrOf(match[1], "w:id")
    if (!id) continue
    const paragraphs = [...match[2].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((paragraph) => decodeXml(textsOf(paragraph[0], "t")))
    out.push({
      id,
      author: decodeXml(attrOf(match[1], "w:author")),
      date: attrOf(match[1], "w:date"),
      text: paragraphs.length ? paragraphs.join("\n") : decodeXml(textsOf(match[2], "t")),
      paragraphIndex: -1,
      referenceIndex: -1,
      rangeText: "",
    })
  }
  const byId = new Map(out.map((comment) => [comment.id, comment]))
  let paragraphs = 0
  let references = 0
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>|<w:commentRangeStart\b[^>]*>|<w:commentReference\b[^>]*>/g)) {
    const tag = match[0]
    if (tag.startsWith("<w:p")) {
      if (!tag.startsWith("<w:pPr")) paragraphs += 1
      continue
    }
    const comment = byId.get(attrOf(tag, "w:id"))
    if (tag.startsWith("<w:commentReference")) {
      if (comment && comment.referenceIndex < 0) comment.referenceIndex = references
      references += 1
    }
    if (comment && comment.paragraphIndex < 0) comment.paragraphIndex = paragraphs - 1
  }
  for (const comment of out) {
    const start = documentXml.search(new RegExp(`<w:commentRangeStart\\b[^>]*w:id="${comment.id}"[^>]*/>`))
    if (start < 0) continue
    const endPattern = new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${comment.id}"`, "g")
    endPattern.lastIndex = start
    const end = endPattern.exec(documentXml)
    if (!end) continue
    const text = decodeXml(textsOf(documentXml.slice(start, end.index), "t"))
    if (text) comment.rangeText = text
  }
  return out
}

/** The document's non-empty paragraph texts, in order. */
export function paragraphTexts(documentXml: string): string[] {
  return documentXml
    .split("</w:p>")
    .map((segment) => decodeXml(textsOf(segment, "t")).trim())
    .filter(Boolean)
}

function commonEnds(before: string[], after: string[]) {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  return { prefix, suffix }
}

/* MiMo's short description of what an edit changed, for the version note: "a→b;新增:c 等 N 处". */
export function diffSummary(before: string[], after: string[]): string {
  const { prefix, suffix } = commonEnds(before, after)
  const oldMiddle = before.slice(prefix, before.length - suffix)
  const newMiddle = after.slice(prefix, after.length - suffix)
  const cut = (text: string) => (text.length > 12 ? `${text.slice(0, 12)}…` : text)
  const changes: string[] = []
  for (let at = 0; at < Math.max(oldMiddle.length, newMiddle.length); at++) {
    const old = oldMiddle[at]
    const next = newMiddle[at]
    if (old !== undefined && next !== undefined) changes.push(`${cut(old)}→${cut(next)}`)
    else if (next !== undefined) changes.push(`新增:${cut(next)}`)
    else if (old !== undefined) changes.push(`删除:${cut(old)}`)
  }
  const head = changes.slice(0, 3).join(";")
  return changes.length > 3 ? `${head} 等 ${changes.length} 处` : head
}

/* Where an old paragraph index sits after an edit, or null when its paragraph was rewritten away. */
export function mapParagraphIndex(before: string[], after: string[], index: number): number | null {
  const { prefix, suffix } = commonEnds(before, after)
  if (index < prefix) return index
  if (index >= before.length - suffix) return index + (after.length - before.length)
  return index < after.length - suffix ? index : null
}

/* The theme's East-Asian major and minor fonts, for the language the document defaults to. */
export async function themeEastAsia(zip: JSZip): Promise<{ major?: string; minor?: string }> {
  try {
    const themeName = Object.keys(zip.files).find((name) => /^word\/theme\/theme[^/]*\.xml$/.test(name))
    if (!themeName) return {}
    const theme = await partOf(zip, themeName)
    const styles = await partOf(zip, "word/styles.xml")
    const defaults = styles.match(/<w:rPrDefault\b[\s\S]*?<\/w:rPrDefault>/)?.[0] ?? ""
    const lang = defaults.match(/<w:lang\b[^>]*w:eastAsia="([^"]*)"/)?.[1] ?? ""
    const script = /^zh-(TW|HK|MO)|Hant/i.test(lang) ? "Hant" : /^zh/i.test(lang) ? "Hans" : /^ja/i.test(lang) ? "Jpan" : /^ko/i.test(lang) ? "Kore" : ""
    const pick = (tag: string) => {
      const block = theme.match(new RegExp(`<a:${tag}\\b[\\s\\S]*?</a:${tag}>`))?.[0] ?? ""
      const ea = block.match(/<a:ea\b[^>]*typeface="([^"]*)"/)?.[1]
      if (ea) return ea
      return script ? block.match(new RegExp(`<a:font\\b[^>]*script="${script}"[^>]*typeface="([^"]*)"`))?.[1] || undefined : undefined
    }
    return { major: pick("majorFont"), minor: pick("minorFont") }
  } catch {
    return {}
  }
}
