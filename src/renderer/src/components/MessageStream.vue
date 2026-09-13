<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, onBeforeUnmount } from "vue"
import { useApp } from "../stores/app"
import TextPart from "./parts/TextPart.vue"
import ReasoningPart from "./parts/ReasoningPart.vue"
import ToolPart from "./parts/ToolPart.vue"
import ToolGroup from "./parts/ToolGroup.vue"
import TextShimmer from "./parts/TextShimmer.vue"
import type { Attachment, AssistantMessage, AssistantPart } from "@shared/protocol"
import { preview } from "../lib/attach"
import { useRestoreDraft } from "../lib/draft"
import { withoutLatest } from "../lib/model"
import { language, t } from "../lib/i18n"
import { questionParts } from "../lib/question-parts"
import { renderMarkdown } from "../lib/markdown"
import { notifyFailure } from "../lib/toast"

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
const shownStreaming = computed(() => (props.side ? app.sideStreaming : app.streaming))
const shownError = computed(() => (props.side ? app.sideError : app.error))
const scroller = ref<HTMLElement>()
/** Handed down by App.vue, which is the only thing that can see the composer. */
const restoreDraft = useRestoreDraft()

type Row =
  | { kind: "part"; id: string; part: AssistantPart }
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
  /** When the user sent it, for the footer under their own message. */
  asked?: number
  parts: AssistantPart[]
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
      current = {
        id: message.id,
        text: message.text,
        attachments: message.attachments,
        asked: message.time.created,
        parts: [],
      }
      out.push(current)
      continue
    }
    if (!current) {
      current = { id: message.id, parts: [] }
      out.push(current)
    }
    current.parts.push(...message.parts)
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
 * Whether to say the model is working before it has said anything.
 *
 * A turn that has been sent but has produced no renderable part yet used to
 * draw nothing at all - the transcript simply sat there, and the only sign the
 * message had gone anywhere was the composer's stop button. The reference puts
 * a shimmering "Thinking" at the end of the live turn instead, and drops it the
 * moment the first part arrives.
 *
 * `rows()` rather than `parts.length` because a part can be present and render
 * nothing - an empty reasoning part is the usual case, and counting it would
 * clear this row while the screen was still blank.
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
  return shownBusy.value && !turn.error && rows(turn.parts).length === 0
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

/** The picker shows display names, so the footer has to agree with it. */
/**
 * The step a turn ran at, or nothing.
 *
 * Nothing only for turns recorded before this was stored - every turn run since
 * carries a concrete step, because an unset session resolves to the app default
 * before the request goes out.
 */
function effortName(message: AssistantMessage): string {
  /*
   * The raw id, capitalised by the stylesheet rather than by hand. The
   * reference never translates a step and never spells one out either: it
   * labels the option `x` and puts `capitalize` on the control
   * (main-8t-QUXax.js @4574058), so its own reading is "Xhigh". The hand-built
   * "XHigh" this replaces was the one word in the pair that was invented here.
   */
  return message.effort ?? ""
}

function modelName(message: AssistantMessage): string {
  const provider = app.providers.find((entry) => entry.id === message.model.provider)
  const found = provider?.models.find((entry) => entry.id === message.model.model)
  // Stripped for the same reason the picker strips it: "(latest)" is a tag in
  // the reference, and its model store hands out the name without the word.
  return found ? withoutLatest(found.name) : message.model.model
}

/** Which copy button is showing its tick, keyed by turn and by which one. */
const copied = ref<string>()

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
 * footer reads in the same language as the words beside it.
 */
function stamp(at: number): string {
  return new Intl.DateTimeFormat(language.value, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at)
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
  copied.value = `${turn.id}:asked`
  setTimeout(() => {
    if (copied.value === `${turn.id}:asked`) copied.value = undefined
  }, 1600)
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
  copied.value = turn.id
  setTimeout(() => {
    if (copied.value === turn.id) copied.value = undefined
  }, 1600)
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

/** Whether this turn did any work worth folding. */
function hasTools(turn: Turn): boolean {
  return turn.parts.some((part) => part.type === "tool")
}

/** What the answer shows: its own words always, its steps once opened. */
function shown(turn: Turn): Row[] {
  const all = rows(turn.parts)
  return opened.value.has(turn.id) ? all : all.filter((row) => row.kind !== "tools")
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
  await app.forkFrom(turn.last.id)
}

/** True while a rollback is in flight, so a second press cannot race the first. */
const reverting = ref(false)

/**
 * Takes the conversation back to just before this message was sent.
 *
 * This message and everything after it leaves the transcript, and the project's
 * files go back to how that moment found them. Nothing is destroyed: what goes
 * out is listed in the dock above the composer until either it is put back or
 * something new is sent, which is the point at which the branch is abandoned
 * for good.
 *
 * And the sentence itself goes back in the box. That is the whole point of the
 * feature in the reference - its revert mutation is `roll(...)` immediately
 * followed by `prompt.set(draft(messageID))` (main-8t-QUXax.js @5578333) -
 * without which reverting reads as "delete what I said" rather than "let me
 * rephrase it", and the dock would be claiming the words are recoverable while
 * the one place they are useful stayed empty.
 *
 * Set after the request rather than optimistically before it: the reference
 * sets it early and puts the old prompt back in `runPromptRollbackMutation`'s
 * catch, and this app has already awaited the server by here, so both reach the
 * same end state in both outcomes. The difference is only visible to something
 * watching the box during a request that is going to fail.
 */
async function revert(turn: Turn) {
  const sessionID = app.currentID
  if (!sessionID || reverting.value) return
  reverting.value = true
  try {
    await app.revert(sessionID, turn.id)
    const message = app.messages.find((entry) => entry.id === turn.id)
    if (message?.role === "user") restoreDraft(message)
  } catch (failure) {
    /*
     * The server refuses rather than moving the transcript on its own when the
     * files cannot be made to follow - a turn still running, a snapshot that
     * was never taken, a message older than the history reaches. The sentence
     * it refuses with is the only explanation there is, so it is shown.
     */
    notifyFailure(t("common.requestFailed"), failure instanceof Error ? failure.message : String(failure))
  } finally {
    reverting.value = false
  }
}

/** A turn that finished without saying or doing anything. */
function emptyReply(turn: Turn): boolean {
  if (!turn.finish || turn.error || turn.finish === "aborted") return false
  return !turn.parts.some((part) => (part.type === "text" && part.text.trim()) || part.type === "tool")
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
    await app.send(message.text ?? "", message.attachments ?? [], props.side ? sessionID : undefined)
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
      <div v-for="(turn, at) in turns" :key="turn.id" class="turn" :data-turn="turn.id">
        <div v-if="turn.text !== undefined || turn.attachments?.length" class="msg user">
          <div v-if="turn.attachments?.length" class="sent">
            <template v-for="(item, at) in turn.attachments" :key="at">
              <span v-if="preview(item)" class="sent-tile picture">
                <img :src="preview(item)" :alt="item.path" />
              </span>
              <span v-else class="sent-tile file" :title="item.path">
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
          <div v-if="turn.text && hasCode(turn.text)" class="user-bubble" data-asked-parts>
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
          <div v-else-if="turn.text && foldable(turn.text)" class="user-bubble" data-asked-fold :data-folded="openAsked.has(turn.id) ? undefined : ''">
            <span class="asked-text" :class="{ folded: !openAsked.has(turn.id) }">{{ turn.text }}</span><button class="asked-expand" data-asked-expand @click="toggleAsked(turn.id)" @dblclick.stop>{{ openAsked.has(turn.id) ? t("stream.collapseAsked") : t("stream.expandAsked", { count: askedLines(turn.text) }) }}</button>
          </div>
          <div v-else-if="turn.text" class="user-bubble">{{ turn.text }}</div>

          <!--
            The same footer the reply gets. What was asked is worth being able
            to copy back out, and which model picked it up belongs with the
            question as much as with the answer.
          -->
          <!--
            MiMo's question footer: when it was asked, then copy, then edit.
            Branching lives under the answer, and the agent and model are the
            answer's to state. Edit takes the conversation back to before this
            question and puts it into the box to be changed and sent again.
          -->
          <div class="footer user-footer">
            <span class="when">{{ askedAt(turn) }}</span>
            <button
              class="copy"
              :aria-label="t('stream.copyAsked')"
              v-tip="{ label: t('stream.copyAsked'), placement: 'top' }"
              @click="copyAsked(turn)"
            >
              <svg v-if="copied === `${turn.id}:asked`" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" stroke="currentColor" stroke-width="1" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4.14908 11.0081H1.76282V1.51758H9.1038V2.55588M14.2225 4.99681H6.75397V14.4873H14.2225V4.99681Z"
                  stroke="currentColor"
                  stroke-width="1"
                />
              </svg>
            </button>
            <button
              v-if="!side"
              class="copy edit"
              :disabled="reverting"
              :aria-label="t('stream.edit')"
              v-tip="{ label: t('stream.edit'), placement: 'top' }"
              @click="revert(turn)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M10.6 2.6l2.8 2.8L6 12.8H3.2V10zM9 4.2l2.8 2.8"
                  stroke="currentColor"
                  stroke-width="1.1"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
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
          <div v-if="turn.started" class="run">
            <span class="run-label">{{ turn.completed ? t("turn.processed") : t("turn.processing") }}</span>
            <span v-if="elapsed(turn)" class="run-time">{{ elapsed(turn) }}</span>
            <button
              v-if="hasTools(turn)"
              class="run-fold"
              :aria-expanded="opened.has(turn.id)"
              :aria-label="t('turn.steps')"
              @click="foldRun(turn.id)"
            >
              <svg
                class="run-chev"
                :class="{ open: opened.has(turn.id) }"
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>

          <div v-for="row in shown(turn)" :key="row.id" class="part">
            <ToolGroup v-if="row.kind === 'tools'" :parts="row.parts" />
            <ReasoningPart v-else-if="row.part.type === 'reasoning'" :part="row.part" />
            <ToolPart v-else-if="row.part.type === 'tool'" :part="row.part" />
            <TextPart v-else :part="row.part" />
          </div>

          <!--
            Held back until the reply is under the pointer. Who answered and how
            long it took is worth having, but not worth a permanent grey line
            under every message - and the copy button belongs with it.
          -->
          <div v-if="turn.finish && !turn.error && turn.last" class="footer">
            <button v-if="!side" class="copy branch" v-tip="{ label: t('stream.fork'), placement: 'top' }" @click="branchReply(turn)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1" />
                <circle cx="4.5" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1" />
                <circle cx="11.5" cy="5.5" r="1.6" stroke="currentColor" stroke-width="1" />
                <path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.2 3.4-5.4 3.9" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
              </svg>
            </button>
            <button class="copy" v-tip="{ label: t('stream.copy'), placement: 'top' }" @click="copyReply(turn)">
              <svg v-if="copied === turn.id" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" stroke="currentColor" stroke-width="1" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4.14908 11.0081H1.76282V1.51758H9.1038V2.55588M14.2225 4.99681H6.75397V14.4873H14.2225V4.99681Z"
                  stroke="currentColor"
                  stroke-width="1"
                />
              </svg>
            </button>
            <span>{{ t(`agent.${turn.last.agent}`) }}</span>
            <span class="dot">·</span>
            <span>{{ modelName(turn.last) }}</span>
            <template v-if="effortName(turn.last)">
              <span class="dot">·</span>
              <span class="level">{{ effortName(turn.last) }}</span>
            </template>
            <template v-if="elapsed(turn)">
              <span class="dot">·</span>
              <span>{{ elapsed(turn) }}</span>
            </template>
            <template v-if="completedAt(turn)">
              <span class="dot">·</span>
              <span class="when">{{ completedAt(turn) }}</span>
            </template>
          </div>

          <!--
            A failure as MiMo shows one: a card with the reason and a retry at its
            end. A stopped or empty turn gets its line and a quiet retry under it.
          -->
          <div v-if="turn.error" class="err-card" data-turn-error>
            <svg class="err-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2" />
              <path d="M8 4.8v3.8M8 11v.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
            <span class="err-text">{{ turn.errorCode ? t(turn.errorCode, turn.errorParams) : turn.error }}</span>
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

        <div v-if="thinking(turn, at)" class="thinking">
          <TextShimmer :text="t('stream.thinking')" :active="true" />
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
    <button v-if="!following" class="jump" :aria-label="t('stream.jump')" @click="toBottom(true)">
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M15.2083 11.6667L10 16.875L4.79167 11.6667M10 16.25V3.125"
          stroke="currentColor"
          stroke-width="1.25"
          stroke-linecap="square"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 2px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  opacity: 0;
  transition: opacity 0.12s;
}

/* focus-within so the copy button is reachable by keyboard, not just by mouse. */
.msg.user:hover .footer,
.msg.user:focus-within .footer,
.msg.assistant:hover .footer,
.msg.assistant:focus-within .footer {
  opacity: 1;
}

/*
 * 24 on a 6px radius in --text-weak, which is what the reference's own message
 * actions measure - its undo, copy-message and copy-reply are all 24x24 around
 * a 14px icon in rgb(128,128,128). These were 20x20 on a 4px radius in
 * --avatar-gray, a size and two steps of colour below.
 */
.copy {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-inline-end: 2px;
  color: var(--text-weak);
  border-radius: 6px;
}

.copy:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.footer .dot {
  opacity: 0.6;
}

/* The step a turn ran at, drawn from its own id. See effortName: the reference
   capitalises the raw word in CSS rather than naming the steps anywhere. */
.footer .level {
  text-transform: capitalize;
}

/* Quiet: it marks a boundary, it is not an event in the conversation. */
/* The reference's own `session-turn-thinking` rule, rather than a guess at it. */
.thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 20px;
  margin-top: 12px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 20px;
  color: var(--text-weak);
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

/* Trails the bubble it belongs to, which sits against the right edge. */
.user-footer {
  justify-content: flex-end;
  margin: 6px 2px 2px;
}

/*
 * MiMo's measure: the time six clear of two 26px buttons, those two apart by
 * two, each on a 7px corner around a 12px glyph.
 */
.user-footer {
  gap: 2px;
}

.user-footer .when {
  margin-inline-end: 4px;
}

.user-footer .copy {
  width: 26px;
  height: 26px;
  margin-inline: 0;
  border-radius: 7px;
}

.user-footer .copy svg {
  width: 12px;
  height: 12px;
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

.sent-tile.picture {
  position: relative;
  width: 58px;
  height: 46px;
  border: none;
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
.jump {
  position: sticky;
  bottom: 12px;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  color: var(--text-strong);
  background: color-mix(in srgb, var(--surface-raised) 92%, transparent);
  border-radius: 8px;
  transform: translateX(-50%);
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

.run-fold {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--text-weak);
  border-radius: 6px;
}

.run-fold:hover {
  color: var(--text-base);
  background: var(--surface-hover);
}

/* Along the line while the steps are away, and down once they are opened. */
.run-chev {
  transform: rotate(0deg);
  transition: transform 0.12s;
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
