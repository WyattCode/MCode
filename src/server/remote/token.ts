import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * The pairing token a phone must present to the gateway.
 *
 * Kept beside the storage rather than in config.json: editing the config is
 * how settings change, and a token that a config edit could reveal - or one
 * that rides along in every config export - would make the pairing weaker
 * than it looks. First use generates it; every later start reads the same one,
 * so a phone's saved address keeps working across restarts.
 */
export function loadOrCreateToken(dataDirectory: string): string {
  const file = path.join(dataDirectory, "storage", "remote-token.json")
  // Mirrors the storage quarantine naming: the damaged file is kept beside the
  // original so a phone's pairing can be recovered by hand, never silently lost.
  const quarantine = (): string | undefined => {
    const iso = new Date().toISOString().replace(/[:.]/g, "-")
    for (const aside of [`${file}.corrupt-${iso}`, `${file}.corrupt-${iso}-1`, `${file}.corrupt-${iso}-2`, `${file}.corrupt-${iso}-3`]) {
      try {
        renameSync(file, aside)
        return aside
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue
        return undefined
      }
    }
    return undefined
  }
  if (existsSync(file)) {
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      console.warn(`[remote] the pairing token could not be read (${why}); nothing is written over ${file}`)
      throw new Error(`the pairing token could not be read: ${file}`)
    }
    let doc: { token?: unknown } | undefined
    try {
      doc = JSON.parse(raw) as { token?: unknown }
    } catch {
      const aside = quarantine()
      if (aside === undefined) {
        console.warn(`[remote] the pairing token is damaged and could not be moved aside; nothing is written over ${file}`)
        throw new Error(`the pairing token is damaged and could not be moved aside: ${file}`)
      }
      console.warn(`[remote] the pairing token was damaged; the file was kept as ${aside}`)
    }
    if (doc && typeof doc.token === "string" && doc.token.length >= 16) {
      // Tokens written by older versions may be world-readable; tighten on load
      // (mode on writeFileSync only applies at creation). No-op on Windows.
      try {
        if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
      } catch {
        // A permission we cannot change is not worth failing the start over.
      }
      return doc.token
    }
    if (doc) {
      const aside = quarantine()
      if (aside === undefined) {
        console.warn(`[remote] the pairing token is malformed and could not be moved aside; nothing is written over ${file}`)
        throw new Error(`the pairing token is malformed and could not be moved aside: ${file}`)
      }
      console.warn(`[remote] the pairing token was malformed; the file was kept as ${aside}`)
    }
  }
  const token = randomBytes(24).toString("base64url")
  // Owner-only: this token drives this machine from the LAN, so no other
  // local account may read it (Windows keeps inherited ACLs; mode is a no-op there).
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ token }), { encoding: "utf8", mode: 0o600 })
  return token
}
