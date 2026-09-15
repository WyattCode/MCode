import { ref } from "vue"

/**
 * The one image preview the window shows at a time, as MiMo keeps one: whoever
 * wants a picture looked at hands its address here, and ImagePreview draws it.
 */
export interface ImagePreviewMeta {
  /** What a download is called. */
  name?: string
  /** The file on disk, when the picture is one; the previews branch adds copy and reveal for it. */
  path?: string
  /** The other pictures it sits with, in order, so the arrow keys can step through them. */
  group?: string[]
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
