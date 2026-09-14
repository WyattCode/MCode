<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, onBeforeUnmount } from "vue"
import { useApp } from "../stores/app"
import TextPart from "./parts/TextPart.vue"
import ReasoningPart from "./parts/ReasoningPart.vue"
import ToolPart from "./parts/ToolPart.vue"
import ToolGroup from "./parts/ToolGroup.vue"
import TextShimmer from "./parts/TextShimmer.vue"
import type { Annotation, Attachment, AssistantMessage, AssistantPart } from "@shared/protocol"
import { preview } from "../lib/attach"
import { openImagePreview } from "../lib/image-preview"
import { language, t } from "../lib/i18n"
import { questionParts } from "../lib/question-parts"
import { renderMarkdown } from "../lib/markdown"
import { highlightWithin } from "../lib/highlight"
import { notify, notifyFailure } from "../lib/toast"
import EditedFilesCard from "./EditedFilesCard.vue"
import AnnotationChips from "./AnnotationChips.vue"
import { openDocument } from "../lib/office-open"
import { occurrences, registerFoldedCounter } from "../lib/find-folded"

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
const props = defineProps<{ side?: boolean }>()
const shownMessages = computed(() => (props.side ? app.sideMessages : app.visible))
const shownBusy = computed(() => (props.side ? app.sideBusy : app.busy))
const shownCompacting = computed(() => (props.side ? false : app.compacting))
const shownSession = computed(() => (props.side ? app.side : app.current))
const shownID = computed(() => (props.side ? app.sideID : app.currentID))
/* The project the shown conversation works in; a side conversation shares the main one's. */
const shownDirectory = computed(() => app.current?.directory)
const shownStreaming = computed(() => (props.side ? app.sideStreaming : app.streaming))
const shownError = computed(() => (props.side ? app.sideError : app.error))
const scroller = ref<HTMLElement>()

/** A message sent into a turn while it was running - MiMo's 插话 - and where among the turn's parts it landed. */
interface Steer {
  id: string
  text?: string
  attachments?: Attachment[]
  created: number
  /** How many of the turn's parts came before it. */
  at: number
}

type Row =
  | { kind: "part"; id: string; part: AssistantPart }
  | { kind: "steer"; id: string; steer: Steer }
  /** A run of lookups plus whatever the model said between them. */
  | { kind: "tools"; id: string; parts: AssistantPart[] }

/**
 * Collapses runs of finished tool calls into one row.
 *
 * Rendered one card each, a dozen ordinary lookups bury the two sentences that
 * actually answer the question. Anything still running or failed stays on its
 * own, because that is exactly what the reader needs to see.
 */
/**
 * Calls that only look at things.
 *
 * Several of these in a row are one act of looking around, and collapse into a
 * single line. Anything that acts - a command, an edit - keeps its own row:
 * what the model did is worth a line each, what it read is not.
 */
const CONTEXT_TOOLS = new Set(["read", "glob", "grep", "list", "webfetch"])

function rows(parts: AssistantPart[]): Row[] {
  const out: Row[] = []
  /** The current run, in order, including the notes written between calls. */
  let run: AssistantPart[] = []
  let tools = 0
  /** Trailing reasoning: part of the run only if another lookup follows. */
  let pending: AssistantPart[] = []

  const flush = () => {
    // Even one call collapses. Rendering the first as a card and folding it away
    // once a second arrived made every step flash a box on and off.
    if (tools >= 1) out.push({ kind: "tools", id: `g:${run[0].id}`, parts: run })
    else for (const part of run) out.push({ kind: "part", id: part.id, part })
    for (const part of pending) out.push({ kind: "part", id: part.id, part })
    run = []
    pending = []
    tools = 0
  }

  for (const part of parts) {
    // A reasoning part with nothing in it renders nothing, but an empty row
    // still wraps it - a blank gap that appears and goes on every tool call.
    if (part.type === "reasoning" && !part.text.trim()) continue

    // Running calls belong in the group too: the count ticks up live, which is
    // the progress report - a card that appears and then folds away reads as a
    // glitch rather than as work happening.
    // Pending counts too: a call waiting to start would otherwise appear as a
    // card for an instant before the group swallowed it.
    if (part.type === "tool" && part.status !== "error" && CONTEXT_TOOLS.has(part.name)) {
      // Reasoning between two lookups does not end the run: the model narrates
      // before every call, so treating that as a break meant nothing grouped.
      // It is carried into the group rather than dropped - silently losing what
      // the model said is worse than the wall of cards this replaced.
      run.push(...pending, part)
      pending = []
      tools += 1
      continue
    }
    if (part.type === "reasoning" && tools) {
      pending.push(part)
      continue
    }
    flush()
    out.push({ kind: "part", id: part.id, part })
  }
  flush()
  return out
}

interface Turn {
  id: string
  text?: string
  attachments?: Attachment[]
  /** The places the message pointed at, shown under it as MiMo does. */
  annotations?: Annotation[]
  /** When the user sent it, for the footer under their own message. */
  asked?: number
  parts: AssistantPart[]
  steers: Steer[]
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

  /*
   * The conversation as it now stands, which is not always the whole of what
   * is held. A conversation rolled back to a message keeps everything after
   * that message on disk so it can be put back, and the reader is told those
   * turns are no longer part of the conversation - so this is where they stop
   * being drawn.
   */
  for (const message of shownMessages.value) {
    if (message.role === "user") {
      /*
       * A message sent into a running turn stays inside that turn, where the
       * model took it in, as MiMo shows it. The backend marks such a message
       * when it joins the turn; guessing from the step before it would also
       * swallow the next question after a turn the app was closed during.
       */
      if (current && message.steered) {
        current.steers.push({
          id: message.id,
          text: message.text,
          attachments: message.attachments,
          created: message.time.created,
          at: current.parts.length,
        })
        continue
      }
      current = {
        id: message.id,
        text: message.text,
        attachments: message.attachments,
        annotations: message.annotations,
        asked: message.time.created,
        parts: [],
        steers: [],
        messageIDs: [],
      }
      out.push(current)
      continue
    }
    if (!current) {
      current = { id: message.id, parts: [], steers: [], messageIDs: [] }
      out.push(current)
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

/**
 * Whether the model's context begins after this turn.
 *
 * The transcript keeps everything; the line just says where the summary took
 * over, so a reply that seems not to remember something earlier has a visible
 * reason.
 */
function compactedAfter(turn: Turn): boolean {
  const mark = shownSession.value?.compacted?.messageID
  if (!mark) return false
  return turn.last?.id === mark || turn.id === mark
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

async function copyAsked(turn: Turn) {
  if (!turn.text) return
  await navigator.clipboard.writeText(turn.text)
  notify(t("stream.replyCopied"))
}

/** The reply itself, without the tool traffic that produced it. */
function replyText(turn: Turn): string {
  return turn.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n\n")
    .trim()
}

async function copyReply(turn: Turn) {
  const text = replyText(turn)
  if (!text) return
  await navigator.clipboard.writeText(text)
  notify(t("stream.replyCopied"))
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
      if (part.type !== "tool") continue
      if (document.querySelector(`[data-tool-part="${CSS.escape(part.id)}"]`)) continue
      total += occurrences(part.title ?? "", needle)
    }
  }
  return total
}

let releaseFoldedCounter: (() => void) | undefined
onMounted(() => {
  if (!props.side) releaseFoldedCounter = registerFoldedCounter(foldedMatchCount)
})
onBeforeUnmount(() => releaseFoldedCounter?.())

/** Whether this turn did any work worth folding. */
function hasTools(turn: Turn): boolean {
  return turn.parts.some((part) => part.type === "tool")
}

/** What the answer shows: its own words always, its steps once opened. */
function shown(turn: Turn): Row[] {
  const all: Row[] = []
  let from = 0
  for (const steer of turn.steers) {
    all.push(...rows(turn.parts.slice(from, steer.at)), { kind: "steer", id: steer.id, steer })
    from = steer.at
  }
  all.push(...rows(turn.parts.slice(from)))
  return opened.value.has(turn.id) ? all : all.filter((row) => row.kind !== "tools")
}

/*
 * MiMo's 已插话 · 会尽快处理 under a message sent into the running turn, until
 * the model has taken it in - which is when a step begins after it.
 */
function steerWaiting(turn: Turn, at: number, steer: Steer): boolean {
  if (at !== turns.value.length - 1 || !shownBusy.value) return false
  return !shownMessages.value.some((message) => message.role === "assistant" && message.time.created > steer.created)
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

function elapsed(turn: Turn): string | undefined {
  if (!turn.started || !turn.completed) return undefined
  const seconds = Math.max(1, Math.round((turn.completed - turn.started) / 1000))
  if (seconds < 60) return t("stream.seconds", { n: seconds })
  return t("stream.minutes", { m: Math.floor(seconds / 60), s: seconds % 60 })
}
/** Auto-follow is on until the user scrolls up, and resumes when they return. */
const following = ref(true)

function onScroll() {
  const element = scroller.value
  if (!element) return
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight
  /*
   * Ten, which is the reference's own `bottomThreshold` - it defaults to 10 in
   * `createAutoScroll` and nothing ever passes another value. Sixty meant the
   * view resumed following from six times further away than it should, so
   * scrolling back to nearly-the-end silently re-armed the jump and took the
   * reader the rest of the way on the next message.
   */
  following.value = distance < 10
}

function toBottom(smooth = false) {
  const element = scroller.value
  if (!element) return
  element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" })
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
    if (!following.value) return
    await nextTick()
    toBottom()
  },
)

// Streaming grows the last message in place, which does not change the array
// length - so follow the text itself.
watch(
  () => shownStreaming.value?.parts.map((part) => ("text" in part ? part.text.length : part.status)).join(),
  async () => {
    if (!following.value) return
    await nextTick()
    toBottom()
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
  if (await app.forkFrom(turn.last.id)) notify(t("stream.branchedFromHere"))
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

/** True while a rollback is in flight, so a second press cannot race the first. */
const reverting = ref(false)

/*
 * MiMo's in-place edit of the last question. Only the last one offers it; the
 * bubble becomes a box holding the question, and sending takes the
 * conversation back to just before it - files too, as a rollback does - and
 * sends the new words. While a turn is running it says so rather than sending.
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
  if (!sessionID || shownBusy.value || reverting.value || message?.role !== "user") {
    notifyFailure(t("stream.editBusy"))
    return
  }
  reverting.value = true
  try {
    await app.revert(sessionID, turn.id)
    editingAsked.value = undefined
    await app.send(text, message.attachments ?? [], undefined, message.annotations ?? [])
  } catch (failure) {
    /*
     * The server refuses rather than moving the transcript on its own when the
     * files cannot be made to follow; the sentence it refuses with is the only
     * explanation there is, so it is shown.
     */
    notifyFailure(t("common.requestFailed"), failure instanceof Error ? failure.message : String(failure))
  } finally {
    reverting.value = false
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

/* MiMo's sent pictures open in its image preview; the message's other pictures are its neighbours. */
function previewSent(item: Attachment, all: Attachment[] | undefined) {
  const url = preview(item)
  if (!url) return
  const group = (all ?? []).map((entry) => preview(entry)).filter((entry): entry is string => Boolean(entry))
  openImagePreview(url, { name: item.path.split(/[\\/]/).pop(), group })
}

/** Whether the turn said or did anything a reader would call an answer. */
function answered(turn: Turn): boolean {
  return turn.parts.some((part) => (part.type === "text" && part.text.trim()) || part.type === "tool")
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
  if (!turn.finish || turn.error || turn.finish === "aborted") return false
  return !answered(turn) && !thinkOnly(turn)
}

/*
 * MiMo's retry on a turn that failed, was stopped or came back empty: the
 * question that started it goes out again, as it was, in place of the turn.
 * The conversation is taken back to just before that question - the same
 * rollback editing it uses - and the question is sent once more. While a turn
 * is still running, or when there is no question to send, it says so instead.
 */
async function retry(turn: Turn) {
  const sessionID = props.side ? app.sideID : app.currentID
  const message = shownMessages.value.find((entry) => entry.id === turn.id)
  if (!sessionID || shownBusy.value || reverting.value || message?.role !== "user") {
    notifyFailure(t("stream.retryUnavailable"))
    return
  }
  reverting.value = true
  try {
    await app.revert(sessionID, turn.id)
    await app.send(message.text ?? "", message.attachments ?? [], props.side ? sessionID : undefined, message.annotations ?? [])
  } catch (failure) {
    notifyFailure(t("common.requestFailed"), failure instanceof Error ? failure.message : String(failure))
  } finally {
    reverting.value = false
  }
}

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
  <div ref="scroller" class="stream" @scroll="onScroll">
    <div ref="inner" class="inner">
      <!--
        MiMo's marker at the top of a branched conversation: a hairline either
        side of a link back to the conversation it came from.
      -->
      <div v-if="!side && shownSession?.forkOf" class="fork-row" data-fork-row>
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
      <div v-for="(turn, at) in turns" :key="turn.id" class="turn" :data-turn="turn.id">
        <div
          v-if="turn.text !== undefined || turn.attachments?.length"
          class="msg user"
          :class="{ editing: editingAsked === turn.id }"
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
                @click="previewSent(item, turn.attachments)"
              >
                <img :src="preview(item)" :alt="item.path" />
              </button>
              <span
                v-else
                class="sent-tile file"
                :class="{ openable: Boolean(item.path) }"
                :title="item.path"
                data-sent-file
                @click="item.path && openSentFile(item.path)"
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
                <span class="sent-name">{{ item.path }}</span>
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
                :disabled="shownBusy || reverting || !editDraft.trim()"
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
                :disabled="reverting"
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

        <div v-if="turn.parts.length || turn.error || turn.finish" class="msg assistant">
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
            v-if="turn.started && hasTools(turn) && !liveTurn(at)"
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
          <div v-else-if="turn.started" class="run" data-turn-head :data-live="liveTurn(at) ? 'true' : undefined">
            <span class="run-label"><TextShimmer :text="t('turn.processed')" :active="liveTurn(at)" /></span>
            <span v-if="headTime(turn, at)" class="run-time" data-turn-time>{{ headTime(turn, at) }}</span>
          </div>

          <div v-for="row in shown(turn)" :key="row.id" class="part">
            <div
              v-if="row.kind === 'steer'"
              class="steer"
              :data-user-steer="row.id"
              :data-steer-state="steerWaiting(turn, at, row.steer) ? 'waiting' : 'landed'"
            >
              <div v-if="row.steer.attachments?.length" class="sent">
                <template v-for="(item, index) in row.steer.attachments" :key="index">
                  <button
                    v-if="preview(item)"
                    type="button"
                    class="sent-tile picture"
                    :aria-label="t('stream.previewTip')"
                    v-tip="{ label: t('stream.previewTip'), placement: 'top' }"
                    :data-preview-src="preview(item)"
                    @click="previewSent(item, row.steer.attachments)"
                  >
                    <img :src="preview(item)" :alt="item.path" />
                  </button>
                  <span v-else class="sent-tile file" :title="item.path">
                    <span class="sent-name">{{ item.path }}</span>
                  </span>
                </template>
              </div>
              <div v-if="row.steer.text" class="user-bubble steer-bubble">{{ row.steer.text }}</div>
              <span v-if="steerWaiting(turn, at, row.steer)" class="steer-note">{{ t("stream.steerWaiting") }}</span>
            </div>
            <ToolGroup v-else-if="row.kind === 'tools'" :parts="row.parts" />
            <ReasoningPart v-else-if="row.part.type === 'reasoning'" :part="row.part" />
            <ToolPart v-else-if="row.part.type === 'tool'" :part="row.part" />
            <TextPart v-else :part="row.part" />
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

          <!--
            MiMo's action row under a reply: copy and branch, always there, 26px
            each; then the time it finished, which shows under the pointer only.
          -->
          <div v-if="turn.finish && !turn.error && turn.last" class="msg-actions" data-msg-actions>
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
              :aria-label="t('stream.replyBranch')"
              v-tip="{ label: t('stream.replyBranch'), placement: 'top' }"
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

          <!--
            A failure as MiMo shows one: a card with the reason and a retry at its
            end. A stopped or empty turn gets its line and a quiet retry under it.
          -->
          <div v-if="turn.error || thinkOnly(turn)" class="err-card" data-turn-error>
            <svg class="err-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2" />
              <path d="M8 4.8v3.8M8 11v.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
            <span class="err-text">{{
              !turn.error ? t("stream.thinkOnlyNoAnswer") : turn.errorCode ? t(turn.errorCode, turn.errorParams) : turn.error
            }}</span>
            <button class="retry-pill" data-retry @click="retry(turn)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.9h-2.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              {{ t("stream.retry") }}
            </button>
          </div>
          <template v-else-if="turn.finish === 'aborted' || emptyReply(turn)">
            <div class="note finished" :class="{ empty: emptyReply(turn) }" data-turn-finished>
              {{
                emptyReply(turn)
                  ? t("stream.noContent")
                  : elapsed(turn)
                    ? t("stream.stoppedAfter", { dur: elapsed(turn) ?? "" })
                    : t("stream.stopped")
              }}
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
          <div v-else-if="turn.finish === 'max_tokens'" class="note">{{ t("stream.maxTokens") }}</div>
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

        <div v-if="compactedAfter(turn)" class="compacted">
          <span class="compacted-line" />
          <span class="compacted-text">{{ t("stream.compacted") }}</span>
          <span class="compacted-line" />
        </div>
      </div>

      <div v-if="shownError" class="err banner">{{ shownError }}</div>
    </div>

    <!--
      Icon only, with the words left to the label. The reference's button is
      26x22 around a 13px arrow and says nothing out loud; this said "jump to
      latest" in full, which is four times the width for a control that appears
      over the conversation it is covering.
    -->
    <button
      v-if="!following"
      class="jump"
      data-jump-to-bottom
      :aria-label="t('stream.jumpToBottom')"
      :title="t('stream.jumpToBottom')"
      @click="toBottom(true)"
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
.msg-actions:is(.file-card + .msg-actions, [data-fc-reverted] + .msg-actions, .fc-confirm + .msg-actions) {
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

.compacted {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  /* Its own breathing room rather than a margin, so two of them in a row do
     not collapse into one gap. */
  padding: 10px 0;
}

.compacted-line {
  flex: auto;
  height: 1px;
  background: var(--border-weak);
}

.compacted-text {
  flex: none;
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
  text-align: center;
}

.stream {
  position: relative;
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.inner {
  /* The reference caps the reading column here, and the composer below
     shares it - so a turn and the box you answer it in line up. */
  max-width: 800px;
  margin: 0 auto;
  /*
   * Twenty each side, not twenty-four: opencode's turn is 800 wide with its
   * content at 760, and four pixels of difference is four pixels every line
   * of every answer wraps at.
   *
   * Extra room at the true end of the transcript, past the standing gap the
   * composer holds open below.
   */
  padding: 20px 20px 16px;
}

/*
 * A wider reading column on a wide screen.
 *
 * The reference carries `2xl:max-w-[1000px]` alongside its `md:max-w-200` on
 * both the turn and the composer (main-Db9FY8Yb.js), so past 1536px the pair
 * grows together and the transcript stops leaving two thirds of a large
 * monitor empty. Without it the column stayed at 800 at every size.
 */
@media (min-width: 1536px) {
  .inner {
    max-width: 1000px;
  }
}

/*
 * The reference's timeline is a flat list of rows with `gap: 24px` between
 * them - the question, each part of the answer, the lot - and it drops a
 * 24px-tall spacer row (`data-timeline-row=TurnGap`, `class=h-6`) between one
 * turn and the next, so consecutive turns stand 72px apart while the rows
 * inside a turn stand 24 apart. This was a flat 18 for both, which made a
 * conversation read as one long column rather than as a series of exchanges.
 */
.msg {
  margin-bottom: 24px;
}

/*
 * The spacer itself rather than a margin, because a margin does not stack: the
 * previous turn's 24 and a 48 here collapsed to 48, which is the larger of the
 * two and not their sum. A box with height carries its own space, the way the
 * reference's own spacer row does.
 */
.turn + .turn::before {
  content: "";
  display: block;
  height: 24px;
  margin-bottom: 24px;
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

.sent-tile.picture img {
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

.part + .part {
  margin-top: 24px;
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
  transition: color 0.12s;
}

.jump:hover {
  color: var(--text-strong);
}

/* Lifted clear of the "files changed" pill while it hangs over the composer. */
:global(.main:has([data-live-edit-pill])) .jump {
  bottom: 48px;
}

/*
 * 2.0: MiMo's reading column - 764 wide with 28 each side, so its text runs
 * 708 wide, and it keeps that width on a large screen rather than growing.
 * The composer's 712 sits under it two pixels proud on either side.
 */
.inner {
  max-width: 764px;
  padding: 12px 28px 16px;
}

/* A gutter on both edges, as MiMo keeps: the column then centres on the same
   line as the composer under it instead of half a scrollbar to one side. */
.stream {
  scrollbar-gutter: stable both-edges;
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
 * MiMo's 插话: the message sits where it landed among the turn's steps, at the
 * end of the line and at most 78% of it wide, in the question's own bubble,
 * with a 12px quiet note under it until the model has taken it in.
 */
.steer {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: 78%;
  margin-inline-start: auto;
  padding: 5px 0;
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

@media (min-width: 1536px) {
  .inner {
    max-width: 764px;
  }
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
/*
 * A failed, stopped or empty turn, as MiMo draws one. The failure is a card on a
 * 16px corner - the reason clamped to about six lines, a framed retry pill at
 * its end. A stopped or empty turn keeps its short line with a 26px retry
 * button under it.
 */
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

.err-icon {
  flex-shrink: 0;
  color: var(--error);
}

.err-text {
  flex: 1;
  min-width: 0;
  max-height: 143px;
  overflow: hidden;
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.retry-pill {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 5px 13px;
  color: var(--text-base);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
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
</style>
