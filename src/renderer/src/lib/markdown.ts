/**
 * Small markdown renderer for assistant output.
 *
 * Model output is not trusted markup, so everything is HTML-escaped first and
 * formatting is applied to the escaped text afterwards. That ordering is the
 * whole security story here - no raw HTML from the model ever reaches the DOM,
 * which is why this exists instead of a general-purpose parser plus sanitizer.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function inline(text: string): string {
  return (
    text
      // Inline code first: its contents must not be re-processed for emphasis.
      .replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
      // Links render as text plus a dim URL: nothing in this pane should be a
      // live navigation target the model chose.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 <span class="md-url">$2</span>')
  )
}

/**
 * One row of a pipe table, with the outer pipes taken off.
 *
 * `| a | b |` and `a | b` are the same row - GFM makes the leading and
 * trailing pipe optional - so they are stripped before splitting rather than
 * left to become empty cells at each end.
 */
function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

/**
 * The row of dashes under a table's head, and what it says about alignment.
 *
 * Returns undefined when the line is not one, which is what decides whether
 * the line above it was a header or just a paragraph with pipes in it: a table
 * exists only if this row is directly beneath.
 */
function tableAlignment(line: string): ("left" | "center" | "right" | undefined)[] | undefined {
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line)) return undefined
  return tableCells(line).map((cell) => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) return "center"
    if (right) return "right"
    if (left) return "left"
    return undefined
  })
}

/** What a caller can ask the renderer for beyond plain formatting. */
export interface MarkdownOptions {
  /**
   * A head on every code block with its language and a copy button, as MiMo
   * draws code in a reply. The words come from the caller, which knows the
   * language the window is in; the button carries both its idle and its
   * "copied" label, and the caller's click handler switches between them.
   */
  codeActions?: { copy: string; copied: string; label: string }
}

const COPY_ICON =
  '<svg class="md-code-icon idle" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>' +
  '<path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.2"/></svg>' +
  '<svg class="md-code-icon done" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** One fenced block; its body is already escaped. */
function codeBlock(language: string, body: string, options: MarkdownOptions): string {
  const pre = `<pre class="md-code"${language ? ` data-lang="${language}"` : ""}><code>${body}</code></pre>`
  const actions = options.codeActions
  if (!actions) return pre
  return (
    `<div class="md-codeblock"><div class="md-code-head">` +
    `<span class="md-code-lang">${language ? language.toLowerCase() : "text"}</span>` +
    `<button type="button" class="md-code-copy" data-copy-code aria-label="${escapeHtml(actions.label)}">${COPY_ICON}` +
    `<span class="md-code-word idle">${escapeHtml(actions.copy)}</span>` +
    `<span class="md-code-word done">${escapeHtml(actions.copied)}</span></button></div>${pre}</div>`
  )
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const escaped = escapeHtml(source)
  const lines = escaped.split("\n")
  const out: string[] = []

  let inCode = false
  let codeLanguage = ""
  let codeBuffer: string[] = []
  let listType: "ul" | "ol" | undefined
  let quoting = false

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = undefined
    }
  }

  const closeQuote = () => {
    if (!quoting) return
    out.push("</blockquote>")
    quoting = false
  }

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      if (inCode) {
        out.push(codeBlock(codeLanguage, codeBuffer.join("\n"), options))
        codeBuffer = []
        inCode = false
        codeLanguage = ""
      } else {
        closeList()
        inCode = true
        codeLanguage = fence[1]
      }
      continue
    }

    if (inCode) {
      codeBuffer.push(line)
      continue
    }

    /*
     * A quote runs until something that is not one. Consecutive lines join into
     * a single blockquote rather than each becoming its own, which is what the
     * author wrote when they prefixed a paragraph.
     */
    // The source was escaped before this loop, so the marker arrives as an
    // entity rather than as the character the author typed.
    const quoted = line.match(/^\s*&gt;\s?(.*)$/)
    if (quoted) {
      closeList()
      if (!quoting) {
        out.push('<blockquote class="md-quote">')
        quoting = true
      }
      out.push(`<p class="md-p">${inline(quoted[1])}</p>`)
      continue
    }
    closeQuote()

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      /*
       * Shifted down two, so a reply's own headings sit under the page's; the
       * size they are drawn at comes from the markdown level instead, which is
       * what the author actually meant by one hash or three.
       */
      const level = Math.min(6, heading[1].length + 2)
      /*
       * Four and beyond share one look, the way the reference draws them: past
       * the third level a heading stops being a size and becomes a label.
       */
      const rank = Math.min(4, heading[1].length)
      out.push(
        `<h${level} class="md-h" data-level="${rank}">${inline(heading[2])}</h${level}>`,
      )
      continue
    }

    /*
     * A pipe table. Recognised by the row of dashes UNDER the header, which is
     * what tells a real table from a line that merely contains pipes - a shell
     * command with a pipe in it is far more common in this app than a table,
     * and must stay a paragraph.
     *
     * Before this the whole thing fell through to the paragraph arm and a reply
     * containing a table arrived as three lines of raw pipes.
     */
    const alignment = at + 1 < lines.length ? tableAlignment(lines[at + 1]) : undefined
    if (alignment && line.includes("|")) {
      const head = tableCells(line)
      // A delimiter that does not match the header's width is not a table
      // either; GFM requires the two to agree.
      if (head.length === alignment.length) {
        closeList()
        const align = (column: number) => {
          const side = alignment[column]
          return side ? ` class="md-${side}"` : ""
        }
        out.push('<table class="md-table">')
        out.push("<thead><tr>")
        head.forEach((cell, column) => out.push(`<th${align(column)}>${inline(cell)}</th>`))
        out.push("</tr></thead>")

        at += 2
        const body: string[] = []
        while (at < lines.length && lines[at].includes("|") && lines[at].trim() !== "") {
          const cells = tableCells(lines[at])
          // Short rows are padded and long ones cut, the way GFM asks, so the
          // grid stays rectangular whatever the model wrote.
          const row = Array.from({ length: head.length }, (_, column) => cells[column] ?? "")
          body.push("<tr>" + row.map((cell, column) => `<td${align(column)}>${inline(cell)}</td>`).join("") + "</tr>")
          at += 1
        }
        if (body.length) out.push("<tbody>" + body.join("") + "</tbody>")
        out.push("</table>")
        // The loop's own increment lands on the line after the last row.
        at -= 1
        continue
      }
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      if (listType !== "ul") {
        closeList()
        out.push('<ul class="md-list">')
        listType = "ul"
      }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/)
    if (numbered) {
      if (listType !== "ol") {
        closeList()
        out.push('<ol class="md-list">')
        listType = "ol"
      }
      out.push(`<li>${inline(numbered[1])}</li>`)
      continue
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      closeList()
      out.push('<hr class="md-rule" />')
      continue
    }

    if (line.trim() === "") {
      closeList()
      continue
    }

    closeList()
    out.push(`<p class="md-p">${inline(line)}</p>`)
  }

  // An unterminated fence still has content worth showing - this is the normal
  // state while a code block is streaming in.
  if (inCode && codeBuffer.length) {
    out.push(codeBlock(codeLanguage, codeBuffer.join("\n"), options))
  }
  closeList()
  closeQuote()

  return out.join("\n")
}
