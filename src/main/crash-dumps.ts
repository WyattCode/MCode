import path from "node:path"
import type { CrashReporter } from "electron"

/**
 * MiMo's local crash dumps: Crashpad writes a minidump when the main process,
 * a renderer, the GPU process or a native module crashes, and nothing is ever
 * sent anywhere (`uploadToServer: false`). The dumps stay in the profile's
 * `Crashpad` folder for whoever debugs a native crash, and ten seconds after
 * launch the old and odd ones are pruned with MiMo's limits.
 *
 * Electron-free apart from the pieces passed in, so smoke can hold the pruning
 * rule and the start options.
 */

export const CRASH_FOLDER = "Crashpad"
/** MiMo's limits: the newest ten dumps, none older than 14 days, none under 32 bytes or over 128 MB. */
export const DUMP_LIMITS = { maxFiles: 10, maxBytes: 128 * 1024 * 1024, minBytes: 32, maxAgeMs: 14 * 24 * 60 * 60 * 1000 }
export const PRUNE_DELAY_MS = 10_000
/** How deep Crashpad nests its report folders (reports, attachments, pending...). */
const MAX_DEPTH = 3

export interface DumpEntry {
  /** Relative to the crash folder, with forward slashes. */
  relativePath: string
  sizeBytes: number
  mtimeMs: number
}

/** Which dumps to delete: anything that is not a sane minidump, too old, or past the newest ten. Other files are Crashpad's own. */
export function prunableDumps(entries: DumpEntry[], now: number, limits = DUMP_LIMITS): DumpEntry[] {
  const prune: DumpEntry[] = []
  const kept: DumpEntry[] = []
  for (const entry of entries) {
    if (!/\.dmp$/i.test(entry.relativePath)) continue
    if (entry.sizeBytes < limits.minBytes || entry.sizeBytes > limits.maxBytes || now - entry.mtimeMs > limits.maxAgeMs) prune.push(entry)
    else kept.push(entry)
  }
  kept.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return [...prune, ...kept.slice(limits.maxFiles)]
}

export interface DumpFs {
  readdir(directory: string): Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>
  stat(file: string): Promise<{ size: number; mtimeMs: number }>
  unlink(file: string): Promise<void>
}

async function listDumps(root: string, files: DumpFs, relative = "", depth = 0): Promise<DumpEntry[]> {
  if (depth > MAX_DEPTH) return []
  let entries: Awaited<ReturnType<DumpFs["readdir"]>>
  try {
    entries = await files.readdir(path.join(root, relative))
  } catch {
    return []
  }
  const found: DumpEntry[] = []
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await listDumps(root, files, child, depth + 1)))
    else if (entry.isFile()) {
      try {
        const stat = await files.stat(path.join(root, child))
        found.push({ relativePath: child, sizeBytes: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // Gone between the listing and the stat.
      }
    }
  }
  return found
}

/** Deletes what prunableDumps picks; resolves with the relative paths it removed. Never throws. */
export async function pruneCrashDumps(root: string, files: DumpFs, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  for (const entry of prunableDumps(await listDumps(root, files), now)) {
    try {
      await files.unlink(path.join(root, entry.relativePath))
      removed.push(entry.relativePath)
    } catch {
      // Still being written, or already gone.
    }
  }
  return removed
}

/**
 * Starts the local-only reporter with the dumps in `<profile>/Crashpad`, where
 * MiMo keeps them. Call before the app is ready and after the profile folder is
 * settled. Returns the folder, or undefined when the reporter would not start.
 */
export function startLocalCrashDumps(options: {
  reporter: Pick<CrashReporter, "start">
  setCrashFolder(folder: string): void
  profile: string
  log(line: string): void
}): string | undefined {
  const folder = path.join(options.profile, CRASH_FOLDER)
  try {
    options.setCrashFolder(folder)
    // Nothing is uploaded, and no submit address exists to upload to.
    options.reporter.start({ uploadToServer: false })
    options.log(`[crash] native crash dumps are kept locally in ${folder}`)
    return folder
  } catch (error) {
    options.log(`[crash] the local crash reporter did not start: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
