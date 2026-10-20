import { lookup } from "node:dns/promises"

/** At most this many sessions keep a breaker; the oldest marked session is dropped first. */
const MAX_SESSIONS = 500

const OFFLINE = new Map<string, string>()
const DEFAULT_REASON = "disabled by MCODE_OFFLINE"

export function offlineByEnv(): boolean {
  const value = process.env.MCODE_OFFLINE
  return value === "1" || value === "true"
}

export function markOffline(sessionID: string, reason: string): void {
  // Re-marking a session moves it to the newest end, so a long-lived session is not dropped while it is still being used.
  OFFLINE.delete(sessionID)
  OFFLINE.set(sessionID, reason)
  while (OFFLINE.size > MAX_SESSIONS) {
    const oldest = OFFLINE.keys().next().value
    if (oldest === undefined) break
    OFFLINE.delete(oldest)
  }
}

export function isOffline(sessionID: string): boolean {
  return offlineByEnv() || OFFLINE.has(sessionID)
}

export function offlineMessage(sessionID: string): string {
  // Per session: one conversation's DNS failure must not be reported as
  // another's reason for being offline.
  const reason = OFFLINE.get(sessionID) ?? DEFAULT_REASON
  return `The network is unavailable in this session (${reason}). Web tools are disabled for the rest of it; do not retry them. Work from the repository, installed packages and their source on disk.`
}

export function resetOffline(): void {
  OFFLINE.clear()
}

export async function probeOnline(hosts: string[], timeoutMs = 1500, resolve: (host: string) => Promise<unknown> = lookup): Promise<boolean> {
  // Nothing to probe is not evidence of being offline; callers treat true as
  // "no reason to trip the breaker".
  if (!hosts.some((host) => Boolean(host))) return true
  const deadline = Date.now() + timeoutMs
  for (const host of hosts) {
    if (!host) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const resolved = await new Promise<boolean>((settle) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        settle(value)
      }

      timer = setTimeout(() => finish(false), remaining)

      try {
        Promise.resolve(resolve(host)).then(
          () => finish(true),
          () => finish(false),
        )
      } catch {
        finish(false)
      }
    })
    if (resolved) return true
  }
  return false
}
