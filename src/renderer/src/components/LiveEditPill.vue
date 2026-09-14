<script setup lang="ts">
import { computed } from "vue"
import type { ToolPart } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

/*
 * The pill over the composer that says how much this conversation has changed:
 * "N files changed +a -d", pressed to open the review beside it. Counted from
 * the edits the conversation's own tools made - not from git - so it speaks
 * for this conversation and nothing else that happened to the working tree.
 */
defineProps<{ expanded?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const app = useApp()

const EDITING = new Set(["edit", "write", "patch"])

function isAbsolute(file: string) {
  return file.startsWith("/") || file.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(file)
}

/* A path the model reached outside the project is not a change to it. */
function inProject(file: string, directory?: string) {
  if (file.startsWith("../") || file.startsWith("..\\")) return false
  if (!isAbsolute(file)) return true
  if (!directory) return true
  const root = directory.replace(/[\\/]+$/, "")
  const windows = root.includes("\\") || /^[a-zA-Z]:/.test(root)
  return windows ? file.toLowerCase().startsWith(`${root.toLowerCase()}\\`) || file.toLowerCase().startsWith(`${root.toLowerCase()}/`) : file.startsWith(`${root}/`)
}

/*
 * Lines added and removed. Only lines inside a hunk count, and a new file
 * header ends the hunk before it, so a patch touching several files does not
 * count its second file's "--- a/" line as a removal.
 */
function lineCounts(diff: string) {
  let add = 0
  let del = 0
  let inHunk = false
  const lines = diff.split("\n")
  lines.forEach((line, index) => {
    if (line.startsWith("@@")) {
      inHunk = true
      return
    }
    if (line.startsWith("diff --git ") || (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "))) {
      inHunk = false
      return
    }
    if (!inHunk) return
    if (line.startsWith("+")) add++
    else if (line.startsWith("-")) del++
  })
  return { add, del }
}

const changes = computed(() => {
  const files = new Set<string>()
  let add = 0
  let del = 0
  const directory = app.current?.directory
  for (const message of app.messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || !EDITING.has(part.name)) continue
      const tool = part as ToolPart
      if (tool.status === "error") continue
      const diff = typeof tool.metadata?.diff === "string" ? tool.metadata.diff : ""
      if (!diff) continue
      const named = Array.isArray(tool.metadata?.files)
        ? (tool.metadata.files as unknown[]).filter((file): file is string => typeof file === "string")
        : typeof tool.metadata?.path === "string"
          ? [tool.metadata.path]
          : []
      const kept = named.filter((file) => file.trim() && inProject(file, directory))
      if (!kept.length) continue
      kept.forEach((file) => files.add(file))
      const counted = lineCounts(diff)
      add += counted.add
      del += counted.del
    }
  }
  return { files: files.size, add, del }
})
</script>

<template>
  <div v-if="changes.files > 0" class="live-edit-pill-wrap">
    <button type="button" class="live-edit-pill" data-live-edit-pill :aria-expanded="expanded" @click="emit('toggle')">
      <span class="live-edit-pill-text">{{ t("composer.filesChanged", { n: changes.files }) }}</span>
      <span class="live-edit-pill-stats">
        <span class="live-edit-add">+{{ changes.add }}</span>
        {{ " " }}
        <span class="live-edit-del">-{{ changes.del }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped>
/*
 * Hung above the composer's top edge, centred on its column, without taking
 * any room of its own: the anchor it sits in is zero tall.
 */
.live-edit-pill-wrap {
  position: absolute;
  inset-inline: 28px;
  top: 0;
  z-index: 4;
  display: flex;
  justify-content: center;
  pointer-events: none;
  transform: translateY(calc(-100% - 8px));
}

.live-edit-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 14px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  cursor: pointer;
  pointer-events: auto;
  transition: color 0.12s;
}

.live-edit-pill:hover {
  color: var(--text-strong);
}

.live-edit-pill-text {
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.live-edit-pill-stats {
  flex: none;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.live-edit-add {
  color: var(--diff-add);
}

.live-edit-del {
  color: var(--diff-delete);
}
</style>
