<script setup lang="ts">
import { t } from "../../lib/i18n"

/*
 * MiMo 26.920's footer under a document viewer (its AigcViewerLabel): the same
 * reminder the composer carries - answers are generated and can be wrong -
 * on a line of its own at the foot of the PDF, Word, Excel, PowerPoint and
 * HTML views, shown whatever the file is. Its own component so it stays apart
 * from the labels written into delivered files, which are another lane's.
 */
defineProps<{ viewer: "pdf" | "docx" | "xlsx" | "pptx" | "html" }>()
</script>

<template>
  <p class="viewer-ai-note" role="note" data-viewer-ai-note :data-viewer="viewer">{{ t("composer.aiNote") }}</p>
</template>

<style scoped>
/* MiMo's line: 8 above, 12 at the sides, 6 below, 10px centred in the dim colour, never in the way of the pointer. */
.viewer-ai-note {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 12px 6px;
  color: var(--text-weak);
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: 1.4;
  text-align: center;
  pointer-events: none;
  user-select: none;
}
</style>
