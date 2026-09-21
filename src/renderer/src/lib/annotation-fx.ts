import { onBeforeUnmount, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import { useApp } from "../stores/app"

/*
 * MiMo's working light for a document's sent annotations. Sending one - from
 * the document's own "send now", or from the composer, into a new turn or one
 * already running - registers a watch on the conversation it went to; a viewer
 * showing that file arms: "ignite" for 550ms, then "work" while the
 * conversation runs; when the run ends, "finish" for 850ms, "out" for 500ms,
 * then nothing. Annotations sent into the run while it glows join the glow
 * (MiMo 26.920's noteBatch).
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
  /** The run it watched has ended; a later send starts a watch of its own rather than joining this one. */
  ended?: boolean
}

const watches = ref<Watch[]>([])
let seq = 0

/**
 * Recorded when an annotation on a document goes into a conversation. A send
 * into a run that already watches this file joins its watch, as MiMo's steer
 * merges into the running officeWatch, keeping the prompt it was started with.
 */
export function watchOfficeSend(convoId: string, file: string, annotatedIds: string[], prompt: string) {
  const live = watches.value.find((entry) => entry.convoId === convoId && entry.file === file && !entry.ended)
  if (!live) {
    watches.value = [...watches.value, { convoId, file, annotatedIds, prompt, seq: ++seq }]
    return
  }
  const merged = { ...live, annotatedIds: [...new Set([...live.annotatedIds, ...annotatedIds])], prompt: live.prompt || prompt }
  watches.value = watches.value.map((entry) => (entry === live ? merged : entry))
}

/* MiMo's documents: the ones its viewers light up (MB's filter). */
const OFFICE_FILE = /\.(xlsx|xlsm|xls|docx|doc|pptx|ppt|pdf)$/i

/**
 * MiMo's VD / KD over a message's annotations: those with a note of their own
 * (HD - one only pointed at does not count), grouped by the document they sit
 * on, so each document's viewer is told which of its annotations went.
 */
export function annotatedDocuments(annotations: readonly Annotation[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const note of annotations) {
    if (!note.path || !note.text.trim() || !OFFICE_FILE.test(note.path)) continue
    out.set(note.path, [...(out.get(note.path) ?? []), note.id])
  }
  return out
}

/** A message with annotations on documents went into a conversation: each document it names lights up for the run. */
export function watchAnnotatedSend(convoId: string, annotations: readonly Annotation[], prompt: string) {
  for (const [file, ids] of annotatedDocuments(annotations)) watchOfficeSend(convoId, file, ids, prompt)
}

/** The documents a conversation's run was sent from, so their views look again when it ends. */
export function watchedFilesOf(convoId: string): string[] {
  return watches.value.filter((entry) => entry.convoId === convoId).map((entry) => entry.file)
}

/** What was last asked from a document into this conversation, for the version its reply makes. */
export function promptOf(convoId: string): string {
  return [...watches.value].reverse().find((entry) => entry.convoId === convoId)?.prompt ?? endedPrompts.get(convoId) ?? ""
}

/* Outlasts a mounted viewer's finish (850 + 500ms) and the views' own run-end reads, which run after the idle event. */
const ENDED_GRACE_MS = 5000
/* The prompt of a conversation whose watches were cleared, for a view that reloads and records a minute later. */
const endedPrompts = new Map<string, string>()

/** A conversation went idle or failed: its watches go, so no viewer opened later lights up for a run that is over. */
export function endOfficeWatches(convoId: string) {
  const ending = watches.value.filter((entry) => entry.convoId === convoId)
  if (!ending.length) return
  endedPrompts.set(convoId, ending[ending.length - 1].prompt)
  const upTo = Math.max(...ending.map((entry) => entry.seq))
  watches.value = watches.value.map((entry) => (entry.convoId === convoId ? { ...entry, ended: true } : entry))
  setTimeout(() => {
    // Only what was there at the end: a send made into the same conversation meanwhile keeps its watch.
    watches.value = watches.value.filter((entry) => entry.convoId !== convoId || entry.seq > upTo)
  }, ENDED_GRACE_MS)
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
        // A watch whose run is already over has nothing left to light.
        const next = watches.value.find((entry) => entry.file === file() && entry.seq > armedSeq && app.running.has(entry.convoId))
        if (next) arm(next)
        return
      }
      if (phase.value !== "ignite" && phase.value !== "work") return
      if (!app.running.has(convoId)) {
        finish()
        return
      }
      // noteBatch: annotations sent into the run while it glows join it.
      const armed = convoId
      const sent = watches.value.filter((entry) => entry.convoId === armed && entry.file === file()).flatMap((entry) => entry.annotatedIds)
      const fresh = sent.filter((id) => !annotatedIds.value.includes(id))
      if (fresh.length) annotatedIds.value = [...annotatedIds.value, ...new Set(fresh)]
    },
    { deep: true },
  )

  onBeforeUnmount(clear)
  return { phase, annotatedIds }
}
