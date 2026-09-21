/** A question as MiMo shows it: runs of text, and the fenced code between them. */
export type QuestionPart = { type: "text"; text: string } | { type: "code"; code: string; lang: string | null }

/* A fence opens on its own line: three or more backticks and an optional language. */
const OPENER = /^(`{3,})([\w#+.-]*)\s*$/

/**
 * Splits what someone asked into text and code, by MiMo's rule.
 *
 * A fence closes on the first line of at least as many backticks and nothing
 * else; one that never closes is left as text. Text runs lose the blank lines at
 * their ends, and an empty run is dropped.
 */
export function questionParts(source: string): QuestionPart[] {
  const lines = source.split("\n")
  const parts: QuestionPart[] = []
  let pending: string[] = []
  const flush = () => {
    if (!pending.length) return
    const text = pending.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
    if (text) parts.push({ type: "text", text })
    pending = []
  }
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    const open = OPENER.exec(line)
    if (open) {
      const closer = new RegExp("^`{" + open[1].length + ",}\\s*$")
      let end = index + 1
      while (end < lines.length && !closer.test(lines[end] ?? "")) end++
      if (end < lines.length) {
        flush()
        parts.push({ type: "code", code: lines.slice(index + 1, end).join("\n"), lang: open[2] || null })
        index = end + 1
        continue
      }
    }
    pending.push(line)
    index++
  }
  flush()
  return parts
}
