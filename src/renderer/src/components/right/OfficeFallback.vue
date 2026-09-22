<script setup lang="ts">
import { t } from "../../lib/i18n"

/**
 * MiMo's structured preview, shown when a document's own view cannot draw it.
 * MiMo fills it from a text extraction it does not run for files opened this
 * way, so what it shows is the note and the empty message for the kind.
 */
defineProps<{ type?: string }>()
</script>

<template>
  <div class="office-fallback" data-office-fallback>
    <div class="of-note">{{ t("office.structuredNoteFailed") }}</div>
    <div class="of-message">
      {{
        type === "xlsx"
          ? t("office.emptyWorkbook")
          : type === "docx"
            ? t("office.emptyDoc")
            : type === "pptx"
              ? t("office.pptNoText")
              : t("office.unsupported")
      }}
    </div>
  </div>
</template>

<style scoped>
.office-fallback {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.of-note {
  flex-shrink: 0;
  padding: 7px 12px;
  color: var(--text-base);
  background: var(--surface-base);
  border-bottom: 1px solid var(--border-weak);
  font-size: 12px;
  line-height: 1.5;
}

.of-message {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 20px;
  color: var(--text-base);
  font-size: 13px;
  text-align: center;
}
</style>
