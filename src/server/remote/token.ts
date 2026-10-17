import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
      if (typeof doc.token === "string" && doc.token.length >= 16) return doc.token
    } catch {
      // Fallen through to a fresh one below; the old file is overwritten.
    }
  }
  const token = randomBytes(24).toString("base64url")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ token }), "utf8")
  return token
}
