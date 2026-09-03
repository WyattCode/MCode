<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { t } from "../lib/i18n"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"

/**
 * The right-click menu for text.
 *
 * Chromium supplies one of its own for editable fields, but it is drawn in the
 * platform's chrome and labelled in the platform's language - neither of which
 * this window is. Listening once at the document rather than wiring every field
 * means a box added later gets the same menu without being told to.
 */
const menu = ref<{ x: number; y: number; editable: boolean; keyboard: boolean }>()

/** The field the menu belongs to, so focus can be handed back to it. */
let owner: HTMLElement | undefined

/** Whether anything is selected, in the field or in the page. */
const hasSelection = ref(false)

function editableTarget(node: EventTarget | null): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : undefined
  if (!element) return undefined
  const field = element.closest<HTMLElement>("input, textarea, [contenteditable=true]")
  if (!field) return undefined
  if (field instanceof HTMLInputElement && ["checkbox", "radio", "button", "range"].includes(field.type)) {
    return undefined
  }
  // xterm keeps an off-screen textarea to receive keystrokes; the terminal has
  // its own selection and its own menu, and this one would act on the wrong thing.
  if (field.classList.contains("xterm-helper-textarea")) return undefined
  return field
}

function selectionIn(field: HTMLElement | undefined): boolean {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.selectionStart !== field.selectionEnd
  }
  return (window.getSelection()?.toString().length ?? 0) > 0
}

function open(event: MouseEvent) {
  const field = editableTarget(event.target)
  const selected = (window.getSelection()?.toString().length ?? 0) > 0

  // Nothing worth offering: no field to paste into and no text to copy.
  if (!field && !selected) {
    menu.value = undefined
    return
  }

  // Right-clicking a field it does not already own should move the caret there,
  // so cut and paste act on what the user just pointed at.
  if (field && document.activeElement !== field) field.focus()

  event.preventDefault()
  owner = field
  hasSelection.value = selectionIn(field)
  /*
   * The context-menu key raises this same event. Chromium reports no click
   * count for it, which is how a keyboard press is told from a right-click.
   */
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    editable: Boolean(field),
    keyboard: event.detail === 0,
  }
}

function close() {
  menu.value = undefined
}

/*
 * Routed through the main process, which runs the same editing commands the
 * native menu does. The field keeps focus throughout, since the menu never
 * takes it - which is why the items suppress their own mousedown.
 */
function pick(key: string) {
  // Focus may be sitting on a menu item; the command acts on what is focused.
  owner?.focus()
  window.mcode.edit(key as "cut" | "copy" | "paste" | "selectAll")
  close()
}

const items = computed<MenuItem[]>(() => {
  if (!menu.value) return []
  if (!menu.value.editable) return [{ key: "copy", label: t("edit.copy") }]
  return [
    { key: "cut", label: t("edit.cut"), enabled: hasSelection.value },
    { key: "copy", label: t("edit.copy"), enabled: hasSelection.value },
    { key: "paste", label: t("edit.paste") },
    { key: "selectAll", label: t("edit.selectAll") },
  ]
})

onMounted(() => document.addEventListener("contextmenu", open))
onBeforeUnmount(() => document.removeEventListener("contextmenu", open))
</script>

<template>
  <ContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :items="items"
    :keyboard="menu.keyboard"
    @pick="pick"
    @close="close"
  />
</template>
