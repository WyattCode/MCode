import fs from "node:fs/promises"
import type { OAuthTokens } from "./auth/oauth"

export interface Credentials {
  keys: Record<string, string>
  oauth: Record<string, OAuthTokens>
}

export type CredentialRead =
  | { state: "absent" }
  | { state: "read"; credentials: Credentials }
  /** Never carries the file's text: a parse error quotes it, and it is keys. */
  | { state: "unreadable"; problem: string }

/**
 * The credential file as stored.
 *
 * Two shapes read: the old bare provider -> key map and `{keys, oauth}`.
 * Anything else - text that is not JSON, a file that cannot be opened - is
 * unreadable, never empty: an empty answer is what let the next saved key
 * write over every other one (L12-2).
 */
export async function readCredentialFile(file: string): Promise<CredentialRead> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { state: "absent" }
    return { state: "unreadable", problem: `credentials.json could not be opened (${code ?? "unknown error"})` }
  }
  return parseCredentials(text)
}

export function parseCredentials(text: string): CredentialRead {
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return { state: "unreadable", problem: "credentials.json is not valid JSON" }
  }
  if (!isRecord(raw)) return { state: "unreadable", problem: "credentials.json does not hold an object" }
  // The file used to be a bare provider -> key map; keep those working.
  const versioned = "keys" in raw || "oauth" in raw
  const keys = versioned ? (raw.keys ?? {}) : raw
  const oauth = versioned ? (raw.oauth ?? {}) : {}
  if (!isRecord(keys) || !isRecord(oauth)) return { state: "unreadable", problem: "credentials.json does not hold key and sign-in maps" }
  return { state: "read", credentials: { keys: keys as Record<string, string>, oauth: oauth as Record<string, OAuthTokens> } }
}

/** The file's text. */
export function renderCredentials(credentials: Credentials): string {
  return JSON.stringify({ keys: credentials.keys, oauth: credentials.oauth }, null, 2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
