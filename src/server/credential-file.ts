import fs from "node:fs/promises"
import type { OAuthTokens } from "./auth/oauth"

/**
 * Seals and opens single values with the operating system's secret store.
 *
 * The desktop app hands in Electron's safeStorage (DPAPI on Windows, the
 * Keychain on macOS, the keyring on Linux), as MiMo stores its provider
 * credentials. It lives in the main process and only works once the app is
 * ready, so the backend is given it rather than reaching for it: run on its
 * own under plain node - the checks - the backend has none and keeps the file
 * in plain text.
 */
export interface SecretBox {
  /** Whether values can be sealed on this machine now; false on Linux without a keyring. */
  available(): boolean
  /** One value sealed, as text fit for JSON. */
  seal(plain: string): string
  /** A sealed value opened again; throws when it was sealed by another user or machine. */
  open(sealed: string): string
}

export interface Credentials {
  keys: Record<string, string>
  oauth: Record<string, OAuthTokens>
}

/** What a sealed credential file names as its sealing, so a later scheme is never misread as this one. */
const SEALING = "safeStorage"

export type CredentialRead =
  | { state: "absent" }
  | { state: "read"; credentials: Credentials; sealed: boolean }
  /**
   * Never carries the file's text: a parse error quotes it, and it is keys.
   * `keep` means the file must stay where it is (Linux keyring locked / no
   * box yet) so a later unlock can open it - never quarantine those.
   */
  | { state: "unreadable"; problem: string; keep?: boolean }

/**
 * The credential file as stored.
 *
 * Three shapes read: the old bare provider -> key map, `{keys, oauth}` in
 * plain text, and the sealed form, whose every value is sealed on its own.
 * Anything else - text that is not JSON, a sealed file this machine cannot
 * open (another Windows user's, a profile copied from another computer, a
 * keyring that is gone) - is unreadable, never empty: an empty answer is what
 * let the next saved key write over every other one.
 */
export async function readCredentialFile(file: string, box: SecretBox | undefined): Promise<CredentialRead> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { state: "absent" }
    return { state: "unreadable", problem: `credentials.json could not be opened (${code ?? "unknown error"})` }
  }
  return parseCredentials(text, box)
}

export function parseCredentials(text: string, box: SecretBox | undefined): CredentialRead {
  let raw: unknown
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return { state: "unreadable", problem: "credentials.json is not valid JSON" }
  }
  if (!isRecord(raw)) return { state: "unreadable", problem: "credentials.json does not hold an object" }
  if ("sealed" in raw) return opened(raw, box)
  // The file used to be a bare provider -> key map; keep those working.
  const versioned = "keys" in raw || "oauth" in raw
  const keys = versioned ? (raw.keys ?? {}) : raw
  const oauth = versioned ? (raw.oauth ?? {}) : {}
  if (!isRecord(keys) || !isRecord(oauth)) return { state: "unreadable", problem: "credentials.json does not hold key and sign-in maps" }
  return { state: "read", sealed: false, credentials: { keys: keys as Record<string, string>, oauth: oauth as Record<string, OAuthTokens> } }
}

function opened(raw: Record<string, unknown>, box: SecretBox | undefined): CredentialRead {
  if (raw.sealed !== SEALING) return { state: "unreadable", problem: "credentials.json is sealed in a form this build does not know" }
  if (!box?.available()) return { state: "unreadable", problem: "credentials.json is encrypted and this system's secure storage cannot open it", keep: true }
  const keys = raw.keys ?? {}
  const oauth = raw.oauth ?? {}
  if (!isRecord(keys) || !isRecord(oauth)) return { state: "unreadable", problem: "credentials.json does not hold key and sign-in maps" }
  const out: Credentials = { keys: {}, oauth: {} }
  try {
    for (const [id, sealed] of Object.entries(keys)) {
      if (typeof sealed !== "string") throw new Error("not text")
      out.keys[id] = box.open(sealed)
    }
    for (const [id, sealed] of Object.entries(oauth)) {
      if (typeof sealed !== "string") throw new Error("not text")
      const tokens = JSON.parse(box.open(sealed)) as unknown
      if (!isRecord(tokens) || typeof tokens.access !== "string") throw new Error("not tokens")
      out.oauth[id] = tokens as unknown as OAuthTokens
    }
  } catch {
    // Which value, or why, is not said: either could hint at what the file holds.
    return { state: "unreadable", problem: "credentials.json could not be decrypted here (written by another user or machine?)" }
  }
  return { state: "read", sealed: true, credentials: out }
}

/** The file's text: every value sealed when the box can, otherwise plain as before. */
export function renderCredentials(credentials: Credentials, box: SecretBox | undefined): string {
  if (!box?.available()) return JSON.stringify({ keys: credentials.keys, oauth: credentials.oauth }, null, 2)
  const seal = <T>(map: Record<string, T>, text: (value: T) => string) =>
    Object.fromEntries(Object.entries(map).map(([id, value]) => [id, box.seal(text(value))]))
  return JSON.stringify(
    {
      sealed: SEALING,
      keys: seal(credentials.keys, (key) => key),
      oauth: seal(credentials.oauth, (tokens) => JSON.stringify(tokens)),
    },
    null,
    2,
  )
}

/** Whether two sets of credentials say the same, for the check after sealing. */
export function sameCredentials(a: Credentials, b: Credentials): boolean {
  const canonical = (credentials: Credentials) =>
    JSON.stringify([
      Object.entries(credentials.keys).sort(([x], [y]) => x.localeCompare(y)),
      Object.entries(credentials.oauth)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([id, tokens]) => [id, Object.entries(tokens).sort(([x], [y]) => x.localeCompare(y))]),
    ])
  return canonical(a) === canonical(b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
