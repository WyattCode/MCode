/**
 * What a file is, before deciding how to show it.
 *
 * The reference splits a preview four ways - text, image, audio and binary -
 * and this classifies the same four. Extension first because it is cheap and
 * decides the two that carry bytes; a sniff of the head settles the rest,
 * since plenty of files worth reading have no extension at all (`Makefile`,
 * `.gitignore`, a shell script) and plenty of binaries share one with a text
 * format.
 */
export type FileKind = "text" | "image" | "audio" | "binary"

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"])
const AUDIO = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"])

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
}

/* Either separator, because a path from Windows carries the other one. */
const SEPARATORS = /[\/]/

function extensionOf(filePath: string) {
  const name = filePath.split(SEPARATORS).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
}

export function mimeFor(filePath: string) {
  return MIME[extensionOf(filePath)]
}

/**
 * Whether a run of bytes is text.
 *
 * A NUL byte is the giveaway - no encoding this app will ever show uses one -
 * and past that it is the proportion of bytes that no text file has any reason
 * to carry. UTF-8 multibyte sequences live above 0x7f, so counting anything
 * high as suspicious would call every Chinese source file binary; only the
 * control range below 0x20 counts, minus the three that are ordinary.
 */
export function looksBinary(head: Buffer) {
  if (head.length === 0) return false
  let odd = 0
  for (const byte of head) {
    if (byte === 0) return true
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) odd += 1
  }
  return odd / head.length > 0.3
}

export function kindFor(filePath: string, head: Buffer): FileKind {
  const extension = extensionOf(filePath)
  // SVG is an image by extension and text by content; the reference shows it,
  // so the picture wins.
  if (IMAGE.has(extension)) return "image"
  if (AUDIO.has(extension)) return "audio"
  return looksBinary(head) ? "binary" : "text"
}
