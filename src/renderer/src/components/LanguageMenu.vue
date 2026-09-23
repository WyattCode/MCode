<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue"
import { LANGUAGES, t } from "../lib/i18n"
import { composing } from "../lib/keys"
import { onMenuRowKey } from "../lib/menu-keys"

/**
 * MiMo's language picker: a bordered trigger that opens a searchable list.
 *
 * The list has a search row whose keys stay inside the field, a pinned
 * 自动检测 row the search never hides, then the languages sorted by name and
 * filtered by what is typed. An empty value is "follow the system", which is
 * what the config has always meant by a blank language.
 */
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()

const GAP = 4
const EDGE = 12
const WIDTH = 240

const root = ref<HTMLElement>()
const pop = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const open = ref(false)
const query = ref("")
const box = ref({ left: 0, top: 0, maxHeight: 320, flip: false })

const label = computed(() =>
  props.modelValue ? (LANGUAGES.find((entry) => entry.id === props.modelValue)?.label ?? props.modelValue) : t("set.langSystem"),
)

// MiMo orders by language code, not by the label, and filtering keeps that order.
const sorted = computed(() => [...LANGUAGES].sort((a, b) => a.id.localeCompare(b.id, "en-US")))
const matches = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return needle ? sorted.value.filter((entry) => entry.label.toLocaleLowerCase().includes(needle)) : sorted.value
})

/* Aligned to the trigger's end edge, flipping above when the room below runs out. */
function place() {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) return
  const rtl = document.documentElement.dir === "rtl"
  const below = window.innerHeight - rect.bottom - EDGE - GAP
  const above = rect.top - EDGE - GAP
  const flip = below < 240 && above > below
  const left = rtl ? rect.left : rect.right - WIDTH
  box.value = {
    left: Math.max(EDGE, Math.min(left, window.innerWidth - WIDTH - EDGE)),
    top: flip ? rect.top - GAP : rect.bottom + GAP,
    maxHeight: Math.max(160, Math.min(360, flip ? above : below)),
    flip,
  }
}

async function toggle() {
  if (open.value) return close()
  open.value = true
  place()
  await nextTick()
  search.value?.focus()
}

/* The query goes with the menu, so it opens on the full list next time. */
function close() {
  open.value = false
  query.value = ""
}

function choose(value: string) {
  close()
  if (value !== props.modelValue) emit("update:modelValue", value)
}

/* Keys typed into the search stay there: no type-ahead, no dialog shortcuts. */
function onSearchKey(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === "Escape") {
    event.preventDefault()
    close()
  } else if (event.key === "Enter" && !composing(event)) {
    event.preventDefault()
    const first = matches.value[0]
    if (first) choose(first.id)
  }
}

/* MiMo's menu keys over the rows, once focus has left the search for them. */
function onRowKey(event: KeyboardEvent) {
  onMenuRowKey(event, [...(pop.value?.querySelectorAll<HTMLElement>(".lang-item") ?? [])])
}

function onPointerDown(event: MouseEvent) {
  if (!open.value) return
  const target = event.target as Node
  if (root.value?.contains(target) || pop.value?.contains(target)) return
  close()
}

function onKeydown(event: KeyboardEvent) {
  if (open.value && event.key === "Escape") {
    event.stopPropagation()
    close()
  }
}

function reflow() {
  if (open.value) place()
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown, true)
  window.addEventListener("resize", reflow)
  window.addEventListener("scroll", reflow, true)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown, true)
  window.removeEventListener("resize", reflow)
  window.removeEventListener("scroll", reflow, true)
})
</script>

<template>
  <div ref="root" class="lang-menu">
    <button class="lang-trigger" type="button" data-language-trigger :aria-expanded="open" aria-haspopup="listbox" @click="toggle">
      <span class="lang-label">{{ label }}</span>
      <svg class="lang-caret" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="pop"
        class="lang-pop"
        :class="{ flip: box.flip }"
        data-language-menu
        role="listbox"
        :style="{ left: `${box.left}px`, top: `${box.top}px`, maxHeight: `${box.maxHeight}px` }"
        @keydown="onRowKey"
      >
        <div class="lang-search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          <input
            ref="search"
            v-model="query"
            class="lang-search-input"
            data-language-search
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('set.langSearch')"
            :aria-label="t('set.langSearch')"
            @keydown="onSearchKey"
          />
        </div>
        <!-- MiMo pins 自动检测 above the scrolling list, with no rule after it. -->
        <button class="lang-item" type="button" role="option" data-language-option="" :aria-selected="!modelValue" @click="choose('')">
          <span>{{ t("set.langSystem") }}</span>
          <svg v-if="!modelValue" class="lang-check" width="16" height="16" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6.4 4.7 8.6 9.5 3.8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" />
          </svg>
        </button>
        <div class="lang-list">
          <button
            v-for="entry in matches"
            :key="entry.id"
            class="lang-item"
            type="button"
            role="option"
            :data-language-option="entry.id"
            :aria-selected="entry.id === modelValue"
            @click="choose(entry.id)"
          >
            <span>{{ entry.label }}</span>
            <svg v-if="entry.id === modelValue" class="lang-check" width="16" height="16" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 6.4 4.7 8.6 9.5 3.8" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" />
            </svg>
          </button>
          <div v-if="!matches.length" class="lang-empty" data-language-empty>{{ t("set.langNoMatch") }}</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.lang-menu {
  flex-shrink: 0;
}

/* MiMo's select override for the language row: 28 tall, 8 round, the input border, 14/500. */
.lang-trigger {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 8px 0 12px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid #e3e3e0;
  border-radius: 8px;
  box-shadow: var(--shadow-xs);
  font-size: calc(14px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.lang-label {
  font-weight: 500;
}

.lang-caret {
  flex-shrink: 0;
  opacity: 0.5;
}

:root[data-theme="dark"] .lang-trigger {
  background: rgb(58 58 58 / 0.3);
  border-color: #3a3a3a;
}

:root[data-theme="dark"] .lang-trigger:hover {
  background: rgb(58 58 58 / 0.5);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .lang-trigger {
    background: rgb(58 58 58 / 0.3);
    border-color: #3a3a3a;
  }

  :root:not([data-theme="light"]) .lang-trigger:hover {
    background: rgb(58 58 58 / 0.5);
  }
}
</style>

<style>
/*
 * Unscoped: the list is teleported out of the component. MiMo's lang-menu:
 * 16 round on a half-pixel input border with the menu glass, 5px of padding,
 * a rule-less search row, the pinned 自动检测 row, then 14px rows 1px apart
 * whose picked one carries only a 16px check in the send colour.
 */
.lang-pop {
  position: fixed;
  z-index: 200;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 240px;
  max-height: 380px;
  padding: 5px;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-composer);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
}

.lang-pop.flip {
  transform: translateY(-100%);
}

.lang-pop .lang-search {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  margin: -5px -5px 4px;
  padding: 11px 15px 6px;
  color: var(--text-weak);
}

.lang-pop .lang-search svg {
  width: 15px;
  height: 15px;
}

.lang-pop .lang-search-input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.lang-pop .lang-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  overflow-y: auto;
}

.lang-pop .lang-item {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  color: var(--text-strong);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.lang-pop .lang-item:hover {
  background: var(--surface-hover);
}

.lang-pop .lang-check {
  flex-shrink: 0;
  color: var(--button-primary);
}

.lang-pop .lang-empty {
  padding: 14px 10px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}
</style>
