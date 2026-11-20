<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { HooksListing } from "@shared/hooks"
import { t } from "../lib/i18n"

const props = defineProps<{
  directory?: string
  request: (type: "hooks.list" | "hooks.reload", directory?: string) => Promise<HooksListing | undefined>
}>()
const emit = defineEmits<{ reloaded: [] }>()
const listing = ref<HooksListing>()
const busy = ref(false)
const failed = ref(false)
const hasRows = computed(() => listing.value?.groups.some((group) => group.rows.length))
let generation = 0

async function load(type: "hooks.list" | "hooks.reload") {
  const current = ++generation
  busy.value = true
  failed.value = false
  try {
    const next = await props.request(type, props.directory)
    if (current !== generation) return
    if (!next) throw new Error("Hooks request unavailable")
    listing.value = next
    if (type === "hooks.reload") emit("reloaded")
  } catch {
    if (current === generation) failed.value = true
  } finally {
    if (current === generation) busy.value = false
  }
}

watch(() => props.directory, () => {
  listing.value = undefined
  void load("hooks.list")
}, { immediate: true })
</script>

<template>
  <h2>{{ t("set.hooks.title") }}</h2>
  <p class="page-sub">{{ t("set.hooks.subtitle") }}</p>
  <button type="button" class="ctl-btn" :disabled="busy" @click="load('hooks.reload')">{{ t("set.hooks.reload") }}</button>
  <p v-if="failed" role="alert" class="line-sub">{{ t("set.hooks.loadFailed") }}</p>
  <div v-if="listing && !hasRows" class="hooks-empty">
    <strong>{{ t("set.hooks.empty") }}</strong>
    <p class="line-sub">{{ t("set.hooks.emptyDescription") }}</p>
  </div>
  <section v-for="group in listing?.groups" :key="group.scope" class="hooks-scope">
    <h3>{{ t(`set.hooks.scope.${group.scope}`, { name: group.name ?? "" }) }}</h3>
    <p v-if="!group.rows.length && hasRows" class="line-sub">{{ t("set.hooks.empty") }}</p>
    <dl v-for="(row, index) in group.rows" :key="index" class="hooks-row">
      <template v-if="row.event">
        <dt>{{ t("set.hooks.event") }}</dt><dd>{{ row.event }}</dd>
      </template>
      <template v-if="row.matcher !== undefined">
        <dt>matcher</dt><dd><code>{{ row.matcher }}</code></dd>
      </template>
      <template v-if="row.command !== undefined">
        <dt>{{ t("set.hooks.command") }}</dt><dd><code>{{ row.command }}</code></dd>
      </template>
      <dt>{{ t("set.hooks.source") }}</dt><dd><code>{{ row.source }}</code></dd>
      <template v-if="row.reason">
        <dt>{{ t("set.hooks.skipped") }}</dt><dd>{{ t(`set.hooks.reason.${row.reason}`) }}</dd>
      </template>
    </dl>
  </section>
</template>

<style scoped>
h2 { margin: 0 0 6px; color: var(--text-strong); }
.page-sub, .line-sub { color: var(--text-base); font-size: calc(13px * var(--ui-font-scale, 1)); }
.page-sub { margin: 0 0 14px; line-height: 1.5; }
.line-sub { margin: 4px 0 0; }
.ctl-btn {
  min-height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}
.ctl-btn:disabled { opacity: 0.4; cursor: default; }
.hooks-scope, .hooks-empty { margin-block-start: 20px; }
.hooks-scope h3 { margin: 0 0 8px; font-size: 0.95em; }
.hooks-row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 12px;
  margin: 0;
  padding: 10px 0;
  border-top: 1px solid var(--border-weak);
  font-size: 0.9em;
}
.hooks-row dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.hooks-row dt { opacity: 0.75; }
</style>
