<script setup lang="ts">
import { computed, ref } from "vue"
import type { CustomProvider } from "@shared/protocol"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"
import CustomProviderForm from "./CustomProviderForm.vue"

/**
 * MiMo's add / edit model dialog, which the quick-add 自定义 chip and 编辑 both open.
 *
 * 640 wide (at most the window less 2rem), at most 90vh, an 18px corner on a
 * line. A header ruled off below with a 20px semibold title, a scrolling body
 * padded 22 by 24, and a footer ruled off above with 取消 and 保存 (保存中…
 * while saving) at its end.
 */
const props = defineProps<{ editing?: CustomProvider }>()
const emit = defineEmits<{ close: [] }>()

const form = ref<InstanceType<typeof CustomProviderForm>>()
const busy = computed(() => Boolean(form.value?.busy))
const canSave = computed(() => Boolean(form.value?.canSave))

async function save() {
  if (!form.value) return
  if (await form.value.submit()) emit("close")
}

useEscapeLayer(() => emit("close"))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-custom-model-dialog aria-labelledby="custom-model-title">
      <header class="head">
        <h2 id="custom-model-title">{{ t(props.editing ? "model.editTitle" : "model.addTitle") }}</h2>
      </header>
      <div class="body">
        <CustomProviderForm ref="form" framed :editing="props.editing" :autofocus="!props.editing" />
      </div>
      <footer class="foot">
        <button type="button" class="ghost" data-custom-model-cancel @click="emit('close')">{{ t("common.cancel") }}</button>
        <button type="button" class="primary" data-custom-model-save :disabled="busy || !canSave" @click="save">
          {{ busy ? t("common.saving") : t("common.save") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

.dialog {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(640px, calc(100% - 2rem));
  max-height: 90vh;
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 18px;
  box-shadow: var(--shadow-overlay);
  outline: none;
}

.head {
  flex: none;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-weak);
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(20px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.body {
  flex: 1;
  min-height: 0;
  padding: 22px 24px;
  overflow-y: auto;
}

.foot {
  display: flex;
  flex: none;
  justify-content: flex-end;
  gap: 12px;
  padding: 20px 24px;
  border-top: 1px solid var(--border-weak);
}

.ghost,
.primary {
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  cursor: pointer;
}

.ghost {
  color: var(--text-base);
  background: transparent;
}

.ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.primary {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}

.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
