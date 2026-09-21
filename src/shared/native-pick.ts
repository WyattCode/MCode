/**
 * What a native file or folder dialog answers while another one is already
 * open. MiMo 26.920 lets one native dialog up at a time and, instead of
 * answering a second ask with nothing, answers `{ busy: true }`, so the window
 * can tell a refused ask from a cancelled one and say why nothing opened.
 */
export interface PickerBusy {
  busy: true
}

export const PICKER_BUSY: PickerBusy = Object.freeze({ busy: true as const })

export function isPickerBusy(value: unknown): value is PickerBusy {
  return typeof value === "object" && value !== null && (value as { busy?: unknown }).busy === true
}
