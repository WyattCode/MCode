/**
 * Puts MuseScore_General.sf3 in resources/soundfont for a build or `npm run dev`.
 *
 * The 38 MB file is not in git. It is taken, in order, from resources/soundfont
 * when it is already there, from a local cache (MCODE_SOUNDFONT_CACHE, a folder,
 * or the user's build cache folder), and only then downloaded from MuseScore's
 * own mirror. Whatever the source, the size and sha256 must match exactly or the
 * file is refused and the script fails - so a package build never ships a
 * different or damaged soundfont. A download goes to a temporary file first and
 * is renamed only once it verifies; a good download also fills the cache.
 *
 *   node scripts/soundfont.mjs             fail (exit 1) when it cannot be placed
 *   node scripts/soundfont.mjs --optional  warn and exit 0 (npm run dev)
 *
 * The file, size and hash repeat src/shared/soundfont.ts; the smoke check
 * compares them.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { pipeline } from "node:stream/promises"
import { Readable, Transform } from "node:stream"
import { fileURLToPath } from "node:url"

export const SOUNDFONT_FILE = "MuseScore_General.sf3"
export const SOUNDFONT_SIZE = 39_900_972
export const SOUNDFONT_SHA256 = "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3"
/* MuseScore's official mirror; the hash above was computed independently from a copy downloaded here. */
export const SOUNDFONT_SOURCE = "https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3"

const EXPECTED = { size: SOUNDFONT_SIZE, sha256: SOUNDFONT_SHA256 }

/** Why `file` is not the soundfont ("missing", "size", "hash"), or undefined when it is. */
export async function soundfontFileProblem(file, expected = EXPECTED) {
  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    return "missing"
  }
  if (!stat.isFile()) return "missing"
  if (stat.size !== expected.size) return "size"
  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest("hex") === expected.sha256 ? undefined : "hash"
}

export function defaultCacheDir() {
  if (process.env.MCODE_SOUNDFONT_CACHE) return process.env.MCODE_SOUNDFONT_CACHE
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local") : process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "mcode-build-cache", "soundfont")
}

async function copyVerified(from, to, expected) {
  const temporary = `${to}.part`
  await fs.promises.mkdir(path.dirname(to), { recursive: true })
  await fs.promises.copyFile(from, temporary)
  const problem = await soundfontFileProblem(temporary, expected)
  if (problem) {
    await fs.promises.rm(temporary, { force: true })
    return problem
  }
  await fs.promises.rename(temporary, to)
  return undefined
}

async function download(url, to, expected, log) {
  const temporary = `${to}.part`
  await fs.promises.mkdir(path.dirname(to), { recursive: true })
  log(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`)
  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      // A body longer than the file is already wrong; stop reading it.
      if (received > expected.size) callback(new Error(`download is larger than ${expected.size} bytes`))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temporary))
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
  const problem = await soundfontFileProblem(temporary, expected)
  if (problem) {
    await fs.promises.rm(temporary, { force: true })
    throw new Error(`downloaded soundfont refused: ${problem} mismatch`)
  }
  await fs.promises.rename(temporary, to)
}

/**
 * Makes `target` the verified soundfont. `options.download` false never touches
 * the network. Resolves with where it came from; rejects when nothing verified.
 */
export async function ensureSoundfont(target, options = {}) {
  const expected = options.expected ?? EXPECTED
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const log = options.log ?? (() => undefined)
  const present = await soundfontFileProblem(target, expected)
  if (present === undefined) return "present"
  if (present !== "missing") {
    log(`resources copy refused (${present} mismatch); replacing it`)
    await fs.promises.rm(target, { force: true })
  }
  const cached = path.join(cacheDir, path.basename(target))
  const cacheProblem = await soundfontFileProblem(cached, expected)
  if (cacheProblem === undefined) {
    const copied = await copyVerified(cached, target, expected)
    if (copied === undefined) return "cache"
    log(`cache copy refused (${copied} mismatch)`)
  } else if (cacheProblem !== "missing") {
    log(`cache copy refused (${cacheProblem} mismatch)`)
  }
  if (options.download === false) throw new Error("soundfont is not present, no verified cache copy, and downloading is off")
  await download(options.url ?? SOUNDFONT_SOURCE, target, expected, log)
  try {
    await copyVerified(target, cached, expected)
  } catch {
    // A cache that cannot be written only means the next build downloads again.
  }
  return "download"
}

const here = path.dirname(fileURLToPath(import.meta.url))
if (path.basename(process.argv[1] ?? "") === "soundfont.mjs") {
  const optional = process.argv.includes("--optional")
  const target = path.join(here, "..", "resources", "soundfont", SOUNDFONT_FILE)
  ensureSoundfont(target, { log: (line) => console.log(`soundfont: ${line}`) }).then(
    (from) => console.log(`soundfont: ${from === "present" ? "verified" : `placed from ${from}`} (${SOUNDFONT_SIZE} bytes, sha256 ${SOUNDFONT_SHA256.slice(0, 12)}…)`),
    (error) => {
      console[optional ? "warn" : "error"](`soundfont: ${error instanceof Error ? error.message : error}`)
      if (optional) console.warn("soundfont: scores will play through the built-in synth until it is placed")
      process.exit(optional ? 0 : 1)
    },
  )
}
