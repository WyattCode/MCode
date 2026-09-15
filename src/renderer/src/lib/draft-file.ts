import type { Annotation, Attachment } from "@shared/protocol"

/**
 * The saved composer input as it sits on disk: MiMo's per-conversation drafts
 * (words, files, mentions, skill chips), the annotations waiting in each box,
 * and which box was on screen. Kept apart from the window so it can be checked
 * without one.
 */
export const DRAFT_FILE_VERSION = 1

export interface SavedDraft {
  text: string
  attachments: Attachment[]
  mentioned: string[]
  skills: string[]
}

export interface DraftFile {
  v: typeof DRAFT_FILE_VERSION
  /** By box: "home", "main:<conversation>", "side:<conversation>". */
  drafts: Record<string, SavedDraft>
  /** By annotation scope, as the annotations store keys them. */
  annotations: Record<string, Annotation[]>
  /** The box on screen when this was written. */
  current?: string
}

export function emptyDraftFile(): DraftFile {
  return { v: DRAFT_FILE_VERSION, drafts: {}, annotations: {} }
}

/** Mentions alone are not a draft: they are only ever written in the text. */
export function draftHasContent(draft: SavedDraft | undefined): boolean {
  return Boolean(draft && (draft.text || draft.attachments.length || draft.skills.length))
}

export function isEmptyDraftFile(file: DraftFile): boolean {
  return !Object.keys(file.drafts).length && !Object.keys(file.annotations).length
}

export function draftFileOf(
  drafts: ReadonlyMap<string, SavedDraft>,
  annotations: Readonly<Record<string, readonly Annotation[]>>,
  current?: string,
): DraftFile {
  const file = emptyDraftFile()
  for (const [key, draft] of drafts) {
    if (!draftHasContent(draft)) continue
    file.drafts[key] = { text: draft.text, attachments: [...draft.attachments], mentioned: [...draft.mentioned], skills: [...draft.skills] }
  }
  for (const [scope, list] of Object.entries(annotations)) if (list.length) file.annotations[scope] = [...list]
  if (current) file.current = current
  return file
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [])

function isAttachment(entry: unknown): entry is Attachment {
  const file = entry as Partial<Attachment> | null
  return Boolean(file) && typeof file?.path === "string" && typeof file.mime === "string" && typeof file.data === "string"
}

function isAnnotation(entry: unknown): entry is Annotation {
  const note = entry as Partial<Annotation> | null
  return Boolean(note) && typeof note?.id === "string" && typeof note.kind === "string" && typeof note.text === "string"
}

/**
 * The file as read back, with anything malformed left out. One written in
 * another version reads as nothing; text that is not JSON at all throws, which
 * the caller takes as a load that failed.
 */
export function readDraftFile(text: string): DraftFile | undefined {
  const raw = JSON.parse(text) as { v?: unknown; drafts?: unknown; annotations?: unknown; current?: unknown } | null
  if (!raw || typeof raw !== "object" || raw.v !== DRAFT_FILE_VERSION) return undefined
  const file = emptyDraftFile()
  if (raw.drafts && typeof raw.drafts === "object") {
    for (const [key, value] of Object.entries(raw.drafts as Record<string, unknown>)) {
      const entry = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
      const draft: SavedDraft = {
        text: typeof entry.text === "string" ? entry.text : "",
        attachments: Array.isArray(entry.attachments) ? entry.attachments.filter(isAttachment) : [],
        mentioned: strings(entry.mentioned),
        skills: strings(entry.skills),
      }
      if (draftHasContent(draft)) file.drafts[key] = draft
    }
  }
  if (raw.annotations && typeof raw.annotations === "object") {
    for (const [scope, value] of Object.entries(raw.annotations as Record<string, unknown>)) {
      const list = Array.isArray(value) ? value.filter(isAnnotation) : []
      if (list.length) file.annotations[scope] = list
    }
  }
  if (typeof raw.current === "string") file.current = raw.current
  return file
}

/** The home screen's words as earlier builds kept them, folded in unless the file already has home words. */
export function withLegacyHome(file: DraftFile, legacy: string): DraftFile {
  if (!legacy || file.drafts.home?.text) return file
  const home = file.drafts.home ?? { text: "", attachments: [], mentioned: [], skills: [] }
  return { ...file, drafts: { ...file.drafts, home: { ...home, text: legacy } } }
}
