import fs from "node:fs/promises"
import path from "node:path"
import type { Attachment, Message } from "@shared/protocol"
import { kindFor, mimeFor } from "../media"
import type { LoadedAttachment } from "../provider/attachment-parts"

/**
 * Files attached by path, as MiMo attaches them: the message carries the path,
 * and the file is read from disk each time a request is built. Nothing about
 * the file's size limits what can be attached; what a request carries of it is
 * limited instead, as MiMo's read of a text file is.
 */

/** A text file is sent up to this much, with a note saying where the rest is. */
export const INLINE_TEXT_BYTES = 50 * 1024

/** Media larger than this is not put into a request (MiMo's media ceiling). */
export const MEDIA_BYTES = 20 * 1024 * 1024

const VIDEO: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", webm: "video/webm", mkv: "video/x-matroska" }

function resolved(file: Attachment, directory: string): string {
  return path.isAbsolute(file.path) ? file.path : path.resolve(directory, file.path)
}

/** What an attached file is, read off the disk: a folder, text, media, or some other file. */
async function mimeOf(target: string): Promise<string> {
  const stat = await fs.stat(target)
  if (stat.isDirectory()) return "application/x-directory"
  const extension = path.extname(target).slice(1).toLowerCase()
  if (VIDEO[extension]) return VIDEO[extension]!
  const handle = await fs.open(target, "r")
  try {
    const head = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const kind = kindFor(target, head.subarray(0, bytesRead))
    if (kind === "text") return "text/plain"
    if (kind === "binary") return "application/octet-stream"
    return mimeFor(target) ?? "application/octet-stream"
  } finally {
    await handle.close()
  }
}

/** Fills in what each file attached by path is, as the message is sent. A file that cannot be read keeps an empty type. */
export async function settleAttachments(list: Attachment[] | undefined, directory: string): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const file of list ?? []) {
    if (!file.byPath || file.mime) {
      out.push(file)
      continue
    }
    out.push({ ...file, mime: await mimeOf(resolved(file, directory)).catch(() => "") })
  }
  return out
}

export type AttachmentCache = Map<string, LoadedAttachment>

async function load(file: Attachment, directory: string): Promise<LoadedAttachment> {
  const target = resolved(file, directory)
  try {
    const mime = file.mime || (await mimeOf(target))
    if (mime === "application/x-directory") {
      const entries = await fs.readdir(target, { withFileTypes: true })
      const names = entries
        .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
        .sort()
        .slice(0, 200)
      return { ...file, mime, data: names.join("\n") }
    }
    if (mime.startsWith("text/")) {
      const handle = await fs.open(target, "r")
      try {
        const buffer = Buffer.alloc(INLINE_TEXT_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const size = (await handle.stat()).size
        const text = buffer.subarray(0, bytesRead).toString("utf8")
        const rest = size > bytesRead ? `\n[... the file continues past ${INLINE_TEXT_BYTES / 1024} KB; read the rest of ${target} with the read tool]` : ""
        return { ...file, mime, data: text + rest }
      } finally {
        await handle.close()
      }
    }
    if (/^(image|audio|video)\/|^application\/pdf$/.test(mime)) {
      const size = (await fs.stat(target)).size
      if (size > MEDIA_BYTES) {
        return { ...file, mime, data: "", note: `[${path.basename(target)} was attached, but at ${size} bytes it is too large to put into a request, so it was not sent. Tell the user.]` }
      }
      return { ...file, mime, data: (await fs.readFile(target)).toString("base64") }
    }
    return { ...file, mime, data: "" }
  } catch (err) {
    return { ...file, data: "", note: `[${file.path} was attached but could not be read: ${(err as Error).message}]` }
  }
}

/**
 * The history with every file attached by path read in. Within one turn a file
 * is read once; the stored messages are not changed.
 */
export async function withAttachmentData(history: Message[], directory: string, cache: AttachmentCache): Promise<Message[]> {
  if (!history.some((message) => message.role === "user" && message.attachments?.some((file) => file.byPath))) return history
  const out: Message[] = []
  for (const message of history) {
    if (message.role !== "user" || !message.attachments?.some((file) => file.byPath)) {
      out.push(message)
      continue
    }
    const attachments: Attachment[] = []
    for (const file of message.attachments) {
      if (!file.byPath) {
        attachments.push(file)
        continue
      }
      const key = resolved(file, directory)
      let loaded = cache.get(key)
      if (!loaded) {
        loaded = await load(file, directory)
        cache.set(key, loaded)
      }
      attachments.push({ ...loaded, path: file.path })
    }
    out.push({ ...message, attachments })
  }
  return out
}
