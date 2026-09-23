<script setup lang="ts">
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * MiMo's own confirm for switching to full access, rather than the shared one.
 *
 * 430 wide on a 16px corner at 22 by 24; a head row with a 16px title and a
 * 30px close; the description at 14px in the text colour, 1.65 line height;
 * then 取消 and a light red confirm led by a warning triangle. Nothing is
 * focused when it opens, so Enter cannot turn full access on by accident.
 * The body is MiMo's sentence with MCode's name in it, which is true of MCode.
 */
const emit = defineEmits<{ close: []; confirm: [] }>()

useEscapeLayer(() => emit("close"))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog" data-full-access-confirm data-modal-keep-focus aria-labelledby="full-access-title">
      <div class="head">
        <h2 id="full-access-title">{{ t("composer.access.confirmTitle") }}</h2>
        <button class="close" type="button" :aria-label="t('common.close')" v-tip="t('common.close')" data-full-access-close @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <p class="desc">{{ t("composer.access.confirmBody") }}</p>
      <footer>
        <button class="ghost" type="button" data-full-access-cancel @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="confirm" type="button" data-full-access-ok @click="emit('confirm')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          {{ t("composer.access.confirmOk") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

.dialog {
  box-sizing: border-box;
  width: min(430px, 88vw);
  padding: 22px 24px;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-pop);
  outline: none;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-block-end: 10px;
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.close {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-inline-end: -6px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 8px;
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* MiMo's permc-desc: 14px in --color-txt (#151c13cc light, #f4f4f5 dark). */
.desc {
  margin: 0 0 20px;
  color: #151c13cc;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.65;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.ghost,
.confirm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  cursor: pointer;
}

.ghost {
  color: var(--text-base);
  background: #fffefd;
  border-color: var(--border-weak);
}

.ghost:hover {
  color: var(--text-strong);
  background: #f1f0ec;
}

.confirm {
  color: #d93025;
  background: #fdecea;
  border-color: #fdecea;
}

.confirm:hover {
  background: #fadbd8;
  border-color: #fadbd8;
}

:root[data-theme="dark"] .desc {
  color: #f4f4f5;
}

:root[data-theme="dark"] .ghost {
  background: #1a1a1a;
}

:root[data-theme="dark"] .ghost:hover {
  background: #ffffff0f;
}

:root[data-theme="dark"] .confirm {
  color: #ff9b7f;
  background: #3a2320;
  border-color: #3a2320;
}

:root[data-theme="dark"] .confirm:hover {
  background: #4a2c27;
  border-color: #4a2c27;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .desc {
    color: #f4f4f5;
  }

  :root:not([data-theme="light"]) .ghost {
    background: #1a1a1a;
  }

  :root:not([data-theme="light"]) .ghost:hover {
    background: #ffffff0f;
  }

  :root:not([data-theme="light"]) .confirm {
    color: #ff9b7f;
    background: #3a2320;
    border-color: #3a2320;
  }

  :root:not([data-theme="light"]) .confirm:hover {
    background: #4a2c27;
    border-color: #4a2c27;
  }
}
</style>
