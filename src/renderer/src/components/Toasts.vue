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
  gap: 20px;
  width: min(400px, calc(100vw - 64px));
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
  font-size: 12px;
  font-weight: 500;
}

.act:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.mark {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--success);
}

.toast.failed .mark {
  color: var(--error);
}

.text {
  flex: 1;
  min-width: 0;
}

.title {
  color: var(--text-strong);
  font-size: 13.5px;
  line-height: 1.45;
}

.body {
  margin-top: 3px;
  color: var(--text-weaker);
  font-size: 12.5px;
  line-height: 1.55;
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
