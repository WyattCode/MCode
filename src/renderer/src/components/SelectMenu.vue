<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { typeAheadBuffer, typeAheadMatch } from "../lib/type-ahead"

/**
 * Dropdown drawn in-app.
 *
 * A native <select> renders its popup with the OS widget - system highlight
 * colour, system border, system font - which cannot be themed and looks
 * pasted-on next to everything else here.
 *
 * The list is teleported to <body> and positioned fixed rather than being
 * absolutely positioned inside the component. Anchoring it to the trigger's own
 * box means any ancestor that clips - a rounded card with overflow:hidden, a
 * scrolling pane, the dialog itself - swallows the popup, which is exactly what
 * happened in settings: the menu was in the DOM and measured 129x169, but only
 * a sliver of its edge ever painted.
 */
export interface SelectOption {
  value: string
  label: string
  /** Draws a rule above that option, to set it apart from the list. */
  divider?: boolean
  /**
   * MiMo's app picker draws each app's icon before its name. An empty string
   * asks for the name's first letter on a tile instead; undefined draws nothing.
   */
  icon?: string
}

const props = defineProps<{
  modelValue: string
  options: SelectOption[]
  /** Widen when the labels are long; the trigger sizes to this. */
  width?: number
}>()

const emit = defineEmits<{ "update:modelValue": [value: string] }>()

/* MiMo's item: 6px above and below a 20px line. */
const ROW = 32
const GAP = 4
const MARGIN = 12

const open = ref(false)
const root = ref<HTMLElement>()
/** Row the keyboard is on; -1 while the pointer is driving. */
const active = ref(-1)
const box = ref({ left: 0, top: 0, width: 0, maxHeight: 0, flip: false })

const chosen = computed(() => props.options.find((option) => option.value === props.modelValue))
const label = computed(() => chosen.value?.label ?? props.modelValue)

/** Anchors the popup to the trigger, flipping up when the room below runs out. */
function place() {
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const wanted = props.options.length * ROW + props.options.filter((option) => option.divider).length * 9 + 12
  const below = window.innerHeight - rect.bottom - MARGIN - GAP
  const above = rect.top - MARGIN - GAP
  const flip = below < wanted && above > below
  box.value = {
    left: rect.left,
    top: flip ? rect.top - GAP : rect.bottom + GAP,
    width: rect.width,
    maxHeight: Math.max(ROW * 2, Math.min(wanted, flip ? above : below)),
    flip,
  }
}

function toggle() {
  open.value = !open.value
  if (!open.value) return
  place()
  // Open on the current value, so the first arrow press moves from there.
  active.value = props.options.findIndex((option) => option.value === props.modelValue)
}

function choose(value: string) {
  open.value = false
  if (value !== props.modelValue) emit("update:modelValue", value)
}

function onPointerDown(event: MouseEvent) {
  const target = event.target as Node
  if (root.value?.contains(target)) return
  // The popup no longer lives inside the component, so it needs its own test.
  if ((target as HTMLElement)?.closest?.(".select-pop")) return
  open.value = false
}

/**
 * Keyboard handling the native <select> gave for free.
 *
 * Replacing it with a drawn menu quietly removed arrow-key selection, so the
 * control could only be operated with a mouse - worse than what it replaced.
 */
const typed = typeAheadBuffer()

/*
 * MiMo's settings dropdown types ahead, open or closed: open, the typed text
 * moves the highlighted row; closed, it picks the next matching value, as a
 * select does.
 */
function typeAhead(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.key.length !== 1) return false
  if (event.key === " " && !typed.searching()) return false
  const labels = props.options.map((option) => option.label)
  const current = open.value ? active.value : props.options.findIndex((option) => option.value === props.modelValue)
  const hit = typeAheadMatch(labels, current, typed.push(event.key))
  event.preventDefault()
  if (hit < 0) return true
  if (open.value) active.value = hit
  else choose(props.options[hit].value)
  return true
}

function onKeydown(event: KeyboardEvent) {
  const focused = root.value?.contains(document.activeElement)

  if (!open.value) {
    if (!focused) return
    if (typeAhead(event)) return
    // MiMo's trigger opens on Space as well as the arrows and Enter.
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      toggle()
    }
    return
  }

  if (typeAhead(event)) return

  const last = props.options.length - 1
  switch (event.key) {
    case "Escape":
      event.preventDefault()
      open.value = false
      break
    case "ArrowDown":
      event.preventDefault()
      active.value = active.value >= last ? 0 : active.value + 1
      break
    case "ArrowUp":
      event.preventDefault()
      active.value = active.value <= 0 ? last : active.value - 1
      break
    case "Home":
      event.preventDefault()
      active.value = 0
      break
    case "End":
      event.preventDefault()
      active.value = last
      break
    case "Enter":
    case " ":
      event.preventDefault()
      if (active.value >= 0) choose(props.options[active.value].value)
      break
    case "Tab":
      open.value = false
      break
  }
}

/** Keeps the highlighted row visible when arrowing past the fold. */
watch(active, async (index) => {
  if (!open.value || index < 0) return
  await nextTick()
  document.querySelectorAll<HTMLElement>(".select-pop .item")[index]?.scrollIntoView({ block: "nearest" })
})

/** Fixed coordinates go stale the moment anything scrolls underneath. */
function reflow() {
  if (open.value) place()
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  // Capture, so an open list takes Escape before a dialog that mounted earlier sees it and closes too.
  window.addEventListener("keydown", onKeydown, true)
  window.addEventListener("scroll", reflow, true)
  window.addEventListener("resize", reflow)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown, true)
  window.removeEventListener("scroll", reflow, true)
  window.removeEventListener("resize", reflow)
})
</script>

<template>
  <div ref="root" class="select" :style="{ width: width ? `${width}px` : undefined }">
    <button class="trigger" :class="{ open }" @click="toggle">
      <slot name="icon" />
      <template v-if="chosen?.icon !== undefined">
        <img v-if="chosen.icon" class="opt-icon" :src="chosen.icon" alt="" data-select-icon />
        <span v-else class="opt-letter" data-select-icon>{{ chosen.label.slice(0, 1) }}</span>
      </template>
      <span class="label">{{ label }}</span>
      <svg class="caret" :class="{ up: open }" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        class="select-pop"
        :class="{ flip: box.flip }"
        :style="{
          left: `${box.left}px`,
          top: `${box.top}px`,
          maxHeight: `${box.maxHeight}px`,
        }"
      >
        <template v-for="(option, index) in options" :key="option.value">
          <div v-if="option.divider" class="rule" role="separator" />
          <button
            class="item"
            :class="{ on: option.value === modelValue, active: index === active }"
            @click="choose(option.value)"
            @mousemove="active = index"
          >
            <template v-if="option.icon !== undefined">
              <img v-if="option.icon" class="opt-icon" :src="option.icon" alt="" data-select-option-icon />
              <span v-else class="opt-letter" data-select-option-icon>{{ option.label.slice(0, 1) }}</span>
            </template>
            <span class="item-label">{{ option.label }}</span>
            <svg v-if="option.value === modelValue" class="item-check" width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 6.4 4.7 8.6 9.5 3.8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" />
            </svg>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * Sized by what it says. opencode's select-v2 trigger measures 84x24 for a
 * value like "深色" - it is a ghost control that fits its text - and its
 * popup is sized separately (min 160, max 23rem, content between). This root
 * used to hold a 130px floor and callers passed 150-180px on top of it, so
 * every trigger was a wide box whatever it held.
 */
.select {
  position: relative;
  flex-shrink: 0;
  width: fit-content;
  min-width: 0;
}

/*
 * Measured on opencode's settings page: `height: 24px; padding: 4px 4px 4px
 * 8px; gap: 4px; border-radius: 4px`, transparent, no border, no shadow. The
 * value inside is 13px/530/16px and the chevron a 16-box. The settings dialog
 * restyles it as MiMo's bordered select.
 */
.trigger {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  height: calc(24px * var(--ui-font-scale, 1));
  padding: 4px 4px 4px 8px;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  border-radius: 4px;
  outline: 1px solid transparent;
  outline-offset: 0;
  font-size: calc(13px * var(--ui-font-scale, 1));
  transition: outline-color 0.12s, background 0.12s;
}

/* A ghost shows itself on hover and while open, with the same overlay every
   other ghost control here uses. */
.trigger:hover,
.trigger.open {
  background: var(--surface-hover);
}

.trigger:focus-visible {
  outline-color: var(--interactive);
}

.label {
  overflow: hidden;
  font-weight: 530;
  line-height: calc(16px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  flex-shrink: 0;
  color: var(--text-weak);
  transition: transform 0.14s;
}

.caret.up {
  transform: rotate(180deg);
}
</style>

<style>
/*
 * Unscoped: the popup is teleported out of the component, so a scoped rule
 * would not reach it. Sits above the settings dialog (z-index 120).
 *
 * MiMo's select popup: 12 round, a 1px line, the menu glass with its 18px blur,
 * 5px of padding; rows 8 round at 6 / 32 / 6 / 8 with the check at the end.
 */
.select-pop {
  width: max-content;
  min-width: 160px;
  max-width: 23rem;
  position: fixed;
  z-index: 200;
  box-sizing: border-box;
  padding: 5px;
  background: var(--surface-menu);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
  max-height: 12rem;
  overflow-x: hidden;
  overflow-y: auto;
}

.select-pop .rule {
  flex: none;
  height: 1px;
  margin: 4px 6px;
  background: var(--border-weak);
}

.select-pop.flip {
  transform: translateY(-100%);
}

.select-pop .item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 32px 6px 8px;
  color: var(--text-strong);
  text-align: start;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.select-pop .item-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.select-pop .item-check {
  position: absolute;
  inset-inline-end: 10px;
}

.select-pop .item:hover,
.select-pop .item.active {
  background: var(--surface-hover);
}

/* MiMo's picked row carries only the check; the fill is the focused row's. */
.select-pop .item.on:not(.active) {
  background: transparent;
}

/* MiMo's app tile: an 18px icon on a 4px corner, or the name's first letter on the side fill. */
.select .opt-icon,
.select .opt-letter,
.select-pop .opt-icon,
.select-pop .opt-letter {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 4px;
}

.select .opt-letter,
.select-pop .opt-letter {
  display: grid;
  place-items: center;
  color: var(--text-weak);
  background: var(--surface-hover);
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: 1;
}

.select .opt-icon,
.select .opt-letter {
  margin-inline-end: 6px;
}
</style>
