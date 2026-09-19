import { safeStorage } from "electron"
import type { SecretBox } from "../server/credential-file"

/**
 * Electron's safeStorage as the backend's secret box (L12-3): each value
 * sealed on its own and kept as base64, as MiMo keeps its provider keys.
 *
 * Only usable once the app is ready, which is when the backend is started.
 * A check that throws is read as "cannot seal here", so the keys stay in plain
 * text with the notice rather than the backend failing to start.
 */
export const safeStorageBox: SecretBox = {
  available() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },
  seal(plain) {
    return safeStorage.encryptString(plain).toString("base64")
  },
  open(sealed) {
    return safeStorage.decryptString(Buffer.from(sealed, "base64"))
  },
}
