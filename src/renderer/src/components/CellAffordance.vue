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
  /** A selection's box, which the note box sits above (right edges together) in place of the pointer. */
  selectionRect?: { top: number; bottom: number; right: number } | null
  /** Take focus whenever it is placed, as for a picked slide piece; a text selection leaves focus with the page. */
  autofocus?: boolean
}>()
const emit = defineEmits<{ send: [text: string]; stash: [text: string]; close: []; focus: [focused: boolean] }>()

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
watch(
  () => [props.autofocus, props.anchor],
  () => {
    if (props.autofocus) void nextTick(() => field.value?.focus())
  },
  { immediate: true },
)

const position = computed(() => {
  const host = props.host()
  if (!host) return null
  const gap = 8
  const inset = 4
  const rect = props.selectionRect
  let left = (rect ? rect.right : props.anchor.x) - WIDTH
  let top = (rect ? rect.top : props.anchor.y) - height.value - gap
  if (top < host.top + inset) top = (rect ? rect.bottom : props.anchor.y) + gap
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
      role="group"
      :aria-label="t('annotations.cellPlaceholder')"
      data-cell-affordance
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    >
      <textarea
        ref="field"
        v-model="text"
        rows="1"
        :aria-label="t('annotations.cellPlaceholder')"
        :placeholder="t('annotations.cellPlaceholder')"
        @keydown="onKey"
        @focus="emit('focus', true)"
        @blur="emit('focus', false)"
      />
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
        <!-- Remix Icon chat-new-line (Apache-2.0), the filled glyph MiMo draws here. -->
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" data-ca-stash-glyph>
          <path d="M9.33334 2V3.33333H2.66668V12.2567L3.84189 11.3333H13.3333V6.66667H14.6667V12C14.6667 12.3682 14.3682 12.6667 14 12.6667H4.30304L1.33334 15V2.66667C1.33334 2.29848 1.63182 2 2.00001 2H9.33334ZM12.6667 2V0H14V2H16V3.33333H14V5.33333H12.6667V3.33333H10.6667V2H12.6667Z" />
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
  box-shadow: var(--shadow-tip);
}

.cell-affordance textarea {
  display: block;
  flex: 1;
  min-width: 0;
  max-height: 132px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  color: var(--text-body);
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  /* Fixed as in MiMo's note box. */
  font-size: 12px;
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

.ca-send:focus-visible,
.ca-stash:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}
</style>
