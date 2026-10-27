/**
 * Text onto the system clipboard, written by the main process.
 *
 * The page's own `navigator.clipboard.writeText` refuses a document that is
 * not focused - which is exactly when a copy button gets pressed: a click
 * that also moved focus, an assistive tool working a window behind others.
 * The main process's write has no such condition, so it goes first and the
 * page API stays as the fallback for a bridge that is somehow absent.
 */
export async function writeText(text: string): Promise<void> {
  try {
    window.mcode.setClipboardText(text)
  } catch {
    await navigator.clipboard.writeText(text)
  }
}
