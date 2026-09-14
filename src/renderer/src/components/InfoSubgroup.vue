<script setup lang="ts">
/** A folded group inside an info card section: MiMo's 用户上传, 项目文件, 更多 and 中间产物. */
defineProps<{ name: string; title: string; open: boolean; count: number }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <div class="subgroup" :data-info-subgroup="name">
    <button type="button" class="head" :aria-expanded="open" @click="emit('toggle')">
      <svg v-if="open" class="chev" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <svg v-else class="chev" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.5 4.5 10 8l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="title">{{ title }}</span>
      <span class="count">{{ count }}</span>
    </button>
    <div v-if="open" class="body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.subgroup {
  display: flex;
  flex-direction: column;
}

.subgroup + .subgroup {
  margin-top: 9px;
}

.head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 18px;
  text-align: start;
}

.head:hover {
  color: var(--text-base);
}

.chev {
  flex: none;
}

.count {
  margin-inline-start: auto;
  padding-inline-end: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 5px;
  padding-inline-start: 17px;
}
</style>
