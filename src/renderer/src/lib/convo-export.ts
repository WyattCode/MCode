import type { Message } from "@shared/protocol"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "./i18n"
import { saveText } from "./native-pick"
import { noticesHere } from "./toast"
import { conversationMarkdown, exportFileName } from "./convo-markdown"

/*
 * MiMo's 导出对话记录: a conversation saved as Markdown where the person
 * chooses, from wherever they are - the row menu does not open it first.
 */

export function transcriptOf(title: string, messages: readonly Message[]): string {
  return conversationMarkdown(title, messages, {
    untitled: t("export.untitled"),
    user: t("export.userPrefix"),
    assistant: t("export.assistantPrefix"),
    done: t("export.done"),
  })
}

/* Anything thrown in a main-process handler arrives wrapped in the IPC's own words. */
const reasonOf = (failure: unknown) =>
  (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']*':\s*/, "")

type Say = ReturnType<typeof noticesHere>

/** Saves text through the save dialog; MiMo's single-line toasts, and silence when the dialog is dismissed. */
export async function saveExport(suggested: string, text: string, say: Say = noticesHere()): Promise<void> {
  try {
    const saved = await saveText(suggested, text)
    if (saved) say.notify(t("toast.exported", { path: saved }))
  } catch (failure) {
    say.notifyFailure(reasonOf(failure) || t("toast.exportFailed"))
  }
}

export async function exportConversationMarkdown(title: string, messages: readonly Message[], say?: Say): Promise<void> {
  await saveExport(exportFileName(title), transcriptOf(title, messages), say)
}

/** The row menu's export: the named conversation's messages, read without navigating when it is not the one on show. */
export async function exportConversationById(sessionID: string): Promise<void> {
  const app = useApp()
  // Leaving mid-await must not flash export toasts onto another conversation.
  const say = noticesHere()
  const session = app.sessions.find((entry) => entry.id === sessionID)
  if (!session) return
  let messages: readonly Message[] | undefined = app.currentID === sessionID ? app.messages : undefined
  if (!messages) {
    try {
      messages = (await app.client?.request({ type: "session.get", sessionID }))?.messages
    } catch (failure) {
      say.notifyFailure(reasonOf(failure) || t("toast.exportFailed"))
      return
    }
  }
  if (!messages) {
    say.notifyFailure(t("toast.exportFailed"))
    return
  }
  await exportConversationMarkdown(sessionTitle(session.title), messages, say)
}
