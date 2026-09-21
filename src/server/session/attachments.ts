import fs from "node:fs/promises"
import path from "node:path"
import type { AssistantPart, Attachment, Message } from "@shared/protocol"
import { kindFor, mimeFor } from "../media"
import { fittedImage, type LoadedAttachment } from "../provider/attachment-parts"
import { READ_MEDIA_BYTES, sniffMime } from "../tool/read-media"

/**
 * Files attached by path, as MiMo attaches them: the message carries the path,
 * and nothing about the file's size limits what can be attached.
 *
 * Of what the user attached, only a picture is ever read into the request - the
 * rest is named by absolute path in the turn's attachment blocks and read by
 * the model itself. What a tool's result carried is read here in full, because
 * what the tool showed the model is what the model must go on seeing.
 */

/** A text file a tool returned is sent up to this much, with a note saying where the rest is. */
export const INLINE_TEXT_BYTES = 50 * 1024

/** Media larger than this is not put into a request (MiMo's media ceiling). */
export const MEDIA_BYTES = 20 * 1024 * 1024

const VIDEO: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", webm: "video/webm", mkv: "video/x-matroska" }

function resolved(file: Attachment, directory: string): string {
  return path.isAbsolute(file.path) ? file.path : path.resolve(directory, file.path)
}

/**
 * What an attached file is, read off the disk: a folder, text, media, or some
 * other file. The first bytes decide before the name does, as MiMo's do, so a
 * JPEG saved as .png is sent as the JPEG it is rather than refused by the
 * provider for claiming to be something else.
 */
async function mimeOf(target: string): Promise<string> {
  const stat = await fs.stat(target)
  if (stat.isDirectory()) return "application/x-directory"
  const handle = await fs.open(target, "r")
  try {
    const head = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const sniffed = sniffMime(head.subarray(0, bytesRead))
    if (sniffed) return sniffed
    const extension = path.extname(target).slice(1).toLowerCase()
    if (VIDEO[extension]) return VIDEO[extension]!
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

async function load(file: Attachment, directory: string, forUser: boolean): Promise<LoadedAttachment> {
  // A tool's copy, taken when it read the file, stands for the file; read already held it to its own limit.
  const target = file.copy ?? resolved(file, directory)
  const limit = file.copy ? READ_MEDIA_BYTES : MEDIA_BYTES
  try {
    const mime = file.mime || (await mimeOf(target))
    /*
     * Nothing but a picture is read for the user's own attachment. Its path is
     * in the turn's attachment blocks, and the model reads the file itself -
     * which is the only way it sees all of a large one. Reading it here would
     * cost the bytes twice and hand over a truncated copy besides.
     */
    if (forUser && !mime.startsWith("image/")) return { ...file, mime, data: "" }
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
      if (size > limit) {
        return { ...file, mime, data: "", note: `[${path.basename(target)} was attached, but at ${size} bytes it is too large to put into a request, so it was not sent. Tell the user.]` }
      }
      const data = (await fs.readFile(target)).toString("base64")
      /*
       * MiMo makes an oversized picture smaller rather than letting the wire
       * drop it. Where there is no decoder - the checks, which run this under
       * plain node - it goes as it was and the wire says why it did not fit.
       */
      const fitted = await fittedImage({ mime, data })
      return { ...file, mime: fitted?.mime ?? mime, data: fitted?.data ?? data }
    }
    return { ...file, mime, data: "" }
  } catch (err) {
    return { ...file, data: "", note: `[${file.path} was attached but could not be read: ${(err as Error).message}]` }
  }
}

/**
 * The history with every file attached by path read in - what the user
 * attached, and what a tool's result carries. Within one turn a file is read
 * once; the stored messages are not changed.
 */
export async function withAttachmentData(history: Message[], directory: string, cache: AttachmentCache): Promise<Message[]> {
  const byPath = (list: readonly Attachment[] | undefined) => Boolean(list?.some((file) => file.byPath))
  const carries = (message: Message) =>
    message.role === "user" ? byPath(message.attachments) : message.parts.some((part) => part.type === "tool" && byPath(part.attachments))
  if (!history.some(carries)) return history

  const read = async (list: readonly Attachment[], forUser: boolean): Promise<Attachment[]> => {
    const out: Attachment[] = []
    for (const file of list) {
      if (!file.byPath) {
        out.push(file)
        continue
      }
      // The same file can be both a user's attachment and a tool's result, and the two are read differently.
      const key = `${forUser ? "u" : "t"}:${file.copy ?? resolved(file, directory)}`
      let loaded = cache.get(key)
      if (!loaded) {
        loaded = await load(file, directory, forUser)
        cache.set(key, loaded)
      }
      out.push({ ...loaded, path: file.path })
    }
    return out
  }

  const out: Message[] = []
  for (const message of history) {
    if (!carries(message)) {
      out.push(message)
      continue
    }
    if (message.role === "user") {
      out.push({ ...message, attachments: await read(message.attachments ?? [], true) })
      continue
    }
    const parts: AssistantPart[] = []
    for (const part of message.parts) {
      parts.push(part.type === "tool" && byPath(part.attachments) ? { ...part, attachments: await read(part.attachments ?? [], false) } : part)
    }
    out.push({ ...message, parts })
  }
  return out
}
