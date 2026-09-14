import { onBeforeUnmount, ref, watch } from "vue"
import { useApp } from "../stores/app"

/*
 * MiMo's working light for a document's sent annotations. Sending from a
 * document registers a watch on the conversation it went to; a viewer showing
 * that file arms: "ignite" for 550ms, then "work" while the conversation runs;
 * when the run ends, "finish" for 850ms, "out" for 500ms, then nothing.
 */

export type FxPhase = "ignite" | "work" | "finish" | "out"

export interface FxBox {
  key: string
  left: number
  top: number
  width: number
  height: number
  diag: number
}

interface Watch {
  convoId: string
  file: string
  annotatedIds: string[]
  /** What was asked, as MiMo keeps it for the version history ("【PDF 第2页】…"). */
  prompt: string
  seq: number
}

const watches = ref<Watch[]>([])
let seq = 0

/** Recorded when a document sends an annotation into a conversation. */
export function watchOfficeSend(convoId: string, file: string, annotatedIds: string[], prompt: string) {
  watches.value = [...watches.value, { convoId, file, annotatedIds, prompt, seq: ++seq }]
}

const IGNITE_MS = 550
const FINISH_MS = 850
const OUT_MS = 500

export function useAnnotationFx(file: () => string) {
  const app = useApp()
  const phase = ref<FxPhase | null>(null)
  const annotatedIds = ref<string[]>([])
  let convoId: string | null = null
  let armedSeq = 0
  let timers: ReturnType<typeof setTimeout>[] = []

  const clear = () => {
    timers.forEach(clearTimeout)
    timers = []
  }

  function arm(watch: Watch) {
    clear()
    convoId = watch.convoId
    armedSeq = watch.seq
    annotatedIds.value = watch.annotatedIds
    phase.value = "ignite"
    timers.push(setTimeout(() => phase.value === "ignite" && (phase.value = "work"), IGNITE_MS))
  }

  function finish() {
    clear()
    phase.value = "finish"
    timers.push(setTimeout(() => (phase.value = "out"), FINISH_MS))
    timers.push(
      setTimeout(() => {
        phase.value = null
        annotatedIds.value = []
        watches.value = watches.value.filter((entry) => entry.seq !== armedSeq)
        convoId = null
      }, FINISH_MS + OUT_MS),
    )
  }

  watch(
    () => [watches.value, app.running.size] as const,
    () => {
      if (convoId === null) {
        const next = watches.value.find((entry) => entry.file === file() && entry.seq > armedSeq)
        if (next) arm(next)
        return
      }
      if ((phase.value === "ignite" || phase.value === "work") && !app.running.has(convoId)) finish()
    },
    { deep: true },
  )

  onBeforeUnmount(clear)
  return { phase, annotatedIds }
}
