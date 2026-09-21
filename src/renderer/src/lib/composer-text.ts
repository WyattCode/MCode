import type { Message } from "@shared/protocol"

/**
 * Rules the composer applies to its plain text, kept apart from the component
 * so each can be checked on its own: prompt history, whole-mention deletion,
 * the slash trigger on the caret's line, the slash highlight's match, and
 * turning dropped project files into mentions.
 */

/* MiMo keeps the last hundred prompts. */
export const HISTORY_LIMIT = 100

/** The conversation's prompts for arrow history: trimmed, repeats in a row counted once, newest last. */
export function promptHistory(messages: readonly Message[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = message.text.trim()
    if (!text || out[out.length - 1] === text) continue
    out.push(text)
  }
  return out.slice(-HISTORY_LIMIT)
}

/**
 * Backspace just after a mention takes the whole of it.
 *
 * The caret, or the caret less one when a space sits before it, has to end a
 * mention that was chosen, and the `@` has to open the text or follow
 * whitespace. Everything from the `@` to the caret goes, the trailing space too.
 */
export function mentionBackspace(
  text: string,
  caret: number,
  mentions: Iterable<string>,
): { text: string; caret: number } | undefined {
  const ends = [caret]
  if (caret > 0 && text[caret - 1] === " ") ends.push(caret - 1)
  for (const end of ends) {
    for (const path of mentions) {
      const token = `@${path}`
      const at = end - token.length
      if (at < 0 || text.slice(at, end) !== token) continue
      if (at > 0 && !/\s/.test(text[at - 1])) continue
      return { text: text.slice(0, at) + text.slice(caret), caret: at }
    }
  }
  return undefined
}

/**
 * The slash command being typed on the caret's line, if one is.
 *
 * MiMo's trigger: the line holds only spaces or tabs before a `/`, and nothing
 * between that `/` and the caret is whitespace. Any line counts, not only the first.
 */
export function slashAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const lineStart = before.lastIndexOf("\n") + 1
  const found = /^[ \t]*\/(\S*)$/.exec(before.slice(lineStart))
  if (!found) return undefined
  return { start: caret - found[1].length - 1, query: found[1] }
}

/**
 * The known command a draft opens with, for the highlight behind it.
 *
 * Leading blank lines and spaces are allowed, a tab is not; the name must be one
 * the slash menu knows and be followed by whitespace or the end.
 */
export function slashLead(text: string, known: ReadonlySet<string>): { newlines: number; indent: string; token: string } | undefined {
  const found = /^([ \n\r]*)\/([^\s/]+)(?=\s|$)/.exec(text)
  if (!found || !known.has(found[2])) return undefined
  const lead = found[1].replace(/\r/g, "")
  const newlines = (lead.match(/\n/g) ?? []).length
  return { newlines, indent: lead.slice(lead.lastIndexOf("\n") + 1), token: `/${found[2]}` }
}

/** A dropped file's path from the project root, or nothing when it lives outside it. */
export function projectRelative(root: string, file: string): string | undefined {
  if (!root || !file) return undefined
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = norm(root)
  const full = norm(file)
  // Windows paths compare without regard to case.
  const fold = /^[a-zA-Z]:/.test(base) ? (value: string) => value.toLowerCase() : (value: string) => value
  if (!fold(full).startsWith(`${fold(base)}/`)) return undefined
  return full.slice(base.length + 1) || undefined
}

/** The draft with `@rel ` appended for each path, one space between it and what was there. */
export function appendMentions(draft: string, paths: readonly string[]): string {
  if (!paths.length) return draft
  const lead = draft && !/\s$/.test(draft) ? " " : ""
  return draft + lead + paths.map((path) => `@${path} `).join("")
}
