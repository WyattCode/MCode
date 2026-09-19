import { createHash, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync, watch, type FSWatcher } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { shell, type IpcMain, type IpcMainInvokeEvent, type WebContents } from "electron"
import { servePreview } from "./preview-server"
import { OFFICE_BYTES_LIMIT, guarded, type WorkingRoots } from "./office-guard"
import { registerPaths } from "./paths"
import { registerImageClipboard } from "./image-clipboard"

/*
 * The main-process half of MiMo's Office tab: reading a document's bytes (and
 * saying when they have not changed), watching it on disk, a version history
 * per file that undo, redo and the history list move through, and turning old
 * doc/xls/ppt files into their modern forms with LibreOffice.
 */

const READ_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".pptx", ".docx", ".pdf", ".html", ".htm"])
const RESTORE_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".pptx", ".pptm", ".docx", ".docm", ".pdf", ".html", ".htm"])
const READ_LIMIT = OFFICE_BYTES_LIMIT
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

  /* One chain per history folder: every read-then-write of a manifest waits for the one before, so concurrent records keep every version. */
  private readonly locks = new Map<string, Promise<void>>()

  private exclusive<T>(file: string, work: () => Promise<T>): Promise<T> {
    const key = this.dirOf(file)
    const before = this.locks.get(key) ?? Promise.resolve()
    const run = before.then(work)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(key, tail)
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
    return run
  }

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
    // A name of its own per write, so two writers never rename each other's half-written file.
    const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    try {
      await fs.writeFile(temp, JSON.stringify(manifest))
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
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

  init(file: string, base64: string, assumeAi: boolean, note: string): Promise<VersionState> {
    return this.exclusive(file, async () => {
      const bytes = Buffer.from(base64, "base64")
      let manifest = await this.read(file)
      if (!manifest.versions.length) manifest = await this.add(file, bytes, "initial", "初始版本")
      else if (manifest.versions[manifest.cursor]?.hash !== sha1(bytes)) {
        manifest = await this.add(file, bytes, assumeAi ? "ai_local" : "external", note)
      }
      return publicState(manifest)
    })
  }

  record(file: string, base64: string, source: VersionSource, note: string): Promise<VersionState> {
    return this.exclusive(file, async () => publicState(await this.add(file, Buffer.from(base64, "base64"), source, note)))
  }

  restore(file: string, id: string): Promise<{ ok: true; state: VersionState } | { ok: false; reason: string }> {
    return this.exclusive(file, () => this.restoreNow(file, id))
  }

  private async restoreNow(file: string, id: string): Promise<{ ok: true; state: VersionState } | { ok: false; reason: string }> {
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

/* The file `rel` names under `root`, or undefined when it climbs out; "..draft.docx" is a name, not a climb. */
function resolveInside(root: string, rel: string | undefined): string | undefined {
  const base = path.resolve(root)
  const target = rel ? path.resolve(base, rel) : base
  if (rel) {
    const relative = path.relative(base, target)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  }
  return target
}

async function readFileBytes(root: string, rel: string | undefined, ifUnchanged?: { size: number; mtimeMs: number }): Promise<ReadResult> {
  if (typeof root !== "string") return { ok: false, reason: "denied" }
  const target = resolveInside(root, rel)
  if (!target) return { ok: false, reason: "denied" }
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

export type WriteResult = { ok: true; size: number; mtimeMs: number } | { ok: false; reason: "denied" | "unsupported" | "writefail" }

/* Only the spreadsheet view writes documents back. */
const WRITE_EXTENSIONS = new Set([".xlsx", ".xlsm"])

/* A spreadsheet the view edited, written back in place under the same rules as reading. */
async function writeFileBytes(root: string, rel: string | undefined, base64: string): Promise<WriteResult> {
  if (typeof root !== "string") return { ok: false, reason: "denied" }
  const target = resolveInside(root, rel)
  if (!target) return { ok: false, reason: "denied" }
  if (!WRITE_EXTENSIONS.has(path.extname(target).toLowerCase()) || typeof base64 !== "string") return { ok: false, reason: "unsupported" }
  const bytes = Buffer.from(base64, "base64")
  // Beside the target so the rename stays on one volume; a crash mid-write leaves the old file whole.
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    try {
      await fs.writeFile(temp, bytes)
      await fs.rename(temp, target)
    } catch {
      // A folder that refuses new files or a rename over a held file: fall back to writing in place.
      await fs.writeFile(target, bytes)
    }
    const stat = await fs.stat(target)
    const size = stat.size
    const mtimeMs = stat.mtimeMs
    // The app's own write is not an outside change: the watcher starts from these bytes.
    const entry = watched.get(watchKey(target))
    if (entry) {
      entry.last = { size, mtimeMs }
      entry.primed = true
    }
    return { ok: true, size, mtimeMs }
  } catch {
    return { ok: false, reason: "writefail" }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

/* ------------------------------------------------------------ watching */

interface Watched {
  watcher: FSWatcher
  count: number
  timer?: ReturnType<typeof setTimeout>
  last?: { size: number; mtimeMs: number }
  /** Whether `last` holds a stat yet; the first one is taken after the watcher is in place. */
  primed: boolean
  /** Per renderer, each spelling of the path it asked with and how many times, so each view hears its own spelling. */
  owners: Map<WebContents, Map<string, number>>
}

const watched = new Map<string, Watched>()
const tracked = new WeakSet<WebContents>()
const caseless = process.platform === "win32"

/* Windows paths differ only in case or slashes still name one file. */
const watchKey = (file: string) => (caseless ? path.resolve(file).toLowerCase() : path.resolve(file))

async function statOf(file: string) {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

function closeEntry(key: string, entry: Watched) {
  clearTimeout(entry.timer)
  entry.watcher.close()
  if (watched.get(key) === entry) watched.delete(key)
}

/* A renderer that goes away lets go of every watch it held. */
function releaseSender(sender: WebContents) {
  for (const [key, entry] of [...watched]) {
    const spellings = entry.owners.get(sender)
    if (!spellings) continue
    for (const times of spellings.values()) entry.count -= times
    entry.owners.delete(sender)
    if (entry.count <= 0) closeEntry(key, entry)
  }
}

function watchFile(sender: WebContents, file: string): boolean {
  if (typeof file !== "string" || !path.isAbsolute(file)) return false
  const key = watchKey(file)
  let entry = watched.get(key)
  if (!entry) {
    const resolved = path.resolve(file)
    const name = caseless ? path.basename(resolved).toLowerCase() : path.basename(resolved)
    let watcher: FSWatcher
    try {
      watcher = watch(path.dirname(resolved), { persistent: false }, (_event, changed) => {
        const changedName = changed ? (caseless ? changed.toString().toLowerCase() : changed.toString()) : ""
        if (changedName && changedName !== name) return
        clearTimeout(created.timer)
        created.timer = setTimeout(async () => {
          const now = await statOf(resolved)
          if (watched.get(key) !== created) return
          if (now && created.last && now.size === created.last.size && now.mtimeMs === created.last.mtimeMs) return
          created.last = now
          created.primed = true
          for (const [contents, spellings] of created.owners) {
            if (contents.isDestroyed()) continue
            for (const spelling of spellings.keys()) contents.send("mcode:file-changed", spelling)
          }
        }, WATCH_SETTLE_MS)
      })
    } catch {
      return false
    }
    const created: Watched = { watcher, count: 0, primed: false, owners: new Map() }
    watcher.on("error", () => undefined)
    // In the map before anything is awaited, so a second watch or an unwatch in the meantime finds it.
    watched.set(key, created)
    entry = created
    void statOf(resolved).then((stat) => {
      if (created.primed) return
      created.last = stat
      created.primed = true
    })
  }
  entry.count += 1
  const spellings = entry.owners.get(sender) ?? new Map<string, number>()
  spellings.set(file, (spellings.get(file) ?? 0) + 1)
  entry.owners.set(sender, spellings)
  if (!tracked.has(sender)) {
    tracked.add(sender)
    sender.once("destroyed", () => releaseSender(sender))
  }
  return true
}

function unwatchFile(sender: WebContents, file: string) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return
  const key = watchKey(file)
  const entry = watched.get(key)
  const spellings = entry?.owners.get(sender)
  if (!entry || !spellings) return
  // The spelling it watched with, else any this renderer holds for the same file.
  const spelling = spellings.has(file) ? file : spellings.keys().next().value
  if (spelling === undefined) return
  const times = (spellings.get(spelling) ?? 0) - 1
  if (times > 0) spellings.set(spelling, times)
  else spellings.delete(spelling)
  if (!spellings.size) entry.owners.delete(sender)
  entry.count -= 1
  if (entry.count <= 0) closeEntry(key, entry)
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
    let profile: string | undefined
    let outDir: string | undefined
    // Every exit, early ones and throws included, lets go of the key, so a failure is never handed out again.
    try {
      const soffice = sofficePath()
      if (!soffice) return { ok: false as const, error: "未找到 LibreOffice(MCODE_SOFFICE 未设置且系统未装)" }
      profile = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-soffice-"))
      outDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-conv-"))
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
        let timedOut = false
        const child = execFile(soffice, args, { windowsHide: true }, (error, stdout, stderr) => {
          clearTimeout(timer)
          if (timedOut) return resolve(`soffice 超时(${CONVERT_TIMEOUT_MS / 1000}s)`)
          if (!error) return resolve(null)
          const code = typeof error.code === "number" ? error.code : 1
          resolve(`soffice 退出码 ${code}:${String(stderr || stdout || error.message).slice(0, 500)}`)
        })
        const timer = setTimeout(() => {
          timedOut = true
          // soffice.exe hands the work to soffice.bin; killing only the launcher leaves the converter running.
          if (process.platform === "win32" && child.pid !== undefined) {
            execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => child.kill())
          } else child.kill("SIGKILL")
        }, CONVERT_TIMEOUT_MS)
      })
      if (failure) return { ok: false as const, error: failure }
      const produceDir = outDir
      let produced = path.join(produceDir, `${path.basename(input, extension)}.${target}`)
      if (!existsSync(produced)) {
        const found = (await fs.readdir(produceDir)).find((name) => name.toLowerCase().endsWith(`.${target}`))
        if (!found) return { ok: false as const, error: `soffice 未产出 .${target} 文件` }
        produced = path.join(produceDir, found)
      }
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.rename(produced, output).catch(async () => {
        await fs.copyFile(produced, output)
      })
      return { ok: true as const, output, cached: false }
    } catch (err) {
      return { ok: false as const, error: `转换失败:${err instanceof Error ? err.message : String(err)}` }
    } finally {
      if (profile) await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined)
      if (outDir) await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })()
  converting.set(key, job)
  // Let go of the key once the job settles, however it ends. Deleting inside the job is not enough: an exit before its first await runs before this set.
  void job.finally(() => {
    if (converting.get(key) === job) converting.delete(key)
  })
  return job
}

/* ------------------------------------------------------------ wiring */

export function registerOffice(ipcMain: IpcMain, userData: string, roots: WorkingRoots) {
  const versions = new VersionStore(path.join(userData, "office-versions"))
  registerPaths(ipcMain)
  registerImageClipboard(ipcMain)

  /*
   * Every channel here passes its declared checks (office-guard.ts) before its
   * handler runs; a call that does not gets the answer the channel gives for a
   * file it cannot use, so the tab shows its ordinary failure.
   */
  const checked = <A extends unknown[]>(channel: string, refused: unknown, handler: (event: IpcMainInvokeEvent, ...args: A) => unknown) => {
    ipcMain.handle(channel, guarded(channel, refused, roots, handler))
  }

  checked("mcode:read-file-bytes", { ok: false, reason: "denied" }, (_event, root: string, rel?: string, ifUnchanged?: { size: number; mtimeMs: number }) =>
    readFileBytes(root, rel ?? undefined, ifUnchanged ?? undefined),
  )
  checked("mcode:write-file-bytes", { ok: false, reason: "denied" }, (_event, root: string, rel: string | undefined, base64: string) =>
    writeFileBytes(root, rel ?? undefined, base64),
  )
  checked("mcode:file-size", 0, async (_event, file: string) => {
    const stat = await fs.stat(file).catch(() => undefined)
    return stat?.isFile() ? stat.size : 0
  })
  checked("mcode:watch-file", false, (event, file: string) => watchFile(event.sender, file))
  checked("mcode:unwatch-file", undefined, (event, file: string) => unwatchFile(event.sender, file))
  checked("mcode:office-version-init", { ok: false, reason: "invalid" }, async (_event, file: string, base64: string, assumeAi: boolean, note?: string) => {
    try {
      return { ok: true, state: await versions.init(file, base64, assumeAi, note ?? "") }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })
  checked("mcode:office-version-record", { ok: false, reason: "invalid" }, async (_event, file: string, base64: string, source: VersionSource, note?: string) => {
    try {
      return { ok: true, state: await versions.record(file, base64, source, note ?? "") }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })
  checked("mcode:office-version-restore", { ok: false, reason: "invalid" }, (_event, file: string, id: string) => versions.restore(file, id))
  checked("mcode:office-convert-legacy", { ok: false, error: "invalid" }, (_event, file: string) => convertLegacy(userData, file))
  checked("mcode:office-serve", { ok: false, error: "missing" }, (_event, file: string) => servePreview(file))
  checked("mcode:reveal-path", { ok: false, error: "not found" }, async (_event, file: string) => {
    if (typeof file !== "string" || !path.isAbsolute(file) || !existsSync(file)) return { ok: false, error: "not found" }
    shell.showItemInFolder(file)
    return { ok: true }
  })
}
