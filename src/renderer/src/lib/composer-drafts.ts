import { ref } from "vue"
import type { Annotation } from "@shared/protocol"
import { draftFileOf, emptyDraftFile, readDraftFile, withLegacyHome, type DraftFile, type SavedDraft } from "./draft-file"

export type { SavedDraft }

/**
 * MiMo keeps a draft per conversation - the words, the files, the skill chips
 * and the annotations waiting - and puts it back on returning, and on the next
 * launch. Held outside any one composer, because the box is remounted as it
 * moves between the hero, the dock and the floating chat. Written through the
 * main process 300ms after a change and once more as the page goes.
 */
export const drafts = new Map<string, SavedDraft>()

/* Whether the home screen's box holds words, files or skill chips; MiMo's 已经是新任务了 reads it. */
export const homeFilled = ref(false)

export const DRAFT_SAVE_DELAY = 300

/* Where earlier builds kept the home screen's words; folded into the file once, then removed. */
const LEGACY_HOME_KEY = "composer.draft.home"

interface DraftSources {
  annotations: () => Readonly<Record<string, readonly Annotation[]>>
  current: () => string | undefined
}

let sources: DraftSources = { annotations: () => ({}), current: () => undefined }
/* A load that failed must not be answered by writing an empty state over the file. */
let loadFailed = false
let legacyPending = false
let timer: ReturnType<typeof setTimeout> | undefined

/** Reads the saved input, once, before any composer mounts; answers everything restored. */
export function loadDrafts(): DraftFile {
  let file: DraftFile | undefined
  try {
    const read = window.mcode.composerInputLoad()
    if (!read.ok) throw new Error("unreadable")
    file = read.text ? readDraftFile(read.text) : undefined
  } catch {
    loadFailed = true
  }
  let legacy = ""
  try {
    legacy = localStorage.getItem(LEGACY_HOME_KEY) ?? ""
  } catch {
    // No storage: nothing older to bring along.
  }
  const restored = withLegacyHome(file ?? emptyDraftFile(), legacy)
  drafts.clear()
  for (const [key, draft] of Object.entries(restored.drafts)) drafts.set(key, draft)
  if (legacy) {
    legacyPending = true
    scheduleDraftSave()
  }
  return restored
}

/**
 * A skill chip put into a box's draft from outside it - MiMo's 在对话中试用
 * and 让 Agent 配置 on the skill card. `only` replaces the chips already
 * there; `text` replaces the words. A box showing that draft picks the change
 * up through `draftTouched`; one mounted later reads it when it opens.
 */
export const draftTouched = ref<{ key: string; at: number }>({ key: "", at: 0 })

export function addDraftSkill(key: string, name: string, options: { only?: boolean; text?: string } = {}): void {
  const kept = drafts.get(key)
  const skills = options.only ? [name] : [...(kept?.skills ?? []).filter((entry) => entry !== name), name]
  drafts.set(key, {
    text: options.text ?? kept?.text ?? "",
    attachments: kept?.attachments ?? [],
    mentioned: kept?.mentioned ?? [],
    skills,
  })
  if (key === "home") homeFilled.value = true
  draftTouched.value = { key, at: Date.now() }
  scheduleDraftSave()
}

/** What else is saved with the drafts: the annotations waiting, and the box on screen. */
export function bindDraftSources(next: DraftSources): void {
  sources = next
}

function snapshot(): DraftFile | undefined {
  const file = draftFileOf(drafts, sources.annotations(), sources.current())
  return loadFailed ? undefined : file
}

/* The older home key goes only once the file holding its words is safely written. */
function written(ok: boolean) {
  if (!ok || !legacyPending) return
  legacyPending = false
  try {
    localStorage.removeItem(LEGACY_HOME_KEY)
  } catch {
    // Left behind; the file already has the words, so it is never read again.
  }
}

export function scheduleDraftSave(): void {
  clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    const file = snapshot()
    if (!file) return
    void window.mcode
      .composerInputSave(JSON.stringify(file))
      .then(written)
      .catch(() => undefined)
  }, DRAFT_SAVE_DELAY)
}

/** The page is going: what is waiting is written before it does. */
export function flushDrafts(): void {
  clearTimeout(timer)
  timer = undefined
  const file = snapshot()
  if (!file) return
  try {
    written(window.mcode.composerInputFlush(JSON.stringify(file)))
  } catch {
    // The window is already gone; the last scheduled write stands.
  }
}
