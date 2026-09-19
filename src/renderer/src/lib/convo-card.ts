import type { ChatLink } from "@shared/protocol"
import { dateIn, language, sessionTitle, t } from "./i18n"
import { projectName } from "./project"
import { sessionGroup, type GroupContext } from "@shared/session-group"
import type { TipLine } from "./tip"

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
  return `${dateIn(date, { month: "short", day: "numeric" })} ${clock}`
}

/** session chat: MiMo's order - the messages being handled first, then the queue by position. */
export function sortedChatLinks(links: readonly ChatLink[]): ChatLink[] {
  return [...links].sort((a, b) => Number(a.phase === "queued") - Number(b.phase === "queued") || a.queueAhead - b.queueAhead)
}

/**
 * session chat: MiMo's words for one message in flight - waiting for a reply,
 * handling a message, or handling a reply - with its place in the queue after
 * it while it waits (a running message is first in line, so the next is #2).
 */
export function chatLinkText(link: ChatLink): string {
  const peer = sessionTitle(link.peerTitle)
  const doing =
    link.direction === "outbound"
      ? t("side.chatLink.waiting", { peer })
      : link.kind === "reply"
        ? t("side.chatLink.handlingReply", { peer })
        : t("side.chatLink.handlingRequest", { peer })
  return link.phase === "queued" ? `${doing} · ${t("side.chatLink.queued", { position: String(link.queueAhead + 1) })}` : doing
}

/**
 * What MiMo's card says about a conversation: its title, the project it is in,
 * the folder it works in and when it last changed. A task without a project
 * has no project line.
 *
 * session chat: then a line for each message in flight with another
 * conversation; given `jump`, a line whose other side still exists opens it.
 */
export function convoCard(
  session: { title: string; directory: string; updated: number; scratch?: boolean; group?: string },
  names?: Record<string, string>,
  links: readonly ChatLink[] = [],
  jump?: (sessionID: string) => void,
  context?: GroupContext,
): { title: string; lines: (string | TipLine | undefined)[] } {
  // The project it is filed under, which 移动至项目 may have moved; the folder line below still says where it works.
  const group = sessionGroup(session, context)
  return {
    title: sessionTitle(session.title),
    lines: [
      group ? t("convoTip.project", { name: projectName(group, names) }) : undefined,
      session.directory || undefined,
      session.updated ? t("convoTip.updatedAt", { time: cardTime(session.updated) }) : undefined,
      ...sortedChatLinks(links).map((link): TipLine => {
        const peer = link.peerID
        return {
          text: chatLinkText(link),
          direction: link.direction,
          ...(peer && jump ? { title: t("side.chatLink.jump"), action: () => jump(peer) } : {}),
        }
      }),
    ],
  }
}
