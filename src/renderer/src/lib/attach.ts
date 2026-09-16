import type { Attachment } from "@shared/protocol"

/**
 * Turns files the user hands over - picked, pasted or dropped - into what the
 * protocol carries.
 *
 * All three ways in produce the same `File` objects, so they share this rather
 * than each growing their own idea of what an attachment is.
 */

/**
 * The most a file carried inside the message may weigh.
 *
 * MiMo attaches a file by its path, so a file on disk has no cap: it goes by
 * path and the server reads it when the model is asked. Only what has no path
 * - something pasted from the clipboard - travels as data.
 *
 * MiMo's engine takes an attachment up to 50 MB, and this used to refuse at 8;
 * pasting a 12 MB log into the box was turned away with a "too large" notice
 * that MiMo would never have shown.
 */
export const MAX_BYTES = 50 * 1024 * 1024

/**
 * The most a file on disk may weigh and still have its bytes carried too.
 *
 * MiMo's desktop picker inlines a picture under 8 MB as a data URL and passes
 * anything larger by path alone. Here the bytes are only ever for the
 * thumbnail beside the box - the model is served from the path either way - so
 * a large picture keeps its path and loses nothing but the preview.
 */
export const THUMBNAIL_MAX = 8 * 1024 * 1024

/** Where a file lives on disk, or empty for one that does not (pasted, or outside the app). */
function diskPath(file: File): string {
  try {
    return (globalThis as { mcode?: { pathForFile?: (file: File) => string } }).mcode?.pathForFile?.(file) ?? ""
  } catch {
    return ""
  }
}

/** Extensions worth reading as text even when the OS reports nothing useful. */
const TEXTUAL = /\.(txt|md|markdown|json|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|jsx?|tsx?|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|env|gitignore|dockerfile|makefile)$/i

/**
 * The most a dropped file may weigh and still be named rather than sent.
 *
 * MiMo's main process fills in a dropped file's `text` only for text-like
 * extensions under 256KB, and the drop then turns exactly those - inside the
 * project - into `@path` mentions.
 */
export const MENTION_MAX = 256 * 1024

/**
 * Whether a dropped file is one MiMo would turn into an @mention rather than
 * attach: a text file, with something in it, under the cap.
 */
export function mentionable(file: File): boolean {
  return isTextual(file) && file.size > 0 && file.size < MENTION_MAX
}

export function isTextual(file: File): boolean {
  if (file.type.startsWith("text/")) return true
  if (/^application\/(json|xml|x-yaml|toml)$/.test(file.type)) return true
  // A file the OS has no opinion about is read as text if its name suggests it.
  return !file.type && TEXTUAL.test(file.name)
}

async function base64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  // Chunked: spreading a multi-megabyte array into String.fromCharCode at once
  // overruns the argument limit and throws.
  let binary = ""
  for (let at = 0; at < buffer.length; at += 8192) {
    binary += String.fromCharCode(...buffer.subarray(at, at + 8192))
  }
  return btoa(binary)
}

export interface Rejected {
  name: string
  reason: "too-large" | "unreadable"
}

export interface Taken {
  attachments: Attachment[]
  rejected: Rejected[]
}

/**
 * Reads what it can and says what it could not.
 *
 * A file that is refused is named rather than dropped in silence: the user
 * chose it deliberately and would otherwise be left wondering.
 */
export async function readFiles(files: readonly File[]): Promise<Taken> {
  const attachments: Attachment[] = []
  const rejected: Rejected[] = []

  for (const file of files) {
    const absolute = diskPath(file)
    const thumbnailed = (file.type.startsWith("image/") || file.type.startsWith("video/")) && file.size <= THUMBNAIL_MAX
    if (absolute && !thumbnailed) {
      // MiMo's attachment by path: no copy in the message, no size cap.
      attachments.push({ path: absolute, mime: file.type, data: "", byPath: true })
      continue
    }
    /*
     * A picture with no file behind it - pasted from the clipboard - is written
     * to disk first, as MiMo writes one, and then attached by path: it can be
     * opened and located afterwards, it carries the name it was written under
     * rather than a made-up one, and no cap applies to it. Its bytes are kept
     * beside the path for the thumbnail.
     */
    if (!absolute && file.type.startsWith("image/")) {
      try {
        const data = await base64(file)
        const saved = await window.mcode.savePastedImage(`data:${file.type};base64,${data}`)
        if (saved.ok) {
          attachments.push({ path: saved.path, mime: file.type, data, byPath: true })
          continue
        }
      } catch {
        // The in-memory attachment below is the fallback.
      }
    }
    if (file.size > MAX_BYTES) {
      rejected.push({ name: file.name, reason: "too-large" })
      continue
    }
    try {
      const textual = isTextual(file)
      attachments.push({
        // Pasted images arrive without a name; the model is told what it is.
        path: file.name || `pasted-${Date.now()}.png`,
        mime: file.type || (textual ? "text/plain" : "application/octet-stream"),
        data: textual ? await file.text() : await base64(file),
      })
    } catch {
      rejected.push({ name: file.name, reason: "unreadable" })
    }
  }

  return { attachments, rejected }
}

/**
 * Built once per attachment.
 *
 * The template asks for this while deciding what to draw and again for the src,
 * on every render - and each call joins the whole base64 payload, which for a
 * photograph is megabytes. Weakly keyed, so it goes when the attachment does.
 */
const previews = new WeakMap<Attachment, string>()

/** A data URL for playing a video attachment back in the video preview; one restored by path alone has no bytes to play. */
export function videoUrl(attachment: Attachment): string | undefined {
  if (!attachment.mime.startsWith("video/") || !attachment.data) return undefined
  const known = previews.get(attachment)
  if (known) return known
  const url = `data:${attachment.mime};base64,${attachment.data}`
  previews.set(attachment, url)
  return url
}

/**
 * A data URL for showing an image attachment back to the user.
 *
 * A draft restored from disk carries a file by its path and no bytes, as MiMo
 * saves it; without them there is no thumbnail to draw, and the box shows the
 * file as a capsule with its name instead of an empty picture.
 */
export function preview(attachment: Attachment): string | undefined {
  if (!attachment.mime.startsWith("image/") || !attachment.data) return undefined
  const known = previews.get(attachment)
  if (known) return known
  const url = `data:${attachment.mime};base64,${attachment.data}`
  previews.set(attachment, url)
  return url
}
