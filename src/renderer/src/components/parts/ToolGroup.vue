<script setup lang="ts">
import { computed, ref, watch } from "vue"
import ToolPart from "./ToolPart.vue"
import PermissionRow from "./PermissionRow.vue"
import ErrorStep from "./ErrorStep.vue"
import NoticeRow from "./NoticeRow.vue"
import StepIcon from "./StepIcon.vue"
import StepCollapse from "./StepCollapse.vue"
import SubagentActivity from "./SubagentActivity.vue"
import "./steps.css"
import { isPill } from "../../lib/subagents"
import { t } from "../../lib/i18n"
import { tn } from "../../lib/plural"
import { stepsEpoch, stepsOpen } from "../../lib/steps"
import { SINGLE_TITLE_MAX, stepState, toolIcon } from "../../lib/tool-meta"
import { groupFailed, groupSummary, singleTool, type StepItem } from "../../lib/step-rows"

/**
 * A run of steps under one summary line, as MiMo draws it.
 *
 * 「已读取 3 个文件 · 已运行 2 条命令」 with the first call's icon, a sweep over
 * the words while anything in it runs, and a warning mark when a step in it
 * failed. A group of one call is simply that call's row.
 */
const props = withDefaults(
  defineProps<{
    items: StepItem[]
    /**
     * Open while it is the group the live turn is working in. When the answer
     * starts arriving this turns false and the group folds itself - unless the
     * reader has opened or closed it, which sticks.
     */
    defaultOpen?: boolean
    /** subagents: a group of subagent calls - one pill row, or its calls flat, never folded behind a summary. */
    actor?: boolean
  }>(),
  { defaultOpen: false, actor: false },
)

/* subagents: subagent calls that are all working or done are one pill list, with no summary line, as MiMo merges them. */
const pills = computed(() =>
  props.actor && props.items.every((item) => item.kind === "tool" && isPill(item.part))
    ? props.items.flatMap((item) => (item.kind === "tool" ? [item.part] : []))
    : undefined,
)
const single = computed(() => (props.actor ? undefined : singleTool(props.items)))
const firstTool = computed(() => props.items.find((item) => item.kind === "tool"))
const icon = computed(() => toolIcon(firstTool.value?.kind === "tool" ? firstTool.value.part.name : ""))
const running = computed(() => props.items.some((item) => item.kind === "tool" && stepState(item.part) === "running"))
const failed = computed(() => groupFailed(props.items))
const summary = computed(() =>
  groupSummary(props.items)
    .map(({ bucket, count }) => tn(`buildWorkDisplay.${bucket}`, count))
    .join(" · "),
)

const touched = ref(false)
const open = ref(props.defaultOpen || stepsOpen.value)
/** Only a fold the reader asked for animates. */
const animate = ref(false)

watch(
  () => props.defaultOpen,
  (value) => {
    if (!touched.value) open.value = value
  },
)

/* The steps command sets every group to one state, and counts as a choice made. */
watch(stepsEpoch, () => {
  touched.value = true
  open.value = stepsOpen.value
})

function toggle() {
  touched.value = true
  animate.value = true
  open.value = !open.value
}
</script>

<template>
  <SubagentActivity v-if="pills" :parts="pills" />
  <!-- subagents: any other run of subagent calls is drawn call by call, flush with the column, as MiMo's flushToolLeft rows. -->
  <div v-else-if="actor" class="hs-actor-group" data-actor-group>
    <template v-for="item in items" :key="item.id">
      <ToolPart v-if="item.kind === 'tool'" :part="item.part" />
      <PermissionRow v-else-if="item.kind === 'permission'" :part="item.part" :record="item.record" />
      <ErrorStep v-else-if="item.kind === 'error'" :error="item.error" />
      <NoticeRow v-else :text-key="item.key" />
    </template>
  </div>
  <ToolPart v-else-if="single" :part="single" summary :title-max="SINGLE_TITLE_MAX" />
  <div v-else class="hs-group" data-step-group>
    <button type="button" class="hs-h hs-summary" :aria-expanded="open" data-group-head @click="toggle">
      <span class="hs-ic"><StepIcon :name="icon" /></span>
      <span class="hs-text" :class="{ 'running-shimmer': running }">
        <span data-group-summary>{{ summary }}</span>
        <span
          v-if="failed"
          class="hs-group-err"
          data-group-err
          :aria-label="t('stepList.groupHasError')"
          v-tip="{ label: t('stepList.groupHasError'), placement: 'top' }"
        >
          <StepIcon name="alert" />
        </span>
      </span>
      <span class="hs-chev" :class="{ open }">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>
    <StepCollapse :show="open" :animate="animate">
      <template v-for="item in items" :key="item.id">
        <ToolPart v-if="item.kind === 'tool'" :part="item.part" indent />
        <PermissionRow v-else-if="item.kind === 'permission'" :part="item.part" :record="item.record" />
        <ErrorStep v-else-if="item.kind === 'error'" :error="item.error" />
        <NoticeRow v-else :text-key="item.key" />
      </template>
    </StepCollapse>
  </div>
</template>
