import { defineStore } from "pinia"
import { ref } from "vue"
import type { Annotation } from "@shared/protocol"
import { ANNOTATION_LIMIT } from "@shared/annotations"
import { notify, notifyFailure } from "../lib/toast"
import { t } from "../lib/i18n"

/** The home screen's box, which has no conversation to keep them under yet. */
export const HOME_SCOPE = "home"

const EMPTY: readonly Annotation[] = []

/**
 * MiMo's annotations waiting in the box, per conversation: switching away keeps
 * them with the conversation they were made in, and sending takes them along.
 */
export const useAnnotations = defineStore("annotations", () => {
  const byScope = ref<Record<string, Annotation[]>>({})

  function list(scope: string): readonly Annotation[] {
    return byScope.value[scope] ?? EMPTY
  }

  function put(scope: string, next: Annotation[]) {
    const copy = { ...byScope.value }
    if (next.length) copy[scope] = next
    else delete copy[scope]
    byScope.value = copy
  }

  /** Adds one, saying so; at the limit it is refused and the user told why. */
  function add(scope: string, note: Annotation): boolean {
    const current = list(scope)
    if (current.length >= ANNOTATION_LIMIT) {
      notifyFailure(t("composer.annotationLimit", { max: ANNOTATION_LIMIT }))
      return false
    }
    put(scope, [...current, note])
    notify(t("composer.annotationAdded"))
    return true
  }

  function update(scope: string, index: number, text: string) {
    put(
      scope,
      list(scope).map((note, at) => (at === index ? { ...note, text: text.trim() } : note)),
    )
  }

  function remove(scope: string, indexes: readonly number[]) {
    const drop = new Set(indexes)
    put(
      scope,
      list(scope).filter((_, at) => !drop.has(at)),
    )
  }

  /** Everything waiting, removed: what a message sends. */
  function take(scope: string): Annotation[] {
    const taken = [...list(scope)]
    put(scope, [])
    return taken
  }

  return { byScope, list, put, add, update, remove, take }
})
