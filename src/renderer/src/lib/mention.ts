import type { Attachment } from "@shared/protocol"

/**
 * Naming a file in the prompt by typing @.
 *
 * The composer is a plain textarea, so a mention is not an object sitting in
 * the draft - it is the text `@path` and nothing else. Everything here works
 * off that text: what the caret is currently in the middle of, what a chosen
 * path does to the draft, and which paths the finished message names. Keeping
 * the mention as text is what makes an unmatched one survive: the message is
 * always sent exactly as it was typed, and the file is carried alongside it.
 */

/**
 * The mention the caret is inside, if it is inside one.
 *
 * The `@` has to open the run or follow a space, which is the whole reason an
 * email address typed into the prompt is left alone - the `@` in
 * name@example.com follows a letter. The query stops at the next space or `@`
 * for the same reason: one address must not swallow the next word.
 *
 * This is the reference's own rule, read off its prompt input: it matches
 * /(?:^|\s)@([^\s@]*)$/ against the text before the caret.
 */
const TRIGGER = /(?:^|\s)@([^\s@]*)$/

/**
 * Every mention a finished draft names, in the order they were written.
 *
 * The same rule as the trigger, minus the anchor to the caret, and requiring
 * at least one character after the `@` - a lone `@` sitting in a sentence
 * names nothing. It has to keep agreeing with the trigger: a draft where the
 * two disagreed would offer a file and then decline to send it.
 */
const NAMED = /(?:^|\s)@([^\s@]+)/g

export interface MentionSpan {
  /** What has been typed after the `@`, which narrows the list. */
  query: string
  /** Where the `@` itself sits, so replacing the run leaves the space before it. */
  start: number
  end: number
}

export function mentionSpan(text: string, cursor: number): MentionSpan | undefined {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)))
  const found = TRIGGER.exec(before)
  if (!found) return undefined
  const query = found[1] ?? ""
  return { query, start: before.length - query.length - 1, end: before.length }
}

/**
 * What the draft becomes when a file is chosen, and where the caret lands.
 *
 * A space follows the path so that the next word typed is a word rather than
 * more of the path - and so that a second mention right after this one still
 * has the space its own trigger needs.
 */
export function withMention(text: string, span: MentionSpan, path: string): { text: string; cursor: number } {
  return {
    text: `${text.slice(0, span.start)}@${path} ${text.slice(span.end)}`,
    cursor: span.start + path.length + 2,
  }
}

/**
 * The two halves a menu row shows: the file's own name, and where it lives.
 *
 * A list of full paths is unreadable at a glance in a project of any size -
 * every row starts with the same twenty characters - so the name leads and the
 * directory follows it in the quiet colour.
 */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

export function fileDirectory(path: string): string {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? "" : path.slice(0, cut)
}

export function mentionedIn(text: string): string[] {
  const out: string[] = []
  for (const found of text.matchAll(NAMED)) out.push(found[1])
  return out
}

/**
 * Whether the file came back as prose rather than as bytes read as prose.
 *
 * The server reads every file as UTF-8, so a PNG arrives as a page of
 * replacement characters and NULs. Sending that costs tokens and tells the
 * model nothing, so it is refused here and the user is told which file it was.
 */
function textual(content: string): boolean {
  // A NUL byte is the giveaway: no text file has one, and almost every
  // binary does within its first few bytes.
  if (content.includes("\u0000")) return false
  // Failing that, a file that is mostly U+FFFD was not text either.
  return (content.split("\ufffd").length - 1) * 50 <= content.length
}

/**
 * The mentioned file as something the message can carry.
 *
 * The path stays relative to the project, because that is how the file was
 * named in the sentence and how the providers wrap it - `<file path="...">` -
 * so the model reads the same path the person wrote.
 */
/**
 * A mentioned file, as something a model can be given.
 *
 * A picture goes as a picture. This used to read every mention as text, so
 * naming a PNG attached a few hundred kilobytes of replacement characters -
 * or, once the `textual` guard was there, quietly attached nothing at all and
 * said the file was unreadable. It was readable; it just was not prose.
 *
 * Audio and binaries still do not go. Nothing downstream would know what to do
 * with them, and saying so is better than sending bytes that get dropped.
 */
export function mentionAttachment(
  path: string,
  file: { kind: "text" | "image" | "audio" | "binary"; content: string; mime?: string; data?: string },
): Attachment | undefined {
  if (file.kind === "image") {
    if (!file.data || !file.mime) return undefined
    return { path, mime: file.mime, data: file.data }
  }
  if (file.kind !== "text") return undefined
  if (!textual(file.content)) return undefined
  return { path, mime: "text/plain", data: file.content }
}

/**
 * The project-relative path as the file system knows it.
 *
 * The separator is taken from the root rather than assumed, so a Windows
 * project does not end up asking for a path that is half forward slashes.
 */
export function absolutePath(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/"
  return root.replace(/[\\/]+$/, "") + separator + relative.split("/").join(separator)
}
