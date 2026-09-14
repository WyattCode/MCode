<script setup lang="ts">
import { computed, ref } from "vue"
import type { QuestionPrompt, ToolPart } from "@shared/protocol"
import { parseUnifiedDiff } from "@shared/unified-diff"
import DiffView from "./DiffView.vue"
import TextShimmer from "./TextShimmer.vue"
import QuestionForm from "./QuestionForm.vue"
import { t } from "../../lib/i18n"
import { useApp } from "../../stores/app"
import { useQuestions } from "../../stores/questions"

const props = defineProps<{ part: ToolPart }>()

const app = useApp()
const questions = useQuestions()

/** Failures and long-running work open themselves; successes stay collapsed. */
const manual = ref<boolean>()

/** A tool that named its failure gets it said in the user's language. */
const errorText = computed(() =>
  props.part.errorCode ? t(props.part.errorCode, props.part.errorParams) : props.part.error,
)
/*
 * Two settings, because reading a shell command and reading an edit are
 * different habits: someone who wants every diff open does not necessarily
 * want every `ls` open beside it. A failure still opens itself either way,
 * and touching the row wins over both.
 */
const preferOpen = computed(() => {
  const config = app.config
  if (props.part.name === "bash") return config?.expandShell === true
  if (["edit", "write", "patch", "apply_patch"].includes(props.part.name)) return config?.expandEdits === true
  /*
   * A question opens itself, whether it is still waiting or already answered.
   * Waiting, because the form is the whole point and nobody would think to
   * expand a collapsed row to find it; answered, because that is what the
   * reference does - its renderer passes `defaultOpen: completed()`.
   */
  if (props.part.name === "question") return pending.value !== undefined || answers.value !== undefined
  return false
})

/**
 * The live question raised by this call, if it is still waiting on an answer.
 *
 * Matched on the call id, which is what the request's `tool` field carries.
 * The reference draws this form above the composer instead; see QuestionForm
 * for why it is here and what it would take to move it.
 */
const pending = computed(() => questions.forCall(props.part.callID))

/** What the reader chose, once they have - read back from the stored part. */
const answers = computed(() => {
  if (props.part.name !== "question") return undefined
  const stored = props.part.metadata?.answers
  return Array.isArray(stored) ? (stored as string[][]) : undefined
})

/** The questions as the model wrote them, for redrawing an answered card. */
const asked = computed(() => {
  const raw = props.part.input?.questions
  return Array.isArray(raw) ? (raw as QuestionPrompt[]) : []
})

const open = computed({
  get: () => manual.value ?? (props.part.status === "error" || preferOpen.value),
  set: (value: boolean) => (manual.value = value),
})

const diff = computed(() => (props.part.metadata?.diff as string) || undefined)

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
const todos = computed(() => (props.part.metadata?.todos as { id: string; content: string; status: string }[]) || undefined)

/*
 * A tool's own name when the app has nothing better to call it.
 *
 * Which is the right answer for an MCP tool: its name comes from whichever
 * server provides it, so no table here could ever hold them all. This used to
 * decide by a list of the nine built-in tools written out here, which is the
 * server's tool registry copied by hand - add a tool there and its card quietly
 * started showing the bare identifier. Asking the table instead cannot drift,
 * because a lookup that finds nothing returns the key it was given.
 */
const label = computed(() => {
  const key = `tool.${props.part.name}`
  const found = t(key)
  return found === key ? props.part.name : found
})

const subject = computed(() => {
  const part = props.part
  /*
   * A question says how many it is asking rather than repeating its own title.
   * The reference's renderer builds the same line: `ui.question.subtitle.answered`
   * once the reader has replied, and before that `${count} ${one|other}` from
   * `ui.common.question.one` / `.other`. Those two keys have not landed in this
   * app's tables, and inventing "question"/"questions" in eighteen languages is
   * exactly what this project does not do, so the count stands alone until they
   * do. See the report for their values, read out of the reference.
   */
  if (part.name === "question") {
    const count = asked.value.length
    if (!count) return ""
    if (answers.value?.length) return t("ui.question.subtitle.answered", { count })
    return String(count)
  }
  /*
   * A shell row is the command, not a description of it.
   *
   * The model supplies a `title` for most calls and it is the better label
   * nearly everywhere - but for a shell call the reference prints the command
   * itself, truncated, and that is the thing a reader actually wants to check.
   * "Read nbattle.txt, ls2data.dat, announce.txt" is a summary of the one thing
   * only the command can state exactly.
   *
   * Named rather than inferred from the presence of a `command` input. `bash`
   * is the only tool that carries one today, so the two are the same test now -
   * but they would stop being the same the moment another tool took a command,
   * and then this would have quietly changed that tool's label too.
   */
  const input = part.input
  if (part.name === "bash" && typeof input.command === "string" && input.command.trim()) {
    return input.command.trim()
  }
  if (part.title) return part.title
  return String(input.path ?? input.pattern ?? input.command ?? input.url ?? "")
})

</script>

<template>
  <div class="tool" :class="part.status" :data-tool-part="part.id">
    <button class="head" @click="open = !open">
      <span class="verb">
        <TextShimmer :text="label" :active="part.status === 'running'" />
      </span>
      <span class="subject">{{ subject }}</span>
      <!-- MiMo's hs-diffstat: what the step added and took away, zeroes left out. -->
      <span v-if="diffstat.add || diffstat.del" class="diffstat" data-diffstat>
        <span v-if="diffstat.add" class="add">+{{ diffstat.add }}</span>
        <template v-if="diffstat.add && diffstat.del">{{ " " }}</template>
        <span v-if="diffstat.del" class="del">-{{ diffstat.del }}</span>
      </span>
      <svg class="caret" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>

    <div v-if="open" class="body">
      <!--
        The form comes first, before the error line: a question that was
        dismissed and then asked again would otherwise be hidden behind the
        refusal the previous one left on the part.
      -->
      <QuestionForm v-if="pending" :request="pending" />

      <!--
        An answered question redraws from the transcript - the questions off the
        call's own input, the replies off its metadata. That pairing is the
        reference's renderer exactly: `props.input.questions` beside
        `props.metadata.answers`.
      -->
      <dl v-else-if="answers" class="answers">
        <template v-for="(entry, index) in asked" :key="index">
          <dt>{{ entry.question }}</dt>
          <dd>{{ answers[index]?.join(", ") || t("ui.question.answer.none") }}</dd>
        </template>
      </dl>

      <div v-else-if="part.error" class="error">{{ errorText }}</div>

      <DiffView v-else-if="diff" :diff="diff" />

      <ul v-else-if="todos" class="todos">
        <li v-for="todo in todos" :key="todo.id" :class="todo.status">
          <span class="box">{{ todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " " }}</span>
          <span>{{ todo.content }}</span>
        </li>
      </ul>

      <pre v-else-if="part.output" class="output">{{ part.output }}</pre>

      <div v-else class="empty">{{ t("tool.noOutput") }}</div>
    </div>

    <!-- A collapsed todowrite is still worth showing: it is the plan. -->
    <ul v-else-if="todos" class="todos collapsed">
      <li v-for="todo in todos" :key="todo.id" :class="todo.status">
        <span class="box">{{ todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " " }}</span>
        <span>{{ todo.content }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/*
 * A line of the transcript, not a card.
 *
 * Every call used to arrive in its own bordered box, so a turn that ran nine
 * commands read as nine panels stacked down the page. The new design gives a
 * call one row - what it was and what it was given - and keeps the borders for
 * whatever the row is opened to reveal.
 */
.tool {
  border-radius: var(--radius-sm);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  text-align: start;
}

.head:hover .caret {
  color: var(--text-base);
}


.verb {
  flex-shrink: 0;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 21px;
}

/* Dimmed while it runs, which is the only signal the row needs. */
.running .verb,
.running .subject {
  color: var(--text-weak);
}

.error .verb {
  color: var(--error);
}

.subject {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 21px;
  /* Figures line up between rows, so a column of counts reads as a column. */
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Twelve after the title, as MiMo sets it: the row's gap and four more. */
.diffstat {
  flex: none;
  margin-inline-start: 4px;
  font-family: var(--font-mono);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 21px;
  white-space: pre;
}

.diffstat .add {
  color: var(--diff-add);
}

.diffstat .del {
  color: var(--diff-delete);
}

.caret {
  flex-shrink: 0;
  margin-inline-start: auto;
  width: 24px;
  color: var(--text-weaker);
  transition: transform 0.12s, color 0.12s;
}

/* Closed lies on its side; open faces the output it reveals. */
.tool:not(:has(.body)) .caret {
  transform: rotate(-90deg);
}

/*
 * A hairline frame over the page rather than a filled card: the transcript is
 * already a plane, and a second fill inside it made every opened call look
 * like a panel dropped on top of the conversation.
 */
.body {
  position: relative;
  margin-bottom: 8px;
  overflow: hidden;
  border: 0.5px solid var(--border-weak);
  border-radius: 6px;
}

.output {
  /* Deep enough to read a stack trace, shallow enough not to bury the reply. */
  max-height: 240px;
  margin: 0;
  padding: 12px;
  overflow: hidden auto;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  /* The frame is 240px tall at most; a bar inside it would cost a line. */
  scrollbar-width: none;
}

.output::-webkit-scrollbar {
  display: none;
}

.error {
  padding: 8px 10px;
  color: var(--error);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
  white-space: pre-wrap;
}

.empty {
  padding: 8px 10px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

/*
 * opencode's `question-answers`: items 12 apart inside `8px 0`, each a
 * question in text-weak over its answer in text-base, both 13px and 2 apart.
 */
.answers {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 8px 0;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 150%;
}

.answers dt {
  color: var(--text-weak);
}

.answers dd {
  margin: 0 0 10px;
  color: var(--text-base);
}

.answers dd:last-child {
  margin-bottom: 0;
}

.todos {
  margin: 0;
  padding: 8px 10px;
  list-style: none;
}

.todos.collapsed {
  border-top: 1px solid var(--border-weak);
}

.todos li {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  color: var(--text-base);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
}

.todos li.completed {
  color: var(--text-weak);
  text-decoration: line-through;
}

.todos li.in_progress {
  color: var(--text-strong);
}

.todos li.cancelled {
  color: var(--text-weak);
  opacity: 0.6;
}

.box {
  width: 12px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  text-align: center;
}

.todos li.in_progress .box {
  color: var(--interactive);
}
</style>
