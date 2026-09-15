import { addFileNotice, type FileNotice, type FileNoticeSource } from "@shared/file-notices"

/*
 * Document changes waiting for their conversation's next message, as MiMo
 * queues them: kept per conversation, merged per file, taken by the send that
 * carries them, and put back if that send is refused.
 */
const pending = new Map<string, FileNotice[]>()

export function noteFileChange(sessionID: string | undefined, change: { path: string; source: FileNoticeSource; note?: string }): void {
  if (!sessionID) return
  pending.set(sessionID, addFileNotice(pending.get(sessionID) ?? [], { ...change, time: Date.now() }))
}

export function takeFileNotices(sessionID: string): FileNotice[] {
  const list = pending.get(sessionID) ?? []
  pending.delete(sessionID)
  return list
}

/* A refused send hands its notices back, behind anything that arrived meanwhile for another file. */
export function returnFileNotices(sessionID: string, list: readonly FileNotice[]): void {
  if (!list.length) return
  const now = pending.get(sessionID) ?? []
  pending.set(sessionID, [...list.filter((entry) => !now.some((later) => later.path === entry.path)), ...now])
}
