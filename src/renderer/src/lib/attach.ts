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

/** A data URL for showing an image attachment back to the user. */
export function preview(attachment: Attachment): string | undefined {
  if (!attachment.mime.startsWith("image/")) return undefined
  const known = previews.get(attachment)
  if (known) return known
  const url = `data:${attachment.mime};base64,${attachment.data}`
  previews.set(attachment, url)
  return url
}

/**
 * Splits a data: URL into its type and its bytes.
 *
 * Decoded rather than fetched: a page's connect-src governs fetch, and this app
 * allows data: as an image source but not as something to connect to - so
 * fetching the URL an image dragged out of its own transcript hands over comes
 * back as a bare "Failed to fetch". The bytes are in the string already.
 */
export function fromDataURL(link: string): { mime: string; bytes: Uint8Array<ArrayBuffer> } | undefined {
  if (!link.startsWith("data:")) return undefined
  const comma = link.indexOf(",")
  if (comma < 0) return undefined

  const header = link.slice("data:".length, comma)
  const payload = link.slice(comma + 1)
  const base64 = /;base64$/i.test(header)
  const mime = header.replace(/;base64$/i, "").split(";")[0] || "text/plain"

  try {
    const text = base64 ? atob(payload) : decodeURIComponent(payload)
    return { mime, bytes: Uint8Array.from(text, (character) => character.charCodeAt(0)) }
  } catch {
    // A truncated or mangled payload; the caller says so rather than throwing.
    return undefined
  }
}

/** The URL a drop is pointing at, whichever flavour the source offered. */
export function linkFrom(transfer: DataTransfer): string | undefined {
  // A uri-list may hold several lines and comments; the first URL is the one.
  const fromList = transfer
    .getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"))
  if (fromList) return fromList

  // Chat windows and editors often hand over the markup instead.
  const src = /<img[^>]+src\s*=\s*["\']([^"\']+)["\']/i.exec(transfer.getData("text/html"))?.[1]
  if (src) return src

  const plain = transfer.getData("text/plain").trim()
  return /^(https?:|data:|blob:)/i.test(plain) ? plain : undefined
}

/** Keeps an extension on the name, so the type can still be told from it. */
const EXTENSIONS: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "text/csv": "csv",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "application/json": "json",
}

export function nameFor(name: string, mime: string): string {
  if (name.includes(".")) return name
  const extension = EXTENSIONS[mime] ?? mime.split("/")[1]?.split("+")[0]
  return extension ? `${name}.${extension}` : name
}
