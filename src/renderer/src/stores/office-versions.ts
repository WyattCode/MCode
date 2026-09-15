import { defineStore } from "pinia"
import { ref } from "vue"
import type { OfficeVersionSource, OfficeVersionState } from "../../../preload/index"
import { notifyFailure } from "../lib/toast"
import { t } from "../lib/i18n"
import { noteFileChange } from "../lib/file-notices"
import { useApp } from "./app"

/**
 * MiMo's version history for documents, per file: the main process keeps the
 * snapshots; this keeps what the views and the history list show, and a reload
 * tick per file that bumps when a restore rewrites it, so every view of it
 * reloads. Undo and redo move to the version either side of the cursor.
 */
export const useOfficeVersions = defineStore("officeVersions", () => {
  const byPath = ref<Record<string, OfficeVersionState>>({})
  const reloadTick = ref<Record<string, number>>({})

  function keep(path: string, state: OfficeVersionState) {
    byPath.value = { ...byPath.value, [path]: state }
  }

  async function init(path: string, base64: string, options: { assumeAi: boolean; note: string }) {
    const result = await window.mcode.officeVersionInit(path, base64, options.assumeAi, options.note)
    if (result.ok) keep(path, result.state)
  }

  async function record(path: string, base64: string, source: OfficeVersionSource, note: string) {
    const before = byPath.value[path]?.versions.length ?? 0
    const result = await window.mcode.officeVersionRecord(path, base64, source, note)
    if (!result.ok) return
    keep(path, result.state)
    // MiMo tells the model on the next send when a person, not the model, made a new version.
    if ((source === "user" || source === "external") && result.state.versions.length > before) {
      noteFileChange(useApp().currentID, { path, source, note })
    }
  }

  async function restore(path: string, id: string) {
    const result = await window.mcode.officeVersionRestore(path, id)
    if (result.ok) {
      noteFileChange(useApp().currentID, { path, source: "restore" })
      keep(path, result.state)
      reloadTick.value = { ...reloadTick.value, [path]: (reloadTick.value[path] ?? 0) + 1 }
      return
    }
    notifyFailure(result.reason === "writefail" ? t("office.restoreFailWrite") : t("office.restoreFail", { reason: result.reason || "error" }))
  }

  function canUndo(path: string) {
    const state = byPath.value[path]
    return Boolean(state && state.cursor > 0)
  }

  function canRedo(path: string) {
    const state = byPath.value[path]
    return Boolean(state && state.cursor >= 0 && state.cursor < state.versions.length - 1)
  }

  function undo(path: string) {
    const state = byPath.value[path]
    if (state && state.cursor > 0) void restore(path, state.versions[state.cursor - 1].id)
  }

  function redo(path: string) {
    const state = byPath.value[path]
    if (state && state.cursor < state.versions.length - 1) void restore(path, state.versions[state.cursor + 1].id)
  }

  return { byPath, reloadTick, init, record, restore, canUndo, canRedo, undo, redo }
})
