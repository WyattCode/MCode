import type { Message, SessionInfo } from "./protocol"

/**
 * A conversation as a file, so one can leave this app and come back.
 *
 * MiMo has `mimo export` and `mimo import` as a matched pair over sessions;
 * MCode could only write Markdown (`convo-export.ts`), which is a transcript to
 * read rather than a conversation to reopen, and could only import from other
 * tools (`import.ts`) - never from itself. So a conversation could not be moved
 * between profiles or machines at all.
 *
 * The document is deliberately plain: the conversation's own record and its
 * messages, exactly as this app stores them, behind a name and a format number.
 * Nothing is derived and nothing is summarised, so what comes back is what went
 * out.
 *
 * Kept in `shared` and free of Vue, i18n and node so that both ends - the
 * window that writes the file and the server that reads it back - agree on one
 * definition, and so the checks can drive it directly.
 */

/** What this build writes, and the highest it knows how to read. */
export const CONVO_FILE_FORMAT = 1

/** How a document announces itself, so another app's JSON is not read as one of these. */
export const CONVO_FILE_APP = "MCode"

/**
 * The conversation's own record, less the parts that cannot travel.
 *
 * The id is left behind on purpose: the conversation being written is a new one
 * in the profile that reads it, and carrying the old id would either collide
 * with a conversation already there or quietly overwrite it. The same goes for
 * everything that points at other records in the profile it came from - a
 * parent conversation, a subagent's place in it, a fork's origin - which would
 * name records the reading profile does not have.
 */
export interface ConvoFileSession {
  title: string
  directory: string
  agent?: SessionInfo["agent"]
  model?: SessionInfo["model"]
  created: number
  updated: number
  titleSource?: SessionInfo["titleSource"]
  /** MiMo's grouping label, kept so an imported conversation lands where it was filed. */
  group?: string
}

export interface ConvoFile {
  app: typeof CONVO_FILE_APP
  format: number
  /** When it was written, which is not the conversation's own clock. */
  exportedAt: number
  session: ConvoFileSession
  messages: Message[]
}

/** The document for one conversation, ready to be written out. */
export function conversationDocument(session: SessionInfo, messages: readonly Message[], now = Date.now()): ConvoFile {
  return {
    app: CONVO_FILE_APP,
    format: CONVO_FILE_FORMAT,
    exportedAt: now,
    session: {
      title: session.title,
      directory: session.directory,
      agent: session.agent,
      model: session.model,
      created: session.created,
      updated: session.updated,
      ...(session.titleSource ? { titleSource: session.titleSource } : {}),
      ...(session.group !== undefined ? { group: session.group } : {}),
    },
    messages: [...messages],
  }
}

/** The name a saved conversation gets, with the characters a file system refuses taken out. */
export function conversationFileName(title: string, untitled: string): string {
  const cleaned = (title || untitled).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim()
  return `${cleaned.slice(0, 80) || untitled}.mcode.json`
}

/**
 * Reads a document back, or says why it is not one.
 *
 * Every failure is a sentence rather than a throw, because all of them are
 * things a person can act on: the wrong file was picked, the file is damaged,
 * or it was written by a newer build. The last is refused rather than half
 * read - a format this build does not know may mean something different by the
 * same fields, and importing it would make a conversation that quietly is not
 * the one that was exported.
 *
 * `problem` is a code the window turns into its own sentence, so this file
 * stays free of i18n.
 */
export type ConvoFileProblem = "notJson" | "notMCode" | "fromNewer" | "noMessages"

export function parseConversationDocument(text: string): { file?: ConvoFile; problem?: ConvoFileProblem; format?: number } {
  let parsed: unknown
  try {
    // A byte-order mark is dropped rather than parsed: most Windows editors add one.
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return { problem: "notJson" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "notMCode" }
  const document = parsed as Partial<ConvoFile>
  if (document.app !== CONVO_FILE_APP || typeof document.format !== "number") return { problem: "notMCode" }
  if (document.format > CONVO_FILE_FORMAT) return { problem: "fromNewer", format: document.format }

  const session = document.session
  if (!session || typeof session !== "object") return { problem: "notMCode" }
  const messages = Array.isArray(document.messages) ? document.messages : []
  /*
   * Only messages that read as messages. A document hand-edited into something
   * this app cannot draw would otherwise become a conversation that throws when
   * it is opened, which is a worse answer than saying the file is not one.
   */
  const kept = messages.filter((message): message is Message => {
    if (!message || typeof message !== "object") return false
    const entry = message as Partial<Message>
    return typeof entry.id === "string" && (entry.role === "user" || entry.role === "assistant")
  })
  if (!kept.length) return { problem: "noMessages" }

  return {
    file: {
      app: CONVO_FILE_APP,
      format: document.format,
      exportedAt: typeof document.exportedAt === "number" ? document.exportedAt : Date.now(),
      session: {
        title: typeof session.title === "string" ? session.title : "",
        directory: typeof session.directory === "string" ? session.directory : "",
        agent: session.agent,
        model: session.model,
        created: typeof session.created === "number" ? session.created : Date.now(),
        updated: typeof session.updated === "number" ? session.updated : Date.now(),
        ...(session.titleSource ? { titleSource: session.titleSource } : {}),
        ...(session.group !== undefined ? { group: session.group } : {}),
      },
      messages: kept,
    },
  }
}
