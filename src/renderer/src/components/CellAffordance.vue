<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { t } from "../lib/i18n"

/**
 * MiMo's inline note box for documents (PDF, and the Office viewers): the same
 * row as the conversation's annotation box - a one-line note, an arrow that
 * appears once something is written, and "add to chat" - but pinned at once,
 * no entrance, and placed by the pointer: its right edge on the pointer, 8
 * above it (below when that leaves the viewer), kept 4 inside the viewer.
 * Enter sends, Shift+Enter breaks the line, Escape closes.
 */
const props = defineProps<{
  anchor: { x: number; y: number }
  /** The viewer's box, which the note box stays inside. */
  host: () => DOMRect | undefined
  /** Whether a press landed in the viewer, which does not close the box. */
  inside: (target: Node) => boolean
}>()
const emit = defineEmits<{ send: [text: string]; stash: [text: string]; close: [] }>()

const MAX_FIELD = 132
const WIDTH = 296

const text = defineModel<string>({ default: "" })
const box = ref<HTMLElement>()
const field = ref<HTMLTextAreaElement>()
const height = ref(40)

function grow() {
  const el = field.value
  if (!el) return
  el.style.height = "auto"
  el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD)}px`
  const measured = box.value?.offsetHeight
  if (measured && measured !== height.value) height.value = measured
}

watch(text, () => void nextTick(grow))
onMounted(() => void nextTick(grow))

const position = computed(() => {
  const host = props.host()
  if (!host) return null
  const gap = 8
  const inset = 4
  let left = props.anchor.x - WIDTH
  let top = props.anchor.y - height.value - gap
  if (top < host.top + inset) top = props.anchor.y + gap
  left = Math.min(Math.max(left, host.left + inset), Math.max(host.left + inset, host.right - WIDTH - inset))
  top = Math.min(Math.max(top, host.top + inset), Math.max(host.top + inset, host.bottom - height.value - inset))
  return { left, top }
})

function onKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    emit("send", text.value)
  } else if (event.key === "Escape") {
    event.preventDefault()
    emit("close")
  }
}

/* A press anywhere but the box or the viewer closes it. */
function outside(event: PointerEvent) {
  const target = event.target as Element | null
  if (!target || target.closest?.("[data-cell-affordance]") || props.inside(target)) return
  emit("close")
}

onMounted(() => document.addEventListener("pointerdown", outside, true))
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside, true))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="position"
      ref="box"
      class="cell-affordance"
      data-cell-affordance
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    >
      <textarea ref="field" v-model="text" rows="1" :placeholder="t('annotations.cellPlaceholder')" @keydown="onKey" />
      <button
        v-if="text.trim()"
        type="button"
        class="ca-send"
        data-ca-send
        :aria-label="t('annotations.send')"
        :title="t('annotations.send')"
        @click="emit('send', text)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
      </button>
      <button
        type="button"
        class="ca-stash"
        data-ca-stash
        :aria-label="t('annotations.stash')"
        :title="`${t('annotations.stash')}\n${t('annotations.stashTip')}`"
        @click="emit('stash', text)"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8.5 2.5H3.5a1.5 1.5 0 0 0-1.5 1.5v6.5a1.5 1.5 0 0 0 1.5 1.5H5v2.5l3-2.5h4.5a1.5 1.5 0 0 0 1.5-1.5V7.5" />
          <path d="M12.5 1v4.5M10.25 3.25h4.5" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.cell-affordance {
  position: fixed;
  z-index: 4000;
  display: flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  width: 296px;
  max-width: 92vw;
  padding: 5px 6px 5px 10px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: 0 2px 8px #0000000d, 0 1px 2px #0000000a;
}

:root[data-theme="dark"] .cell-affordance {
  box-shadow: 0 2px 8px #0000004d, 0 1px 2px #00000040;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .cell-affordance {
    box-shadow: 0 2px 8px #0000004d, 0 1px 2px #00000040;
  }
}

.cell-affordance textarea {
  display: block;
  flex: 1;
  min-width: 0;
  max-height: 132px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  color: var(--text-strong);
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 18px;
}

.ca-send,
.ca-stash {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 8px;
}

.ca-send {
  color: #fff;
  background: #3295fb;
  border: none;
}

.ca-stash {
  color: #3295fb;
  background: transparent;
  border: 1px solid var(--border-weak);
}
</style>
