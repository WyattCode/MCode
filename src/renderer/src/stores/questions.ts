import { computed, ref, watch } from "vue"
import { defineStore } from "pinia"
import type { QuestionAnswer, QuestionRequest } from "@shared/protocol"
import { useApp } from "./app"
import { composerAnswers, confirmQueue } from "../lib/confirm-queue"

/**
 * The questions a turn is parked on, in this window, and the dock queue they
 * share with permission requests.
 *
 * Kept keyed by request id, not by session. The reference's `list` is flatly
 * "all pending question requests across all sessions" and the id is what a
 * reply names, so keying by anything else would mean translating back.
 */
export const useQuestions = defineStore("questions", () => {
  const app = useApp()
  const pending = ref(new Map<string, QuestionRequest>())
  /** Requests answered here, so the form can disable itself before the event returns. */
  const sending = ref(new Set<string>())

  /** The question raised by one tool call, if any. */
  const forCall = computed(() => (callID: string): QuestionRequest | undefined => {
    for (const request of pending.value.values()) {
      if (request.tool?.callID === callID) return request
    }
    return undefined
  })

  const busy = computed(() => (requestID: string) => sending.value.has(requestID))

  /*
   * What the dock shows: the current session's undecided permissions and
   * questions in one list, oldest first, as MiMo keeps them.
   */
  const queue = computed(() => {
    const sessionID = app.currentID
    const permissions = sessionID ? (app.pendingPermissions.get(sessionID) ?? []) : []
    return confirmQueue(sessionID, permissions, pending.value.values())
  })

  function drop(requestID: string): void {
    if (!pending.value.has(requestID)) return
    const next = new Map(pending.value)
    next.delete(requestID)
    pending.value = next
  }

  async function reply(requestID: string, answers: QuestionAnswer[]): Promise<void> {
    if (sending.value.has(requestID)) return
    sending.value = new Set(sending.value).add(requestID)
    try {
      await app.client?.request({ type: "question.reply", requestID, answers })
    } finally {
      const next = new Set(sending.value)
      next.delete(requestID)
      sending.value = next
    }
  }

  /*
   * MiMo's X is not a refusal: it replies with every answer empty, so the call
   * completes as "Unanswered" and the transcript shows the question cancelled.
   */
  function dismiss(request: QuestionRequest): Promise<void> {
    return reply(
      request.id,
      request.questions.map(() => []),
    )
  }

  /**
   * Plain text sent from the composer while a question waits answers its first
   * question (MiMo's `hx`). True when it was taken as an answer.
   */
  function answerFromComposer(sessionID: string, text: string): boolean {
    const waiting = [...pending.value.values()]
      .filter((request) => request.sessionID === sessionID)
      .sort((a, b) => a.time - b.time)[0]
    if (!waiting || sending.value.has(waiting.id)) return false
    const answers = composerAnswers(text, waiting.questions.length)
    if (!answers) return false
    void reply(waiting.id, answers)
    return true
  }

  /*
   * Attaches to whichever socket the app store currently holds. The client is
   * replaced on every boot and on a server switch, so it is watched, not read once.
   */
  let detach: (() => void) | undefined
  watch(
    () => app.client,
    (client) => {
      detach?.()
      detach = undefined
      pending.value = new Map()
      if (!client) return
      detach = client.on((event) => {
        if (event.type === "question.asked") {
          const next = new Map(pending.value)
          next.set(event.request.id, event.request)
          pending.value = next
          return
        }
        if (event.type === "question.replied" || event.type === "question.rejected") {
          drop(event.requestID)
        }
      })
      void refresh()
    },
    { immediate: true },
  )

  /*
   * Asks for everything still parked. `question.asked` is a one-shot event, so
   * a window that reloaded would otherwise show a busy session and no dock.
   */
  async function refresh(): Promise<void> {
    const result = await app.client?.request({ type: "question.list" }).catch(() => undefined)
    if (!result) return
    pending.value = new Map(result.questions.map((request) => [request.id, request]))
  }

  // Re-asked whenever the socket comes back: events published while it was down are gone.
  watch(
    () => app.connected,
    (up) => {
      if (up) void refresh()
    },
  )

  return { pending, forCall, busy, queue, reply, dismiss, answerFromComposer, refresh }
})
