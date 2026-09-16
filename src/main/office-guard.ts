import path from "node:path"
import { insideReal } from "../server/tool/fs-util"
import { appDataRefusal } from "../server/tool/app-data"

/*
 * What the Office tab's channels accept, declared per channel and checked
 * before any handler runs - MiMo validates every one of its channels' inputs
 * against a schema the same way. The arguments come from the renderer, which
 * renders model output, so each is treated as untrusted: its type, its size,
 * and for anything that writes, whether the file lies in a folder the app
 * works in. Kept free of Electron so the checks can be exercised without it.
 */

/** The largest document the tab reads or writes. */
export const OFFICE_BYTES_LIMIT = 25 * 1024 * 1024
/** The longest path accepted; Windows' own long-path ceiling. */
const PATH_LIMIT = 32_767
/** A version note: the view writes a sentence, not a document. */
const NOTE_LIMIT = 4_000

export const VERSION_SOURCES = ["initial", "ai", "ai_local", "user", "external"] as const

type Rule = (value: unknown) => boolean

const absolutePath: Rule = (value) => typeof value === "string" && value.length > 0 && value.length <= PATH_LIMIT && !value.includes("\0") && path.isAbsolute(value)
const relativePath: Rule = (value) =>
  typeof value === "string" && value.length <= PATH_LIMIT && !value.includes("\0") && !path.isAbsolute(value) && !/^[a-zA-Z]:/.test(value)
const optional =
  (rule: Rule): Rule =>
  (value) =>
    value === undefined || value === null || rule(value)
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const statPair: Rule = (value) => typeof value === "object" && value !== null && finite((value as { size?: unknown }).size) && finite((value as { mtimeMs?: unknown }).mtimeMs)
/* Base64 of at most the document limit; the alphabet is checked so a stray object or a huge string of anything else is refused. */
const base64: Rule = (value) => typeof value === "string" && value.length <= Math.ceil(OFFICE_BYTES_LIMIT / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
const flag: Rule = (value) => typeof value === "boolean"
const note: Rule = (value) => value === undefined || (typeof value === "string" && value.length <= NOTE_LIMIT)
const source: Rule = (value) => typeof value === "string" && (VERSION_SOURCES as readonly string[]).includes(value)
/* The ids the version store makes: `v` and base-36 time and hex. */
const versionID: Rule = (value) => typeof value === "string" && /^v[0-9a-z]{1,40}$/.test(value)

export const OFFICE_SCHEMAS: Record<string, readonly Rule[]> = {
  "mcode:read-file-bytes": [absolutePath, optional(relativePath), optional(statPair)],
  "mcode:write-file-bytes": [absolutePath, optional(relativePath), base64],
  "mcode:file-size": [absolutePath],
  "mcode:watch-file": [absolutePath],
  "mcode:unwatch-file": [absolutePath],
  "mcode:office-version-init": [absolutePath, base64, flag, note],
  "mcode:office-version-record": [absolutePath, base64, source, note],
  "mcode:office-version-restore": [absolutePath, versionID],
  "mcode:office-convert-legacy": [absolutePath],
  "mcode:office-serve": [absolutePath],
  "mcode:reveal-path": [absolutePath],
}

/** The folders a document may be written in: the app's projects and conversation folders. */
export type WorkingRoots = () => Promise<string[]>

/** The file a root and an optional relative path name, or undefined when the path climbs out of the root. */
async function joined(root: string, rel: unknown): Promise<string | undefined> {
  if (typeof rel !== "string" || !rel) return path.resolve(root)
  const target = path.resolve(root, rel)
  return (await insideReal(root, target)) ? target : undefined
}

async function inWorkingRoot(target: string, roots: WorkingRoots): Promise<boolean> {
  if (await appDataRefusal(target, "write")) return false
  for (const folder of await roots()) {
    if (await insideReal(folder, target)) return true
  }
  return false
}

/**
 * Why a call on this channel is refused, or undefined when it may run.
 *
 * "shape" is an argument of the wrong type or size; "place" is a file outside
 * where the channel may reach: nothing is written outside a working folder,
 * and nothing in the app's own data folder is read or served.
 */
export async function officeRefusal(channel: string, args: readonly unknown[], roots: WorkingRoots): Promise<"shape" | "place" | undefined> {
  const schema = OFFICE_SCHEMAS[channel]
  if (!schema) return "shape"
  if (args.length > schema.length) return "shape"
  for (let index = 0; index < schema.length; index++) {
    if (!schema[index]!(args[index])) return "shape"
  }
  const first = args[0] as string
  switch (channel) {
    case "mcode:read-file-bytes":
    case "mcode:office-serve":
    case "mcode:office-convert-legacy":
    case "mcode:office-version-init":
    case "mcode:office-version-record": {
      const target = channel === "mcode:read-file-bytes" ? await joined(first, args[1]) : path.resolve(first)
      if (!target || (await appDataRefusal(target, "view"))) return "place"
      return undefined
    }
    case "mcode:write-file-bytes": {
      const target = await joined(first, args[1])
      return target && (await inWorkingRoot(target, roots)) ? undefined : "place"
    }
    case "mcode:office-version-restore":
      // A restore writes the recorded bytes over the file, so it is a write.
      return (await inWorkingRoot(path.resolve(first), roots)) ? undefined : "place"
    default:
      return undefined
  }
}
