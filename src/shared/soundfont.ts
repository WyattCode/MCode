/**
 * The General MIDI soundfont a reply's ABC score plays through, as MiMo's:
 * MuseScore_General 0.2, the Vorbis-compressed SF3 (MIT). It ships beside the
 * asar in resources/soundfont; the main process hands its bytes to the window
 * only when they are exactly this file.
 *
 * scripts/soundfont.mjs, which puts the file there for a build, carries the same
 * three values; the smoke check fails if the two ever disagree.
 */
export const SOUNDFONT = {
  file: "MuseScore_General.sf3",
  size: 39_900_972,
  sha256: "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3",
} as const

/** The main process's answer to the window's request for the soundfont. */
export type SoundfontReply = { ok: true; bytes: Uint8Array } | { ok: false; reason: "missing" | "size" | "hash" | "unreadable" }

export interface SoundfontExpectation {
  size: number
  sha256: string
}

/** Why a file is not the soundfont, or undefined when it is: the size is checked first, as it costs nothing. */
export function soundfontProblem(found: { size: number; sha256?: string }, expected: SoundfontExpectation = SOUNDFONT): "size" | "hash" | undefined {
  if (found.size !== expected.size) return "size"
  if (found.sha256?.toLowerCase() !== expected.sha256.toLowerCase()) return "hash"
  return undefined
}
