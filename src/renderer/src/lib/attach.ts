import { textualName } from "@shared/attachment-kind"
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
 * The cap as the notice names it.
 *
 * Written from the constant rather than into eighteen language tables: they
 * said 8 MB for as long as the cap was 50, because the number had been copied
 * in by hand and the constant moved without them.
 */
export const MAX_LABEL = `${Math.round(MAX_BYTES / (1024 * 1024))} MB`

/**
 * The most a file on disk may weigh and still have its bytes carried too.
 *
 * MiMo's desktop picker reads a picture under 8 MB into a data URL beside the
 * path and passes anything larger by path alone. Here the bytes are only ever
 * for the thumbnail beside the box - the model is served from the path either
 * way - so a large picture keeps its path and loses nothing but the preview.
 */
export const THUMBNAIL_MAX = 8 * 1024 * 1024

/**
 * Whether a drag carries something to attach.
 *
 * Files and a `text/uri-list` only, as MiMo reads a drag: plain text dragged
 * into the box is the browser's business, not this app's. The window's overlay
 * and the box's own ring asked two different questions before this, so dragging
 * a word lit one and not the other.
 */
export function acceptsDrop(types: readonly string[] | DOMStringList | undefined): boolean {
  const list = types ? [...types].map((type) => type.toLowerCase()) : []
  return list.includes("files") || list.includes("text/uri-list")
}

/**
 * Whether a drag event's pointer has left the window.
 *
 * `dragleave` fires with a null `relatedTarget` inside the window as well in
 * Chromium, so the clean-up it drove ran while the drag was still going and
 * only a following `dragover` put the indicator back.
 */
export function outsideWindow(event: { clientX: number; clientY: number }): boolean {
  return event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
}

/**
 * The files a `text/uri-list` names, as absolute paths.
 *
 * One URI per line, `#` comments skipped. Windows arrives as `file:///C:/x`,
 * whose path part keeps a leading slash that has to come off before it names a
 * real file - MiMo leaves it on, and the path it builds exists nowhere.
 */
export function uriListPaths(list: string): string[] {
  const out: string[] = []
  for (const line of list.split(/\r?\n/)) {
    const uri = line.trim()
    if (!uri || uri.startsWith("#") || !/^file:/i.test(uri)) continue
    let target = uri.replace(/^file:\/{2,3}/i, "")
    try {
      target = decodeURIComponent(target)
    } catch {
      // A name with a stray % is taken as written rather than dropped.
    }
    if (/^\/[a-z]:/i.test(target)) target = target.slice(1)
    if (target) out.push(target)
  }
  return out
}

/**
 * A dragged `data:` address, turned into the file it carries.
 *
 * Dragging a picture out of a conversation - this app's own, or a chat in a
 * browser - hands over an address rather than a file, and `uriListPaths` reads
 * only `file:`. So the drop was accepted, the ring lit, the browser's own
 * handling was suppressed, and then nothing happened at all: no attachment and
 * no word about why (R25-#11, carried over from the audit of PR #3).
 *
 * Decoded here rather than fetched, because `connect-src` forbids the window
 * fetching anything - including a `data:` address - and this is the shape the
 * app's own conversation hands over.
 */
export function dataUriFile(uri: string, name: string): File | undefined {
  const head = /^data:([^;,]*)(;[^,]*)?,/i.exec(uri)
  if (!head) return undefined
  const type = head[1] || "application/octet-stream"
  const body = uri.slice(head[0].length)
  try {
    let bytes: Uint8Array
    if ((head[2] ?? "").toLowerCase().includes(";base64")) {
      const binary = atob(body)
      bytes = new Uint8Array(binary.length)
      for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body))
    }
    if (!bytes.length) return undefined
    const extension = /^image\/(png|jpeg|gif|webp|svg\+xml)$/i.exec(type)?.[1]?.replace("svg+xml", "svg") ?? ""
    return new File([bytes as BlobPart], extension ? `${name}.${extension}` : name, { type })
  } catch {
    // A malformed address is not an attachment; the caller says so rather than dropping it silently.
    return undefined
  }
}

/** Addresses in a `text/uri-list` that are neither `file:` nor `data:` - a web address, which this window may not fetch. */
export function uriListRemote(list: string): string[] {
  const out: string[] = []
  for (const line of list.split(/\r?\n/)) {
    const uri = line.trim()
    if (!uri || uri.startsWith("#")) continue
    if (/^(file|data):/i.test(uri)) continue
    out.push(uri)
  }
  return out
}

/** The `data:` addresses in a `text/uri-list`, in order. */
export function uriListData(list: string): string[] {
  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((uri) => uri.length > 0 && !uri.startsWith("#") && /^data:/i.test(uri))
}

/** Where a file lives on disk, or empty for one that does not (pasted, or outside the app). */
function diskPath(file: File): string {
  try {
    return (globalThis as { mcode?: { pathForFile?: (file: File) => string } }).mcode?.pathForFile?.(file) ?? ""
  } catch {
    return ""
  }
}

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
 * attach: a text file under the cap.
 *
 * An empty file counts. MiMo fills in a dropped file's `text` from whatever it
 * read, and an empty string is still text, so a freshly created file in the
 * project becomes a mention there rather than a nameless attachment.
 */
export function mentionable(file: File): boolean {
  return isTextual(file) && file.size < MENTION_MAX
}

export function isTextual(file: File): boolean {
  if (file.type.startsWith("text/")) return true
  if (/^application\/(json|xml|x-yaml|toml)$/.test(file.type)) return true
  // A file the OS has no opinion about is read as text if its name suggests it.
  return !file.type && textualName(file.name)
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
    if (absolute) {
      /*
       * MiMo's attachment by path: no copy in the message, no size cap. A
       * picture or a video small enough to preview also carries its bytes, but
       * only so the box can draw a thumbnail - `byPath` keeps the model served
       * from the path, and the draft on disk drops the bytes again.
       */
      const thumbnailed = (file.type.startsWith("image/") || file.type.startsWith("video/")) && file.size <= THUMBNAIL_MAX
      let data = ""
      if (thumbnailed) {
        try {
          data = await base64(file)
        } catch {
          // A thumbnail is worth nothing next to the path; attach it without one.
        }
      }
      attachments.push({ path: absolute, mime: file.type, data, byPath: true })
      continue
    }
    /*
     * A picture with no file behind it - pasted from the clipboard - is written
     * to disk first, as MiMo writes one, and then attached by path: it can be
     * opened and located afterwards, it carries the name it was written under
     * rather than a made-up one, and no cap applies to it. Its bytes are kept
     * beside the path for the thumbnail.
     */
    if (file.type.startsWith("image/")) {
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
