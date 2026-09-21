<script setup lang="ts">
/**
 * One section of the info card, measured off MiMo's: a 14px medium title, a
 * chevron that points down while open and right while folded, and a count pill
 * at the end - grey, or green once a task list is all done.
 */
defineProps<{ name: string; title: string; open: boolean; count?: string | number; complete?: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <section class="section" :data-info-section="name">
    <button type="button" class="head" :aria-expanded="open" @click="emit('toggle')">
      <span class="title">{{ title }}</span>
      <svg v-if="open" class="chev" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <svg v-else class="chev" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.5 4.5 10 8l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="count" class="count" :class="{ complete }" data-info-count>{{ count }}</span>
    </button>
    <div v-if="open" class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.section {
  display: flex;
  flex: none;
  flex-direction: column;
}

/* MiMo's rule between sections: 13 above it and 13 below. */
.section + .section {
  margin-top: 13px;
  padding-top: 13px;
  border-top: 1px solid var(--border-weak);
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(18px * var(--ui-font-scale, 1));
  text-align: start;
}

.chev {
  flex: none;
  color: var(--text-weak);
}

.count {
  margin-inline-start: auto;
  padding: 0 6px;
  color: var(--text-weak);
  background: color-mix(in srgb, var(--text-strong) 9.5%, var(--surface-raised));
  border-radius: 999px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  line-height: calc(16px * var(--ui-font-scale, 1));
}

/* MiMo's --color-done, one value in both schemes; restated for dark so a theme cannot tint it. */
.count.complete {
  color: #21a366;
  background: rgb(33 163 102 / 0.12);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .count.complete {
    color: #21a366;
    background: rgb(33 163 102 / 0.12);
  }
}

:root[data-theme="dark"] .count.complete {
  color: #21a366;
  background: rgb(33 163 102 / 0.12);
}
</style>
