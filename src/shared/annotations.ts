import type { Annotation } from "./protocol"

/*
 * MiMo's annotations: places the user pointed at - a passage of a reply, a
 * stretch of code in the files tab, a whole file - each with an optional note,
 * carried with the next message. The transcript keeps them beside the message
 * rather than inside its text, so the bubble shows what was typed; the model
 * reads them as a block after it. The block's wording is MCode's own.
 */

/** How many one message can carry, as MiMo limits it. */
export const ANNOTATION_LIMIT = 20

/** Whitespace folded to single spaces, as a selection is compared and quoted. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function where(note: Annotation): string {
  if (note.kind === "file") return `File ${note.path ?? note.name ?? ""} (the whole file)`
  if (note.kind === "code") return `Code in the file viewer${note.path ? `: ${note.path}` : ""}`
  if (note.kind === "pdf") return `PDF ${note.path ?? note.name ?? ""}, page ${note.page ?? 1}`
  return "A passage of an earlier assistant reply in this conversation"
}

/** The block the model reads after the message, or nothing when there are none. */
export function annotationsBlock(list: readonly Annotation[] | undefined): string {
  if (!list?.length) return ""
  const entries = list.map((note, index) => {
    const lines = [`${index + 1}. ${where(note)}`]
    if (note.quote) {
      const nth = note.occTotal && note.occTotal > 1 ? ` (occurrence ${note.occ ?? 1} of ${note.occTotal})` : ""
      lines.push(`   Selected text${nth}: "${note.quote}"`)
    }
    if (note.rect) {
      const n = (value: number) => Math.round(value * 10) / 10
      const { x, y, w, h, pageW, pageH } = note.rect
      lines.push(
        `   Position: x ${n(x)}, y ${n(y)}, width ${n(w)}, height ${n(h)} (PDF points from the bottom-left corner of a ${n(pageW)} x ${n(pageH)} page)`,
      )
    }
    lines.push(note.text ? `   Note: ${note.text}` : "   Note: none; it is pointed at as context for the message.")
    return lines.join("\n")
  })
  return [
    "<annotations>",
    `While writing this message the user marked ${list.length} place(s). Take each into account together with the message:`,
    "",
    entries.join("\n\n"),
    "</annotations>",
  ].join("\n")
}

/** A user message's text as the model is given it: what was typed, then its annotations. */
export function withAnnotations(text: string, list: readonly Annotation[] | undefined): string {
  return [text, annotationsBlock(list)].filter(Boolean).join("\n\n")
}
