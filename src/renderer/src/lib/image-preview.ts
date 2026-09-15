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
  /** The picture's file on disk, when it has one: adds "copy image" and "show in folder" (keys C and F), as MiMo does. */
  path?: string
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

export type ImagePreviewAction = "close" | "previous" | "next" | "zoomIn" | "zoomOut" | "reset" | "rotate" | "download" | "copy" | "reveal"

/** What a key does in the preview; copy and reveal only exist for a picture with a file behind it. */
export function imagePreviewKey(key: string, hasPath: boolean): ImagePreviewAction | undefined {
  switch (key) {
    case "Escape":
      return "close"
    case "ArrowLeft":
      return "previous"
    case "ArrowRight":
      return "next"
    case "+":
    case "=":
      return "zoomIn"
    case "-":
    case "_":
      return "zoomOut"
    case "0":
      return "reset"
    case "r":
    case "R":
      return "rotate"
    case "d":
    case "D":
      return "download"
    case "c":
    case "C":
      return hasPath ? "copy" : undefined
    case "f":
    case "F":
      return hasPath ? "reveal" : undefined
    default:
      return undefined
  }
}

/** The bar's tools after the divider, in MiMo's order. */
export function imagePreviewFileTools(hasPath: boolean): ImagePreviewAction[] {
  return hasPath ? ["download", "copy", "reveal"] : ["download"]
}
