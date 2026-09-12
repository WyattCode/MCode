<script setup lang="ts">
import { dismiss, toasts } from "../lib/toast"
import { t } from "../lib/i18n"
</script>

<template>
  <!--
    Above the composer rather than centred: a confirmation should be findable
    without taking over the view it is confirming something about.
  -->
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">
        <!--
          The mark says which of the two things happened. One tick for
          everything meant a failure was confirmed as a success.
        -->
        <svg class="mark" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
          <path
            v-if="toast.kind === 'failed'"
            d="M8 4.6V8.9"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <circle v-if="toast.kind === 'failed'" cx="8" cy="11.2" r="0.8" fill="currentColor" />
          <path
            v-else
            d="M5.2 8.2 7.1 10.1 10.9 6.3"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div class="text">
          <div class="title">{{ toast.title }}</div>
          <div v-if="toast.body" class="body">{{ toast.body }}</div>
        </div>
        <button
          v-if="toast.action"
          class="act"
          @click="(toast.action.run(), dismiss(toast.id))"
        >
          {{ toast.action.label }}
        </button>
        <button class="close" v-tip="{ label: t('common.close'), placement: 'top' }" @click="dismiss(toast.id)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  /* The corner a line of text finishes in, so a toast arrives where the eye
     already is and its own row - message, action, dismiss - still reads in
     the order the rest of the app does. */
  inset-inline-end: 32px;
  bottom: 48px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  /*
   * 12 between the icon and the text, and 320 wide - both opencode's:
   * `[data-slot="toast-v2-header"] { gap: 12px }` and
   * `.toast-v2-region { max-width: min(320px, calc(100vw - 64px)) }`. This was
   * 20 and 400, which made a one-line toast a wide, loosely-spaced band.
   */
  gap: 12px;
  width: min(320px, calc(100vw - 64px));
  padding: 16px 20px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  pointer-events: auto;
}

/* Sits between the message and the dismiss control, on the same baseline. */
.act {
  flex-shrink: 0;
  align-self: center;
  height: 24px;
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.act:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

/*
 * `16x20`, not 16 square: opencode's `[data-slot="toast-v2-icon"]` is 16 wide
 * and 20 tall, which is the text's line box, so the glyph centres against the
 * first line instead of being nudged down by a margin.
 */
.mark {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  color: var(--success);
}

.toast.failed .mark {
  color: var(--error);
}

.text {
  flex: 1;
  min-width: 0;
}

/*
 * Both lines are 13/20 with the same tracking, and only the weight and the
 * colour separate them - which is what opencode's own rules say:
 *
 *   [data-slot="toast-v2-title"]       { 13px / 530 / 20px; -0.04px; text-base }
 *   [data-slot="toast-v2-description"] { 13px / 440 / 20px; -0.04px; text-muted }
 *
 * These were 13.5/1.45 and 12.5/1.55, two sizes and two leadings that met
 * nothing else in the app.
 */
.title {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.04px;
}

.body {
  /* 4 between them, from `[data-slot="toast-v2-content"] { gap: 4px }`. */
  margin-top: 4px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 20px;
  letter-spacing: -0.04px;
}

.close {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--text-weaker);
  border-radius: var(--radius-sm);
}

.close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * Up from the edge it sits against, and back down the same way.
 *
 * Leaving is quicker than arriving: a toast on its way out is no longer being
 * read, and lingering makes the next one feel late.
 */
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
  transform: translateY(20px);
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
