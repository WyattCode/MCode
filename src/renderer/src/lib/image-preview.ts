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
}

export const imagePreview = ref<({ url: string } & ImagePreviewMeta) | undefined>()

export function openImagePreview(url: string, meta: ImagePreviewMeta = {}): void {
  imagePreview.value = { url, ...meta }
}

export function closeImagePreview(): void {
  imagePreview.value = undefined
}
