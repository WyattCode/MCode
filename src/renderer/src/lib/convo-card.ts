import { language, sessionTitle, t } from "./i18n"
import { projectName } from "./project"

/**
 * The time on a conversation's information card, as MiMo writes it: month and
 * day with the hour in Chinese ("9月14日 00:24"), the locale's short month and
 * day with the hour everywhere else.
 */
export function cardTime(at: number): string {
  if (!at) return ""
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (language.value.toLowerCase().startsWith("zh")) return `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${clock}`
  try {
    return `${new Intl.DateTimeFormat(language.value, { month: "short", day: "numeric" }).format(date)} ${clock}`
  } catch {
    return clock
  }
}

/**
 * What MiMo's card says about a conversation: its title, the project it is in,
 * the folder it works in and when it last changed. A task without a project
 * has no project line.
 */
export function convoCard(
  session: { title: string; directory: string; updated: number; scratch?: boolean },
  names?: Record<string, string>,
): { title: string; lines: (string | undefined)[] } {
  return {
    title: sessionTitle(session.title),
    lines: [
      session.scratch ? undefined : t("convoTip.project", { name: projectName(session.directory, names) }),
      session.directory || undefined,
      session.updated ? t("convoTip.updatedAt", { time: cardTime(session.updated) }) : undefined,
    ],
  }
}
