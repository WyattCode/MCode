import type { Attachment } from "@shared/protocol"

/**
 * Turns files the user hands over - picked, pasted or dropped - into what the
 * protocol carries.
 *
 * All three ways in produce the same `File` objects, so they share this rather
 * than each growing their own idea of what an attachment is.
 */

/**
 * Refused above this, per file.
 *
 * A base64 image is a third larger than the bytes it came from and travels in
 * the prompt itself, so a phone photo dropped in without thinking would push
 * the request past what most models accept before the model ever sees it.
 */
export const MAX_BYTES = 8 * 1024 * 1024

/** Extensions worth reading as text even when the OS reports nothing useful. */
const TEXTUAL = /\.(txt|md|markdown|json|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|jsx?|tsx?|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|env|gitignore|dockerfile|makefile)$/i

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

/** A data URL for playing a video attachment back in the video preview. */
export function videoUrl(attachment: Attachment): string | undefined {
  if (!attachment.mime.startsWith("video/")) return undefined
  const known = previews.get(attachment)
  if (known) return known
  const url = `data:${attachment.mime};base64,${attachment.data}`
  previews.set(attachment, url)
  return url
}

/** A data URL for showing an image attachment back to the user. */
export function preview(attachment: Attachment): string | undefined {
  if (!attachment.mime.startsWith("image/")) return undefined
  const known = previews.get(attachment)
  if (known) return known
  const url = `data:${attachment.mime};base64,${attachment.data}`
  previews.set(attachment, url)
  return url
}
