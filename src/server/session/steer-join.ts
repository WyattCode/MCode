/**
 * Whether a mid-turn prompt may join the open steering list.
 *
 * A turn that has already been stopped still keeps its AbortController in
 * `running` until cleanup finishes, and used to keep its steering entry too.
 * Joining that list writes the message into a turn that will not resume after
 * Stop — so the words land in the transcript and nothing answers them.
 */
export function mayJoinSteering(hasOpen: boolean, turnAborted: boolean): boolean {
  return hasOpen && !turnAborted
}

