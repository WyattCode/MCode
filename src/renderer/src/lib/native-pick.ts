import { isPickerBusy, type PickerBusy } from "@shared/native-pick"
import { t } from "./i18n"
import { notice } from "./toast"

/**
 * The native pickers, as every caller in the window reaches them.
 *
 * The main process lets one native dialog up at a time. A second ask while one
 * is open (possibly hidden behind the main window) is answered busy, and here,
 * as MiMo 26.920 does, that becomes a warning saying so, then the same empty
 * answer a cancel gives - so a blocked click is never a silent dead button.
 */
function unlessBusy<T>(answer: T | PickerBusy, empty: T): T {
  if (!isPickerBusy(answer)) return answer
  notice.warning(t("toast.pickerBusy"))
  return empty
}

export async function pickDirectory(title: string, multiple = false): Promise<string[]> {
  return unlessBusy(await window.mcode.pickDirectory(title, multiple), [])
}

/** MiMo's 选择或新建项目文件夹: the same dialog, opening at the default project location. */
export async function pickProjectFolder(title: string, multiple = false): Promise<string[]> {
  return unlessBusy(await window.mcode.pickProjectFolder(title, multiple), [])
}

export async function saveText(suggested: string, text: string): Promise<string | undefined> {
  return unlessBusy(await window.mcode.saveText(suggested, text), undefined)
}

export async function openText(title: string): Promise<{ name: string; text: string } | undefined> {
  return unlessBusy(await window.mcode.openText(title), undefined)
}

export async function savePng(suggested: string, base64: string): Promise<string | undefined> {
  return unlessBusy(await window.mcode.savePng(suggested, base64), undefined)
}
