import { nextTick, watch } from "vue"
import { useApp } from "../stores/app"
import { t } from "./i18n"
import { notifyFailure } from "./toast"
import { openDocument } from "./office-open"
import { artifactAbsolute } from "./artifact-kind"

/*
 * MiMo's 打开预览 from the artifacts page: the file opens as a right-panel tab
 * - a web page tab, the Office tab, or the files tab - rather than in a dialog.
 *
 * The panel's tabs belong to a conversation, and the files tab is rooted in its
 * project, so the tab is opened in the conversation that wrote the file: that
 * conversation is entered first, and the tab goes in once it is the one on show.
 */

/** Resolves once the named conversation is the current one, or false after the wait. */
function untilCurrent(sessionID: string, ms = 10000): Promise<boolean> {
  const app = useApp()
  if (app.currentID === sessionID) return Promise.resolve(true)
  return new Promise((resolve) => {
    const stop = watch(
      () => app.currentID,
      (now) => {
        if (now !== sessionID) return
        clearTimeout(timer)
        stop()
        resolve(true)
      },
    )
    const timer = setTimeout(() => {
      stop()
      resolve(false)
    }, ms)
  })
}

export interface ArtifactTarget {
  sessionID: string
  directory: string
  path: string
  name: string
}

/** `enter` shows the conversation (the page's own 进入对话). */
export async function previewArtifact(target: ArtifactTarget, enter: (sessionID: string) => void): Promise<void> {
  const app = useApp()
  const file = artifactAbsolute(target.directory, target.path)
  const found = await window.mcode.resolveExistingPath([file]).catch(() => null)
  if (!found || found.directory) {
    notifyFailure(t("art.previewFailed", { error: t("harnessRow.pathNotExist") }))
    return
  }
  if (!app.sessions.some((session) => session.id === target.sessionID)) {
    notifyFailure(t("art.convoNotFound"))
    return
  }
  enter(target.sessionID)
  if (!(await untilCurrent(target.sessionID))) return
  // The panel takes up the conversation's tabs in a watcher; the new tab goes in after it.
  await nextTick()
  try {
    await openDocument({ path: found.path, name: target.name }, target.directory)
  } catch (failure) {
    notifyFailure(t("art.previewFailed", { error: failure instanceof Error ? failure.message : String(failure) }))
  }
}
