import { computed, ref, watch } from "vue"
import { defineStore } from "pinia"
import type { QuestionAnswer, QuestionRequest } from "@shared/protocol"
import { useApp } from "./app"

/**
 * The questions a turn is parked on, in this window.
 *
 * Its own store rather than a corner of the app store, because it is the whole
 * client half of one feature and nothing else reads it: the tool card asks
 * whether its own call has a question outstanding, answers it, and forgets it.
 *
 * Kept keyed by request id, not by session. The reference's service can have
 * one parked question per session at a time in practice, but its `list` is
 * flatly "all pending question requests across all sessions" and the id is
 * what a reply names, so keying by anything else would mean translating back.
 */
export const useQuestions = defineStore("questions", () => {
  const app = useApp()
  const pending = ref(new Map<string, QuestionRequest>())
  /** Requests answered here, so the form can close before the event returns. */
  const sending = ref(new Set<string>())

  /**
   * The question raised by one tool call, if any.
   *
   * Matched on the call id the request carries. The reference puts the same
   * field on its request (`tool: {messageID, callID}`) for the same purpose -
   * it is how a client finds which card the question belongs to.
   */
  const forCall = computed(() => (callID: string): QuestionRequest | undefined => {
    for (const request of pending.value.values()) {
      if (request.tool?.callID === callID) return request
    }
    return undefined
  })

  const busy = computed(() => (requestID: string) => sending.value.has(requestID))

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

  async function dismiss(requestID: string): Promise<void> {
    if (sending.value.has(requestID)) return
    sending.value = new Set(sending.value).add(requestID)
    try {
      await app.client?.request({ type: "question.reject", requestID })
    } finally {
      const next = new Set(sending.value)
      next.delete(requestID)
      sending.value = next
    }
  }

  /**
   * Attaches to whichever socket the app store currently holds.
   *
   * The client is replaced on every boot and whenever the reader points the app
   * at another server, so subscribing once to the instance that happened to
   * exist at setup would leave this store listening to a socket nobody uses.
   * Watching the ref is what keeps it attached across both.
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

  /**
   * Asks for everything still parked.
   *
   * `question.asked` is a one-shot event, so a window that reloaded - or a
   * second window opened after the model asked - would otherwise show a busy
   * session with a running tool card and no form in it. This is the same
   * replay `session.list` does for permissions.
   */
  async function refresh(): Promise<void> {
    const result = await app.client?.request({ type: "question.list" }).catch(() => undefined)
    if (!result) return
    pending.value = new Map(result.questions.map((request) => [request.id, request]))
  }

  /*
   * Re-asked whenever the socket comes back. Events published while it was
   * down are gone, and one of them may have been the question this window is
   * about to be asked to answer.
   */
  watch(
    () => app.connected,
    (up) => {
      if (up) void refresh()
    },
  )

  return { pending, forCall, busy, reply, dismiss, refresh }
})
