import { ref } from "vue"

/**
 * The one image preview the window shows at a time, as MiMo keeps one: whoever
 * wants a picture looked at hands its address here, and ImagePreview draws it.
 */
export interface ImagePreviewMeta {
  /** What a download is called. */
  name?: string
  /** The other pictures it sits with, in order, so the arrow keys can step through them. */
  group?: string[]
  /** Where the clicked thumbnail was on screen, so the preview can zoom out of it and back into it. */
  rect?: PreviewRect
}

export interface PreviewRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * MiMo's zoom from a thumbnail: the translate between the two centres and a
 * uniform scale by the width ratio. Without an origin, or with nothing to
 * measure, it is a plain 94% scale.
 */
export function originTransform(from: PreviewRect | undefined, to: PreviewRect | undefined): string {
  if (!from || !to || !from.width || !to.width) return "scale(0.94)"
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(from.width / to.width).toFixed(4)})`
}

export const imagePreview = ref<({ url: string } & ImagePreviewMeta) | undefined>()

/** A video being previewed: its address, and the file on disk when it has one (an attachment has none). */
export const videoPreview = ref<{ url: string; path?: string; name?: string } | undefined>()

export function openImagePreview(url: string, meta: ImagePreviewMeta = {}): void {
  videoPreview.value = undefined
  imagePreview.value = { url, ...meta }
}

export function closeImagePreview(): void {
  imagePreview.value = undefined
}

/** MiMo keeps one preview slot: a video replaces whatever picture is showing, and the other way round. */
export function openVideoPreview(url: string, meta: { path?: string; name?: string } = {}): void {
  imagePreview.value = undefined
  videoPreview.value = { url, ...meta }
}

export function closeVideoPreview(): void {
  videoPreview.value = undefined
}
