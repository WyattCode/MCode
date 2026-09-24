import { watch } from "vue"
import type { Message, ToolPart } from "@shared/protocol"
import { language } from "./i18n"
import { hushSpeech, speak } from "./voice"

/*
 * speak: the window's half of the speak tool.
 *
 * The backend offers that tool only while voice feedback is on, so a call of it
 * arriving here is one the reader asked to hear. When it completes in the
 * conversation on show, the line it carries is read out with the machine's own
 * voice - the OS speech engine, through lib/voice - so nothing said this way
 * leaves the computer.
 */

/* A completion counts only when it is new, as a delivered file's does: a transcript read back says nothing. */
const RECENT_MS = 15_000

/** The line a completed speak call asks for: what the tool recorded, or failing that what was passed to it. */
export function spokenLine(part: ToolPart): string {
  const said = part.metadata?.text
  if (typeof said === "string" && said.trim()) return said.trim()
  const asked = part.input?.text
  return typeof asked === "string" ? asked.trim() : ""
}

/**
 * Watches the conversation on show for speak calls completing, and says each
 * once. A conversation opened later, or a transcript read back, has only old
 * completions and so stays quiet.
 */
export function followSpoken(source: { enabled: () => boolean; session: () => string | undefined; messages: () => readonly Message[] }) {
  const handled = new Set<string>()
  let since = Date.now()
  /* Leaving a conversation stops its narration: the line belongs to the turn that is no longer on screen. */
  watch(source.session, () => {
    since = Date.now()
    hushSpeech()
  })
  /* And so does switching the feature off, which otherwise only stopped the next line rather than this one. */
  watch(source.enabled, (on) => {
    if (!on) hushSpeech()
  })
  watch(
    () => {
      if (!source.enabled()) return []
      const list = source.messages()
      const found: ToolPart[] = []
      // A completion lands in the turn being written, so only the last few messages are looked at.
      for (let at = Math.max(0, list.length - 4); at < list.length; at++) {
        const message = list[at]
        if (message.role !== "assistant") continue
        for (const part of message.parts) {
          if (part.type === "tool" && part.name === "speak" && part.status === "completed" && !handled.has(part.callID)) found.push(part)
        }
      }
      return found
    },
    (parts) => {
      for (const part of parts) {
        if (handled.has(part.callID)) continue
        handled.add(part.callID)
        const done = part.time.completed ?? 0
        if (done < since || Date.now() - done > RECENT_MS) continue
        const line = spokenLine(part)
        if (line) speak(line, language.value, source.session())
      }
    },
  )
}
