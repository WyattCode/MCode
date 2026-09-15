<script setup lang="ts">
import { computed } from "vue"
import type { AssistantPart, ToolPart } from "@shared/protocol"
import { useApp } from "../stores/app"
import { useRightPanel } from "../stores/right-panel"
import { editedFiles } from "../lib/edited-files"
import { t } from "../lib/i18n"

/*
 * MiMo's pill over the composer: what the latest turn changed - the one
 * running, or the last to finish - as "N files changed +a -d", pressed to show
 * or put away that turn's diff in a 审阅 tab. A new question starts a new turn,
 * so the pill goes until that turn edits something. Counted from the edits the
 * turn's own tools made, not from git.
 */
defineProps<{ expanded?: boolean }>()
const app = useApp()
const rp = useRightPanel()

/* The diff tab's source, which App.vue also reads to say whether the tab is on show. */
const LIVE_EDIT = "live-edit"

/* The parts after the last question; a message sent into the running turn stays inside it. */
const latest = computed<AssistantPart[]>(() => {
  const parts: AssistantPart[] = []
  const list = app.visible
  for (let at = list.length - 1; at >= 0; at--) {
    const message = list[at]!
    if (message.role === "assistant") parts.unshift(...message.parts)
    else if (!message.steered) break
  }
  return parts
})

const changes = computed(() => editedFiles(latest.value, app.current?.directory))

function toggle() {
  const diffs: string[] = []
  for (const part of latest.value) {
    if (part.type !== "tool" || !["edit", "write", "patch"].includes(part.name) || part.status === "error") continue
    const diff = (part as ToolPart).metadata?.diff
    if (typeof diff === "string" && diff) diffs.push(diff)
  }
  rp.toggleDiff(t("stream.reviewFiles"), diffs.join("\n"), LIVE_EDIT)
}
</script>

<template>
  <div v-if="changes.files.length > 0" class="live-edit-pill-wrap">
    <button type="button" class="live-edit-pill" data-live-edit-pill :aria-expanded="expanded" @click="toggle">
      <span class="live-edit-pill-text">{{ t("composer.filesChanged", { n: changes.files.length }) }}</span>
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

/* MiMo's colours: the input border and muted text, #151c130f / #151c1399, and #2e2e2e / #b8b8b8 in the dark. */
.live-edit-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 14px;
  color: #151c1399;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
  background: var(--surface-base);
  border: 1px solid #151c130f;
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
  color: #1a7f37;
}

.live-edit-del {
  color: #e5484d;
}

:root[data-theme="dark"] .live-edit-pill {
  color: #b8b8b8;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .live-edit-pill:hover {
  color: var(--text-strong);
}

:root[data-theme="dark"] .live-edit-add {
  color: #3fb950;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .live-edit-pill {
    color: #b8b8b8;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .live-edit-pill:hover {
    color: var(--text-strong);
  }

  :root:not([data-theme="light"]) .live-edit-add {
    color: #3fb950;
  }
}
</style>
