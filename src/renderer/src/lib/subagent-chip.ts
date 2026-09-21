/*
 * subagents: MiMo 26.920's side column chip. A conversation whose own turn has
 * ended while subagents it started are still working keeps a spinner and an
 * "N subagents" chip on its row; one working under another counts for the
 * conversation at the top of the chain.
 */

/** The working subagents of each conversation that is not itself running, by the conversation's id. */
export function subagentsAtWork<T extends { id: string }>(
  subagents: readonly T[],
  running: ReadonlySet<string>,
  rootOf: (sessionID: string) => string,
): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const session of subagents) {
    if (!running.has(session.id)) continue
    const root = rootOf(session.id)
    if (root === session.id || running.has(root)) continue
    out.set(root, [...(out.get(root) ?? []), session])
  }
  return out
}
