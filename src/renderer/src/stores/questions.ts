import { computed, ref, watch } from "vue"
import { defineStore } from "pinia"
import type { QuestionAnswer, QuestionRequest } from "@shared/protocol"
import { useApp } from "./app"
import { accessOf, composerAnswers, confirmQueue, freshGuide, guideShown, type GuideState } from "../lib/confirm-queue"

/* Waving the guide off holds for every conversation, and across restarts, as in MiMo. */
const GUIDE_DISMISSED_KEY = "mcode.perm-guide-dismissed-v1"

function readGuideDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(GUIDE_DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

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
    // subagents: a subagent's questions wait in the dock of the conversation it works for.
    return confirmQueue(sessionID, permissions, pending.value.values(), (id) => app.rootOf(id) === sessionID)
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
      .filter((request) => app.rootOf(request.sessionID) === sessionID)
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

  /*
   * The approval guide ("想减少审批提示吗？"). Window memory per session, as
   * MiMo keeps it: approvals given by hand, and whether this task is allowed.
   */
  const guides = ref(new Map<string, GuideState>())
  const guideDismissed = ref(readGuideDismissed())

  function guideFor(sessionID: string): GuideState {
    const state = guides.value.get(sessionID) ?? freshGuide()
    return { ...state, dismissed: state.dismissed || guideDismissed.value }
  }

  function patchGuide(sessionID: string, patch: Partial<GuideState>): void {
    const next = new Map(guides.value)
    next.set(sessionID, { ...(guides.value.get(sessionID) ?? freshGuide()), ...patch })
    guides.value = next
  }

  /** Whether the dock shows the guide in place of the permission card at its head. */
  const guide = computed(() => {
    const first = queue.value[0]
    const sessionID = app.currentID
    if (!first || !sessionID || first.kind !== "permission") return false
    return guideShown(guideFor(sessionID), accessOf(app.config), first.kind, first.request.forced === true)
  })

  const guideCount = computed(() => (app.currentID ? guideFor(app.currentID).allowCount : 0))

  /** An approval pressed on the card. Automatic ones are not counted. */
  function noteAllowed(sessionID: string): void {
    patchGuide(sessionID, { allowCount: guideFor(sessionID).allowCount + 1 })
  }

  /** 保留手动审批: never offer the guide again, here or in any other conversation. */
  function dismissGuide(): void {
    guideDismissed.value = true
    try {
      globalThis.localStorage?.setItem(GUIDE_DISMISSED_KEY, "1")
    } catch {
      // Private storage refused; the guide stays away for this window at least.
    }
  }

  /** 帮我审批: the composer's middle access level, which the server applies to what is already waiting. */
  async function acceptEdits(): Promise<void> {
    await app.patchConfig({ accessLevel: "auto" })
  }

  /*
   * 本任务放行: everything but a delete is approved for the rest of this turn,
   * starting with what is already waiting. Deletes still come to the card.
   */
  const autoAnswered = new Set<string>()

  function allowOnce(requestID: string): void {
    if (autoAnswered.has(requestID)) return
    autoAnswered.add(requestID)
    void app.client?.request({ type: "permission.respond", requestID, response: "once" }).catch(() => autoAnswered.delete(requestID))
  }

  function allowTask(): void {
    const sessionID = app.currentID
    if (!sessionID) return
    patchGuide(sessionID, { taskAllowOn: true })
  }

  watch(
    () =>
      [...app.pendingPermissions.entries()].flatMap(([sessionID, requests]) =>
        guides.value.get(sessionID)?.taskAllowOn ? requests.filter((request) => !request.forced).map((request) => request.id) : [],
      ),
    (ids) => ids.forEach(allowOnce),
    { immediate: true },
  )

  // The task ends with the turn; the next one asks again.
  watch(
    () => [...app.running],
    (now, before) => {
      for (const sessionID of before ?? []) {
        if (!now.includes(sessionID) && guides.value.get(sessionID)?.taskAllowOn) patchGuide(sessionID, { taskAllowOn: false })
      }
    },
  )

  return {
    pending,
    forCall,
    busy,
    queue,
    reply,
    dismiss,
    answerFromComposer,
    refresh,
    guide,
    guideCount,
    noteAllowed,
    dismissGuide,
    acceptEdits,
    allowTask,
  }
})
