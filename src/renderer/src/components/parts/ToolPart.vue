<script setup lang="ts">
import { computed, ref } from "vue"
import type { ToolPart } from "@shared/protocol"
import { parseUnifiedDiff } from "@shared/unified-diff"
import { redactText, redactValue } from "@shared/display-redact"
import DiffView from "./DiffView.vue"
import StepShots from "./StepShots.vue"
import StepIcon from "./StepIcon.vue"
import StepCollapse from "./StepCollapse.vue"
import SubagentActivity from "./SubagentActivity.vue"
import SubagentAvatar from "./SubagentAvatar.vue"
import "./steps.css"
import { t } from "../../lib/i18n"
import { shownModText } from "../../lib/keys"
import { childFor, isPill } from "../../lib/subagents"
import { useApp } from "../../stores/app"
import { openStepPath } from "../../lib/open-step-path"
import { renderMarkdown } from "../../lib/markdown"
import {
  OUTPUT_CAP,
  ROW_TITLE_MAX,
  bashOf,
  cleanOutput,
  cutTitle,
  isUnifiedDiff,
  noOutput,
  opensPath,
  pathTitleParts,
  reducedTitle,
  showsPath,
  stepImages,
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

/* Closed, as MiMo leaves every row. */
const open = ref(false)
/** Only a fold the reader asked for animates. */
const animate = ref(false)

/*
 * The call as the row shows it: secrets and personal numbers in its title,
 * input, output, error and diff masked (beyond MiMo, live as well as after a
 * reload). Only what is drawn - opening a path uses the part as it is.
 */
const shown = computed<ToolPart>(() => {
  const part = props.part
  const diff = part.metadata?.diff
  return {
    ...part,
    title: part.title === undefined ? undefined : redactText(part.title),
    input: redactValue(part.input),
    output: part.output === undefined ? undefined : redactText(part.output),
    error: part.error === undefined ? undefined : redactText(part.error),
    ...(typeof diff === "string" ? { metadata: { ...part.metadata, diff: redactText(diff) } } : {}),
  }
})

const state = computed(() => stepState(props.part))
const verb = computed(() => stepVerb(props.part, state.value))
const icon = computed(() => toolIcon(props.part.name))
const bash = computed(() => bashOf(shown.value))
const title = computed(() => stepTitle(shown.value))

/** A web lookup's row is its verb alone, and it has no output to open. */
const webLike = computed(() => props.part.name === "webfetch" || props.part.name === "websearch")
const runs = computed(() => props.part.name === "bash" || props.part.name === "exec_command")

/**
 * The row's own title: a JSON title reduced to its subject, a command to its
 * first line. A path is in two parts, so that a row too narrow for it cuts the
 * folders and keeps the file name.
 */
const titleParts = computed(() => {
  const reduced = reducedTitle(title.value)
  const line = runs.value ? (reduced.split("\n", 1)[0] ?? "") : reduced
  return showsPath(props.part.name) ? pathTitleParts(line, props.titleMax) : { head: cutTitle(line, props.titleMax), tail: "", cut: line.length > props.titleMax }
})
const showTitle = computed(() => Boolean(title.value) && props.part.name !== "exec_command" && !webLike.value)

/** The whole title in its own cell, when the row could not show all of it. */
const fullTitle = computed(() => {
  if (bash.value || webLike.value || !title.value) return ""
  return runs.value || titleIsLossy(title.value, props.titleMax) ? title.value : ""
})

/** A tool that named its failure gets it said in the user's language. */
const errorText = computed(() =>
  props.part.errorCode ? redactText(t(props.part.errorCode, props.part.errorParams)) : (shown.value.error ?? ""),
)

const diff = computed(() => {
  const value = shown.value.metadata?.diff
  return typeof value === "string" && value ? value : undefined
})

/*
 * MiMo's step output: the error for a call that did not succeed, else the
 * diff, else what the tool printed - and a finished call's "(no output)" is no
 * output at all, as MiMo's live steps take it.
 */
const output = computed(() => {
  if (state.value === "error" || state.value === "skipped" || state.value === "rejected") return errorText.value
  const said = diff.value ?? shown.value.output ?? ""
  return state.value === "completed" && noOutput(said) ? "" : said
})
const cleaned = computed(() => cleanOutput(output.value))
const diffText = computed(() => (isUnifiedDiff(cleaned.value) ? cleaned.value : undefined))

/* The pictures the call handed back; a step with any can always be opened, a web lookup included. */
const hasShots = computed(() => stepImages(props.part.attachments).length > 0)

/* MiMo draws a skill's output as Markdown, in the output box's frame, rather than as monospaced text. */
const skillHtml = computed(() =>
  props.part.name === "skill" && output.value && state.value === "completed" && !diffText.value
    ? renderMarkdown(cleaned.value.slice(0, OUTPUT_CAP))
    : "",
)

const expandable = computed(
  () => (Boolean(output.value) && !webLike.value) || Boolean(bash.value) || Boolean(fullTitle.value) || hasShots.value,
)

/* The id of the panel the head opens, so the head can point at it. */
const panelId = computed(() => `tool-part-${props.part.id}`)

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
const codeTip = computed(() => (openable.value ? `${title.value}\n${shownModText(t("stepList.cmdClickOpen"))}` : title.value))

/* Ctrl or Cmd with a click on the path, or with Enter on the head from the keyboard (the path sits inside the head's button). */
function onTitleClick(event: MouseEvent | KeyboardEvent) {
  if (!openable.value || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  event.stopPropagation()
  // The path as the call named it, not as it is drawn.
  void openStepPath(stepTitle(props.part), app.current?.directory)
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
        :aria-controls="expandable ? panelId : undefined"
        data-step-head
        @click="toggle"
        @keydown.enter="onTitleClick"
      >
        <span class="hs-ic" :class="{ 'hs-ic-avatar': avatarSeed }">
          <SubagentAvatar v-if="avatarSeed" :seed="avatarSeed" compact />
          <StepIcon v-else :name="icon" />
        </span>
        <span class="hs-text" :class="{ 'running-shimmer': state === 'running' }">
          <span class="hs-verb" :class="{ 'hs-err': state === 'error', 'hs-struck': state === 'skipped' }" data-step-verb>{{ verb }}</span>
          <span v-if="bash" class="hs-bash-desc" dir="auto" :class="{ 'hs-struck': state === 'skipped' }" data-step-title>{{ bash.desc || bash.cmd }}</span>
          <span
            v-else-if="showTitle"
            class="hs-title"
            :class="{ 'hs-struck': state === 'skipped' }"
            data-step-title
          ><code :class="{ openable }" :dir="titleParts.tail ? 'ltr' : 'auto'" :title="codeTip" @click="onTitleClick"><span class="hs-head" :class="{ cut: titleParts.cut }">{{ titleParts.head }}</span><span v-if="titleParts.tail" class="hs-tail">{{ titleParts.tail }}</span></code></span>
          <!-- MiMo's hs-diffstat: what the step added and took away, zeroes left out. -->
          <span
            v-if="diffstat.add || diffstat.del"
            class="hs-diffstat"
            data-diffstat
            :aria-label="t('info.changeStats', { add: diffstat.add, del: diffstat.del })"
          >
            <span v-if="diffstat.add" class="add" aria-hidden="true">+{{ diffstat.add }}</span>
            <template v-if="diffstat.add && diffstat.del">{{ " " }}</template>
            <span v-if="diffstat.del" class="del" aria-hidden="true">-{{ diffstat.del }}</span>
          </span>
          <!-- MiMo's trailing dots mark a running call inside a group; a row standing alone has none. -->
          <span v-if="state === 'running' && !summary" class="hs-dim" aria-hidden="true">…</span>
        </span>
        <span v-if="expandable" class="hs-chev" :class="{ open }">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </button>

      <StepCollapse :id="panelId" :show="open && expandable" :animate="animate">
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
            <div v-else-if="diffText" class="hs-diff"><DiffView :diff="diffText" :root="app.current?.directory" /></div>
            <!-- Safe to bind: the Markdown renderer escapes every piece of source it places. -->
            <div v-else-if="skillHtml" class="tc-out md text" data-step-output data-step-markdown v-html="skillHtml" />
            <pre v-else class="tc-out" data-step-output>{{ cleaned.slice(0, OUTPUT_CAP) }}</pre>
          </template>
        </template>
        <StepShots v-if="hasShots" :attachments="part.attachments" />
      </StepCollapse>
    </div>
  </div>
</template>

<style scoped>
.hs-h:focus-visible:not([aria-disabled="true"]) {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
  border-radius: 6px;
}
</style>
