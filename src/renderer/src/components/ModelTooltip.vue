<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import type { ModelInfo } from "@shared/protocol"
import { language, t } from "../lib/i18n"
import { isLatest, withoutLatest } from "../lib/model"

/**
 * What is known about a model, beside the row naming it.
 *
 * The reference's `ModelTooltip` (out/renderer/assets/main-8t-QUXax.js
 * @4365938) in its v2 form, which is five labelled rows in this order: Model,
 * Provider, Inputs (only when the model declares any), Reasoning, Context. It
 * hangs off each row of the model picker at `placement: "right-start", gutter:
 * 6, openDelay: 0` (@4586900) - no delay, because the whole point is that the
 * list can be read by running the pointer down it.
 *
 * Its own element rather than the app's `v-tip`, which draws one line of text
 * and a key cap and is the wrong shape for a table. It is fixed-positioned and
 * mounted at the end of the body by the caller's teleport, because the picker
 * scrolls its rows inside a clipped box and anything drawn beside a row from
 * inside that box is cut off at the edge of it.
 */
const props = defineProps<{
  model: ModelInfo
  /** The provider's display name, which the model record does not carry. */
  provider: string
  /** Where the row being described is, in viewport coordinates. */
  anchor: DOMRect
}>()

/** Distance from the row, and the closest the box may sit to the window edge. */
const GAP = 6
const EDGE = 6

/**
 * The name with its Latest tag appended in brackets.
 *
 * `name2()` in the reference: `${model.name}${tags.length ? ` (${tags.join(", ")})` : ""}`
 * where the tags are Latest and Free. Free is not here - the reference decides
 * it by `provider === "opencode"`, a hosted gateway this app has no counterpart
 * for, so there is nothing to read it from.
 */
const name = computed(() => {
  const bare = withoutLatest(props.model.name)
  return isLatest(props.model.name) ? `${bare} (${t("model.tag.latest")})` : bare
})

/**
 * The modalities it accepts, in the reference's own order, or nothing.
 *
 * `const order = ["text", "image", "audio", "video", "pdf"]`, filtered by the
 * capability flags and joined with ", ". Empty means the row is not drawn at
 * all rather than drawn blank.
 */
const inputs = computed(() => {
  const accepted = props.model.inputs
  return (["text", "image", "audio", "video", "pdf"] as const)
    .filter((kind) => accepted[kind])
    .map((kind) => t(`model.input.${kind}`))
    .join(", ")
})

const reasoning = computed(() =>
  props.model.reasoning ? t("model.tooltip.reasoning.allowed") : t("model.tooltip.reasoning.none"),
)

/*
 * Grouped by the reader's own locale, which is what `contextLimit()` does with
 * `limit.context.toLocaleString(language.intl())`. Zero is this app's way of
 * saying the number is not known - a provider that lists its models without one
 * - and an unknown limit is left out rather than reported as a limit of 0.
 */
const context = computed(() =>
  props.model.contextWindow ? props.model.contextWindow.toLocaleString(language.value) : "",
)

const box = ref<HTMLElement>()
const left = ref(0)
const top = ref(0)

/**
 * Beside the row, and inside the window.
 *
 * Measured after it is in the document because the width depends on the longest
 * value in it; until then it is drawn at the origin with nothing visible, which
 * is why the opacity only lands once a place has been chosen.
 */
function place() {
  const element = box.value
  if (!element) return
  const self = element.getBoundingClientRect()
  const anchor = props.anchor
  const right = anchor.right + GAP
  // Flips to the other side when there is no room, rather than sliding back
  // over the list it is describing.
  const fits = right + self.width <= window.innerWidth - EDGE
  const x = fits ? right : anchor.left - self.width - GAP
  left.value = Math.min(Math.max(EDGE, x), Math.max(EDGE, window.innerWidth - self.width - EDGE))
  // "right-start": the top edges line up, then it is pulled back into view.
  top.value = Math.min(Math.max(EDGE, anchor.top), Math.max(EDGE, window.innerHeight - self.height - EDGE))
}

onMounted(() => void nextTick(place))
watch(() => [props.anchor, props.model.id], () => void nextTick(place))
</script>

<template>
  <div ref="box" class="model-tip" :style="{ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }">
    <div class="row">
      <span class="label">{{ t("model.tooltip.model") }}</span>
      <span class="value">{{ name }}</span>
    </div>
    <div class="row">
      <span class="label">{{ t("model.tooltip.provider") }}</span>
      <span class="value">{{ provider }}</span>
    </div>
    <div v-if="inputs" class="row">
      <span class="label">{{ t("model.tooltip.inputs") }}</span>
      <span class="value">{{ inputs }}</span>
    </div>
    <div class="row">
      <span class="label">{{ t("model.tooltip.reasoning") }}</span>
      <span class="value">{{ reasoning }}</span>
    </div>
    <div v-if="context" class="row">
      <span class="label">{{ t("model.tooltip.context.label") }}</span>
      <span class="value">{{ context }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * The same surface as the app's own tooltips - it is one of them, in a
 * different shape - and above the menu it hangs off.
 */
.model-tip {
  position: fixed;
  z-index: 320;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 280px;
  padding: 6px 8px;
  background: var(--surface-raised-hover);
  border-radius: 4px;
  box-shadow: var(--shadow-lg);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.35;
  pointer-events: none;
}

.row {
  display: flex;
  gap: 10px;
}

/* The label column is the quiet half; the value is what is being looked up. */
.label {
  flex: none;
  color: var(--text-weaker);
}

.value {
  margin-inline-start: auto;
  overflow: hidden;
  color: var(--text-strong);
  text-align: end;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
