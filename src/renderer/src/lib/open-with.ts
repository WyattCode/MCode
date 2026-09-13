import { computed, ref } from "vue"
import { FILE_MANAGER_ID, fileManagerLabel, openApps } from "@shared/open-app"
import type { MenuItem } from "./menu"
import { t } from "./i18n"
import { notify, notifyFailure } from "./toast"

/**
 * Which app a project folder is opened in, for MiMo's open-location control.
 *
 * Held here rather than in the component so every place that offers it opens
 * with the same remembered choice. The file manager is the starting value and
 * the one with no `openWith`: the plain "hand it to the desktop" path.
 */
const OPEN_WITH_KEY = "mcode.openWith"

const chosen = ref(
  (() => {
    try {
      return localStorage.getItem(OPEN_WITH_KEY) || FILE_MANAGER_ID
    } catch {
      return FILE_MANAGER_ID
    }
  })(),
)

export function useOpenWith(platform: () => string) {
  const apps = computed(() => openApps(platform()))
  const managerLabel = computed(() => t(fileManagerLabel(platform())))

  /* A remembered app this platform does not offer falls back to the file manager. */
  const choice = computed(() =>
    chosen.value === FILE_MANAGER_ID || apps.value.some((entry) => entry.id === chosen.value)
      ? chosen.value
      : FILE_MANAGER_ID,
  )
  const chosenApp = computed(() => apps.value.find((entry) => entry.id === choice.value))
  const label = computed(() => (chosenApp.value ? t(chosenApp.value.label) : managerLabel.value))

  /* As MiMo lists them: the apps it can open with, and nothing else. */
  const items = computed<MenuItem[]>(() => [
    { key: `app.${FILE_MANAGER_ID}`, label: managerLabel.value, checked: choice.value === FILE_MANAGER_ID },
    ...apps.value.map((entry) => ({ key: `app.${entry.id}`, label: t(entry.label), checked: choice.value === entry.id })),
  ])

  /* Opens, then says which app it went to - or why it did not. */
  async function open(directory: string) {
    const name = label.value
    const reason = await window.mcode.openFile(directory, "", chosenApp.value?.openWith)
    if (reason) notifyFailure(t("header.openFailed", { error: reason }))
    else notify(t("header.openedWith", { name }))
  }

  /* Picking an app remembers it and opens with it at once, as MiMo does. */
  async function pick(key: string, directory: string) {
    if (!key.startsWith("app.")) return
    chosen.value = key.slice("app.".length)
    try {
      localStorage.setItem(OPEN_WITH_KEY, chosen.value)
    } catch {}
    await open(directory)
  }

  return { label, items, open, pick }
}
