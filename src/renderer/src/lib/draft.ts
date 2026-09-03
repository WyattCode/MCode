import { inject, provide } from "vue"
import type { InjectionKey } from "vue"
import type { Attachment, UserMessage } from "@shared/protocol"
import { mentionedIn } from "./mention"

/**
 * Turning a message that has been rolled back into a prompt again.
 *
 * Reverting a message in the reference does not delete it - it puts the
 * sentence straight back in the box, ready to be edited and sent again. The
 * mutation that does it reads `const value = draft(input.messageID)` and then
 * `prompt.set(value)` (out/renderer/assets/main-8t-QUXax.js @5578333), where
 * `draft` is `extractPromptFromParts` (@5492369): the message's text, its
 * `@file` mentions re-inlined at their original offsets, and its `data:` file
 * parts brought back as attachment chips. Restoring only the text would ship a
 * resend bug, which is why the split lives here rather than at the two call
 * sites.
 *
 * The split is the other way round in this app. The reference keeps mentions as
 * parts and only chips the pasted files; here a mention is the literal text
 * `@path` (see mention.ts) and `Composer.submit` reads the mentioned files off
 * disk at send time, storing them in `message.attachments` beside the picked
 * ones. So a restored message re-inlines nothing - the `@path` is already in
 * the text - and instead has to drop those files from the chip list, or the
 * next send carries every mentioned file twice: once as a chip and once read
 * again by `mentionAttachments`.
 */
export interface Draft {
  text: string
  /** Files to show as chips: everything the text does not already name. */
  attachments: Attachment[]
  /** Paths the composer should treat as chosen mentions, so they travel again. */
  mentioned: Set<string>
}

/** The file's own name, which is all a one-line summary has room for. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function draftFromMessage(message: UserMessage): Draft {
  const named = new Set(mentionedIn(message.text))
  return {
    text: message.text,
    attachments: message.attachments.filter((file) => !named.has(file.path)),
    /*
     * Rebuilt from the text rather than remembered, because the text is the
     * only record: a mention that was edited out before the message was sent
     * left no trace, and one that is still written has to be re-read on the
     * next send - what the model should look at is the file as it stands when
     * it is asked, not as it stood when the message was first typed.
     */
    mentioned: named,
  }
}

/**
 * One line for a message that is no longer on screen.
 *
 * The reference's own `line` (@5573737) joins the restored prompt parts with no
 * separator, writing an attachment as `[image:<filename>]` and everything else
 * as its text, then collapses whitespace - a rolled back message keeps its
 * paragraphs and this is a single row, so without that a message that began
 * with a blank line showed as an empty entry.
 *
 * Its final fallback - the literal `[` + `common.attachment` + `]` for a message
 * that came to nothing - is reproduced now that the word exists in all eighteen
 * tables, copied from the reference rather than translated. The caller passes it
 * in instead of this module reading it: the row is the only place that needs a
 * string, and importing the table here would drag the whole of `i18n.ts`, and
 * with it Vue's reactivity, into a module the build-time checks import directly.
 * Omitted, the behaviour is what it was before - an empty line.
 */
export function draftLine(message: UserMessage, empty?: string): string {
  const draft = draftFromMessage(message)
  const line = [draft.text, ...draft.attachments.map((file) => `[image:${baseName(file.path)}]`)]
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  if (line) return line
  return empty ? `[${empty}]` : ""
}

/**
 * The way the transcript and the revert dock reach the composer.
 *
 * Both are siblings of the composer with no props and no emits, and the prompt
 * is component-local state (`Composer.vue` `text`/`attachments`/`mentioned`),
 * so neither can see it. The reference has no such problem - there the prompt
 * is store state the mutation writes into directly - so something had to be
 * invented, and this is the smallest thing that works: App.vue owns the
 * composer ref and hands down one function. The faithful alternative, lifting
 * the whole prompt into the store, is a refactor of a different size and would
 * also mean editing a file this parcel does not own.
 *
 * Called with no message it empties the box, which is the reference's
 * `promptSession.reset()` in the branch where nothing is left rolled back.
 */
export type RestoreDraft = (message?: UserMessage) => void

const NOTHING: RestoreDraft = () => {}

export const RESTORE_DRAFT: InjectionKey<RestoreDraft> = Symbol("mcode.restoreDraft")

export function provideRestoreDraft(restore: RestoreDraft): void {
  provide(RESTORE_DRAFT, restore)
}

/** Falls back to doing nothing, so a component can be mounted on its own. */
export function useRestoreDraft(): RestoreDraft {
  return inject(RESTORE_DRAFT, NOTHING)
}
