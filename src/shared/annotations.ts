import type { Annotation } from "./protocol"
import { fileNoticesBlock, type FileNotice } from "./file-notices"

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
  if (note.kind === "docx") return `Word document ${note.path ?? note.name ?? ""}${note.page ? `, around page ${note.page}` : ""}`
  if (note.kind === "pptx") {
    const slide = `Presentation ${note.path ?? note.name ?? ""}, slide ${(note.slide ?? 0) + 1}${note.slideId ? ` (slide id ${note.slideId})` : ""}`
    if (note.shapeId) return `${slide}, shape "${note.shapeName ?? ""}" (shape id ${note.shapeId})`
    if (!note.region) return slide
    const pct = (value: number) => Math.max(0, Math.min(100, Math.round(value * 100)))
    const { fx, fy, fw, fh } = note.region
    return `${slide}, the region roughly from (${pct(fx)}%, ${pct(fy)}%) to (${pct(fx + fw)}%, ${pct(fy + fh)}%) of the slide`
  }
  if (note.kind === "video") {
    const pct = (value: number) => Math.max(0, Math.min(100, Math.round(value * 100)))
    const seconds = Math.max(0, Math.floor(note.timeSec ?? 0))
    const at = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    const file = note.path ? `Video ${note.path}` : `An attached video${note.name ? ` (${note.name})` : ""}, whose local path is unknown`
    if (!note.region) return `${file}, at ${at}`
    const { fx, fy, fw, fh } = note.region
    return `${file}, the region roughly from (${pct(fx)}%, ${pct(fy)}%) to (${pct(fx + fw)}%, ${pct(fy + fh)}%) of the frame at ${at}`
  }
  if (note.kind === "html") {
    const quote = note.quote ? `, containing "${note.quote.length > 60 ? `${note.quote.slice(0, 60)}…` : note.quote}"` : ""
    return `Web page ${note.path ?? ""} (${note.name ?? ""}), the module matching CSS selector \`${note.selector ?? ""}\` <${note.tag ?? ""}>${quote}`
  }
  if (note.kind === "xlsx") return `Spreadsheet ${note.path ?? note.name ?? ""}, sheet "${note.sheet ?? ""}"!${note.a1 ?? ""}`
  if (note.kind === "chart") {
    const detail = [note.chartKind || "chart", note.dataRef].filter(Boolean).join("; ")
    return `Spreadsheet ${note.path ?? note.name ?? ""}, sheet "${note.sheet ?? ""}", chart "${note.chartTitle || "(untitled)"}" (${detail})`
  }
  return "A passage of an earlier assistant reply in this conversation"
}

/** The block the model reads after the message, or nothing when there are none. */
export function annotationsBlock(list: readonly Annotation[] | undefined): string {
  if (!list?.length) return ""
  const entries = list.map((note, index) => {
    const lines = [`${index + 1}. ${where(note)}`]
    if (note.kind === "xlsx") lines.push(`   Current cell values: ${note.quote || "(empty)"}`)
    else if (note.quote) {
      const nth = note.occTotal && note.occTotal > 1 ? ` (occurrence ${note.occ ?? 1} of ${note.occTotal})` : ""
      lines.push(`   Selected text${nth}: "${note.quote}"`)
    }
    if (note.rect) {
      const n = (value: number) => Math.round(value * 10) / 10
      const { x, y, w, h, pageW, pageH } = note.rect
      lines.push(
        note.kind === "pdf"
          ? `   Position: x ${n(x)}, y ${n(y)}, width ${n(w)}, height ${n(h)} (PDF points from the bottom-left corner of a ${n(pageW)} x ${n(pageH)} page)`
          : `   Position: x ${n(x)}, y ${n(y)}, width ${n(w)}, height ${n(h)} (pixels from the top-left corner of a ${n(pageW)} x ${n(pageH)} page as drawn)`,
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
    ...(list.some((note) => note.kind === "html") ? ["", "A web page module is found by its selector in that page's own file; change the file so the module reads and behaves as asked."] : []),
    "</annotations>",
  ].join("\n")
}

/** A user message's text as the model is given it: any document changes, what was typed, then its annotations. */
export function withAnnotations(text: string, list: readonly Annotation[] | undefined, notices?: readonly FileNotice[]): string {
  return [fileNoticesBlock(notices), text, annotationsBlock(list)].filter(Boolean).join("\n\n")
}

/** What a provider is sent for a user message: the runner's notes first, each in a system-reminder, then the above. */
export function userText(message: {
  text: string
  annotations?: readonly Annotation[]
  fileNotices?: readonly FileNotice[]
  reminders?: readonly string[]
}): string {
  const notes = (message.reminders ?? []).map((note) => `<system-reminder>\n${note.trim()}\n</system-reminder>`)
  return [...notes, withAnnotations(message.text, message.annotations, message.fileNotices)].filter(Boolean).join("\n\n")
}
