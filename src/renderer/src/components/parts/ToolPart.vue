<script setup lang="ts">
import { computed, ref } from "vue"
import type { ToolPart } from "@shared/protocol"
import { parseUnifiedDiff } from "@shared/unified-diff"
import DiffView from "./DiffView.vue"
import StepIcon from "./StepIcon.vue"
import StepCollapse from "./StepCollapse.vue"
import SubagentActivity from "./SubagentActivity.vue"
import SubagentAvatar from "./SubagentAvatar.vue"
import "./steps.css"
import { t } from "../../lib/i18n"
import { childFor, isPill } from "../../lib/subagents"
import { useApp } from "../../stores/app"
import { openStepPath } from "../../lib/open-step-path"
import {
  OUTPUT_CAP,
  ROW_TITLE_MAX,
  bashOf,
  cleanOutput,
  isUnifiedDiff,
  opensPath,
  reducedTitle,
  stepState,
  stepTitle,
  stepVerb,
  titleIsLossy,
  toolIcon,
} from "../../lib/tool-meta"
import { actorAction, actorTarget, launches } from "@shared/subagent"

/**
 * One tool call as MiMo's step list draws it.
 *
 * An icon, a verb that says where the call is (正在读取 / 已读取 / 读取失败 /
 * 已拒绝读取 / 未执行：读取), what it was about, and a chevron when there is
 * something to open. Every row starts closed, failures included: MiMo never
 * opens one by itself, and a row with nothing behind it cannot be opened.
 */
const props = withDefaults(
  defineProps<{
    part: ToolPart
    /** Under a group's summary the row is indented past the summary's icon. */
    indent?: boolean
    /** A group of one: the row takes the summary line's spacing and hover. */
    summary?: boolean
    titleMax?: number
  }>(),
  { indent: false, summary: false, titleMax: ROW_TITLE_MAX },
)

const app = useApp()

/*
 * Closed, as MiMo leaves every row - unless the reader has asked in settings for
 * commands or edits to arrive open, which is a choice of theirs to keep.
 */
const preferOpen = (() => {
  const config = app.config
  if (props.part.name === "bash") return config?.expandShell === true
  if (["edit", "write", "patch", "apply_patch"].includes(props.part.name)) return config?.expandEdits === true
  return false
})()

const open = ref(preferOpen)
/** Only a fold the reader asked for animates. */
const animate = ref(false)

const state = computed(() => stepState(props.part))
const verb = computed(() => stepVerb(props.part, state.value))
const icon = computed(() => toolIcon(props.part.name))
const bash = computed(() => bashOf(props.part))
const title = computed(() => stepTitle(props.part))

/** A web lookup's row is its verb alone, and it has no output to open. */
const webLike = computed(() => props.part.name === "webfetch" || props.part.name === "websearch")
const runs = computed(() => props.part.name === "bash" || props.part.name === "exec_command")

/** The row's own title: a JSON title reduced to its subject, a command to its first line. */
const shortTitle = computed(() => {
  const reduced = reducedTitle(title.value)
  const line = runs.value ? (reduced.split("\n", 1)[0] ?? "") : reduced
  return line.slice(0, props.titleMax)
})
const showTitle = computed(() => Boolean(title.value) && props.part.name !== "exec_command" && !webLike.value)

/** The whole title in its own cell, when the row could not show all of it. */
const fullTitle = computed(() => {
  if (bash.value || webLike.value || !title.value) return ""
  return runs.value || titleIsLossy(title.value, props.titleMax) ? title.value : ""
})

/** A tool that named its failure gets it said in the user's language. */
const errorText = computed(() =>
  props.part.errorCode ? t(props.part.errorCode, props.part.errorParams) : (props.part.error ?? ""),
)

const diff = computed(() => {
  const value = props.part.metadata?.diff
  return typeof value === "string" && value ? value : undefined
})

/** MiMo's step output: the error for a call that did not succeed, else the diff, else what the tool printed. */
const output = computed(() => {
  if (state.value === "error" || state.value === "skipped" || state.value === "rejected") return errorText.value
  return diff.value ?? props.part.output ?? ""
})
const cleaned = computed(() => cleanOutput(output.value))
const diffText = computed(() => (isUnifiedDiff(cleaned.value) ? cleaned.value : undefined))

const expandable = computed(() => (Boolean(output.value) && !webLike.value) || Boolean(bash.value) || Boolean(fullTitle.value))

/* Lines the step's diff added and removed, counted inside its hunks as MiMo counts them. */
const diffstat = computed(() => {
  let add = 0
  let del = 0
  if (diff.value) {
    for (const section of parseUnifiedDiff(diff.value)) {
      for (const hunk of section.hunks) {
        add += hunk.added
        del += hunk.removed
      }
    }
  }
  return { add, del }
})

/* Ctrl/⌘+click on a path opens it; a plain click still folds the row. */
const openable = computed(() => opensPath(props.part.name) && Boolean(title.value))
const codeTip = computed(() => (openable.value ? `${title.value}\n${t("stepList.cmdClickOpen")}` : title.value))

function onTitleClick(event: MouseEvent) {
  if (!openable.value || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  event.stopPropagation()
  void openStepPath(title.value, app.current?.directory)
}

function toggle() {
  if (!expandable.value) return
  animate.value = true
  open.value = !open.value
}

/*
 * subagents: a run or spawn working or done is MiMo's pill; in any other state it is a row wearing the avatar.
 * A status, wait, cancel or send row wears the avatar of the subagent it names; models wears none.
 */
const pill = computed(() => isPill(props.part))
const avatarSeed = computed(() => {
  if (props.part.name !== "actor") return undefined
  const action = actorAction(props.part.input)
  if (launches(action)) return childFor(props.part.callID, app.subagentSessions)?.subagent?.id ?? props.part.callID
  return actorTarget(props.part.input) || undefined
})
</script>

<template>
  <SubagentActivity v-if="pill" :parts="[part]" />
  <div
    v-else
    class="hstep"
    :class="{ indent, single: summary }"
    :data-tool-part="part.id"
    :data-tool="part.name"
    :data-step-state="state"
  >
    <div class="hs-body">
      <button
        type="button"
        class="hs-h"
        :class="{ 'hs-summary': summary }"
        :aria-disabled="expandable ? undefined : 'true'"
        :aria-expanded="expandable ? open : undefined"
        data-step-head
        @click="toggle"
      >
        <span class="hs-ic" :class="{ 'hs-ic-avatar': avatarSeed }">
          <SubagentAvatar v-if="avatarSeed" :seed="avatarSeed" compact />
          <StepIcon v-else :name="icon" />
        </span>
        <span class="hs-text" :class="{ 'running-shimmer': state === 'running' }">
          <span class="hs-verb" :class="{ 'hs-err': state === 'error', 'hs-struck': state === 'skipped' }" data-step-verb>{{ verb }}</span>
          <span v-if="bash" class="hs-bash-desc" :class="{ 'hs-struck': state === 'skipped' }" data-step-title>{{ bash.desc || bash.cmd }}</span>
          <span
            v-else-if="showTitle"
            class="hs-title"
            :class="{ 'hs-err': state === 'error', 'hs-struck': state === 'skipped' }"
            data-step-title
          ><code :class="{ openable }" :title="codeTip" @click="onTitleClick">{{ shortTitle }}</code></span>
          <!-- MiMo's hs-diffstat: what the step added and took away, zeroes left out. -->
          <span v-if="diffstat.add || diffstat.del" class="hs-diffstat" data-diffstat>
            <span v-if="diffstat.add" class="add">+{{ diffstat.add }}</span>
            <template v-if="diffstat.add && diffstat.del">{{ " " }}</template>
            <span v-if="diffstat.del" class="del">-{{ diffstat.del }}</span>
          </span>
          <span v-if="state === 'running'" class="hs-dim" aria-hidden="true">…</span>
        </span>
        <span v-if="expandable" class="hs-chev" :class="{ open }">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </button>

      <StepCollapse :show="open && expandable" :animate="animate">
        <!-- A command: what was run (with the model's description) over what it printed. -->
        <div v-if="bash" class="hs-bash-expand" data-bash-expand>
          <pre class="hs-cell top" data-bash-command><span v-if="bash.desc" class="hs-bash-desc-line">{{ `# ${bash.desc}\n` }}</span><span class="hs-bash-cmd-line">{{ bash.cmd }}</span></pre>
          <template v-if="output">
            <div class="hs-divider" />
            <pre class="hs-cell bottom" data-step-output>{{ output.slice(0, OUTPUT_CAP) }}</pre>
          </template>
        </div>
        <template v-else>
          <pre v-if="fullTitle" class="hs-full-cmd" data-full-title>{{ fullTitle }}</pre>
          <template v-if="output && !webLike">
            <template v-if="state === 'skipped'">
              <div class="hs-skip-hint" data-skip-hint>{{ t("stepList.skippedHint") }}</div>
              <pre class="tc-out" data-step-output>{{ cleaned.slice(0, OUTPUT_CAP) }}</pre>
            </template>
            <div v-else-if="diffText" class="hs-diff"><DiffView :diff="diffText" /></div>
            <pre v-else class="tc-out" data-step-output>{{ cleaned.slice(0, OUTPUT_CAP) }}</pre>
          </template>
        </template>
      </StepCollapse>
    </div>
  </div>
</template>
