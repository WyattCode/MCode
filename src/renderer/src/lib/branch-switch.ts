import { ref } from "vue"
import type { BranchState, CheckoutResult } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "./i18n"

/*
 * Switching a project's branch, shared by the home screen's branch chip and the
 * info card's branch row. The two say what happened differently - the chip in
 * toasts, the card in a line under the row - so this only asks git and sorts
 * the answer.
 */

export async function readBranches(directory: string): Promise<BranchState | undefined> {
  return useApp().client?.request({ type: "git.branches", directory })
}

export type SwitchOutcome =
  | { kind: "unchanged" }
  | { kind: "switched"; branch: string; conflicts: boolean }
  /** Uncommitted work in the way; the reader decides whether to carry it across. */
  | { kind: "dirty"; branch: string }
  | { kind: "worktree"; branch: string; directory: string; name: string }
  | { kind: "failed"; branch: string; result?: CheckoutResult; error: string }

export async function switchBranch(
  directory: string,
  branch: string,
  current: string | undefined,
  force = false,
): Promise<SwitchOutcome> {
  if (!force && branch === current) return { kind: "unchanged" }
  let result: CheckoutResult | undefined
  try {
    result = await useApp().client?.request({ type: "git.checkout", directory, branch, force })
  } catch (err) {
    return { kind: "failed", branch, error: err instanceof Error ? err.message : String(err) }
  }
  if (!result) return { kind: "failed", branch, error: t("common.requestFailed") }
  if (result.ok) {
    useApp().branchesChanged()
    return { kind: "switched", branch: result.branch ?? branch, conflicts: Boolean(result.conflicts) }
  }
  if (result.worktree) return { kind: "worktree", branch, ...result.worktree }
  if (result.dirty) return { kind: "dirty", branch }
  return { kind: "failed", branch, result, error: result.error ?? "" }
}

/**
 * The info card's branch menu state, after MiMo's: branches read when the menu
 * opens, a dirty switch held for confirmation, and what went wrong said once.
 */
export function useBranchSwitch(directory: () => string | undefined, onMutated: () => void) {
  const branches = ref<string[]>([])
  const current = ref<string>()
  const loading = ref(false)
  const switching = ref(false)
  const pending = ref<string>()
  const error = ref("")

  async function loadBranches() {
    const root = directory()
    if (!root) return
    loading.value = true
    error.value = ""
    try {
      const state = await readBranches(root)
      if (directory() !== root) return
      branches.value = state?.branches ?? []
      current.value = state?.detached ? undefined : state?.branch
      /*
       * An answer that resolved but holds no repository - a folder outside one,
       * a bare repository, a `for-each-ref` the server swallowed - used to leave
       * the submenu blank and silent. MiMo says so for any answer it cannot read
       * as a branch list, not only for one that threw.
       */
      if (!state?.repo || !Array.isArray(state.branches)) error.value = t("info.branchListUnavailable")
    } catch {
      if (directory() === root) error.value = t("info.branchListUnavailable")
    } finally {
      loading.value = false
    }
  }

  async function switchTo(branch: string, known: string | undefined, force = false) {
    const root = directory()
    if (!root || switching.value) return
    pending.value = undefined
    error.value = ""
    switching.value = true
    try {
      const outcome = await switchBranch(root, branch, known, force)
      if (outcome.kind === "switched") {
        if (outcome.conflicts) error.value = t("info.branchSwitchConflicts")
        current.value = outcome.branch
        onMutated()
      } else if (outcome.kind === "dirty") pending.value = branch
      else if (outcome.kind === "worktree") error.value = t("info.branchWorktree", { name: outcome.name })
      else if (outcome.kind === "failed") error.value = t("info.branchSwitchFailed")
    } finally {
      switching.value = false
    }
  }

  return {
    branches,
    current,
    loading,
    switching,
    pending,
    error,
    loadBranches,
    switchTo,
    clearPending: () => (pending.value = undefined),
  }
}
