<script setup lang="ts">
import { dismiss, hold, release, toasts, type ToastLink } from "../lib/toast"
import { t } from "../lib/i18n"

/* A link runs its step, then the notice has done its job. */
function follow(id: string, link: ToastLink) {
  link.run()
  dismiss(id)
}
</script>

<template>
  <!--
    MiMo's notices: one capsule per line, centred 8px under the top edge of the
    window, the newest last. The column lets clicks through; only a capsule
    takes the pointer.
  -->
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="notice"
        :class="toast.level"
        :data-level="toast.level"
        @mouseenter="hold(toast.id)"
        @mouseleave="release(toast.id)"
      >
        <svg
          class="mark"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="toast.level === 'warning'">
            <path d="M12 3.8 21.2 19.8H2.8z" />
            <path d="M12 10v4.2M12 17v.2" />
          </template>
          <template v-else>
            <circle cx="12" cy="12" r="9.2" />
            <path v-if="toast.level === 'success'" d="m8 12.3 2.8 2.8 5.2-5.4" />
            <path v-else-if="toast.level === 'danger'" d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
            <path v-else d="M12 11.2v5.2M12 7.6v.2" />
          </template>
        </svg>
        <span class="text">
          <span class="title">{{ toast.title }}</span>
          <span v-if="toast.body" class="body">{{ toast.body }}</span>
          <button v-for="link in toast.links" :key="link.label" class="link" @click="follow(toast.id, link)">
            {{ link.label }}
          </button>
        </span>
        <button v-if="toast.closable" class="close" :aria-label="t('common.close')" @click="dismiss(toast.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  top: 8px;
  inset-inline: 16px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  pointer-events: none;
}

/* MiMo's capsule, measured: 16 round, 8 by 12 of padding, 13px text on a 1.3 line. */
.notice {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  max-width: min(560px, 100%);
  padding: 8px 12px;
  color: var(--text-strong);
  background: #ffffff;
  border: 1px solid #ececec;
  border-radius: 16px;
  box-shadow:
    0 8px 30px #0000002e,
    0 1px 3px #0000001a;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.3;
  pointer-events: auto;
}

.notice.success {
  background: #e5f3ff;
  border-color: #c9e6ff;
}

.notice.warning {
  background: #ffe7d9;
  border-color: #ffd0b8;
}

.notice.danger {
  background: #ffd9d9;
  border-color: #ffbdbd;
}

:root[data-theme="dark"] .notice {
  background: #2e2e2e;
  border-color: #3a3a3a;
  box-shadow:
    0 8px 30px #00000099,
    0 1px 3px #00000066;
}

:root[data-theme="dark"] .notice.success {
  background: #00284d;
  border-color: #0a3f75;
}

:root[data-theme="dark"] .notice.warning {
  background: #4a2206;
  border-color: #6b3309;
}

:root[data-theme="dark"] .notice.danger {
  background: #4d100e;
  border-color: #711a16;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .notice {
    background: #2e2e2e;
    border-color: #3a3a3a;
    box-shadow:
      0 8px 30px #00000099,
      0 1px 3px #00000066;
  }

  :root:not([data-theme="light"]) .notice.success {
    background: #00284d;
    border-color: #0a3f75;
  }

  :root:not([data-theme="light"]) .notice.warning {
    background: #4a2206;
    border-color: #6b3309;
  }

  :root:not([data-theme="light"]) .notice.danger {
    background: #4d100e;
    border-color: #711a16;
  }
}

/* 14 square, a pixel down so it sits on the first line. */
.mark {
  flex: none;
  margin-block-start: 1px;
}

.text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.body {
  margin-inline-start: 6px;
  color: var(--text-weak);
}

/* MiMo's links: blue, 8 after the title, underlined only under the pointer. */
.link {
  margin-inline-start: 8px;
  padding: 0;
  color: #2f6fed;
  font: inherit;
  line-height: inherit;
  vertical-align: baseline;
  background: none;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

:root[data-theme="dark"] .link {
  color: #5a9cff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .link {
    color: #5a9cff;
  }
}

/* The close mark is a glyph at half strength, fully drawn under the pointer. */
.close {
  flex: none;
  margin-inline-end: -4px;
  padding: 0 4px;
  color: inherit;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.4;
  background: none;
  border-radius: 999px;
  opacity: 0.5;
  cursor: pointer;
}

.close:hover {
  background: var(--surface-hover);
  opacity: 1;
}

/* Down from the top edge it sits against, and back up the same way. */
.toast-enter-active {
  transition:
    opacity 0.15s ease-out,
    transform 0.15s ease-out;
}

.toast-leave-active {
  transition:
    opacity 0.1s ease-in,
    transform 0.1s ease-in;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: opacity 0.15s ease;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>
