<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, onBeforeUnmount } from "vue"
import { useApp } from "../stores/app"
import TextPart from "./parts/TextPart.vue"
import ToolGroup from "./parts/ToolGroup.vue"
import QuestionCard from "./parts/QuestionCard.vue"
import ErrorStep from "./parts/ErrorStep.vue"
import RetryRow from "./parts/RetryRow.vue"
import TextShimmer from "./parts/TextShimmer.vue"
import MessageSourceRow from "./parts/MessageSource.vue"
import type { MessageSource } from "@shared/protocol"
import SubagentActivity from "./parts/SubagentActivity.vue"
import type { Annotation, Attachment, AssistantMessage, AssistantPart, SubagentNotice } from "@shared/protocol"
import { buildRows, retryReason, stagesOf, type InlineError, type StepItem, type StepRow } from "../lib/step-rows"
import { cleanReply, saysSomething } from "@shared/reply-clean"
import { turnOpeners } from "@shared/steer"
import { redactText } from "@shared/display-redact"
import { preview, videoUrl } from "../lib/attach"
import { openImagePreview, openVideoPreview, type ImagePreviewMeta } from "../lib/image-preview"
import { language, t } from "../lib/i18n"
import { questionParts } from "../lib/question-parts"
import { renderMarkdown } from "../lib/markdown"
import { highlightWithin } from "../lib/highlight"
import { notify, notifyFailure } from "../lib/toast"
import EditedFilesCard from "./EditedFilesCard.vue"
import DeliveredFilesCard from "./DeliveredFilesCard.vue"
import MediaStrip from "./parts/MediaStrip.vue"
import { followSpoken } from "../lib/speak-part"
import AnnotationChips from "./AnnotationChips.vue"
import { openDocument } from "../lib/office-open"
import { occurrences, registerFoldedCounter } from "../lib/find-folded"
import { useRestoreDraft } from "../lib/draft"
import { cardCut, interruptedEnd, stepPart, stickState, stoppedEmpty } from "./parts/turn-end"

/**
 * WHY EVERY MESSAGE IS DRAWN, where opencode virtualises.
 *
 * Its transcript goes through a virtualizer - `TimelineRowView` rows measured
 * by `virtualizer.measureElement` (main-8t-QUXax.js @5068253) - and this one
 * renders the lot. That is the largest structural difference left between the
 * two, so it was measured rather than argued about, with a session written to
 * the app's own on-disk format and opened by the real loader:
 *
 *     300 messages   8,000 DOM nodes    240ms to first paint
 *   1,200 messages  32,000 DOM nodes    681ms to first paint
 *
 * and scrolling forty frames at 1,200 messages had a median frame of 5ms, a
 * worst of 13ms, and not one frame over 32ms. A virtualizer buys nothing at any
 * length a conversation reaches; it would cost the height measurement, the
 * jump-to-latest arithmetic, and every sticky element in a row.
 *
 * The four strings opencode carries for paging a transcript - loading,
 * loadEarlier, loadingEarlier, renderEarlier - are consumed zero times in its
 * own renderer, which is the same conclusion reached from its side.
 */

const app = useApp()

/*
 * In the side column the stream shows the side chat's conversation instead of
 * the open one. Everything the stream reads about "its" conversation goes
 * through these, so the two can never be mixed.
 */
const props = defineProps<{
  side?: boolean
  /* round3-panel: the side chat tab's own conversation, so a tab kept mounted out of sight keeps its transcript. */
  sideId?: string
  /* round3-panel: MiMo's floating chat card - only the latest turn, with no actions, question or jump button. */
  latest?: boolean
  /* subagents: a subagent's transcript in the 子智能体 tab - its first message is 初始任务, a live turn reads 处理中. */
  subagent?: boolean
}>()
const sideKey = computed(() => props.sideId ?? app.sideID)
const shownMessages = computed(() => (props.side ? app.sideMessagesOf(sideKey.value) : app.visible))
const shownBusy = computed(() => (props.side ? app.sideBusyOf(sideKey.value) : app.busy))
const shownCompacting = computed(() => (props.side ? false : app.compacting))
const shownSession = computed(() => (props.side ? app.sideSessionOf(sideKey.value) : app.current))
const shownID = computed(() => (props.side ? sideKey.value : app.currentID))
/* The project the shown conversation works in; a side conversation shares the main one's. */
const shownDirectory = computed(() => app.current?.directory)
const shownStreaming = computed(() => (props.side ? app.sideStreamingOf(sideKey.value) : app.streaming))
const shownError = computed(() => (props.side ? app.sideErrorOf(sideKey.value) : app.turnError))
/* round3-panel (P5-12/13): MiMo's side chat and floating card draw a reply with showActions false. */
const bare = computed(() => Boolean(props.side || props.latest))
/* The open conversation was just switched to and its messages are still on their way. */
const loadingHere = computed(() => !props.side && !props.latest && !props.subagent && Boolean(app.loadingID) && app.loadingID === app.currentID)
/*
 * MiMo's empty thread line: a conversation that has been read and has nothing
 * to draw - rolled back to its first question, say - says so rather than
 * leaving a blank pane. Not while a turn is starting, whose question is on its way.
 */
const emptyHere = computed(() => !props.side && !props.latest && !props.subagent && !loadingHere.value && !shownBusy.value && turns.value.length === 0)
/* speak: a completed call of the speak tool is read aloud, with the machine's own voice. */
followSpoken({
  enabled: () => !props.side && !props.latest && !props.subagent,
  session: () => shownID.value,
  messages: () => shownMessages.value,
})
const scroller = ref<HTMLElement>()

/**
 * A message sent into a turn while it was running (MiMo's 插话) that the model
 * has not taken yet, or news of subagents that reached the turn - and where
 * among the turn's parts it landed.
 */
interface Steer {
  id: string
  text?: string
  attachments?: Attachment[]
  created: number
  /** How many of the turn's parts came before it. */
  at: number
  /** subagents: news of background subagents, drawn as MiMo's pills rather than a bubble. */
  notices?: SubagentNotice[]
  /** subagents: a follow-up the parent sent, labelled 来自 {source} 的消息; session chat: another conversation's message. */
  inbox?: MessageSource
}

/*
 * A turn as MiMo's step list lays it out (see lib/step-rows): consecutive tool
 * calls under one summary line until the model says something, questions on
 * their own rows, and news of subagents where it landed. A group carries whether it is
 * the one the live turn is working in, which is the group that starts open.
 */
type Row =
  | Exclude<StepRow, { kind: "group" }>
  | { kind: "group"; id: string; items: StepItem[]; open: boolean; actor?: boolean }
  | { kind: "steer"; id: string; steer: Steer }
  /** MiMo's 正在重新连接 N, while the provider request is being tried again. */
  | { kind: "retry"; id: string; attempt: number; reason?: string; next?: number }

/** The rows for the parts between two points of the turn, with the errors that fell there. */
function rows(turn: Turn, start: number, end: number, live: boolean): Row[] {
  // An error exactly at a boundary belongs to the steps before it.
  const errors = turn.errors
    .filter((error) => error.at <= end && (start === 0 ? error.at >= 0 : error.at > start))
    .map((error) => ({ ...error, at: error.at - start }))
  const parts = turn.parts.slice(start, end).map((part) => stepPart(part, live))
  return buildRows(parts, errors).map((row) => (row.kind === "group" ? { ...row, open: false } : row))
}

interface Turn {
  id: string
  text?: string
  attachments?: Attachment[]
  /** The places the message pointed at, shown under it as MiMo does. */
  annotations?: Annotation[]
  /** subagents: a turn the runner started to tell of background subagents; it has no question. */
  notices?: SubagentNotice[]
  /** subagents: a turn a subagent took for its parent's follow-up; session chat: for another conversation's message. */
  inbox?: MessageSource
  /** When the user sent it, for the footer under their own message. */
  asked?: number
  parts: AssistantPart[]
  /** subagents: news of background subagents that reached the turn while it ran, drawn where it landed. */
  steers: Steer[]
  /** MiMo's 插话 the model has not taken yet: at the very end of the running turn, after its working marks. */
  waiting: Steer[]
  /** Errors from steps the turn went on past, drawn as MiMo's 错误：… where they happened. */
  errors: InlineError[]
  /** The assistant messages the turn is made of, which is how the server is told which turn to take back. */
  messageIDs: string[]
  last?: AssistantMessage
  started?: number
  completed?: number
  error?: string
  errorCode?: string
  errorParams?: Record<string, string>
  finish?: string
}

/**
 * One exchange, however many messages it took.
 *
 * The agent loop writes a fresh assistant message per step, so a turn that
 * calls six tools is six messages on the wire. Rendering those as six blocks
 * was why grouping never fired in practice and why the footer repeated: the
 * shape on screen has to be the turn, not the transport.
 */
const turns = computed<Turn[]>(() => {
  const out: Turn[] = []
  let current: Turn | undefined
  // MiMo 26.914: a steer the model has taken is a question of its own, and the turn before it is over.
  const openers = turnOpeners(shownMessages.value, !shownBusy.value)

  /*
   * The conversation as it now stands, which is not always the whole of what
   * is held. A conversation rolled back to a message keeps everything after
   * that message on disk so it can be put back, and the reader is told those
   * turns are no longer part of the conversation - so this is where they stop
   * being drawn.
   */
  for (const message of shownMessages.value) {
    // plan: the word that a plan was approved is the app's, not the user's - the model reads it, the transcript does not.
    if (message.role === "user" && message.synthetic) continue
    if (message.role === "user") {
      /*
       * A message sent into a running turn waits at the end of that turn until
       * the model takes it, and news of subagents stays where it landed. The
       * backend marks such a message when it joins the turn; guessing from the
       * step before it would also swallow the next question after a turn the
       * app was closed during.
       */
      if (current && !openers.has(message.id)) {
        const steer: Steer = {
          id: message.id,
          text: message.text,
          attachments: message.attachments,
          created: message.time.created,
          at: current.parts.length,
          notices: message.notices,
          inbox: message.inbox,
        }
        if (message.notices?.length) current.steers.push(steer)
        else current.waiting.push(steer)
        continue
      }
      /*
       * A taken steer settles the turn it was sent into as a whole one, as
       * MiMo's does: that turn's last step was a call, which carries no finish
       * of its own, and would otherwise read as broken off.
       */
      if (current?.last && message.steered) current.finish ??= "end_turn"
      current = {
        id: message.id,
        // subagents: a notice is the runner's words to the model, not a question to show.
        text: message.notices?.length ? undefined : message.text,
        attachments: message.attachments,
        annotations: message.annotations,
        notices: message.notices,
        inbox: message.inbox,
        asked: message.time.created,
        parts: [],
        steers: [],
        waiting: [],
        errors: [],
        messageIDs: [],
      }
      out.push(current)
      continue
    }
    if (!current) {
      current = { id: message.id, parts: [], steers: [], waiting: [], errors: [], messageIDs: [] }
      out.push(current)
    }
    /*
     * An earlier step of this turn failed and the turn went on past it - a
     * refusal for length answered by compacting and asking again. That failure
     * is a step where it happened, not how the turn ended.
     */
    const previous = current.last
    if (previous?.error) {
      current.errors.push({
        id: `err:${previous.id}`,
        at: current.parts.length,
        error: previous.error,
        errorCode: previous.errorCode,
        errorParams: previous.errorParams,
      })
      current.error = undefined
      current.errorCode = undefined
      current.errorParams = undefined
      current.finish = undefined
    }
    current.parts.push(...message.parts)
    current.messageIDs.push(message.id)
    current.last = message
    current.started ??= message.time.created
    current.completed = message.time.completed
    current.error = message.error ?? current.error
    current.errorCode = message.errorCode ?? current.errorCode
    current.errorParams = message.errorParams ?? current.errorParams
    current.finish = message.finish ?? current.finish
  }

  return out
})

/**
 * Whether the live turn ends in MiMo's working indicator.
 *
 * MiMo keeps a small cascade of four marks at the end of the turn for as long
 * as it runs - under the parts that have arrived, not only before the first -
 * and hides it while the turn waits on the reader (here: a permission request).
 */
function thinking(turn: Turn, at: number): boolean {
  if (at !== turns.value.length - 1) return false
  /*
   * A compaction shows it too, and it is the one case where the turn above
   * has an error: a request the provider refused for length is answered by
   * summarising the conversation and asking again, and that summary can take
   * minutes on a long transcript. Without this the refusal is the last thing
   * on screen for all of them, and the app looks like it stopped.
   */
  if (shownCompacting.value) return true
  const waiting = shownID.value ? app.pendingPermissions.has(shownID.value) : false
  return shownBusy.value && !turn.error && !waiting
}

// MiMo's fold for a long question: past fourteen lines, or past 1200 characters
// on fewer, not counting the newlines it ends on.
const ASKED_LINES = 14
const ASKED_CHARS = 1200
const openAsked = ref(new Set<string>())

function askedLines(text: string) {
  const trimmed = text.replace(/\n+$/, "")
  return trimmed ? trimmed.split("\n").length : 0
}

function foldable(text: string) {
  const trimmed = text.replace(/\n+$/, "")
  return askedLines(trimmed) > ASKED_LINES || trimmed.length > ASKED_CHARS
}

/*
 * Code in a question, as MiMo shows it: each fenced block drawn as the code
 * blocks in a reply are - language, copy - and folded past fourteen lines to
 * 264px under a fade, with "show all N lines" / "collapse code" beneath. The
 * text around it folds run by run, as a whole question does.
 */
function hasCode(text: string) {
  return questionParts(text).some((part) => part.type === "code")
}

const partKey = (turnID: string, index: number) => `${turnID}:${index}`

function codeFolds(code: string) {
  return askedLines(code) > ASKED_LINES
}

/* MiMo's chip under a sent message carries the file's name; the whole path is its tooltip. */
const fileName = (file: string) => file.split(/[\\/]/).pop() || file

/* MiMo's sent file chip: a document opens in the Office tab, anything else in the files tab. */
function openSentFile(file: string) {
  const directory = shownSession.value?.directory
  const absolute = /^([a-zA-Z]:)?[\\/]/.test(file) || !directory ? file : `${directory}/${file}`
  void openDocument({ path: absolute }, directory)
}

/* The code a question carries, in the same syntax colours as a reply's code blocks. */
const vHighlight = {
  mounted: (el: HTMLElement) => void highlightWithin(el),
  updated: (el: HTMLElement) => void highlightWithin(el),
}

function codeHtml(code: string, lang: string | null) {
  const fence = "```"
  return renderMarkdown([fence + (lang ?? ""), code, fence].join("\n"), {
    codeActions: { copy: t("code.copy"), copied: t("code.copied"), label: t("code.copyLabel") },
  })
}

/* The copy button inside that rendered block, caught on the way up as a reply's is. */
async function copyCode(event: MouseEvent) {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-copy-code]")
  if (!button) return
  const code = button.closest(".md-codeblock")?.querySelector("pre code")?.textContent ?? ""
  try {
    await navigator.clipboard.writeText(code)
    button.classList.add("copied")
    window.setTimeout(() => button.classList.remove("copied"), 2000)
  } catch {
    notifyFailure(t("code.copyFailed"))
  }
}

function toggleAsked(id: string) {
  const next = new Set(openAsked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openAsked.value = next
}

/**
 * A moment as the reference writes one: the day and the clock, "9月12日 19:50".
 *
 * Clock time rather than "5 minutes ago", because a message carries one fixed
 * moment and a relative phrase would have to keep being recomputed to stay
 * true. The day is written as well as the time: a conversation returned to
 * the next morning otherwise says "19:50" with nothing to say which evening.
 * Formatted in the interface's language rather than the machine's, so the
 * footer reads in the same language as the words beside it. As MiMo does, a
 * moment from another year carries its year in front.
 */
function stamp(at: number): string {
  const date = new Date(at)
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  const otherYear = date.getFullYear() !== new Date().getFullYear()
  if (language.value.startsWith("zh")) {
    const day = `${date.getMonth() + 1}月${date.getDate()}日`
    return `${otherYear ? `${date.getFullYear()}年` : ""}${day} ${clock}`
  }
  const day = new Intl.DateTimeFormat(language.value, {
    month: "short",
    day: "numeric",
    ...(otherYear ? { year: "numeric" as const } : {}),
  }).format(date)
  return `${day} ${clock}`
}

function askedAt(turn: Turn): string | undefined {
  return turn.asked === undefined ? undefined : stamp(turn.asked)
}

/** When the reply finished, for the footer under it - the reference keeps one there too. */
function completedAt(turn: Turn): string | undefined {
  return turn.completed === undefined ? undefined : stamp(turn.completed)
}

/*
 * The clipboard refuses a document that is not focused - an assistive tool
 * pressing the button on a window behind others - and an uncaught refusal
 * would take the whole window to the error page. MiMo answers it with its
 * "copy failed" notice.
 */
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notify(t("stream.replyCopied"))
  } catch {
    notifyFailure(t("code.copyFailed"))
  }
}

async function copyAsked(turn: Turn) {
  if (!turn.text) return
  await copyToClipboard(turn.text)
}

/** The reply itself, without the tool traffic that produced it. */
function replyText(turn: Turn): string {
  return turn.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? cleanReply(part.text) : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

async function copyReply(turn: Turn) {
  const text = replyText(turn)
  if (!text) return
  await copyToClipboard(text)
}

/*
 * Turns whose run of tool calls has been opened by hand.
 *
 * Folded is the resting state, as it is in MiMo: an answer arrives with its
 * steps put away behind the line above it, and the chevron opens them. This
 * was the other way round - shown unless folded - which left a long run of
 * lookups between the question and the sentence that answered it.
 */
const opened = ref(new Set<string>())

function foldRun(id: string) {
  const next = new Set(opened.value)
  if (!next.delete(id)) next.add(id)
  opened.value = next
}

/*
 * For find in the conversation: the matches in step rows that are folded away
 * - a turn's steps not opened, or a group of lookups not expanded - and so not
 * on screen to be searched. A row shows its title once it is drawn, so a row
 * that is not in the page counts its title here. Only the main conversation
 * registers.
 */
function foldedMatchCount(needle: string): number {
  let total = 0
  for (const turn of turns.value) {
    for (const part of turn.parts) {
      // A finished turn folds its earlier words too, as MiMo does, so those count as well.
      if (part.type === "text") {
        if (!saysSomething(part.text) || document.querySelector(`[data-text-part="${CSS.escape(part.id)}"]`)) continue
        total += occurrences(cleanReply(part.text), needle)
        continue
      }
      if (part.type !== "tool") continue
      if (document.querySelector(`[data-tool-part="${CSS.escape(part.id)}"]`)) continue
      total += occurrences(redactText(part.title ?? ""), needle)
    }
  }
  return total
}

let releaseFoldedCounter: (() => void) | undefined
onMounted(() => {
  if (!props.side && !props.latest) releaseFoldedCounter = registerFoldedCounter(foldedMatchCount)
})
onBeforeUnmount(() => releaseFoldedCounter?.())

/** Rows that say something to the reader: MiMo's stages end on these. */
function speaks(row: Row): boolean {
  if (row.kind === "part" || row.kind === "question") return true
  if (row.kind === "group") return Boolean(row.actor)
  return row.kind === "steer" && Boolean(row.steer.notices?.length)
}

/** MiMo's natural end: not stopped, not failed, not cut short by a quit. */
function endedNaturally(turn: Turn, at: number): boolean {
  return turn.finish !== "aborted" && !failed(turn) && !interrupted(turn, at)
}

/**
 * A turn's rows, and where its fold ends (0 when the head folds nothing).
 *
 * While the turn runs, everything, with the group it is working in open. Once
 * it is done, MiMo folds everything before the last stage's words - earlier
 * remarks and questions included - but only for a turn that ended naturally on
 * words or a question. Any other turn (stopped, failed, ended on a call or on
 * subagents) is laid out in full under a plain head, and a last stage that
 * said nothing has its groups open, so the reader sees where it stopped.
 */
function layout(turn: Turn, at: number): { rows: Row[]; foldAt: number } {
  const live = liveTurn(at)
  const all: Row[] = []
  let from = 0
  for (const steer of turn.steers) {
    all.push(...rows(turn, from, steer.at, live), { kind: "steer", id: steer.id, steer })
    from = steer.at
  }
  all.push(...rows(turn, from, turn.parts.length, live))

  if (live) {
    const retry = turn.last?.retry
    if (retry) all.push({ kind: "retry", id: `retry:${turn.last?.id}`, attempt: retry.attempt, reason: retryReason(retry.message, retry.kind), next: retry.next })
    // The last group with nothing said after it is the one being worked in.
    for (let index = all.length - 1; index >= 0; index--) {
      const row = all[index]!
      if (row.kind === "part") break
      if (row.kind === "group") {
        row.open = true
        break
      }
    }
    return { rows: all, foldAt: 0 }
  }

  const last = stagesOf(all, speaks).at(-1)
  if (!last) return { rows: all, foldAt: 0 }
  const tail = all[last.end - 1]
  if (endedNaturally(turn, at) && last.progressEnd < last.end && (tail?.kind === "part" || tail?.kind === "question")) {
    return { rows: all, foldAt: last.progressEnd }
  }
  if (last.progressEnd === last.end) {
    for (const row of all.slice(last.start, last.end)) if (row.kind === "group" && !row.actor) row.open = true
  }
  return { rows: all, foldAt: 0 }
}

const layouts = computed(() => turns.value.map((turn, at) => layout(turn, at)))

/** Whether the finished turn's head is MiMo's fold button. */
function folds(at: number): boolean {
  return (layouts.value[at]?.foldAt ?? 0) > 0
}

/* What the answer shows: the whole layout, or from the fold on while the head is closed. */
function shown(turn: Turn, at: number): Row[] {
  const { rows: all, foldAt } = layouts.value[at] ?? { rows: [], foldAt: 0 }
  return foldAt > 0 && !opened.value.has(turn.id) ? all.slice(foldAt) : all
}

/** Rows that belong to MiMo's tight step column rather than the reply's paragraphs. */
function isStep(row: Row): boolean {
  // subagents: notices that reached a running turn are a step row of pills, spaced as steps are.
  return row.kind === "group" || row.kind === "error" || row.kind === "retry" || row.kind === "question" || row.kind === "steer"
}

/** Whether this is the turn still being worked on. */
function liveTurn(at: number): boolean {
  return at === turns.value.length - 1 && shownBusy.value
}

/*
 * MiMo's head time: whole seconds as "12s", past a minute "1m 5s" - not
 * worded per language. It counts up once a second while the turn runs.
 */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
watch(
  shownBusy,
  (busy) => {
    clearInterval(ticker)
    ticker = undefined
    if (!busy) return
    now.value = Date.now()
    ticker = setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearInterval(ticker))

function headTime(turn: Turn, at: number): string | undefined {
  if (!turn.started) return undefined
  if (liveTurn(at)) return formatDuration(now.value - turn.started)
  return turn.completed ? formatDuration(turn.completed - turn.started) : undefined
}

/* How long a stopped turn ran, in the head's own "12s" / "1m 5s"; 0s when nothing was timed. */
function stoppedAfter(turn: Turn): string {
  return formatDuration(turn.started && turn.completed ? turn.completed - turn.started : 0)
}

/** Auto-follow is on until the user scrolls up, and resumes when they return. */
const following = ref(true)
/** MiMo's jump button, shown only once the reader is further than the stick distance from the end. */
const showJump = ref(false)

/* Asked again whenever the content changes, not only on scroll, as MiMo does. */
function measureJump() {
  const element = scroller.value
  if (!element) return
  showJump.value = stickState(element.scrollHeight, element.scrollTop, element.clientHeight).jump
}

function onScroll() {
  const element = scroller.value
  if (!element) return
  const state = stickState(element.scrollHeight, element.scrollTop, element.clientHeight)
  following.value = state.atEnd
  showJump.value = state.jump
}

function toBottom() {
  const element = scroller.value
  if (!element) return
  element.scrollTop = element.scrollHeight
}

/* MiMo's jump: straight to the end with no smooth scroll, following again, and the button gone in the same tick. */
function jump() {
  toBottom()
  following.value = true
  showJump.value = false
}

/*
 * Opening a session starts at its end, and starts following again.
 *
 * This component is mounted once and reused for every session - App.vue gives
 * it no key - so onMounted cannot do this, and a session opened after scrolling
 * up in the previous one would land in the middle of itself.
 */
watch(
  () => shownID.value,
  async () => {
    following.value = true
    await nextTick()
    toBottom()
    measureJump()
  },
)

/*
 * A new message only moves the view if the reader is already at the end.
 *
 * This used to be unguarded, and shared a watcher with the session change. So
 * scrolling up to read something during a turn lasted until the next message
 * arrived, which yanked the view back down - and because the jump also put the
 * scroller at the bottom, onScroll then set following back to true, so it could
 * not even be escaped twice.
 */
watch(
  () => shownMessages.value.length,
  async () => {
    await nextTick()
    if (following.value) toBottom()
    measureJump()
  },
)

// Streaming grows the last message in place, which does not change the array
// length - so follow the text itself.
watch(
  () => shownStreaming.value?.parts.map((part) => ("text" in part ? part.text.length : part.status)).join(),
  async () => {
    await nextTick()
    if (following.value) toBottom()
    measureJump()
  },
)

/*
 * Neither watcher above sees a part that grows without changing its text or
 * status: a question tool arrives as one part and then unfolds into its
 * options, a tool row expands, an image finishes loading. Following the
 * content's own height catches every one of those, which is also how the
 * reference's `createAutoScroll` does it - it observes the content element
 * and re-pins while the reader is at the bottom.
 */
const inner = ref<HTMLElement | null>(null)
let sizer: ResizeObserver | undefined

onMounted(() => {
  toBottom()
  if (typeof ResizeObserver === "undefined" || !inner.value) return
  sizer = new ResizeObserver(() => {
    if (following.value) toBottom()
    measureJump()
  })
  sizer.observe(inner.value)
})

onBeforeUnmount(() => sizer?.disconnect())

/**
 * Walks the conversation a turn at a time.
 *
 * "Where am I" is taken from whichever turn is closest to the top of the
 * viewport rather than from a remembered index: the user scrolls freely
 * between presses, and an index would send them somewhere they had left.
 */
/**
 * Carries this conversation, as far as the end of this answer, into one of its own.
 *
 * MiMo keeps its branch under the reply and nowhere else: the point to branch
 * from is an answer that was right, with the next step the thing to take
 * another way. The fork is made at the turn's last assistant message, which is
 * the end of the answer, so both the question and the answer come along.
 */
async function branchReply(turn: Turn) {
  if (!turn.last?.id) return
  await app.forkFrom(turn.last.id, { titleSuffix: true, here: true })
}

/* The fork marker's link: back to the conversation this one came from, if it is still there. */
async function backToSource(sourceID: string) {
  if (!app.sessions.some((session) => session.id === sourceID)) {
    notifyFailure(t("stream.sourceNotFound"))
    return
  }
  await app.open(sourceID)
  notify(t("stream.backToSource"))
}

/** True while an edit or retry is deleting and resending, so a second press cannot race the first. */
const resending = ref(false)

/* Where a resend that was not accepted leaves its words: back in the composer. */
const restoreDraft = useRestoreDraft()

/*
 * MiMo's in-place edit of the last question. Only the last one offers it; the
 * bubble becomes a box holding the question, and sending deletes the question
 * and everything after it - the files those turns changed stay as they are -
 * and sends the new words. While a turn is running it says so rather than
 * sending.
 */
const editingAsked = ref<string>()
const editDraft = ref("")

const lastAsked = computed(() => {
  for (let at = turns.value.length - 1; at >= 0; at--) {
    if (turns.value[at].text !== undefined) return turns.value[at].id
  }
  return undefined
})

// A question that stops being the last one (another was sent) is no longer editable.
watch(lastAsked, (id) => {
  if (editingAsked.value && editingAsked.value !== id) editingAsked.value = undefined
})

/** Grows with what is typed, up to half the window, then scrolls. */
function fitEdit(field: HTMLTextAreaElement) {
  field.style.height = "auto"
  const cap = Math.round(window.innerHeight * 0.5)
  field.style.height = `${Math.min(field.scrollHeight, cap)}px`
  field.style.overflowY = field.scrollHeight > cap ? "auto" : "hidden"
}

/** From the edit button the caret goes to the end; from a double-click all of it is selected. */
async function startEdit(turn: Turn, selectAll: boolean) {
  if (props.side || turn.id !== lastAsked.value) return
  window.getSelection()?.removeAllRanges()
  editDraft.value = turn.text ?? ""
  editingAsked.value = turn.id
  await nextTick()
  const field = scroller.value?.querySelector<HTMLTextAreaElement>("[data-asked-edit] textarea")
  if (!field) return
  field.focus({ preventScroll: true })
  field.setSelectionRange(selectAll ? 0 : field.value.length, field.value.length)
  fitEdit(field)
}

function cancelEdit() {
  editingAsked.value = undefined
}

async function sendEdit(turn: Turn) {
  const text = editDraft.value.trim()
  if (!text) return
  const sessionID = app.currentID
  const message = shownMessages.value.find((entry) => entry.id === turn.id)
  if (!sessionID || shownBusy.value || resending.value || message?.role !== "user") {
    notifyFailure(t("stream.editBusy"))
    return
  }
  resending.value = true
  app.markReplacing(sessionID, true)
  try {
    await app.truncate(sessionID, turn.id)
    editingAsked.value = undefined
    // As MiMo: the messages are already gone, so a send that is refused keeps the words as a draft.
    if (!(await app.send(text, message.attachments ?? [], undefined, message.annotations ?? []))) {
      restoreDraft({ ...message, text })
    }
  } catch (failure) {
    notifyFailure(t("common.requestFailed"), failure instanceof Error ? failure.message : String(failure))
  } finally {
    resending.value = false
    app.markReplacing(sessionID, false)
  }
}

function onEditKey(event: KeyboardEvent, turn: Turn) {
  if (event.key === "Escape") {
    event.preventDefault()
    cancelEdit()
    return
  }
  // Enter sends and Shift+Enter breaks the line; an IME still composing keeps its Enter.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    void sendEdit(turn)
  }
}

/*
 * MiMo's sent pictures open in its image preview, zooming out of the tile that
 * was pressed; the message's other pictures are its neighbours.
 */
function previewSent(item: Attachment, all: Attachment[] | undefined, event: MouseEvent) {
  const url = preview(item)
  if (!url) return
  const group = (all ?? []).map((entry) => preview(entry)).filter((entry): entry is string => Boolean(entry))
  // `rect` is the reply agent's addition to ImagePreviewMeta (P1-4), not merged here yet.
  const meta: ImagePreviewMeta & { rect?: DOMRect } = {
    name: item.path.split(/[\\/]/).pop(),
    group,
    rect: (event.currentTarget as HTMLElement).getBoundingClientRect(),
  }
  openImagePreview(url, meta)
}

/** Whether the turn said or did anything a reader would call an answer. */
function answered(turn: Turn): boolean {
  return turn.parts.some((part) => (part.type === "text" && cleanReply(part.text)) || part.type === "tool")
}

/*
 * MiMo's think-only turn: the model reasoned and then stopped without an
 * answer. MiMo writes it up as a failure, with the retry, rather than as an
 * empty reply - there was output, just not the part that counts.
 */
function thinkOnly(turn: Turn): boolean {
  if (!turn.finish || turn.error || turn.finish === "aborted" || answered(turn)) return false
  return turn.parts.some((part) => part.type === "reasoning" && part.text.trim())
}

/** A turn that finished without saying or doing anything. */
function emptyReply(turn: Turn): boolean {
  if (!turn.finish || turn.error || ["aborted", "error", "max_tokens"].includes(turn.finish)) return false
  return !answered(turn) && !thinkOnly(turn)
}

/* MiMo's failure card: an error, a reply cut at the length limit, or reasoning with no answer. */
function failed(turn: Turn): boolean {
  return Boolean(turn.error) || turn.finish === "error" || turn.finish === "max_tokens" || thinkOnly(turn)
}

/*
 * A turn the app was killed in the middle of: no finish was ever written, and
 * nothing is running now to write one. MiMo has a line for exactly this
 * (harnessRow.aborted); without it the reply simply stopped mid-sentence and
 * nothing on the page said why - the only hint was the 继续 button that
 * appeared in the box.
 */
function interrupted(turn: Turn, at: number): boolean {
  return interruptedEnd(turn, liveTurn(at))
}

/** Which of the three closing lines a turn that said nothing usable ends on. */
function finishedNote(turn: Turn, at: number): string {
  if (interrupted(turn, at)) return t("stream.interrupted")
  return emptyReply(turn) ? t("stream.noContent") : t("stream.stoppedAfter", { dur: stoppedAfter(turn) })
}

/**
 * The provider's own words, where they say something the sentence does not.
 *
 * MiMo shows both - its short sentence, and the raw text after 原始错误： - and
 * the runner has stored this all along as `errorParams.detail`. Only shown
 * once the failure was classified: an unclassified one already has the raw
 * text as its whole message, and repeating it under itself reads as a stutter.
 */
function failureDetail(turn: Turn): string {
  if (!turn.errorCode) return ""
  const detail = turn.errorParams?.detail?.trim() ?? ""
  if (!detail) return ""
  // Nothing is gained by printing the sentence again in the provider's words.
  return detail === failureText(turn).text.trim() ? "" : detail
}

/* The card's words, cut as MiMo cuts them; nothing at all reads as the model having returned nothing usable. */
function failureText(turn: Turn): { text: string; clamped: boolean } {
  let said = t("stream.thinkOnlyNoAnswer")
  if (turn.finish === "max_tokens" && !turn.error) said = t("error.outputLength")
  else if (turn.error || turn.finish === "error") said = turn.errorCode ? t(turn.errorCode, turn.errorParams) : (turn.error ?? "")
  return cardCut(said) ?? { text: t("error.emptyOutput"), clamped: false }
}

/*
 * MiMo's retry on a turn that failed, was stopped or came back empty: the
 * question that started it goes out again, as it was, in place of the turn.
 * The question and everything after it are deleted - no file moves, as with
 * editing - and the question is sent once more. While a turn is still
 * running, or when there is no question to send, it says so instead.
 */
async function retry(turn: Turn) {
  const sessionID = props.side ? sideKey.value : app.currentID
  const message = shownMessages.value.find((entry) => entry.id === turn.id)
  if (!sessionID || shownBusy.value || resending.value || message?.role !== "user") {
    notifyFailure(t("stream.retryUnavailable"))
    return
  }
  resending.value = true
  app.markReplacing(sessionID, true)
  try {
    await app.truncate(sessionID, turn.id)
    const sent = await app.send(message.text ?? "", message.attachments ?? [], props.side ? sessionID : undefined, message.annotations ?? [])
    if (!sent && !props.side) restoreDraft(message)
  } catch (failure) {
    notifyFailure(t("common.requestFailed"), failure instanceof Error ? failure.message : String(failure))
  } finally {
    resending.value = false
    app.markReplacing(sessionID, false)
  }
}

/*
 * MiMo's search result: the conversation goes to the message and flashes it,
 * the class kept for 1.3s over a 1.2s fade. Asked through the store's
 * revealMessage(id); the message may still be loading when a search opens
 * another conversation, so it is looked for every 80ms for up to 2s.
 */
const REVEAL_FLASH = 1300
const REVEAL_POLL = 80
const REVEAL_GIVE_UP = 2000
let revealTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => app.revealRequest,
  async (asked) => {
    if (!asked || props.side) return
    const selector = `[data-message-id="${CSS.escape(asked.id)}"], [data-message-ids~="${CSS.escape(asked.id)}"]`
    for (let attempt = 0; attempt <= REVEAL_GIVE_UP / REVEAL_POLL; attempt++) {
      await nextTick()
      const target = scroller.value?.querySelector<HTMLElement>(selector)
      if (target) {
        following.value = false
        target.scrollIntoView({ block: "center" })
        measureJump()
        target.classList.remove("revealed")
        void target.offsetWidth
        target.classList.add("revealed")
        clearTimeout(revealTimer)
        revealTimer = setTimeout(() => target.classList.remove("revealed"), REVEAL_FLASH)
        return
      }
      if (app.revealRequest !== asked) return
      await new Promise((resolve) => setTimeout(resolve, REVEAL_POLL))
    }
  },
)
onBeforeUnmount(() => clearTimeout(revealTimer))

function stepMessage(by: 1 | -1) {
  const view = scroller.value
  if (!view) return
  const turns = [...view.querySelectorAll<HTMLElement>("[data-turn]")]
  if (!turns.length) return

  const top = view.getBoundingClientRect().top
  let nearest = 0
  let best = Infinity
  turns.forEach((turn, index) => {
    const distance = Math.abs(turn.getBoundingClientRect().top - top)
    if (distance < best) {
      best = distance
      nearest = index
    }
  })

  const target = turns[Math.max(0, Math.min(turns.length - 1, nearest + by))]
  target?.scrollIntoView({ block: "start", behavior: "smooth" })
}

// The scroller is exposed for the conversation navigator, which stands beside it.
defineExpose({ stepMessage, scroller })
</script>

<template>
  <div ref="scroller" class="stream" :aria-busy="loadingHere || undefined" @scroll="onScroll">
    <div ref="inner" class="inner">
      <!-- MiMo's line while a conversation just switched to has not brought its messages. -->
      <div v-if="loadingHere" class="thread-loading" data-thread-loading>{{ t("stream.loadingConvo") }}</div>
      <div v-else-if="emptyHere" class="thread-loading" data-thread-empty>{{ t("stream.emptyConvo") }}</div>
      <!--
        MiMo's marker at the top of a branched conversation: a hairline either
        side of a link back to the conversation it came from.
      -->
      <div v-if="!bare && shownSession?.forkOf" class="fork-row" data-fork-row>
        <div class="fork-line" />
        <button type="button" class="fork-label" :data-fork-src="shownSession.forkOf" @click="backToSource(shownSession.forkOf)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
            <path
              d="M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm12-6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm0 0v3a6 6 0 0 1-6 6"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {{ t("stream.forkedFrom") }}
        </button>
        <div class="fork-line" />
      </div>
      <template v-for="(turn, at) in turns" :key="turn.id">
      <!-- round3-panel: the floating card draws the latest turn only, without its question. -->
      <div v-if="!latest || at === turns.length - 1" class="turn" :data-turn="turn.id">
        <!-- Beyond MiMo: a heading per turn that is never drawn, for a screen reader's heading keys; find and selection pass it by. -->
        <h2 v-if="!latest" class="a11y-only" data-turn-heading data-find-skip data-selectable="none">{{ t("a11y.turnHeading", { n: at + 1 }) }}</h2>
        <!-- subagents: what a subagent was handed, labelled as MiMo labels it. -->
        <div v-if="subagent && at === 0 && turn.text !== undefined && !turn.inbox" class="subagent-initial" data-subagent-initial>{{ t("subagentDetail.initialTask") }}</div>
        <!-- session chat: the same row names another conversation, over the question it sent. -->
        <!-- automation: and a scheduled task's run, as MiMo marks one. -->
        <MessageSourceRow v-else-if="turn.inbox && (subagent || (!latest && (turn.inbox.sessionID || turn.inbox.automationID)))" :source="turn.inbox" />
        <div
          v-if="!latest && (turn.text !== undefined || turn.attachments?.length)"
          class="msg user"
          :class="{ editing: editingAsked === turn.id }"
          :data-message-id="turn.id"
        >
          <div v-if="turn.attachments?.length" class="sent">
            <template v-for="(item, at) in turn.attachments" :key="at">
              <button
                v-if="preview(item)"
                type="button"
                class="sent-tile picture"
                :aria-label="t('stream.previewTip')"
                v-tip="{ label: t('stream.previewTip'), placement: 'top' }"
                :data-preview-src="preview(item)"
                @click="previewSent(item, turn.attachments, $event)"
              >
                <img :src="preview(item)" :alt="item.path" />
              </button>
              <button
                v-else-if="videoUrl(item)"
                type="button"
                class="sent-tile picture"
                :aria-label="t('stream.previewTip')"
                v-tip="{ label: t('stream.previewTip'), placement: 'top' }"
                data-sent-video
                @click="openVideoPreview(videoUrl(item) ?? '', { name: item.path })"
              >
                <video :src="videoUrl(item)" muted playsinline preload="metadata" />
              </button>
              <span
                v-else
                class="sent-tile file"
                :class="{ openable: Boolean(item.path) }"
                v-tip="item.path ? t('stream.previewTip') : ''"
                :role="item.path ? 'button' : undefined"
                :tabindex="item.path ? 0 : undefined"
                data-sent-file
                @click="item.path && openSentFile(item.path)"
                @keydown.enter.space.prevent="item.path && openSentFile(item.path)"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M13.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5L13.5 3Z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                  />
                  <path d="M13.4 3.2V9.6H19.8" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                </svg>
                <span class="sent-name">{{ fileName(item.path) }}</span>
              </span>
            </template>
          </div>
          <!--
            MiMo folds a long question: its first 264px under a fade, and a
            button beneath that says how many lines there are. Kept on one line
            each - the bubble keeps its whitespace, so any between these shows.
          -->
          <div v-if="editingAsked === turn.id" class="asked-edit" data-asked-edit>
            <textarea
              v-model="editDraft"
              rows="1"
              :placeholder="t('stream.editPlaceholder')"
              spellcheck="false"
              @input="fitEdit($event.target as HTMLTextAreaElement)"
              @keydown="onEditKey($event, turn)"
            />
            <div class="asked-edit-actions">
              <span v-if="shownBusy" class="asked-edit-busy" data-edit-busy>{{ t("stream.editBusy") }}</span>
              <button type="button" class="asked-edit-cancel" data-edit-cancel @click="cancelEdit">{{ t("common.cancel") }}</button>
              <button
                type="button"
                class="asked-edit-send"
                data-edit-send
                :disabled="shownBusy || resending || !editDraft.trim()"
                @click="sendEdit(turn)"
              >
                {{ t("stream.editSend") }}
              </button>
            </div>
          </div>
          <div v-else-if="turn.text && hasCode(turn.text)" class="user-bubble" data-asked-parts @dblclick="startEdit(turn, true)">
            <template v-for="(part, index) in questionParts(turn.text)" :key="index">
              <div
                v-if="part.type === 'code'"
                class="asked-code"
                data-asked-code
                :data-folded="codeFolds(part.code) && !openAsked.has(partKey(turn.id, index)) ? '' : undefined"
              >
                <div
                  class="text asked-code-body"
                  :class="{ folded: codeFolds(part.code) && !openAsked.has(partKey(turn.id, index)) }"
                  v-highlight
                  @click="copyCode"
                  v-html="codeHtml(part.code, part.lang)"
                />
                <button
                  v-if="codeFolds(part.code)"
                  class="asked-expand code-expand"
                  data-code-expand
                  @click="toggleAsked(partKey(turn.id, index))"
                  @dblclick.stop
                >
                  {{ openAsked.has(partKey(turn.id, index)) ? t("stream.collapseCode") : t("stream.expandAsked", { count: askedLines(part.code) }) }}
                </button>
              </div>
              <div v-else-if="foldable(part.text)" class="asked-part" data-asked-fold :data-folded="openAsked.has(partKey(turn.id, index)) ? undefined : ''"><span class="asked-text" :class="{ folded: !openAsked.has(partKey(turn.id, index)) }">{{ part.text }}</span><button class="asked-expand" data-asked-expand @click="toggleAsked(partKey(turn.id, index))" @dblclick.stop>{{ openAsked.has(partKey(turn.id, index)) ? t("stream.collapseAsked") : t("stream.expandAsked", { count: askedLines(part.text) }) }}</button></div>
              <div v-else class="asked-part">{{ part.text }}</div>
            </template>
          </div>
          <div v-else-if="turn.text && foldable(turn.text)" class="user-bubble" data-asked-fold :data-folded="openAsked.has(turn.id) ? undefined : ''" @dblclick="startEdit(turn, true)">
            <span class="asked-text" :class="{ folded: !openAsked.has(turn.id) }">{{ turn.text }}</span><button class="asked-expand" data-asked-expand @click="toggleAsked(turn.id)" @dblclick.stop>{{ openAsked.has(turn.id) ? t("stream.collapseAsked") : t("stream.expandAsked", { count: askedLines(turn.text) }) }}</button>
          </div>
          <div v-else-if="turn.text" class="user-bubble" @dblclick="startEdit(turn, true)">{{ turn.text }}</div>
          <AnnotationChips v-if="turn.annotations?.length" class="asked-annotations" :list="turn.annotations" read-only />

          <!--
            The same footer the reply gets. What was asked is worth being able
            to copy back out, and which model picked it up belongs with the
            question as much as with the answer.
          -->
          <!--
            MiMo's question footer: when it was asked, then copy, then edit.
            Branching lives under the answer, and the agent and model are the
            answer's to state. Edit is offered on the last question only and
            edits it in place; the footer steps aside while it does.
          -->
          <div v-if="editingAsked !== turn.id" class="user-meta" data-user-meta>
            <span v-if="askedAt(turn)" class="user-time" data-user-time>{{ askedAt(turn) }}</span>
            <div class="user-actions" data-user-actions>
              <button
                type="button"
                class="msg-act"
                data-msg-act="ucopy"
                :aria-label="t('stream.copyAsked')"
                v-tip="{ label: t('stream.copyAsked'), placement: 'top' }"
                @click="copyAsked(turn)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="8" y="8" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2.2" />
                  <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="2.2" />
                </svg>
              </button>
              <button
                v-if="!side && turn.id === lastAsked"
                type="button"
                class="msg-act"
                data-msg-act="edit"
                :disabled="resending"
                :aria-label="t('stream.edit')"
                v-tip="{ label: t('stream.edit'), placement: 'top' }"
                @click="startEdit(turn, false)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M15.9 3.9a2.1 2.1 0 0 1 3 3L8 17.8l-4 1 1-4z"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- subagents: a turn started by news of background subagents opens with their pills, as MiMo draws its actor notifications. -->
        <!-- Drawn in the floating card too, as MiMo's harness row draws its actor notifications wherever the row is. -->
        <div v-if="turn.notices?.length" class="subagent-notices" data-subagent-notices>
          <SubagentActivity :notices="turn.notices" />
        </div>

        <!-- One block answers with every assistant message of the turn: the first names it, and all of them are listed. -->
        <!-- A retry drops what the failed attempt streamed, so a live turn retrying its first request has no parts yet and still shows its reconnecting row. -->
        <div
          v-if="turn.parts.length || turn.error || turn.finish || (liveTurn(at) && turn.last?.retry)"
          class="msg assistant"
          :data-message-id="turn.messageIDs[0]"
          :data-message-ids="turn.messageIDs.join(' ')"
        >
          <!--
            What the turn did, above the answer rather than under it. MiMo
            states it there and keeps it; this app had the same figure in a
            footer that only appeared under the pointer. The chevron folds the
            run of tool calls away - offered, not imposed, so an answer still
            arrives with its work visible.
          -->
          <!--
            MiMo's harness head. While the turn runs it reads 已处理 with a sweep
            over the word and the time counting up; once done, a turn that did
            work is one button - the words, the time and a chevron - that folds
            its steps away.
          -->
          <button
            v-if="turn.started && folds(at)"
            type="button"
            class="run foldable"
            data-turn-head
            :aria-expanded="opened.has(turn.id)"
            :aria-label="t('turn.steps')"
            @click="foldRun(turn.id)"
          >
            <span class="run-label">{{ t("turn.processed") }}</span>
            <span v-if="headTime(turn, at)" class="run-time" data-turn-time>{{ headTime(turn, at) }}</span>
            <svg class="run-chev" :class="{ open: opened.has(turn.id) }" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m9 18 6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <!-- P5-5: MiMo draws no head over a finished turn with neither steps nor words, so a failure card sits flush at the top. -->
          <div v-else-if="turn.started && (liveTurn(at) || answered(turn))" class="run" data-turn-head :data-live="liveTurn(at) ? 'true' : undefined">
            <span class="run-label"><TextShimmer :text="t(subagent && liveTurn(at) ? 'subagentDetail.liveHead' : 'turn.processed')" :active="liveTurn(at)" /></span>
            <span v-if="headTime(turn, at)" class="run-time" data-turn-time>{{ headTime(turn, at) }}</span>
          </div>

          <div v-for="row in shown(turn, at)" :key="row.id" class="part" :class="{ step: isStep(row) }">
            <!-- subagents: news of background subagents that reached the turn while it ran. -->
            <SubagentActivity v-if="row.kind === 'steer'" :notices="row.steer.notices" />
            <ToolGroup v-else-if="row.kind === 'group'" :items="row.items" :default-open="row.open" :actor="row.actor" />
            <QuestionCard v-else-if="row.kind === 'question'" :part="row.part" />
            <ErrorStep v-else-if="row.kind === 'error'" :error="row.error" />
            <RetryRow v-else-if="row.kind === 'retry'" :attempt="row.attempt" :reason="row.reason" :next="row.next" @stop="app.abort(shownID)" />
            <TextPart v-else-if="row.part.type === 'text'" :part="row.part" />
          </div>

          <!--
            MiMo's "edited N files" card, once the turn is over: what it changed,
            with 撤销 and 审阅. A live turn has none - its files are still moving.
          -->
          <EditedFilesCard
            v-if="!(at === turns.length - 1 && shownBusy)"
            :parts="turn.parts"
            :message-ids="turn.messageIDs"
            :session-id="shownID"
            :directory="shownDirectory"
            :reverted="turn.last?.reverted === true"
            :actions="!side"
          />

          <!-- MiMo's delivered-file cards: what the turn's present_files calls handed over. -->
          <DeliveredFilesCard
            v-if="!(at === turns.length - 1 && shownBusy)"
            :parts="turn.parts"
            :directory="shownDirectory"
          />

          <!-- MiMo's video cards: one group for the whole finished reply, after its delivered files. -->
          <MediaStrip v-if="!(at === turns.length - 1 && shownBusy)" :text="replyText(turn)" />

          <!--
            A failure as MiMo shows one: a card with the reason and a retry at its
            end. A stop that got nothing out, or an empty reply, gets its line and
            a quiet retry under it; a stop after output ends on its action row.
          -->
          <div v-if="failed(turn)" class="err-card" :class="{ detailed: Boolean(failureDetail(turn)) }" data-turn-error>
            <svg class="err-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.7" />
              <path d="M10 5.9v4.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              <circle cx="10" cy="13.7" r="1" fill="currentColor" />
            </svg>
            <span class="err-text" :class="{ clamped: failureText(turn).clamped }" data-err-text>{{ failureText(turn).text }}</span>
            <!--
              MiMo keeps the provider's own words beside its short sentence
              (`{code, message, detail}`, joined under 原始错误：). Without this
              a self-hosted gateway's 401, a quota-naming 429 and a 500 naming
              the wrong model id all collapsed into one generic line, and the
              detail the runner had already stored was drawn nowhere.
            -->
            <span v-if="failureDetail(turn)" class="err-detail" data-err-detail>{{ t("error.detail", { detail: failureDetail(turn) }) }}</span>
            <button v-if="!bare" class="retry-pill" data-retry @click="retry(turn)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M3.5 3.5v5h5" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              {{ t("stream.retry") }}
            </button>
          </div>
          <template v-else-if="!bare && (stoppedEmpty(turn) || emptyReply(turn) || interrupted(turn, at))">
            <div class="note finished" :class="{ empty: emptyReply(turn) }" data-turn-finished>
              {{ finishedNote(turn, at) }}
            </div>
            <div class="retry-row">
              <button
                class="retry-icon"
                data-retry
                :aria-label="t('stream.retry')"
                v-tip="{ label: t('stream.retry'), placement: 'top' }"
                @click="retry(turn)"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.9h-2.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </template>

          <!--
            MiMo's action row under a reply: copy and branch, always there, 26px
            each; then the time it finished, which shows under the pointer only.
            A failed turn keeps it, under its card.
          -->
          <div v-if="!bare && turn.finish && turn.last && !stoppedEmpty(turn)" class="msg-actions" data-msg-actions>
            <button
              type="button"
              class="msg-act"
              data-msg-act="copy"
              :aria-label="t('stream.replyCopy')"
              v-tip="{ label: t('stream.replyCopy'), placement: 'top' }"
              @click="copyReply(turn)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="8" y="8" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2.2" />
                <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="2.2" />
              </svg>
            </button>
            <button
              v-if="!side"
              type="button"
              class="msg-act"
              data-msg-act="branch"
              :aria-label="t('stream.replyFork')"
              v-tip="{ label: t('stream.replyFork'), placement: 'top' }"
              @click="branchReply(turn)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="6" cy="5" r="2.2" stroke="currentColor" stroke-width="2.2" />
                <circle cx="6" cy="19" r="2.2" stroke="currentColor" stroke-width="2.2" />
                <circle cx="18" cy="8" r="2.2" stroke="currentColor" stroke-width="2.2" />
                <path d="M6 7.2v9.6M18 10.2c0 4-3.4 5.2-8.3 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              </svg>
            </button>
            <span v-if="completedAt(turn)" class="msg-time" data-msg-time>{{ completedAt(turn) }}</span>
          </div>
        </div>

        <div
          v-if="thinking(turn, at)"
          class="work-indicator"
          role="status"
          aria-live="polite"
          :aria-label="t('stream.workLoading')"
          data-work-loading
        >
          <svg viewBox="0 0 34 7" width="34" height="7" aria-hidden="true" focusable="false">
            <circle v-for="x in [3.5, 12.5, 21.5, 30.5]" :key="x" :cx="x" cy="3.5" r="3" fill="currentColor" />
          </svg>
        </div>

        <!--
          MiMo 26.914's 插话 not yet taken: at the very end of the running turn,
          after its words and working marks, in the question's own bubble with
          已插话 · 会尽快处理 under it. Once the model takes it, it is the next
          turn's question.
        -->
        <div
          v-for="steer in turn.waiting"
          :key="steer.id"
          class="steer"
          :data-user-steer="steer.id"
          :data-message-id="steer.id"
          data-steer-state="waiting"
        >
          <div v-if="steer.attachments?.length" class="sent">
            <template v-for="(item, index) in steer.attachments" :key="index">
              <button
                v-if="preview(item)"
                type="button"
                class="sent-tile picture"
                :aria-label="t('stream.previewTip')"
                v-tip="{ label: t('stream.previewTip'), placement: 'top' }"
                :data-preview-src="preview(item)"
                @click="previewSent(item, steer.attachments, $event)"
              >
                <img :src="preview(item)" :alt="item.path" />
              </button>
              <button
                v-else-if="videoUrl(item)"
                type="button"
                class="sent-tile picture"
                :aria-label="t('stream.previewTip')"
                v-tip="{ label: t('stream.previewTip'), placement: 'top' }"
                data-sent-video
                @click="openVideoPreview(videoUrl(item) ?? '', { name: item.path })"
              >
                <video :src="videoUrl(item)" muted playsinline preload="metadata" />
              </button>
              <span v-else class="sent-tile file">
                <span class="sent-name">{{ fileName(item.path) }}</span>
              </span>
            </template>
          </div>
          <MessageSourceRow v-if="steer.inbox && (subagent || steer.inbox.sessionID || steer.inbox.automationID)" :source="steer.inbox" />
          <div v-if="steer.text" class="user-bubble steer-bubble">{{ steer.text }}</div>
          <span class="steer-note">{{ t("stream.steerWaiting") }}</span>
        </div>
      </div>
      </template>

      <div v-if="shownError && !latest" class="err banner">{{ shownError }}</div>
    </div>

    <!--
      Icon only, with the words left to the label. The reference's button is
      26x22 around a 13px arrow and says nothing out loud; this said "jump to
      latest" in full, which is four times the width for a control that appears
      over the conversation it is covering.
    -->
    <button
      v-if="showJump && !latest"
      class="jump"
      data-jump-to-bottom
      :aria-label="t('stream.jumpToBottom')"
      :title="t('stream.jumpToBottom')"
      @click="jump"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* MiMo's msg-actions: 2px apart, drawn a hair up into the reply above. */
.msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: -2px;
}

/* Under a card - the edited files, or the artifacts - it keeps its distance. */
.msg-actions:is(.file-card + .msg-actions, [data-fc-reverted] + .msg-actions, .fc-confirm + .msg-actions, .err-card + .msg-actions) {
  margin-top: 10px;
}

.msg-act {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.msg-act:hover {
  color: var(--text-base);
  background: var(--surface-hover);
}

.msg-act:active {
  scale: 0.96;
}

/* The finish time: after a hairline, only while the pointer or focus is on the reply. */
.msg-time {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-inline-start: 6px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  opacity: 0;
  transition: opacity 0.12s;
}

.msg-time::before {
  width: 1px;
  height: 12px;
  content: "";
  background: var(--border-weak);
}

.msg.assistant:hover .msg-time,
.msg.assistant:focus-within .msg-time {
  opacity: 1;
}

/* MiMo's fork-row: 12 apart, 26 above the first question. */
.fork-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 26px;
}

.fork-line {
  flex: 1;
  height: 1px;
  background: var(--border-weak);
}

.fork-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  color: var(--text-interactive);
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: transparent;
  border: 0;
  cursor: pointer;
}

/*
 * MiMo's user-meta under a question: the time, then copy and edit, 2px below
 * the bubble; all of it out of sight, and the buttons out of reach, until the
 * question is under the pointer or holds focus.
 */
.user-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 2px;
}

.user-time {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  opacity: 0;
  transition: opacity 0.12s;
}

.user-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}

.msg.user:hover .user-time,
.msg.user:focus-within .user-time,
.msg.user:hover .user-actions,
.msg.user:focus-within .user-actions {
  opacity: 1;
}

.msg.user:hover .user-actions,
.msg.user:focus-within .user-actions {
  pointer-events: auto;
}

/*
 * MiMo's working indicator: a 40 by 14 box at 58% of the strongest text colour
 * holding a 34 by 7 row of four marks, each rising and brightening in turn over
 * a 1.8s loop (a tenth of the loop apart). The marks are MCode's own dots.
 */
.work-indicator {
  display: flex;
  align-items: center;
  width: 40px;
  height: 14px;
  margin-top: 6px;
  color: var(--text-strong);
  opacity: 0.58;
}

.work-indicator svg {
  display: block;
  width: 34px;
  height: 7px;
  margin-inline-start: 2px;
  overflow: visible;
}

.work-indicator circle {
  transform-box: fill-box;
  animation: work-cascade 1.8s ease-in-out infinite both;
}

.work-indicator circle:nth-child(2) {
  animation-delay: 0.18s;
}

.work-indicator circle:nth-child(3) {
  animation-delay: 0.36s;
}

.work-indicator circle:nth-child(4) {
  animation-delay: 0.54s;
}

@keyframes work-cascade {
  0%,
  100% {
    opacity: 0.28;
    transform: translateY(1px);
  }

  42% {
    opacity: 1;
    transform: translateY(-1px);
  }
}

.stream {
  position: relative;
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

/*
 * MiMo's rows: the question and the answer each keep 26px below them, with no
 * spacer between turns, so a question stands 26 from its answer and an answer
 * 26 from the next question.
 */
.msg {
  margin-bottom: 26px;
}

.msg.user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/*
 * MiMo's in-place edit: the row spans the column, the question's own bubble
 * colour holds a box that grows with the words, and 取消 / 发送 sit under it at
 * the end, with a quiet note on the left while a turn is running.
 */
.msg.user.editing {
  align-items: flex-start;
}

.asked-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  padding: 9px 13px;
  background: color-mix(in srgb, var(--text-strong) 9.5%, var(--surface-raised));
  border-radius: 16px;
}

.asked-edit textarea {
  width: 100%;
  padding: 0;
  overflow: hidden;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 20px;
}

.asked-edit-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.asked-edit-busy {
  margin-inline-end: auto;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.4;
}

.asked-edit-cancel,
.asked-edit-send {
  padding: 5px 12px;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.asked-edit-cancel {
  color: var(--text-base);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
}

.asked-edit-cancel:hover {
  background: var(--surface-hover);
}

.asked-edit-send {
  color: var(--surface-base);
  background: var(--text-strong);
  border: 0;
}

.asked-edit-send:hover {
  opacity: 0.9;
}

.asked-edit-send:disabled {
  opacity: 0.4;
  cursor: default;
}

/*
 * Ranged against the right, under the message they belong to, and never wider
 * than the bubble itself.
 */
.sent {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  width: fit-content;
  max-width: min(82%, 64ch);
  margin-bottom: 8px;
  margin-inline-start: auto;
}

/*
 * Two shapes, not one.
 *
 * A picture is a small plate you recognise at a glance; a file is a name you
 * have to read, so it gets a row wide enough to hold one. Sizing both as the
 * same square made the pictures too small to recognise and the names too
 * cramped to read.
 */
.sent-tile {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  background: var(--surface-layer);
  border: 0.5px solid var(--border-weak);
  border-radius: 6px;
  transition: border-color 0.15s;
}

.sent-tile:hover {
  border-color: var(--border-strong);
}

/* MiMo's sent picture: a 64px square on a 12px corner that opens the preview. */
.sent-tile.picture {
  position: relative;
  width: 64px;
  height: 64px;
  padding: 0;
  border: none;
  border-radius: 12px;
  cursor: pointer;
}

/* The ring is drawn inside, so it does not grow the plate. */
.sent-tile.picture::after {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 0.5px var(--border-weak);
  pointer-events: none;
  content: "";
}

.sent-tile.picture img,
.sent-tile.picture video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sent-tile.file {
  flex-direction: row;
  gap: 8px;
  width: min(220px, 100%);
  height: 48px;
  padding: 0 10px;
}

.sent-tile.file svg {
  flex: none;
  color: var(--icon-weak);
}

.sent-name {
  overflow: hidden;
  min-width: 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * A filled bubble with no outline: the fill already separates it from the page,
 * and a border on top of it made what the user said look like a control rather
 * than a remark.
 */
.user-bubble {
  max-width: 100%;
  padding: 8px 12px;
  color: var(--text-strong);
  background: var(--surface-raised-hover);
  border-radius: 10px;
  /*
   * Prose is a point larger than the chrome around it. The app's own labels
   * run at thirteen; what a person wrote, and what the model wrote back, are
   * the thing being read and run at fourteen.
   */
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 21px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.msg.assistant {
  color: var(--text-strong);
}

/* subagents: the notices that opened a turn sit where its first step would, two above the head. */
.subagent-notices {
  margin-bottom: 2px;
}

.part + .part {
  margin-top: 24px;
}

/*
 * MiMo's steps sit in a column two apart, each row carrying its own 5px above
 * and below; a paragraph of the reply keeps a clearer break from them.
 */
.part + .part.step,
.part.step + .part {
  margin-top: 12px;
}

.part.step + .part.step {
  margin-top: 2px;
}

.err {
  padding: 8px 12px;
  /* These run to several sentences; the breaks between them are the structure. */
  white-space: pre-line;
  color: var(--error);
  background: color-mix(in srgb, var(--error) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--error) 32%, transparent);
  border-radius: var(--radius-sm);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.err.banner {
  margin-top: 8px;
}

.note {
  margin-top: 6px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
}

/*
 * Measured on the reference: 26x22 on an 8px radius, filled with the page's own
 * colour at 92% so the conversation shows faintly through it, and no border.
 * This was an 80x35 fully-round pill with a hard fill, a border and a large
 * shadow - a lozenge where the reference has a quiet square.
 */
/*
 * MiMo's: a 34px round button with a hairline and a soft shadow, 14px above the
 * foot of the conversation and centred on it. Centred by its margins rather
 * than by an offset - a sticky element's inset is a threshold, not a shift -
 * so it sits on the reading column even with the info card beside it.
 */
.jump {
  position: sticky;
  bottom: 14px;
  z-index: 10;
  margin-inline: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--text-weak);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
  /* MiMo tweens the lift over the pill and the colour; the sideways move with the info card stays a snap. */
  transition:
    bottom 0.18s cubic-bezier(0.2, 0.7, 0.2, 1),
    color 0.12s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.jump:hover {
  color: var(--text-strong);
}

/* Lifted clear of the "files changed" pill while it hangs over the composer. */
.main:has([data-live-edit-pill]) .jump {
  bottom: 48px;
}

/* And the transcript's end kept clear of it, as MiMo pads its scroller by 66. */
.main:has([data-live-edit-pill]) .inner {
  padding-bottom: 66px;
}

/*
 * 2.0: MiMo's reading column - 764 wide with 28 each side, so its text runs
 * 708 wide. The composer's 712 sits under it two pixels proud on either side.
 * Its thread is `mx-auto w-full min-w-0 max-w-[764px] px-[28px] pt-[12px]`.
 */
.inner {
  max-width: 764px;
  margin-inline: auto;
  padding: 12px 28px 16px;
}

/*
 * A wider reading column on a wide screen, at MiMo's one and only breakpoint.
 *
 * The thread carries `min-[2000px]:max-w-[996px]` - not Tailwind's 1536, and
 * not the round 1000 its home layout uses. Every companion is gated the same
 * way: the composer, its tray, the info card's content width and the
 * suggestion rule all query `min-width: 2000px`, so on a 1440p or 1600p
 * monitor the transcript is still 764 wide.
 */
@media (min-width: 2000px) {
  .inner {
    max-width: 996px;
  }
}

/* A gutter on both edges, as MiMo keeps: the column then centres on the same
   line as the composer under it instead of half a scrollbar to one side. */
.stream {
  scrollbar-gutter: stable both-edges;
}

/* MiMo's 正在加载对话…: centred, 13px and muted, 80 above and below. */
/* MiMo's thread placeholder, loading or empty: 80 above and below, 13px, muted, centred. */
.thread-loading {
  padding-block: 80px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

/* subagents: 初始任务 over a subagent's first message, 12px dim, on the bubble's side. */
.subagent-initial {
  margin-block-end: 4px;
  color: color-mix(in srgb, var(--text-strong) 40%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: end;
}

/* What the user wrote, as MiMo sets it: a filled bubble with a 16px corner,
   14/500 on a 20 line, and never wider than 78% of the column. */
.user-bubble {
  max-width: 78%;
  padding: 9px 13px;
  color: color-mix(in srgb, var(--text-strong) 95%, transparent);
  background: color-mix(in srgb, var(--text-strong) 9.5%, var(--surface-raised));
  border-radius: 16px;
  font-weight: 500;
  line-height: 20px;
}

.asked-text {
  display: block;
}

.asked-text.folded {
  position: relative;
  max-height: 264px;
  overflow: hidden;
}

/* The fade runs up from the bubble's own fill, so the cut reads as a fold. */
.asked-text.folded::after {
  content: "";
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 56px;
  background: linear-gradient(to top, color-mix(in srgb, var(--text-strong) 9.5%, var(--surface-raised)), transparent);
  pointer-events: none;
}

/* MiMo's: 12px in the muted colour, 2 by 4 of padding on a 6px corner. */
.asked-expand {
  display: inline-block;
  margin-top: 4px;
  padding: 2px 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-weak);
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: normal;
  cursor: pointer;
}

.asked-expand:hover {
  color: var(--text-strong);
}

/*
 * A question with code in it is laid out in blocks, so the bubble's own kept
 * whitespace would show between them; only the text runs keep theirs.
 */
.user-bubble[data-asked-parts] {
  white-space: normal;
}

.sent-tile.file.openable {
  cursor: pointer;
}

.sent-tile.file.openable:hover {
  opacity: 0.8;
}

/* The annotations a message carried, under it on its own side. */
.asked-annotations {
  justify-content: flex-end;
  max-width: 78%;
  padding-block: 6px 0;
}

/*
 * MiMo's 插话 waiting to be taken: under the running turn, at the end of the
 * line and at most 78% of it wide, in the question's own bubble, with a 12px
 * quiet note under it.
 */
.steer {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: 78%;
  margin-inline-start: auto;
  padding: 5px 0;
  margin-block: 4px;
}

.steer-bubble {
  max-width: 100%;
}

.steer-note {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.asked-part {
  white-space: pre-wrap;
}

/* MiMo's code in a question: regular weight, the reply's block, 8 above and below. */
.asked-code {
  min-width: 0;
  font-weight: 400;
}

.asked-code-body {
  font-weight: 400;
}

.asked-code-body.folded {
  position: relative;
  max-height: 264px;
  overflow: hidden;
  border-radius: 6px;
}

/* The fade runs up from the code's own fill. */
.asked-code-body.folded::after {
  content: "";
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 56px;
  background: linear-gradient(to top, var(--surface-raised), transparent);
  pointer-events: none;
}

/* Under the code rather than after text: MiMo's sits with 4 below and none above. */
.asked-expand.code-expand {
  margin-top: 0;
  margin-bottom: 4px;
}

/*
 * 2.0: MiMo's line above an answer - 14/500 in the base colour, the time a
 * size down and fainter beside it, and twelve clear of the first line so the
 * two sit thirty apart as they do there.
 */
.run {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--text-base);
}

.run-label {
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 18px;
}

.run-time {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 16px;
}

.run-time {
  font-variant-numeric: tabular-nums;
}

/* The finished head that folds: the whole line is the button. */
.run.foldable {
  width: fit-content;
  padding: 2px 0;
  font: inherit;
  text-align: start;
  background: transparent;
  border: 0;
  cursor: pointer;
}

/* Along the line while the steps are away, and down once they are opened. */
.run-chev {
  flex-shrink: 0;
  opacity: 0.5;
  transform: rotate(0deg);
  transition: transform 0.15s;
}

.run-chev.open {
  transform: rotate(90deg);
}

/* Right to left, the closed chevron points the way the line reads. */
.run-chev:not(.open):dir(rtl) {
  transform: scaleX(-1);
}
/*
 * A failed, stopped or empty turn, as MiMo draws one. The failure is a card on a
 * 16px corner - the reason clamped to about six lines, a framed retry pill at
 * its end. A stopped or empty turn keeps its short line with a 26px retry
 * button under it.
 */
/* With a detail line the card wraps to two rows, so the icon sits with the sentence rather than centred over both. */
.err-card.detailed {
  flex-wrap: wrap;
  align-items: flex-start;
}

.err-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-top: 12px;
  padding: 12px 14px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

/* Nothing above it in the turn: it sits flush, as MiMo's flushTop does. */
.msg.assistant > .err-card:first-child {
  margin-top: 0;
}

/* MiMo's 20px alert in the card's own text colour, not red. */
.err-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
}

.err-text {
  flex: 1;
  min-width: 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

/* The raw text under the sentence: quieter and smaller, as MiMo's detail line is. */
.err-detail {
  flex-basis: 100%;
  min-width: 0;
  margin-top: 6px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.err-text.clamped {
  max-height: 143px;
  overflow: hidden;
}

/* MiMo's framed retry: 8px corners, 6 between the arrow and the word. */
.retry-pill {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 5px 13px;
  color: var(--text-base);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 1.7;
}

.retry-pill:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.note.finished {
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.note.finished.empty {
  color: var(--error);
}

.retry-row {
  display: flex;
  gap: 2px;
  margin-top: 2px;
}

.retry-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
}

.retry-icon:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* A search result arrived at: a soft tint over the message that fades over MiMo's 1.6s. */
/* MiMo's find-flash: radius 8, from 30% accent to clear over 1.2s, with no hold. */
.revealed {
  border-radius: 8px;
  animation: reveal-flash 1.2s ease-out both;
}

@keyframes reveal-flash {
  0% {
    background-color: color-mix(in srgb, var(--text-interactive) 30%, transparent);
  }

  100% {
    background-color: transparent;
  }
}
</style>
