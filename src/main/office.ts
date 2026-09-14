import { createHash, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync, watch, type FSWatcher } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BrowserWindow, shell, type IpcMain } from "electron"

/*
 * The main-process half of MiMo's Office tab: reading a document's bytes (and
 * saying when they have not changed), watching it on disk, a version history
 * per file that undo, redo and the history list move through, and turning old
 * doc/xls/ppt files into their modern forms with LibreOffice.
 */

const READ_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".pptx", ".docx", ".pdf", ".html", ".htm"])
const RESTORE_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".pptx", ".pptm", ".docx", ".docm", ".pdf", ".html", ".htm"])
const READ_LIMIT = 25 * 1024 * 1024
const MAX_VERSIONS = 50
const WATCH_SETTLE_MS = 400
const CONVERT_TIMEOUT_MS = 60_000

export type VersionSource = "initial" | "ai" | "ai_local" | "user" | "external"

interface StoredVersion {
  id: string
  ts: number
  source: VersionSource
  note: string
  hash: string
}

interface Manifest {
  versions: StoredVersion[]
  cursor: number
}

export interface VersionState {
  versions: Omit<StoredVersion, "hash">[]
  cursor: number
}

const sha1 = (data: Buffer | string) => createHash("sha1").update(data).digest("hex")

function publicState(manifest: Manifest): VersionState {
  return { versions: manifest.versions.map(({ hash: _hash, ...rest }) => rest), cursor: manifest.cursor }
}

/* ------------------------------------------------------------ versions */

class VersionStore {
  constructor(private readonly root: string) {}

  private dirOf(file: string) {
    return path.join(this.root, sha1(path.resolve(file)))
  }

  private async read(file: string): Promise<Manifest> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.dirOf(file), "manifest.json"), "utf8")) as Manifest
      if (Array.isArray(parsed.versions) && typeof parsed.cursor === "number") return parsed
    } catch {
      // No history yet, or a broken one: start again.
    }
    return { versions: [], cursor: -1 }
  }

  private async write(file: string, manifest: Manifest) {
    const dir = this.dirOf(file)
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, "manifest.json")
    await fs.writeFile(`${target}.tmp`, JSON.stringify(manifest))
    await fs.rename(`${target}.tmp`, target)
  }

  /* A new version after the cursor - unless it is the version already there - dropping any redo branch and the oldest past fifty. */
  private async add(file: string, bytes: Buffer, source: VersionSource, note: string): Promise<Manifest> {
    const manifest = await this.read(file)
    const hash = sha1(bytes)
    if (manifest.versions[manifest.cursor]?.hash === hash) return manifest
    const dir = this.dirOf(file)
    await fs.mkdir(dir, { recursive: true })
    const dropped = manifest.versions.splice(manifest.cursor + 1)
    const id = `v${Date.now().toString(36)}${randomBytes(2).toString("hex")}`
    await fs.writeFile(path.join(dir, `${id}.bin`), bytes)
    manifest.versions.push({ id, ts: Date.now(), source, note: note.length > 300 ? `${note.slice(0, 300)}…` : note, hash })
    while (manifest.versions.length > MAX_VERSIONS) dropped.push(manifest.versions.shift()!)
    for (const old of dropped) await fs.rm(path.join(dir, `${old.id}.bin`), { force: true })
    manifest.cursor = manifest.versions.length - 1
    await this.write(file, manifest)
    return manifest
  }

  async init(file: string, base64: string, assumeAi: boolean, note: string): Promise<VersionState> {
    const bytes = Buffer.from(base64, "base64")
    let manifest = await this.read(file)
    if (!manifest.versions.length) manifest = await this.add(file, bytes, "initial", "初始版本")
    else if (manifest.versions[manifest.cursor]?.hash !== sha1(bytes)) {
      manifest = await this.add(file, bytes, assumeAi ? "ai_local" : "external", note)
    }
    return publicState(manifest)
  }

  async record(file: string, base64: string, source: VersionSource, note: string): Promise<VersionState> {
    return publicState(await this.add(file, Buffer.from(base64, "base64"), source, note))
  }

  async restore(file: string, id: string): Promise<{ ok: true; state: VersionState } | { ok: false; reason: string }> {
    if (!RESTORE_EXTENSIONS.has(path.extname(file).toLowerCase())) return { ok: false, reason: "unsupported" }
    const manifest = await this.read(file)
    const index = manifest.versions.findIndex((version) => version.id === id)
    if (index < 0) return { ok: false, reason: "noversion" }
    let bytes: Buffer
    try {
      bytes = await fs.readFile(path.join(this.dirOf(file), `${id}.bin`))
    } catch {
      return { ok: false, reason: "nobin" }
    }
    try {
      await fs.writeFile(file, bytes)
    } catch {
      return { ok: false, reason: "writefail" }
    }
    manifest.cursor = index
    await this.write(file, manifest)
    return { ok: true, state: publicState(manifest) }
  }
}

/* ------------------------------------------------------------ reading */

export type ReadResult =
  | { ok: true; unchanged: true; size: number; mtimeMs: number }
  | { ok: true; base64: string; size: number; mtimeMs: number }
  | { ok: false; reason: "denied" | "unsupported" | "noent" | "isdir" | "toobig" }

async function readFileBytes(root: string, rel: string | undefined, ifUnchanged?: { size: number; mtimeMs: number }): Promise<ReadResult> {
  const base = path.resolve(root)
  const target = rel ? path.resolve(base, rel) : base
  if (rel) {
    const relative = path.relative(base, target)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "denied" }
  }
  if (!READ_EXTENSIONS.has(path.extname(target).toLowerCase())) return { ok: false, reason: "unsupported" }
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { ok: false, reason: "noent" }
  }
  if (stat.isDirectory()) return { ok: false, reason: "isdir" }
  if (stat.size > READ_LIMIT) return { ok: false, reason: "toobig" }
  if (ifUnchanged && ifUnchanged.size === stat.size && ifUnchanged.mtimeMs === stat.mtimeMs) {
    return { ok: true, unchanged: true, size: stat.size, mtimeMs: stat.mtimeMs }
  }
  try {
    return { ok: true, base64: (await fs.readFile(target)).toString("base64"), size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { ok: false, reason: "denied" }
  }
}

/* ------------------------------------------------------------ watching */

interface Watched {
  watcher: FSWatcher
  count: number
  timer?: ReturnType<typeof setTimeout>
  last?: { size: number; mtimeMs: number }
}

const watched = new Map<string, Watched>()

async function statOf(file: string) {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

async function watchFile(file: string): Promise<boolean> {
  if (typeof file !== "string" || !path.isAbsolute(file)) return false
  const key = path.resolve(file)
  const existing = watched.get(key)
  if (existing) {
    existing.count += 1
    return true
  }
  const name = path.basename(key)
  try {
    const entry: Watched = {
      count: 1,
      last: await statOf(key),
      watcher: watch(path.dirname(key), { persistent: false }, (_event, changed) => {
        if (changed && changed.toString() !== name) return
        clearTimeout(entry.timer)
        entry.timer = setTimeout(async () => {
          const now = await statOf(key)
          if (now && entry.last && now.size === entry.last.size && now.mtimeMs === entry.last.mtimeMs) return
          entry.last = now
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send("mcode:file-changed", file)
          }
        }, WATCH_SETTLE_MS)
      }),
    }
    entry.watcher.on("error", () => undefined)
    watched.set(key, entry)
    return true
  } catch {
    return false
  }
}

function unwatchFile(file: string) {
  if (typeof file !== "string") return
  const key = path.resolve(file)
  const entry = watched.get(key)
  if (!entry) return
  entry.count -= 1
  if (entry.count > 0) return
  clearTimeout(entry.timer)
  entry.watcher.close()
  watched.delete(key)
}

/* ------------------------------------------------------------ legacy formats */

const LEGACY: Record<string, string> = { ".doc": "docx", ".xls": "xlsx", ".ppt": "pptx" }
const converting = new Map<string, Promise<{ ok: true; output: string; cached: boolean } | { ok: false; error: string }>>()

function sofficePath(): string | undefined {
  const fromEnv = process.env.MCODE_SOFFICE
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
      : process.platform === "win32"
        ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"]
        : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice"]
  return candidates.find((candidate) => existsSync(candidate))
}

async function convertLegacy(userData: string, input: string) {
  if (typeof input !== "string" || !path.isAbsolute(input)) return { ok: false as const, error: "input 必须为绝对路径" }
  const extension = path.extname(input).toLowerCase()
  const target = LEGACY[extension]
  if (!target) return { ok: false as const, error: `不支持的旧格式扩展:${extension}` }
  let stat
  try {
    stat = await fs.stat(input)
  } catch (err) {
    return { ok: false as const, error: `源文件不存在或不可读:${err instanceof Error ? err.message : String(err)}` }
  }
  if (!stat.isFile()) return { ok: false as const, error: "源路径不是文件" }
  const key = createHash("sha256").update(`${input}\0${stat.mtimeMs}\0${stat.size}`).digest("hex").slice(0, 32)
  const cacheDir = path.join(userData, "office-artifacts", "conversions")
  const output = path.join(cacheDir, `${key}.${target}`)
  const cached = await fs.stat(output).catch(() => undefined)
  if (cached && cached.size > 0) return { ok: true as const, output, cached: true }
  const running = converting.get(key)
  if (running) return running
  const job = (async () => {
    const soffice = sofficePath()
    if (!soffice) return { ok: false as const, error: "未找到 LibreOffice(MCODE_SOFFICE 未设置且系统未装)" }
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-soffice-"))
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-conv-"))
    try {
      const args = [
        "--headless",
        "--norestore",
        "--nolockcheck",
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--convert-to",
        target,
        "--outdir",
        outDir,
        input,
      ]
      const failure = await new Promise<string | null>((resolve) => {
        execFile(soffice, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
          if (!error) return resolve(null)
          const code = typeof error.code === "number" ? error.code : 1
          resolve(`soffice 退出码 ${code}:${String(stderr || stdout || error.message).slice(0, 500)}`)
        })
      })
      if (failure) return { ok: false as const, error: failure }
      let produced = path.join(outDir, `${path.basename(input, extension)}.${target}`)
      if (!existsSync(produced)) {
        const found = (await fs.readdir(outDir)).find((name) => name.toLowerCase().endsWith(`.${target}`))
        if (!found) return { ok: false as const, error: `soffice 未产出 .${target} 文件` }
        produced = path.join(outDir, found)
      }
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.rename(produced, output).catch(async () => {
        await fs.copyFile(produced, output)
      })
      return { ok: true as const, output, cached: false }
    } finally {
      await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined)
      converting.delete(key)
    }
  })()
  converting.set(key, job)
  return job
}

/* ------------------------------------------------------------ wiring */

export function registerOffice(ipcMain: IpcMain, userData: string) {
  const versions = new VersionStore(path.join(userData, "office-versions"))

  ipcMain.handle("mcode:read-file-bytes", (_event, root: string, rel?: string, ifUnchanged?: { size: number; mtimeMs: number }) =>
    readFileBytes(root, rel, ifUnchanged),
  )
  ipcMain.handle("mcode:file-size", async (_event, file: string) => {
    const stat = typeof file === "string" && path.isAbsolute(file) ? await fs.stat(file).catch(() => undefined) : undefined
    return stat?.isFile() ? stat.size : 0
  })
  ipcMain.handle("mcode:watch-file", (_event, file: string) => watchFile(file))
  ipcMain.handle("mcode:unwatch-file", (_event, file: string) => unwatchFile(file))
  ipcMain.handle("mcode:office-version-init", async (_event, file: string, base64: string, assumeAi: boolean, note: string) => {
    try {
      return { ok: true, state: await versions.init(file, base64, Boolean(assumeAi), String(note ?? "")) }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle("mcode:office-version-record", async (_event, file: string, base64: string, source: VersionSource, note: string) => {
    try {
      return { ok: true, state: await versions.record(file, base64, source, String(note ?? "")) }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle("mcode:office-version-restore", (_event, file: string, id: string) => versions.restore(file, id))
  ipcMain.handle("mcode:office-convert-legacy", (_event, file: string) => convertLegacy(userData, file))
  ipcMain.handle("mcode:reveal-path", async (_event, file: string) => {
    if (typeof file !== "string" || !path.isAbsolute(file) || !existsSync(file)) return { ok: false, error: "not found" }
    shell.showItemInFolder(file)
    return { ok: true }
  })
}
