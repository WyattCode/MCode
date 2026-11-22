import path from "node:path"
import { realpathSync } from "node:fs"

/**
 * One queue per repository for the git commands that change it (N11-14).
 *
 * Reads never wait here: they run with GIT_OPTIONAL_LOCKS=0 and take no lock of
 * git's own. Writes did not wait either, and two conversations - or a
 * conversation and the commit card - could each be half way through one at
 * once: a `commit` whose `add -A` swept in the file another conversation was
 * writing that moment, a checkout racing a patch being taken back, the loser
 * failing on index.lock. MiMo serialises per git directory with a semaphore of
 * one; this is the same, keyed by the repository's top level.
 *
 * A write that has to wait says so, and the window shows 等待中 on the
 * control that asked for it.
 */

const queues = new Map<string, Promise<unknown>>()
/** How many writes are queued or running per repository, so a newcomer knows whether it waits. */
const depth = new Map<string, number>()

type Listener = (directory: string, waiting: boolean) => void
let listener: Listener | undefined

/** Where waiting is reported: the backend publishes it to the windows. */
export function onGitWaiting(next: Listener | undefined): void {
  listener = next
}

/**
 * The queue key: the folder itself, not the string the caller happened to hold.
 *
 * One folder can be spelled two legal ways on Windows (an 8.3 short name and
 * the long name a folder carries), and `commit` re-keys itself by git's own
 * physical answer. Comparing those two by text made one repository two
 * queues: the commit ran while a checkout was still under way — measured as
 * the FAIL "a commit waits while another write on the repository is under
 * way" on the Windows battery (runs 44949680691 through 44956037950), and
 * reproducible on Mac by queueing a write under a link's name to the folder.
 * A folder that does not exist yet (a checkout about to be created) keeps
 * its resolved spelling, the way `canonicalDirectory` in git.ts does.
 */
function keyOf(root: string): string {
  const resolved = path.resolve(root)
  // The native call asks the file system for the folder's final spelling.
  // There is deliberately no pure-JS `realpathSync` behind it: on Windows that
  // call neither expands an 8.3 short name nor follows a junction, so it would
  // hand the queue a third spelling of one folder and split the repository
  // into two queues again - the exact defect this key exists to prevent
  // (measured on the Windows battery, run 44957873618: both FAILs unchanged
  // with the JS version). A folder git has not made yet keeps its resolved
  // spelling, the way `canonicalDirectory` in git.ts does.
  let key = resolved
  try {
    key = realpathSync.native(resolved)
  } catch {
    // A folder git has not made yet keeps its resolved spelling until it exists.
  }
  return process.platform === "win32" ? key.toLowerCase() : key
}

/**
 * Runs `work` once every earlier write to the same repository has finished.
 *
 * @param root the repository's top level, which is what the queue is keyed by
 * @param directory what the caller asked about, which is what the window knows it by
 */
export function serialisedWrite<T>(root: string, directory: string, work: () => Promise<T>): Promise<T> {
  const key = keyOf(root)
  const ahead = depth.get(key) ?? 0
  depth.set(key, ahead + 1)
  const waited = ahead > 0
  if (waited) listener?.(directory, true)
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(() => {
      if (waited) listener?.(directory, false)
      return work()
    })
  const settled = run.catch(() => undefined)
  queues.set(key, settled)
  void settled.then(() => {
    const left = (depth.get(key) ?? 1) - 1
    if (left > 0) depth.set(key, left)
    else depth.delete(key)
    if (queues.get(key) === settled) queues.delete(key)
  })
  return run
}

/** How many writes are queued or running for a repository, for the checks. */
export function queuedWrites(root: string): number {
  return depth.get(keyOf(root)) ?? 0
}
