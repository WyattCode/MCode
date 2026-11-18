import { t } from "./i18n"

export function archiveNotice(count: number, batch: boolean): string {
  if (count === 0) return t("toast.noConvosToArchive")
  if (batch) return t("toast.archivedNConvos", { count })
  return t("toast.convoArchived")
}

export async function undoArchive(
  ids: readonly string[],
  archive: (sessionID: string, archived: boolean) => Promise<boolean>,
): Promise<number> {
  let restored = 0
  for (const id of ids) {
    if (await archive(id, false)) restored++
  }
  return restored
}
