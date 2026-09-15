import fs from "node:fs"
import path from "node:path"
import type { IpcMain } from "electron"

/*
 * MiMo's saved composer input: every conversation's draft, its files, skill
 * chips and waiting annotations, kept in one file beside the config. The
 * renderer hands over the whole document; this only reads and writes that one
 * file, and refuses anything that is not a JSON object of a sane size.
 */
const FILE = "composer-input.json"
const MAX_BYTES = 64 * 1024 * 1024

export function registerComposerInput(ipc: IpcMain, userData: string): void {
  const file = path.join(userData, "storage", FILE)

  // Read synchronously, once, before the window's first composer is drawn.
  ipc.on("mcode:composer-input-load", (event) => {
    try {
      event.returnValue = { ok: true, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" }
    } catch {
      event.returnValue = { ok: false }
    }
  })

  // Written through a temporary file, so a crash mid-write never leaves half a document.
  const write = (text: unknown): boolean => {
    if (typeof text !== "string" || !text.startsWith("{") || Buffer.byteLength(text, "utf8") > MAX_BYTES) return false
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temporary, text, "utf8")
      fs.renameSync(temporary, file)
      return true
    } catch {
      return false
    }
  }

  ipc.handle("mcode:composer-input-save", (_event, text: unknown) => write(text))
  // The page is going away: the last write has to finish before it does.
  ipc.on("mcode:composer-input-flush", (event, text: unknown) => {
    event.returnValue = write(text)
  })
}
