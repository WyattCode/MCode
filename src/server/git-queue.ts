import path from "node:path"

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

function keyOf(root: string): string {
  const resolved = path.resolve(root)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
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
