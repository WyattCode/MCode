/**
 * Links that open one conversation.
 *
 * The same shape MiMo copies - a fixed action with the session and the project
 * it sits in as query values - under this app's own scheme. Built by the window
 * that copies one and read by the main process that receives one, so both halves
 * live here.
 */
export const LINK_SCHEME = "mcode"

export interface SessionLinkTarget {
  sessionID: string
  directory?: string
}

export function sessionLink(sessionID: string, directory?: string): string {
  const query: string[] = []
  if (directory) query.push("directory=" + encodeURIComponent(directory))
  query.push("session=" + encodeURIComponent(sessionID))
  return `${LINK_SCHEME}://open-session?${query.join("&")}`
}

/** What a link points at, or nothing for a link this app does not answer. */
export function parseSessionLink(raw: string): SessionLinkTarget | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== `${LINK_SCHEME}:`) return undefined
  // Some platforms hand the action over as a path rather than a host.
  const action = (url.host || url.pathname.replace(/^\/+/, "")).toLowerCase()
  if (action !== "open-session") return undefined
  const sessionID = url.searchParams.get("session")?.trim()
  if (!sessionID) return undefined
  const directory = url.searchParams.get("directory") || undefined
  return { sessionID, directory }
}

/** The link among a process's arguments, which is how Windows and Linux pass one. */
export function linkInArgs(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${LINK_SCHEME}://`))
}
