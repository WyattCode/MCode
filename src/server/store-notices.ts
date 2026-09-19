import type { ResponseMap } from "@shared/protocol"
import type { Runtime } from "./index"

/**
 * Stored documents the backend found damaged or unreadable, said in the window.
 *
 * Each of these used to be recovered from quietly - a store moved aside and
 * started again, a document skipped - and noted in the log at most, so the
 * reader was left to work out for themselves why something they had was gone.
 * The window asks once it has booted and shows each as `settings.unreadable`
 * is shown.
 */
export type StoreNotice = ResponseMap["storage.problems"]["problems"][number]

/** What each backend has already said, so a second window or a reload is not told again. */
const told = new WeakMap<Runtime, Set<string>>()

export async function storeNotices(runtime: Runtime): Promise<StoreNotice[]> {
  const found: StoreNotice[] = []
  // L12-7: the artifacts store was damaged, kept aside and made again.
  if (runtime.artifacts?.recovered) found.push({ code: "error.artifactsRecreated", params: { path: runtime.artifacts.recovered } })
  const said = told.get(runtime) ?? new Set<string>()
  told.set(runtime, said)
  const fresh = found.filter((notice) => !said.has(notice.code))
  for (const notice of fresh) said.add(notice.code)
  return fresh
}
