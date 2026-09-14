<script setup lang="ts">
import { computed } from "vue"
import { useApp } from "../stores/app"
import { editedFiles } from "../lib/edited-files"
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

const changes = computed(() =>
  editedFiles(
    app.messages.flatMap((message) => (message.role === "assistant" ? message.parts : [])),
    app.current?.directory,
  ),
)
</script>

<template>
  <div v-if="changes.files.length > 0" class="live-edit-pill-wrap">
    <button type="button" class="live-edit-pill" data-live-edit-pill :aria-expanded="expanded" @click="emit('toggle')">
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
