import { ref } from "vue"
import type { Attachment } from "@shared/protocol"

/**
 * MiMo keeps a draft per conversation - the words, the files, the skill chips -
 * and puts it back on returning. Held for the life of the window, outside any
 * one composer, because the box is remounted as it moves between the hero, the
 * dock and the floating chat. The home screen's words are also kept on disk.
 */
export interface SavedDraft {
  text: string
  attachments: Attachment[]
  mentioned: string[]
  skills: string[]
}

export const drafts = new Map<string, SavedDraft>()

/* Whether the home screen's box holds words, files or skill chips; MiMo's 已经是新任务了 reads it. */
export const homeFilled = ref(false)

const HOME_KEY = "composer.draft.home"

export function loadHomeDraft(): string {
  try {
    return localStorage.getItem(HOME_KEY) ?? ""
  } catch {
    return ""
  }
}

export function keepHomeDraft(text: string): void {
  try {
    if (text) localStorage.setItem(HOME_KEY, text)
    else localStorage.removeItem(HOME_KEY)
  } catch {
    // Kept for this window only.
  }
}
