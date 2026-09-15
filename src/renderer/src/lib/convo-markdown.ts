import type { Message } from "@shared/protocol"

/*
 * MiMo's conversation export, as text: a heading with the title, then each
 * message as its own paragraph behind 我： or MCode:, nothing else. Kept free
 * of Vue and i18n so the smoke test can run it; the caller passes the words.
 */

export interface ConvoMarkdownLabels {
  untitled: string
  user: string
  assistant: string
  /** What a finished turn that said nothing in words reads as. */
  done: string
}

export function conversationMarkdown(title: string, messages: readonly Message[], labels: ConvoMarkdownLabels): string {
  const paragraphs: string[] = []
  for (const message of messages) {
    if (message.role === "user") {
      paragraphs.push(`${labels.user} ${message.text}`)
      continue
    }
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim()
    if (text) paragraphs.push(`${labels.assistant} ${text}`)
    else if (message.finish === "end_turn") paragraphs.push(`${labels.assistant} ${labels.done}`)
  }
  return `# ${title.trim() || labels.untitled}\n\n${paragraphs.join("\n\n")}`
}

/** MiMo's default file name: the title with / \ : * ? " < > | as hyphens, trimmed, no length cap. */
export function exportFileName(title: string): string {
  const name = title.replace(/[\\/:*?"<>|]/g, "-").trim()
  return `${name || "conversation"}.md`
}
