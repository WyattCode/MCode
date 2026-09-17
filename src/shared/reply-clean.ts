/*
 * A reply's words as MiMo shows them: markup a model leaked into its prose is
 * taken out before the text is drawn, copied or counted as a step.
 *
 * Some OpenAI-compatible servers (a vLLM without a reasoning parser, a model
 * that writes its calls as text) put `<think>…</think>` or a whole
 * `<tool_call>…</tool_call>` into the answer itself. MiMo removes those spans
 * outside code, cuts the text where one opens and never closes, and drops any
 * closing tag left on its own. Code - fenced blocks and inline spans - is
 * passed through untouched, so a reply that explains these tags still shows
 * them. The rules are this app's own; only the behaviour follows MiMo.
 */

/** The block tags whose whole span is removed, and whose unclosed opening cuts the text. */
const BLOCK_TAGS = ["tool_call", "tool_result", "thinking", "think"]

/** One run of the reply: code kept as written, or prose to be cleaned. */
interface Run {
  text: string
  code: boolean
}

/** A fence opener: up to three spaces, then three or more backticks or tildes. */
function fenceOf(line: string): { char: string; size: number } | undefined {
  let at = 0
  while (at < 3 && line[at] === " ") at++
  const char = line[at]
  if (char !== "`" && char !== "~") return undefined
  let size = 0
  while (line[at + size] === char) size++
  return size >= 3 ? { char, size } : undefined
}

/** Whether a line closes a fence opened with `char` repeated `size` times: only the fence, nothing after it. */
function closesFence(line: string, char: string, size: number): boolean {
  const bare = line.replace(/\r?\n$/, "").trim()
  if (bare.length < size) return false
  for (const each of bare) if (each !== char) return false
  return line.search(/\S/) <= 3
}

/** Splits prose at inline code spans: a run of backticks closed by a run of the same length, not across a blank line. */
function splitInline(text: string, out: Run[]): void {
  let prose = ""
  let at = 0
  while (at < text.length) {
    if (text[at] !== "`") {
      prose += text[at]
      at++
      continue
    }
    let size = 0
    while (text[at + size] === "`") size++
    let close = -1
    let scan = at + size
    while (scan < text.length) {
      if (text[scan] === "`") {
        let run = 0
        while (text[scan + run] === "`") run++
        if (run === size) {
          close = scan
          break
        }
        scan += run
        continue
      }
      if (text[scan] === "\n" && /^[ \t]*\r?\n/.test(text.slice(scan + 1))) break
      scan++
    }
    if (close < 0) {
      prose += text.slice(at, at + size)
      at += size
      continue
    }
    if (prose) out.push({ text: prose, code: false })
    prose = ""
    out.push({ text: text.slice(at, close + size), code: true })
    at = close + size
  }
  if (prose) out.push({ text: prose, code: false })
}

/** The reply as runs of code and prose, in order; joined back they are the reply. */
function runsOf(text: string): Run[] {
  const out: Run[] = []
  let prose = ""
  let at = 0
  while (at < text.length) {
    const end = text.indexOf("\n", at)
    const next = end < 0 ? text.length : end + 1
    const fence = fenceOf(text.slice(at, next))
    if (!fence) {
      prose += text.slice(at, next)
      at = next
      continue
    }
    // An unclosed fence runs to the end of the reply, as a Markdown reader takes it.
    let stop = text.length
    for (let line = next; line < text.length; ) {
      const lineEnd = text.indexOf("\n", line)
      const after = lineEnd < 0 ? text.length : lineEnd + 1
      if (closesFence(text.slice(line, after), fence.char, fence.size)) {
        stop = after
        break
      }
      line = after
    }
    if (prose) splitInline(prose, out)
    prose = ""
    out.push({ text: text.slice(at, stop), code: true })
    at = stop
  }
  if (prose) splitInline(prose, out)
  return out
}

/** Where the earliest unclosed opener of the given tags starts, or -1. */
function firstOpener(text: string, names: string[], loose: boolean): number {
  const lower = text.toLowerCase()
  let found = -1
  for (const name of names) {
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(`<${name}`, from)
      if (at < 0) break
      const after = lower[at + name.length + 1]
      // `<think>` exactly; `<function=…` and `<parameter …` carry their arguments in the tag.
      const opens = loose ? after === "=" || after === " " || after === "\t" || after === "\n" : after === ">"
      if (opens) {
        if (found < 0 || at < found) found = at
        break
      }
      from = at + 1
    }
  }
  return found
}

/** Removes every `<name…>…</name>` span, the shortest each time. */
function removeSpans(text: string, name: string, loose: boolean): string {
  const lower = () => text.toLowerCase()
  let from = 0
  while (from < text.length) {
    const open = firstOpener(text.slice(from), [name], loose)
    if (open < 0) break
    const start = from + open
    const close = lower().indexOf(`</${name}>`, start)
    if (close < 0) {
      from = start + 1
      continue
    }
    text = text.slice(0, start) + text.slice(close + name.length + 3)
    from = start
  }
  return text
}

/** Prose with the leaked markup gone; `cut` says the text was cut at an unclosed opener. */
function cleanProse(prose: string): { text: string; cut: boolean } {
  let text = prose
  for (const name of BLOCK_TAGS) text = removeSpans(text, name, false)
  text = removeSpans(text, "function", true)
  let cut = false
  const open = Math.min(
    ...[firstOpener(text, BLOCK_TAGS, false), firstOpener(text, ["function"], true)].map((at) => (at < 0 ? Infinity : at)),
  )
  if (open !== Infinity) {
    text = text.slice(0, open)
    cut = true
  }
  text = removeSpans(text, "parameter", true)
  const parameter = firstOpener(text, ["parameter"], true)
  if (parameter >= 0) {
    text = text.slice(0, parameter)
    cut = true
  }
  // A closing tag with nothing to close is dropped.
  text = text.replace(/<\/(?:tool_call|tool_result|thinking|think|function|parameter)>/gi, "")
  return { text, cut }
}

/** The reply with leaked tool-call and thinking markup removed outside code, blank runs squeezed and the ends trimmed. */
export function cleanReply(raw: string): string {
  return stripMarkup(raw)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The reply with the leaked spans taken out and nothing else touched. */
function stripMarkup(raw: string): string {
  if (!raw || !raw.includes("<")) return raw ?? ""
  let out = ""
  for (const run of runsOf(raw)) {
    if (run.code) {
      out += run.text
      continue
    }
    const cleaned = cleanProse(run.text)
    out += cleaned.text
    if (cleaned.cut) break
  }
  return out
}

/** A reply that is only an ellipsis or full stops - MiMo does not count it as a step. */
export function isDotsOnly(text: string): boolean {
  const bare = text.replace(/\s+/g, "")
  return bare.length > 0 && /^[.…。．]+$/.test(bare)
}

/** The tags a reply still being written may be halfway through. */
const PARTIAL_OPENERS = ["<tool_call>", "<function=", "<parameter=", "<thinking>"]

/**
 * The live reply: cleaned, and with a tag that is still arriving at its very
 * end held back, so `<tool_ca` never flashes on screen before it is removed.
 * Its line breaks are left as they came - the reply renderer holds back a
 * last line until its newline arrives, so the end is never trimmed here.
 */
export function cleanLiveReply(raw: string): string {
  const text = stripMarkup(raw)
  const at = text.lastIndexOf("<")
  if (at < 0) return text
  const tail = text.slice(at)
  if (tail.includes(">")) return text
  // Inside code it is code, and stays.
  let seen = 0
  for (const run of runsOf(text)) {
    if (at < seen + run.text.length) {
      if (run.code) return text
      break
    }
    seen += run.text.length
  }
  const lower = tail.toLowerCase()
  return PARTIAL_OPENERS.some((opener) => opener.startsWith(lower)) ? text.slice(0, at).replace(/[ \t]+$/, "") : text
}

/** A text part as the step list reads it: empty or dots-only text is no step. */
export function saysSomething(text: string): boolean {
  const cleaned = cleanReply(text)
  return Boolean(cleaned) && !isDotsOnly(cleaned)
}
