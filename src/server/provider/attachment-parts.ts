import type { Attachment, ModelModalities } from "@shared/protocol"

/**
 * What a user's attachments become on the wire, decided once for every adapter.
 *
 * MiMo sends only pictures. A picture goes natively where the model reads one
 * and is replaced by a short note where it does not - never as base64 inside
 * the text. Everything else the user attached stays out of the message
 * entirely: its absolute path is in the attachment blocks the turn carries
 * (session/context.ts), and the model reads or opens it from there.
 *
 * A file a tool returned is a different matter and keeps its own rules: what
 * `read` took off the disk is what the model was shown, so a picture, a PDF or
 * audio in a tool result still travels with the result. `source` says which of
 * the two a call is for. The adapters then write the parts in their own shapes.
 */

export type Modality = "image" | "audio" | "video" | "pdf"

export type WirePart =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; data: string }
  | { kind: "pdf"; name: string; data: string }
  | { kind: "audio"; format: string; data: string }
  | { kind: "video"; mime: string; data: string }

/** Which wire the parts are for: what it can carry natively is not the same. */
export type Wire = "anthropic" | "chat" | "responses"

/** An attachment as the loader hands it over: with its data, or with a note saying why it has none. */
export type LoadedAttachment = Attachment & { note?: string }

/**
 * What the message carrying a tool's media says.
 *
 * Anthropic takes pictures inside a `tool_result`; the chat-completions and
 * Responses wires take only text there, so what the model can read follows the
 * result as a message of its own and this line says where it came from.
 */
export const TOOL_MEDIA_NOTE = "The file or files in this message are what the tool call just above returned."

/** MiMo's image cap for Anthropic routes: 4.5 MB and 2000 px on the longest side. */
export const ANTHROPIC_IMAGE_BYTES = 4_500_000
export const ANTHROPIC_IMAGE_PIXELS = 2000

/** What an image has to fit before it is sent. */
export interface ImageFit {
  maxBytes: number
  maxPixels: number
}

/**
 * Whether a picture has to be made smaller before it is sent.
 *
 * MiMo re-encodes an oversized picture rather than dropping it (`compressImage`
 * in its engine, against each provider's caps). This app measures against one
 * conservative pair - the Anthropic route's, the strictest it knows - so a
 * picture that fits them fits every wire it might go out on.
 */
export function imageFit(
  mime: string,
  data: string,
  caps: ImageFit = { maxBytes: ANTHROPIC_IMAGE_BYTES, maxPixels: ANTHROPIC_IMAGE_PIXELS },
): ImageFit | undefined {
  if (!mime.startsWith("image/") || !data) return undefined
  const bytes = Math.floor((data.length * 3) / 4)
  const size = imageSize(decoded(data, 96_000))
  const tooHeavy = bytes > caps.maxBytes
  const tooWide = Boolean(size && Math.max(size.width, size.height) > caps.maxPixels)
  return tooHeavy || tooWide ? caps : undefined
}

/**
 * How a picture is made smaller, when this app can do it at all.
 *
 * The decoder belongs to the desktop process - Electron's `nativeImage` - and
 * not here: this package runs under plain node in the checks, where there is
 * nothing to decode an image with. The desktop registers one at startup; with
 * none, an oversized picture is left as it was and the wire's own note explains
 * why it did not go.
 */
export type ImageShrinker = (input: { data: string; mime: string; fit: ImageFit }) => Promise<{ data: string; mime: string } | undefined>

let shrinker: ImageShrinker | undefined

export function setImageShrinker(fn: ImageShrinker | undefined): void {
  shrinker = fn
}

/** A picture made to fit the given limits, or nothing when this app cannot make it smaller (read's oversized pictures). */
export async function shrunkImage(file: { mime: string; data: string }, fit: ImageFit): Promise<{ mime: string; data: string } | undefined> {
  if (!shrinker) return undefined
  const out = await shrinker({ data: file.data, mime: file.mime, fit }).catch(() => undefined)
  return out && Math.floor((out.data.length * 3) / 4) <= fit.maxBytes ? out : undefined
}

/** The picture as it should be sent: smaller when it has to be and can be, and nothing when it is already fine. */
export async function fittedImage(file: { mime: string; data: string }): Promise<{ mime: string; data: string } | undefined> {
  const fit = imageFit(file.mime, file.data)
  if (!fit || !shrinker) return undefined
  const out = await shrinker({ data: file.data, mime: file.mime, fit }).catch(() => undefined)
  // The shrinker's promise is its best effort, not a guarantee: verify the
  // result against the same limit as shrunkImage, or an oversized picture
  // rides to the provider and gets the whole request refused.
  return out && Math.floor((out.data.length * 3) / 4) <= fit.maxBytes ? out : undefined
}

const AUDIO_FORMATS: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/flac": "flac", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg" }
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-msvideo", "video/x-ms-wmv"])
const TEXT_TYPES = /^text\/|^application\/(?:json|xml|x-yaml|yaml|toml|javascript|x-directory)$/

export function modalityOf(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

function nameOf(file: Attachment): string {
  return file.path.split(/[\\/]/).pop() || file.path
}

const WORD: Record<Modality, string> = { image: "image", audio: "audio", video: "video", pdf: "PDF" }

/** The width and height of a PNG, GIF, JPEG or WebP, read from its first bytes. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes.length >= 10 && ascii(0, 3) === "GIF") return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4)
    if (chunk === "VP8X") return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) }
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined
      const marker = bytes[at + 1]!
      const length = view.getUint16(at + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) }
      }
      at += 2 + length
    }
  }
  return undefined
}

function decoded(data: string, limit: number): Uint8Array {
  return Uint8Array.from(Buffer.from(data.slice(0, limit), "base64"))
}

/** The line that says an attached file arrives as a read the app already made for the model. */
export function readFraming(target: string): string {
  return `The read tool was called for you with {"file_path": "${target}"}, and returned:`
}

/** Whose files these are: what the user attached, or what a tool's result carried back. */
export type PartSource = "user" | "tool"

export function attachmentParts(
  attachments: readonly Attachment[],
  inputs: Partial<ModelModalities> | undefined,
  wire: Wire,
  source: PartSource = "tool",
): WirePart[] {
  const parts: WirePart[] = []
  for (const file of attachments as readonly LoadedAttachment[]) {
    const name = nameOf(file)
    if (file.note) {
      parts.push({ kind: "text", text: file.note })
      continue
    }
    const modality = modalityOf(file.mime)
    /*
     * What the user attached and the model cannot see natively stays out of the
     * message: the turn's attachment blocks name it by absolute path and say
     * what opens it, which is what lets the model read a file at the size it
     * really is rather than a truncated copy of it.
     */
    if (source === "user" && modality !== "image") continue
    if (TEXT_TYPES.test(file.mime)) {
      /*
       * Framed as a read the app already made, as MiMo's engine frames one: it
       * runs the read tool for a text file a tool returned and injects the call
       * and its output rather than pasting the text in. The difference is not
       * cosmetic - a model that reads an inline block does not believe it has
       * read the file, so it reads it again before editing, at full cost.
       */
      parts.push({ kind: "text", text: `${readFraming(file.path)}\n<file path="${file.path}">\n${file.data}\n</file>` })
      continue
    }
    if (!modality) {
      parts.push({ kind: "text", text: `[${name} was attached. It is at ${file.path} and is not a kind of file that can be put in a message; open it with a tool if it is needed.]` })
      continue
    }
    if (modality === "image" && !file.data) {
      parts.push({ kind: "text", text: `[${name} was attached, but the image is empty or damaged, so it was not sent.]` })
      continue
    }
    if (!inputs?.[modality]) {
      parts.push({ kind: "text", text: `[${name} was attached, but this model cannot read ${WORD[modality]} input, so the file was not sent. Tell the user it could not be read.]` })
      continue
    }
    const unsendable = () =>
      parts.push({ kind: "text", text: `[${name} was attached, but ${WORD[modality]} cannot be sent to this provider, so the file was not sent. Tell the user it could not be read.]` })
    if (modality === "image") {
      if (wire === "anthropic") {
        const bytes = Math.floor((file.data.length * 3) / 4)
        const size = imageSize(decoded(file.data, 96_000))
        if (bytes > ANTHROPIC_IMAGE_BYTES || (size && Math.max(size.width, size.height) > ANTHROPIC_IMAGE_PIXELS)) {
          parts.push({ kind: "text", text: `[Image omitted: ${name}, a ${bytes}-byte image, exceeds this provider's limits of 4.5 MB and 2000 pixels.]` })
          continue
        }
      }
      parts.push({ kind: "image", mime: file.mime, data: file.data })
    } else if (modality === "pdf") {
      parts.push({ kind: "pdf", name, data: file.data })
    } else if (modality === "audio") {
      const format = AUDIO_FORMATS[file.mime]
      if (wire === "chat" && format) parts.push({ kind: "audio", format, data: file.data })
      else unsendable()
    } else {
      if (wire === "chat" && VIDEO_TYPES.has(file.mime)) parts.push({ kind: "video", mime: file.mime, data: file.data })
      else unsendable()
    }
  }
  return parts
}
