import { defineStore } from "pinia"
import { ref } from "vue"

/** One annotation just sent from a document, still framed there (MiMo numbers it 0: a frame with no badge). */
export interface BatchItem {
  id: string
  num: number
  kind: string
  path: string
  name: string
}

/**
 * MiMo's per-file batch of annotations sent straight from a document viewer.
 * They stay framed in the document until Escape clears the file, or an
 * annotation for that file is added to a box.
 */
export const useAnnotationBatch = defineStore("annotationBatch", () => {
  const byFile = ref<Record<string, BatchItem[]>>({})

  function setBatch(items: BatchItem[]) {
    if (!items.length) return
    const next = { ...byFile.value }
    const grouped: Record<string, BatchItem[]> = {}
    for (const item of items) (grouped[item.path] ??= []).push(item)
    Object.assign(next, grouped)
    byFile.value = next
  }

  function clearFile(path: string) {
    if (!byFile.value[path]) return
    const next = { ...byFile.value }
    delete next[path]
    byFile.value = next
  }

  function clearAll() {
    byFile.value = {}
  }

  return { byFile, setBatch, clearFile, clearAll }
})
