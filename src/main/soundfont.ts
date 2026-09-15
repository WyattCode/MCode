import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { SOUNDFONT, soundfontProblem, type SoundfontExpectation, type SoundfontReply } from "@shared/soundfont"

/**
 * The soundfont's bytes for the window, over IPC.
 *
 * The window is a file:// page and Chromium's fetch cannot read file: at all,
 * so the bytes have to come from here - either through a privileged scheme of
 * our own (MiMo's mimosf://) or as an IPC reply. The reply wins: it needs no
 * new scheme registered before the app is ready and no connect-src entry, and
 * one 38 MB structured clone per session is nothing next to what FluidSynth
 * does with it afterwards.
 *
 * Nothing is fetched here either. A file that is missing or is not exactly the
 * one the build verified is refused, and the window falls back to its own synth.
 */
/* A verified file is not hashed again while its size and mtime stay the same. */
let verified: { file: string; size: number; mtimeMs: number } | undefined

export async function readSoundfont(file: string, expected: SoundfontExpectation = SOUNDFONT): Promise<SoundfontReply> {
  let stat: { size: number; mtimeMs: number }
  try {
    stat = await fs.stat(file)
  } catch {
    return { ok: false, reason: "missing" }
  }
  if (soundfontProblem({ size: stat.size, sha256: expected.sha256 }, expected) === "size") return { ok: false, reason: "size" }
  let bytes: Buffer
  try {
    bytes = await fs.readFile(file)
  } catch {
    return { ok: false, reason: "unreadable" }
  }
  const known = verified && verified.file === file && verified.size === stat.size && verified.mtimeMs === stat.mtimeMs
  if (!known) {
    const problem = soundfontProblem({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, expected)
    if (problem) return { ok: false, reason: problem }
    verified = { file, size: stat.size, mtimeMs: stat.mtimeMs }
  }
  return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
}
