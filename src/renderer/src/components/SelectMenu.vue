<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

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
const props = defineProps<{
  modelValue: string
  /** `divider` draws a rule above that option, to set it apart from the list. */
  options: { value: string; label: string; divider?: boolean }[]
  /** Widen when the labels are long; the trigger sizes to this. */
  width?: number
}>()

const emit = defineEmits<{ "update:modelValue": [value: string] }>()

const ROW = 32
const GAP = 4
const MARGIN = 12

const open = ref(false)
const root = ref<HTMLElement>()
/** Row the keyboard is on; -1 while the pointer is driving. */
const active = ref(-1)
const box = ref({ left: 0, top: 0, width: 0, maxHeight: 0, flip: false })

const label = computed(
  () => props.options.find((option) => option.value === props.modelValue)?.label ?? props.modelValue,
)

/** Anchors the popup to the trigger, flipping up when the room below runs out. */
function place() {
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const wanted = props.options.length * ROW + props.options.filter((option) => option.divider).length * 9 + 8
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
function onKeydown(event: KeyboardEvent) {
  const focused = root.value?.contains(document.activeElement)

  if (!open.value) {
    if (!focused) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
      event.preventDefault()
      toggle()
    }
    return
  }

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
  window.addEventListener("keydown", onKeydown)
  window.addEventListener("scroll", reflow, true)
  window.addEventListener("resize", reflow)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown)
  window.removeEventListener("scroll", reflow, true)
  window.removeEventListener("resize", reflow)
})
</script>

<template>
  <div ref="root" class="select" :style="{ width: width ? `${width}px` : undefined }">
    <button class="trigger" :class="{ open }" @click="toggle">
      <slot name="icon" />
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
            <span>{{ option.label }}</span>
            <svg v-if="option.value === modelValue" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 6.4 4.7 8.6 9.5 3.8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
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
 * The same shell as a text field, because it is the same kind of control: a
 * box you put a value in. Focus colours an outline that is always present, so
 * opening the menu does not nudge the label inside it.
 */
/*
 * Measured on opencode's settings page: `height: 24px; padding: 4px 4px 4px
 * 8px; gap: 4px; border-radius: 4px`, transparent, no border, no shadow. The
 * value inside is 13px/530/16px and the chevron a 16-box. This was 28 tall on
 * `--surface-base` with a 1px border and radius 6 - a bordered field where the
 * reference draws a ghost button.
 */
.trigger {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 4px 4px 4px 8px;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  border-radius: 4px;
  outline: 1px solid transparent;
  outline-offset: 0;
  font-size: 13px;
  transition: outline-color 0.12s, background 0.12s;
}

/* A ghost shows itself on hover and while open, with the same overlay every
   other ghost control here uses. */
.trigger:hover,
.trigger.open {
  background: var(--surface-hover);
}

.trigger:hover:not(.open) {
  background: var(--surface-hover);
}

.trigger.open {
  background: var(--surface-hover);
}

.trigger:focus-visible {
  outline-color: var(--interactive);
}

.label {
  overflow: hidden;
  font-weight: 530;
  line-height: 16px;
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
 */
.select-pop {
  /* opencode's menu-v2-content: min-width 160px, max-width 23rem, content
     between. It used to be pinned to the trigger's width, which no longer
     says anything about how wide the options are. */
  width: max-content;
  min-width: 160px;
  max-width: 23rem;
  position: fixed;
  z-index: 200;
  /* A select's listbox keeps four; the surface around it is the 2px one. */
  padding: 4px;
  background: var(--surface-menu);
  border-radius: 6px;
  box-shadow: var(--shadow-lg);
  /* Twelve rows of 28 and then it scrolls, which is where the reference cuts. */
  max-height: 12rem;
  overflow-x: hidden;
  overflow-y: auto;
}

/* Rows are spaced rather than touching, unlike the ones in a plain menu. */
.select-pop .item + .item {
  margin-top: 2px;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 12px;
  color: var(--text-strong);
  text-align: start;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 440;
  letter-spacing: -0.04px;
  white-space: nowrap;
}

.select-pop .item:hover,
.select-pop .item.active {
  background: var(--surface-hover);
}

/*
 * The chosen row is named by weight and colour, not by a background: the
 * background is what hover uses, and the two have to stay tellable apart when
 * the pointer is resting on the row that is already selected.
 */
/*
 * The chosen option is marked by its fill and nothing else: opencode's
 * selected option measures the same `13px/440` and `rgb(250, 250, 250)` as its
 * neighbours, on `rgba(255, 255, 255, 0.06)` - the hover overlay. This used to
 * go bold and take the accent colour, which no option in the reference does.
 */
.select-pop .item.on {
  background: var(--surface-hover);
}
</style>
