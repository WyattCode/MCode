import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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
  if (existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as { token?: unknown }
      if (typeof doc.token === "string" && doc.token.length >= 16) {
        // Tokens written by older versions may be world-readable; tighten on load
        // (mode on writeFileSync only applies at creation). No-op on Windows.
        try {
          if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
        } catch {
          // A permission we cannot change is not worth failing the start over.
        }
        return doc.token
      }
    } catch {
      // Fallen through to a fresh one below; the old file is overwritten.
    }
  }
  const token = randomBytes(24).toString("base64url")
  // Owner-only: this token drives this machine from the LAN, so no other
  // local account may read it (Windows keeps inherited ACLs; mode is a no-op there).
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ token }), { encoding: "utf8", mode: 0o600 })
  return token
}
