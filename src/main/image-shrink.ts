import { nativeImage } from "electron"
import type { ImageShrinker } from "../server/provider/attachment-parts"

/**
 * MiMo's oversized-picture handling, done where this app has a decoder.
 *
 * Its engine measures a picture against the provider's caps and re-encodes one
 * that is over them rather than letting it be dropped. Only the desktop process
 * can decode an image here (Electron's `nativeImage`), so the backend asks for
 * this through a hook and simply goes without it in the checks, which run the
 * backend under plain node.
 *
 * The picture is scaled to the pixel cap first, then written as JPEG with the
 * quality stepped down until it is under the byte cap. JPEG carries no
 * transparency, which is the price of it fitting at all; MiMo re-encodes the
 * same way.
 */
const QUALITIES = [85, 70, 55, 40]

export const shrinkImage: ImageShrinker = async ({ data, mime, fit }) => {
  // An animation would come back as a single frame, which is worse than the note saying it did not fit.
  if (mime === "image/gif") return undefined
  const source = nativeImage.createFromBuffer(Buffer.from(data, "base64"))
  if (source.isEmpty()) return undefined
  const { width, height } = source.getSize()
  if (!width || !height) return undefined
  const scaled =
    Math.max(width, height) > fit.maxPixels
      ? source.resize(width >= height ? { width: fit.maxPixels } : { height: fit.maxPixels })
      : source
  for (const quality of QUALITIES) {
    const bytes = scaled.toJPEG(quality)
    if (bytes.length > 0 && bytes.length <= fit.maxBytes) return { data: bytes.toString("base64"), mime: "image/jpeg" }
  }
  return undefined
}
