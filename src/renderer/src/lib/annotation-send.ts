import type { Annotation } from "@shared/protocol"
import { useApp } from "../stores/app"
import { HOME_SCOPE } from "../stores/annotations"
import { mainAnnotationScope } from "./annotate"
import { watchOfficeSend } from "./annotation-fx"
import { t } from "./i18n"

/**
 * MiMo's "send now" from a document: the annotation goes out on its own as a
 * message with no words - the note is in the annotation - to the conversation
 * the document was opened from, else the open one, else a new one made for
 * it. A conversation still answering refuses it, and says so.
 */
export async function sendAnnotationNow(
  note: Annotation,
  file: string,
  prompt: string,
  where: { origin?: string; directory?: string } = {},
): Promise<{ ok: boolean; reason?: string; convoId?: string }> {
  const app = useApp()
  const known = (id: string | undefined) => (id && app.sessions.some((session) => session.id === id) ? id : undefined)
  const scope = mainAnnotationScope.value
  let target = known(where.origin) ?? (scope !== HOME_SCOPE ? scope : undefined)
  if (target && app.running.has(target)) return { ok: false, reason: t("annotations.busy") }
  if (!target) {
    try {
      target = (await app.create(where.directory)).id
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }
  const sent = await app.send("", [], target, [note])
  if (!sent) return { ok: false }
  watchOfficeSend(target, file, [note.id], prompt)
  return { ok: true, convoId: target }
}
