import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

/*
 * read's media, settled when the file is read: what kind of file it is by its
 * first bytes, and a copy of it kept in the app's data folder, so a picture the
 * model was shown is still that picture when the conversation is sent again
 * after the file changed or went away (MiMo puts the bytes into the result).
 */

/** MiMo's read limit for pictures and PDFs, and for the base64 of a recording or a video. */
export const READ_MEDIA_BYTES = 50 * 1024 * 1024
/** Above this a picture is not even made smaller; between the two it is, when the app can. */
export const READ_IMAGE_SOURCE_BYTES = 150 * 1024 * 1024

/** The media read attaches, by type: MiMo's lists. */
export const READ_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
export const READ_AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg"])
export const READ_VIDEO_TYPES = new Set(["video/mp4"])

const startsWith = (bytes: Uint8Array, prefix: number[], at = 0) => prefix.every((value, index) => bytes[at + index] === value)

/**
 * What a file is by its first bytes, for the seven kinds MiMo recognises that
 * way: PNG, JPEG, GIF, BMP, PDF, WebP and WAV. Anything else is undefined, and
 * the name decides.
 */
export function sniffMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)) return "audio/wav"
  return undefined
}

/** Media types by extension, for a file whose first bytes said nothing: wider than what read attaches, so the rest can be named. */
const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
}

export function mimeByName(file: string): string | undefined {
  const name = path.basename(file)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined
}

/** The kind read gives a file: by its bytes, then by its name. */
export function mediaTypeOf(file: string, head: Uint8Array): string | undefined {
  return sniffMime(head) ?? mimeByName(file)
}

export function looksLikeMedia(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf"
}

/**
 * Keeps the bytes read attached, under the app's data folder, named by what
 * they are so the same picture read twice is kept once. The folder holding a
 * copy carries the file's own name, which is what a request calls it.
 */
export async function keepReadCopy(folder: string, source: string, bytes: Buffer): Promise<string> {
  const digest = createHash("sha256").update(bytes).digest("hex")
  const directory = path.join(folder, digest.slice(0, 2), digest)
  const target = path.join(directory, path.basename(source) || "file")
  const present = await fs.stat(target).then((stat) => stat.size === bytes.length, () => false)
  if (present) return target
  // Owner-only, as pasted pictures are kept: a file the model read can hold anything.
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temp, bytes, { mode: 0o600 })
  await fs.rename(temp, target).catch(async (error) => {
    await fs.rm(temp, { force: true })
    // Another read of the same bytes got there first.
    if (!(await fs.stat(target).then(() => true, () => false))) throw error
  })
  return target
}
