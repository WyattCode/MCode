<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { applyVoiceResult, dropVoice, editCue, isClearCommand, micFailure, nextVoiceBox, precheckFailure, recorder, reportVoiceStatus, transcribeFailure, voiceOwner, voiceRun, voiceState, voiceStatus, type Recording, type VoiceCue, type VoiceFailure, type VoiceState } from "../lib/voice"
import type { Ref } from "vue"
import type { Attachment, CommandInfo, DirEntry, Effort, FileHit, Message, ModelInfo, QueuedPrompt, SessionInfo } from "@shared/protocol"
import { interruptedTurn } from "@shared/resume"
import { textualName } from "@shared/attachment-kind"
import { commandTitle } from "../lib/skill-display"
import { normalizeChord } from "@shared/chord"
import { chordOf, composing } from "../lib/keys"
import { detectCodeLanguage, insertFence } from "../lib/paste-code"
import { clearPark, requestPark } from "../lib/scroll-follow"
import { appendMentions, mentionBackspace, projectRelative, promptHistory, slashAt } from "../lib/composer-text"
import { matchingNames, wordMatch } from "../lib/word-match"
import { draftTouched, drafts, homeFilled, scheduleDraftSave } from "../lib/composer-drafts"
import SlashPill from "./SlashPill.vue"
import { accessPatch } from "../lib/confirm-queue"
import { expandTemplate, splitCommandLine } from "@shared/command"
import { acceptsDrop, dataUriFile, mentionable, outsideWindow, preview, readFiles, uriListData, uriListPaths, uriListRemote, videoUrl, MAX_LABEL, MENTION_MAX } from "../lib/attach"
import { audioVerdict, isAudioFile, limitMinutes, probeAudio } from "../lib/audio-check"
import { ACCESS_LEVELS, defaultAccess, sessionAccess, type Access } from "@shared/access"
import { openImagePreview, openVideoPreview } from "../lib/image-preview"
import type { Draft } from "../lib/draft"
import { fileCategory } from "../lib/files-tab"
import { clampEffort, effortLabelKey, findModel, withoutLatest } from "../lib/model"
import {
  fileName,
  mentionSpan,
  mentionedIn,
  withMention,
} from "../lib/mention"
import { notice, notify, notifyFailure } from "../lib/toast"
import { useApp } from "../stores/app"
import { useQuestions } from "../stores/questions"
import { HOME_SCOPE, SIDE_SCOPE, useAnnotations } from "../stores/annotations"
import { annotationSend } from "../lib/annotate"
import { openDocument } from "../lib/office-open"
import AnnotationChips from "./AnnotationChips.vue"
import ModelMenuRow from "./ModelMenuRow.vue"
import { besideRow } from "../lib/submenu"
import { isRovingKey, rovingStep, type RovingKey } from "../lib/composer-menu"
import { focusRow } from "../lib/menu-keys"
import { useEscapeLayerWhile } from "../lib/escape-layer"
import FullAccessDialog from "./FullAccessDialog.vue"
import ContextRing from "./ContextRing.vue"
import GoalBar from "./GoalBar.vue"
import QueueBar from "./QueueBar.vue"
import { readContext } from "./session-context"
import { compactTokens, t, language } from "../lib/i18n"

const emit = defineEmits<{
  terminal: []
  "open-settings": [section?: "models"]
  connect: []
  shell: [command: string]
}>()

/**
 * The commands a slash can reach.
 *
 * Handed down rather than built here: App.vue owns the registry, and this is
 * the same filtered list the palette shows, so an entry that cannot run where
 * the user is standing is not offered.
 */
const props = defineProps<{
  /**
   * Which project a task started from the home screen goes into.
   *
   * The home screen has no session behind it - MiMo creates the task when the
   * first message is sent, not when the screen opens - so the box carries the
   * project it would be created in, and creates it on the way out.
   */
  startDirectory?: string
  /** Start that task with no project, in a folder of its own. */
  startScratch?: boolean
  /**
   * This box starts a new task rather than speaking into the open one.
   *
   * The home screen's box. Going home does not close the conversation that was
   * open - its tab, the side chat and the back button all still need it - so
   * without this the box read that conversation's model, agent and context,
   * and a message sent from it went into that conversation instead of starting
   * the task the screen offers.
   */
  fresh?: boolean
  /** This box speaks for the side chat in the side column, not the open conversation. */
  side?: boolean
  /**
   * The side conversation this box speaks for, when its tab names one. Without
   * it (and without `createSide`) a side box speaks for the store's focused side chat.
   */
  sideId?: string
  /**
   * MiMo makes a side conversation on its first message, not when its tab
   * opens. A side box whose tab has no conversation yet is given this, and
   * calls it on send; it answers the new conversation's id.
   */
  createSide?: () => Promise<string | undefined>
  /** Whether its top edge drags it taller; off where MiMo docks it without one, over an expanded panel. */
  resizable?: boolean
}>()

const app = useApp()

/*
 * The right panel's per-id side chat readers (r3-handoff-composer-from-panel.md,
 * on the panel branch). Read through this optional view so the box also works
 * against a store that has only the one focused side chat; once the panel's
 * store is merged every reader is present and the fallbacks go unused.
 */
interface SideReaders {
  sideSessionOf: (id?: string) => SessionInfo | undefined
  sideBusyOf: (id?: string) => boolean
  sideMessagesOf: (id?: string) => Message[]
}
const sideStore = app as unknown as Partial<SideReaders>

/* A side box whose tab names a conversation, or will make one, speaks for that; otherwise for the focused one. */
const sideKey = computed(() => props.sideId ?? (props.createSide ? undefined : app.sideID))
const focusedSide = computed(() => Boolean(sideKey.value) && sideKey.value === app.sideID)

const sideSession = computed(() =>
  sideStore.sideSessionOf ? sideStore.sideSessionOf(sideKey.value) : focusedSide.value ? app.side : undefined,
)
const sideBusy = computed(() =>
  sideStore.sideBusyOf ? sideStore.sideBusyOf(sideKey.value) : focusedSide.value && app.sideBusy,
)
const sideMessages = computed<Message[]>(() =>
  sideStore.sideMessagesOf ? sideStore.sideMessagesOf(sideKey.value) : focusedSide.value ? app.sideMessages : [],
)

/* The conversation this box speaks for: none in a box that starts a new task. */
const sessionID = computed(() => (props.fresh ? undefined : props.side ? sideKey.value : app.currentID))
const session = computed(() => (props.fresh ? undefined : props.side ? sideSession.value : app.current))
const busyHere = computed(() => (props.side ? sideBusy.value : app.busy))
/*
 * MiMo's `pv(conv)`: a review took a turn from this conversation, so it will
 * not be continued. Its box says so in place of the usual invitation and
 * refuses to take a message at all - the same two things MiMo's box does.
 */
const restrictedHere = computed(() => session.value?.reviewRestricted === true)
/* MiMo's annotations wait in the box they were made for, kept per conversation - the side chat's apart from the main one's. */
const annotations = useAnnotations()
const annotationScope = computed(() => sessionID.value ?? (props.side ? SIDE_SCOPE : HOME_SCOPE))
const waiting = computed(() => annotations.list(annotationScope.value))

/* MiMo's attachment click: a picture or a video opens its preview, a document its tab. */
function onTileClick(item: Attachment, event?: Event) {
  const url = videoUrl(item)
  const picture = preview(item)
  if (url) openVideoPreview(url, { name: item.path })
  else if (picture) {
    const group = attachments.value.map((entry) => preview(entry)).filter((entry): entry is string => Boolean(entry))
    // MiMo's preview zooms out of the thumbnail that was clicked and back into it (r3-handoff-composer-from-reply.md).
    const rect = (event?.currentTarget as HTMLElement | null)?.getBoundingClientRect()
    const meta = { name: item.path, group, rect }
    openImagePreview(picture, meta)
  } else if (item.path) openAttachment(item.path)
}

/* MiMo's file chip click: a document opens in the Office tab, anything else in the files tab. */
function openAttachment(file: string) {
  const directory = session.value?.directory ?? props.startDirectory
  const absolute = /^([a-zA-Z]:)?[\\/]/.test(file) || !directory ? file : `${directory}/${file}`
  void openDocument({ path: absolute }, directory)
}
// Enter in the annotation box sends this box's message with everything waiting.
watch(annotationSend, (request) => {
  if (request && request.scope === annotationScope.value) void submit()
})
const text = ref("")
const input = ref<HTMLTextAreaElement>()
/**
 * Prompt history, newest last; -1 means "editing a fresh prompt".
 *
 * Read off the session rather than collected as you type: a local array only
 * ever held what this window had sent, so pressing Up in a session reopened
 * after a restart recalled nothing at all.
 */
const history = computed(() => promptHistory(props.side ? sideMessages.value : app.messages))
/*
 * MiMo's history walk: where Up has got to (null when not walking), and the
 * draft the first Up set aside, which Down past the newest puts back.
 */
const historyIndex = ref<number | null>(null)
const historyStash = ref("")
/* Set while the walk itself writes the box, so that write does not end the walk. */
let walkingHistory = false

/**
 * Set for one write the app made rather than the user, which closes both menus
 * - MiMo's `wn()` before every programmatic rewrite. Cleared by the watcher
 * that reads it, so the next keystroke behaves as typing again.
 */
let rewriting = false

function rewrite(value: string) {
  rewriting = true
  text.value = value
}

/**
 * The picker lists display names, so the pill has to as well - showing the raw
 * slug there made the same model read two different ways on one screen.
 */
/* Smart, for the open conversation or - on the home screen - for the next one. */
const smartOn = computed(() => (session.value ? Boolean(session.value.smart) : Boolean(app.config?.smart)))

const modelName = computed(() => {
  /*
   * With no session open - the home screen - the box names the app's default,
   * because that is the model the task this box creates will run.
   */
  if (smartOn.value) return t("model.smart")
  const chosen = app.shownModel(session.value?.model) ?? app.config?.model
  if (!chosen?.model) return t("model.selectPlaceholder")
  const provider = app.providers.find((entry) => entry.id === chosen.provider)
  const found = provider?.models.find((entry) => entry.id === chosen.model)
  // "(latest)" is a tag in the reference, not part of the name: its model store
  // strips the word out once and hands the stripped name to everything.
  return found ? withoutLatest(found.name) : chosen.model
})

/*
 * MiMo's resizable box. The handle along its top edge drags the writing area
 * taller or shorter - between 44px and 480px or half the window, whichever is
 * less - once the pointer has moved more than 6px; the height is remembered
 * (the home screen's box apart from the conversation's, which the side chat
 * shares), and a double-click hands it back to the text. Without a set height
 * the box fits its text, and holds at 200px once the text is 3000 characters
 * or 30 lines long.
 */
const RESIZE_MIN = 44
const RESIZE_MAX = 480
const RESIZE_SHARE = 0.5
const RESIZE_SLOP = 6
/* MiMo's pause after a width change before the box is measured again. */
const RESIZE_DEBOUNCE = 60
/* Below this the box is not laid out yet, and measuring it would give a wrong answer. */
const MEASURE_MIN_WIDTH = 28
const PINNED_HEIGHT = 200
const PINNED_CHARS = 3000
const PINNED_LINES = 30
const DOCK_HEIGHT_EVENT = "mcode:composer-dock-height"

const heightKey = computed(() => `composer.manualHeight.${props.fresh ? "home" : "dock"}`)

function storedHeight(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null
  } catch {
    return null
  }
}

function clampHeight(value: number) {
  const ceiling = Math.min(RESIZE_MAX, Math.round(window.innerHeight * RESIZE_SHARE))
  return Math.min(Math.max(Math.round(value), RESIZE_MIN), ceiling)
}

const manualHeight = ref<number | null>(storedHeight(heightKey.value))

function keepHeight(value: number | null) {
  try {
    if (value === null) localStorage.removeItem(heightKey.value)
    else localStorage.setItem(heightKey.value, String(value))
  } catch {
    // Remembered for this window only.
  }
  if (!props.fresh) window.dispatchEvent(new Event(DOCK_HEIGHT_EVENT))
}

function pinned(value: string) {
  if (value.length >= PINNED_CHARS) return true
  let lines = 1
  for (let at = 0; at < value.length; at++) {
    if (value.charCodeAt(at) === 10 && ++lines >= PINNED_LINES) return true
  }
  return false
}

function resize() {
  const element = input.value
  if (!element) return
  if (manualHeight.value !== null && props.resizable !== false) {
    element.style.height = `${clampHeight(manualHeight.value)}px`
    return
  }
  if (pinned(element.value)) {
    element.style.height = `${PINNED_HEIGHT}px`
    return
  }
  /*
   * Too narrow to measure against: the box is hidden, has not been laid out, or
   * is halfway through being moved between docks. MiMo skips the measurement
   * below that width and keeps the height it had; measuring anyway collapses a
   * three-line draft to one line for as long as the move lasts.
   */
  if (!Number.isFinite(element.clientWidth) || element.clientWidth <= MEASURE_MIN_WIDTH) return
  element.style.height = "auto"
  element.style.height = `${element.scrollHeight}px`
}

/**
 * The box is measured again when it changes width, not only when it changes
 * text.
 *
 * Narrowing the window or opening the right-hand panel rewraps what is written
 * without touching it, so a draft that already filled three lines stayed two
 * lines tall with its last line scrolled out of sight. MiMo watches the
 * textarea and remeasures 60ms after the width settles; a manual height is
 * clamped again at the same moment, because the ceiling is half the window.
 */
let widthSeen = 0
let widthTimer: ReturnType<typeof setTimeout> | undefined
let widthWatch: ResizeObserver | undefined

function watchWidth() {
  const element = input.value
  if (!element || typeof ResizeObserver === "undefined") return
  widthSeen = element.clientWidth
  widthWatch = new ResizeObserver(() => {
    const now = input.value?.clientWidth ?? 0
    if (now === widthSeen) return
    widthSeen = now
    clearTimeout(widthTimer)
    widthTimer = setTimeout(() => {
      if (manualHeight.value !== null) manualHeight.value = clampHeight(manualHeight.value)
      resize()
    }, RESIZE_DEBOUNCE)
  })
  widthWatch.observe(element)
}

onBeforeUnmount(() => {
  widthWatch?.disconnect()
  widthWatch = undefined
  clearTimeout(widthTimer)
})

let drag: { y: number; height: number; before: number | null; moved: boolean } | null = null

function startResize(event: PointerEvent) {
  const element = input.value
  if (!element) return
  drag = { y: event.clientY, height: element.getBoundingClientRect().height, before: manualHeight.value, moved: false }
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    // A pointer the browser is not tracking cannot be captured; the drag still works.
  }
}

function moveResize(event: PointerEvent) {
  if (!drag) return
  if (!drag.moved && Math.abs(event.clientY - drag.y) <= RESIZE_SLOP) return
  drag.moved = true
  manualHeight.value = clampHeight(drag.height + (drag.y - event.clientY))
}

function endResize(event: PointerEvent) {
  if (!drag) return
  const done = drag
  drag = null
  if (!done.moved) {
    manualHeight.value = done.before
    return
  }
  const value = clampHeight(done.height + (done.y - event.clientY))
  manualHeight.value = value
  keepHeight(value)
}

function resetResize() {
  drag = null
  manualHeight.value = null
  keepHeight(null)
}

/* The conversation's box and the side chat's share one height: either one moving tells the other. */
function followDockHeight() {
  if (!props.fresh) manualHeight.value = storedHeight(heightKey.value)
}

watch(manualHeight, () => void nextTick(resize))
/* A18: carried into the floating dock (or back), the box refits there rather than keeping the main dock's height. */
watch(() => props.resizable, () => void nextTick(resize))
onMounted(() => {
  window.addEventListener(DOCK_HEIGHT_EVENT, followDockHeight)
  watchWidth()
  /*
   * MiMo's: a box that comes back with a draft in it takes the keyboard, its
   * caret at the end of what was kept. MCode has more than one box, but no two
   * are ever on screen together - the home box and the conversation's, the side
   * chat and the floated one each mount with their own view - so the one that
   * has just mounted with a draft is the one that should have the focus. An
   * empty box is left alone, which is what the reference does too.
   */
  if (text.value) void nextTick(focus)
})
onBeforeUnmount(() => window.removeEventListener(DOCK_HEIGHT_EVENT, followDockHeight))

/**
 * A menu closed with Escape, until the next thing typed.
 *
 * Escape used to empty the box. That was survivable while the only menu was
 * the slash one, where the whole draft is the command being typed; the @ menu
 * opens in the middle of a long prompt, and throwing that away to close a list
 * would be a disaster. Both now close and leave the words alone, which is also
 * what Escape does in the reference.
 */
const dismissed = ref(false)

/* MiMo's: leaving the box closes the @ and slash menus. Typing again brings them back. */
function onInputBlur() {
  dismissed.value = true
}

/**
 * Paths that were chosen from the @ menu rather than merely typed.
 *
 * Only these are read and carried with the message. Something that reads like
 * a mention but names nothing - a half-typed path, an @handle - stays the
 * words it is and reaches the model inside the sentence it was written in.
 */
const mentioned = ref(new Set<string>())

/* Mentions put in lately, from the menu or a drop, newest last: what Backspace takes whole. MiMo keeps a hundred. */
const recentMentions: string[] = []

function rememberMention(path: string) {
  const at = recentMentions.indexOf(path)
  if (at >= 0) recentMentions.splice(at, 1)
  recentMentions.push(path)
  if (recentMentions.length > 100) recentMentions.shift()
}

watch(text, (value) => {
  void nextTick(resize)
  // Typing, a paste or a send ends a history walk; only the walk's own writes keep it going.
  if (!walkingHistory) historyIndex.value = null
  /*
   * Whatever the box says now is what the menus answer to. A menu closed with
   * Escape comes back as soon as anything is typed, which is the reference's
   * rule and the only one that keeps Escape from being a trapdoor.
   *
   * A rewrite the app made is not typing, and closes both menus instead - MiMo
   * clears their state before every one of them. Walking back to an old `/word`
   * question used to throw the slash menu open over it, and deleting a whole
   * mention could open the @ menu on whatever `@` was left in front of it.
   */
  dismissed.value = rewriting
  rewriting = false
  // A mention edited out of the draft stops being a mention: the file must not
  // travel with the message because its path was once typed here.
  if (!mentioned.value.size) return
  const present = new Set(mentionedIn(value))
  const kept = [...mentioned.value].filter((path) => present.has(path))
  if (kept.length !== mentioned.value.size) mentioned.value = new Set(kept)
})

/**
 * Where the caret is, kept as state rather than read when someone asks.
 *
 * The @ menu is a question about the few characters before the caret, so it
 * has to be asked again when the caret moves and not only when the text
 * changes - clicking into the middle of a finished sentence is enough to be
 * standing inside a mention, or to have just left one.
 */
const caret = ref(0)

function syncCaret() {
  caret.value = input.value?.selectionStart ?? text.value.length
}

/* ----------------------------------------------------------- attachments -- */

const attachments = ref<Attachment[]>([])
const picker = ref<HTMLInputElement>()
const dragging = ref(false)

/* MiMo's skill chips: skills picked from the slash menu or the plus menu, sent with the message. */
const skills = ref<string[]>([])
/* A chip on its way out, drawn shrinking for MiMo's 200ms before it goes. */
const leavingSkill = ref<string>()

async function take(files: readonly File[]) {
  if (!files.length) return
  // The draft this drop or pick belonged to: switching conversations while the
  // read is in flight must not drop its files into the other one.
  const originKey = draftKey.value
  const { attachments: taken, rejected } = await readFiles(files)
  if (!composerMounted || draftKey.value !== originKey) return
  attachments.value = [...attachments.value, ...taken]
  if (taken.length) notify(t("toast.attachmentsAdded", { count: taken.length }))
  sayIfUnreadable(taken)
  for (const item of rejected) {
    notifyFailure(item.reason === "too-large" ? t("attach.tooLarge", { size: MAX_LABEL }) : t("attach.unreadable"), item.name)
  }
}

/**
 * Says so when the model cannot look at a picture that was just attached.
 *
 * A picture is the only thing that travels inside the message; everything else
 * goes by path and any model can open it with a tool. MiMo has a line for this
 * in all nineteen of its tables and never shows it - nothing in the app reads
 * the key - so a picture attached to a model without vision simply went
 * nowhere. This is MCode's own notice, in the box where it happened.
 */
function sayIfUnreadable(added: readonly Attachment[]) {
  const model = currentModel.value
  if (!model || model.inputs.image) return
  if (!added.some((file) => file.mime.startsWith("image/"))) return
  notify(t("attach.noImageInput", { model: model.name || model.id }))
}

function pick() {
  picker.value?.click()
}

async function onPicked(event: Event) {
  const input = event.target as HTMLInputElement
  await take([...(input.files ?? [])])
  // Cleared so choosing the same file twice in a row still fires a change.
  input.value = ""
}

/*
 * MiMo's large paste: this many characters or more go in as a text file
 * attached to the message rather than as lines in the box, and a toast says so.
 */
const PASTE_AS_FILE = 256 * 1024

async function onPaste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.length) {
    // The clipboard carries a file: it is attached, and nothing is typed.
    event.preventDefault()
    await take(files)
    return
  }
  const uris = uriListPaths(event.clipboardData?.getData("text/uri-list") ?? "")
  if (uris.length) {
    // Copied from another application, which names the files rather than handing them over.
    event.preventDefault()
    await attachPaths(uris)
    return
  }
  /*
   * MiMo's fallback: the clipboard says it holds a picture but hands the page
   * no File item (a screenshot from some tools), so the main process reads the
   * bitmap itself and the picture is attached by path. Three ways of telling,
   * in MiMo's order: the clipboard's own formats, the types on the event, and
   * a paste that carries no plain text at all.
   */
  // The draft this paste belonged to: switching conversations while the
  // clipboard read is in flight must not drop the paste into the other one.
  const originKey = draftKey.value
  const types = [...(event.clipboardData?.types ?? [])].map((type) => type.toLowerCase())
  const looksLikeImage =
    (await window.mcode.clipboardHasImage().catch(() => false)) ||
    types.some((type) => type.startsWith("image/") || type.includes("bitmap")) ||
    (!types.includes("text/plain") && types.includes("files"))
  if (!composerMounted || draftKey.value !== originKey) return
  if (looksLikeImage) {
    event.preventDefault()
    const saved = await window.mcode.saveClipboardImage().catch(() => ({ ok: false as const, error: "" }))
    if (!composerMounted || draftKey.value !== originKey) return
    if (!saved.ok) {
      // MiMo's IMAGE_UNREADABLE: the clipboard said it held a picture and the bitmap could not be read.
      notifyFailure(t("error.imageUnreadable"), "")
      return
    }
    const data = saved.dataUrl?.split(",")[1] ?? ""
    const pasted: Attachment = { path: saved.path, mime: "image/png", data, byPath: true }
    attachments.value = [...attachments.value, pasted]
    notify(t("toast.attachmentsAdded", { count: 1 }))
    sayIfUnreadable([pasted])
    return
  }
  const pasted = event.clipboardData?.getData("text/plain") ?? ""
  if (pasted.length < PASTE_AS_FILE) {
    // MiMo's code paste: text that reads as code goes in fenced, on lines of its own.
    const language = detectCodeLanguage(pasted)
    const box = input.value
    if (!language || !box) return
    event.preventDefault()
    const next = insertFence(text.value, box.selectionStart, box.selectionEnd, language, pasted)
    text.value = next.text
    await nextTick()
    resize()
    box.focus({ preventScroll: true })
    box.setSelectionRange(next.caret, next.caret)
    caret.value = next.caret
    return
  }
  event.preventDefault()
  /*
   * MiMo writes the block to a file in the system temp folder and attaches it
   * by path, so a log of any size goes with the message and can be opened
   * afterwards. Only if that write fails does it stay inside the message.
   */
  const written = await window.mcode.savePastedText(pasted).catch(() => ({ ok: false as const, error: "" }))
  if (!composerMounted || draftKey.value !== originKey) return
  if (written.ok) {
    attachments.value = [...attachments.value, { path: written.path, mime: "text/plain", data: "", byPath: true }]
    notify(t("composer.pasteAttached"))
    return
  }
  /*
   * The write failed, so the paste goes into the box after all - replacing the
   * selection, as a plain paste would. What the user copied is never turned
   * away: refusing it left them with an empty box and a notice, and the text
   * was gone from everywhere but the clipboard.
   */
  const box = input.value
  const start = box?.selectionStart ?? text.value.length
  const end = box?.selectionEnd ?? start
  text.value = text.value.slice(0, start) + pasted + text.value.slice(end)
  const at = start + pasted.length
  caret.value = at
  await nextTick()
  resize()
  box?.focus({ preventScroll: true })
  box?.setSelectionRange(at, at)
}

/**
 * Dropping a file anywhere in the window, not only on the box.
 *
 * The reference puts all three of these on `document`
 * (main-Db9FY8Yb.js, `handleGlobalDragOver`/`DragLeave`/`Drop`), so a file
 * dragged onto the transcript - which is most of the window, and the obvious
 * place to aim - attaches. Bound to the composer element instead, as these were,
 * everything outside that one strip silently did nothing.
 *
 * The depth counter went with them. It existed because dragenter and dragleave
 * fire again for every child element crossed; at the document level the
 * reference's test is simply whether the pointer left the window at all, which
 * is what `relatedTarget` being null means.
 */
function dialogOpen(): boolean {
  // Every dialog in the app lays a scrim, and the palette an overlay.
  return Boolean(document.querySelector(".scrim, .overlay"))
}

/*
 * MiMo takes drops on the main column only - and on the box itself while it
 * floats beside the side panel. A side chat's box, in the side panel, takes none.
 */
function inDropZone(event: DragEvent): boolean {
  if (props.side) return false
  return event.target instanceof Element && Boolean(event.target.closest(".main, #float-dock"))
}

function onDragOver(event: DragEvent) {
  if (dialogOpen()) return
  if (!inDropZone(event)) {
    dragging.value = false
    return
  }
  // Files and named files only: text dragged into the box is the browser's to insert.
  if (!acceptsDrop(event.dataTransfer?.types)) return
  // Without this the window navigates to the dropped file instead.
  event.preventDefault()
  dragging.value = true
}

function onDragLeave(event: DragEvent) {
  if (dialogOpen()) return
  // Chromium leaves `relatedTarget` null inside the window too; the pointer being outside it is the real test.
  if (outsideWindow(event)) dragging.value = false
}

async function onDrop(event: DragEvent) {
  if (dialogOpen()) return
  dragging.value = false
  // Anywhere else the window's own guard stops the browser opening the file, and nothing is added.
  if (!inDropZone(event)) return
  // Text dragged into the box - a word from a page, or a selection moved within the box - is the browser's to insert.
  if (!acceptsDrop(event.dataTransfer?.types)) return
  event.preventDefault()
  // The draft this drop belonged to: switching conversations while the
  // directories are being read must not drop its mentions into the other one.
  const originKey = draftKey.value

  /*
   * MiMo only turns a text file into an @mention: the main process fills in a
   * dropped file's text for text-like names under 256KB, and the drop splits on
   * that - a text file inside the project becomes a mention, and everything
   * else (a PDF, a spreadsheet, an archive, a huge log, a folder) becomes a
   * real attachment by path.
   */
  const files = [...(event.dataTransfer?.files ?? [])]
  const inside: { rel: string; absolute: string }[] = []
  const attach: File[] = []
  const carried = new Set<string>()
  for (const file of files) {
    const absolute = window.mcode.pathForFile(file)
    if (absolute) carried.add(absolute)
    const rel = projectRoot.value && mentionable(file) ? projectRelative(projectRoot.value, absolute) : undefined
    if (rel) inside.push({ rel, absolute })
    else attach.push(file)
  }
  if (inside.length) {
    const folders = new Set(await window.mcode.directoriesOf(inside.map((entry) => entry.absolute)).catch(() => [] as string[]))
    // The reader may have left this draft while the directories were read.
    if (!composerMounted || draftKey.value !== originKey) return
    addDroppedMentions(inside.map((entry) => ({ rel: entry.rel, file: !folders.has(entry.absolute) })))
  }
  if (attach.length) await take(attach)

  /*
   * A drag from an application that names its files instead of handing them
   * over. MiMo reads these from `text/uri-list` and puts them through the same
   * split, after asking the main process which of them exist - so a stale path
   * from another window never becomes a mention of a file that is not there.
   */
  const list = event.dataTransfer?.getData("text/uri-list") ?? ""
  const named = uriListPaths(list).filter((target) => !carried.has(target))
  if (named.length) await attachPaths(named)

  /*
   * An address that is not a path. Dragging a picture out of a conversation -
   * this app's own, or a chat in a browser - hands one of these over, and the
   * drop used to end here: accepted, the browser's own handling suppressed,
   * and then nothing at all (R25-#11).
   *
   * A `data:` address carries the picture itself and is decoded in the page,
   * which is what this window is allowed to do. A web address is not fetched -
   * `connect-src` forbids it, and asking the main process to fetch whatever the
   * page was dropped would be a new way in - so it is said rather than
   * swallowed.
   */
  const carriedData = uriListData(list)
  if (carriedData.length) {
    const decoded = carriedData.map((uri, at) => dataUriFile(uri, `dropped-${at + 1}`)).filter((file): file is File => file !== undefined)
    if (decoded.length) await take(decoded)
    if (decoded.length < carriedData.length) notifyFailure(t("attach.unreadable"))
  } else if (!named.length && !files.length) {
    const remote = uriListRemote(list)
    if (remote.length) notifyFailure(t("attach.webAddress"), remote[0])
  }
}

/**
 * Files named by path rather than handed over: the uri-list half of a drop, and
 * a paste from an application that copies names.
 *
 * The same split as a dropped file - a text file inside the project becomes an
 * @mention, everything else an attachment by path - except that there is no
 * `File` to read, so a picture arrives without the bytes its thumbnail would be
 * drawn from and shows as a capsule with its name.
 */
async function attachPaths(paths: readonly string[]) {
  // Same guard as take(): the paths belong to the draft they were dropped on.
  const originKey = draftKey.value
  const found = await window.mcode.describeFiles([...paths]).catch(() => [])
  if (!composerMounted || draftKey.value !== originKey) return
  if (!found.length) return
  const root = projectRoot.value
  const mentions: { rel: string; file: boolean }[] = []
  const attach: Attachment[] = []
  for (const entry of found) {
    const textual = !entry.directory && textualName(entry.name) && entry.size < MENTION_MAX
    const rel = root && textual ? projectRelative(root, entry.path) : undefined
    if (rel) mentions.push({ rel, file: true })
    else attach.push({ path: entry.path, mime: "", data: "", byPath: true })
  }
  if (mentions.length) addDroppedMentions(mentions)
  if (attach.length) {
    attachments.value = [...attachments.value, ...attach]
    notify(t("toast.attachmentsAdded", { count: attach.length }))
  }
}

/* The project a mention is named from: the conversation's folder, or the one the home screen will start in. */
const projectRoot = computed(() =>
  props.fresh ? (props.startScratch ? undefined : props.startDirectory) : session.value?.directory,
)

function addDroppedMentions(paths: { rel: string; file: boolean }[]) {
  const unique = [...new Map(paths.map((entry) => [entry.rel, entry])).values()]
  const next = appendMentions(
    text.value,
    unique.map((entry) => entry.rel),
  )
  mentioned.value = new Set([...mentioned.value, ...unique.filter((entry) => entry.file).map((entry) => entry.rel)])
  for (const entry of unique) rememberMention(entry.rel)
  text.value = next
  void nextTick(() => {
    resize()
    input.value?.focus()
    input.value?.setSelectionRange(next.length, next.length)
    caret.value = next.length
  })
}

/**
 * What the empty box invites.
 *
 * It no longer changes while the model is working. It used to read "Working -
 * Esc to stop", which was the box telling you it would not take anything, and
 * it will: a prompt sent now joins the turn that is running. Inviting the same
 * thing it always invites is the truthful version, and it is also what the
 * reference does - its placeholder does not know whether a turn is in flight.
 */
const placeholder = computed(() => {
  if (mode.value === "shell") return t("composer.shellPlaceholder")
  // MiMo 26.920's order: compacting, then sending, then a restricted conversation, then the mode's own line, then the everyday one. Attachments do not blank it.
  if (compactingHere.value) return t("composer.compacting")
  if (sending.value) return t("composer.sending")
  if (restrictedHere.value) return t("composer.reviewRestricted")
  if (!props.side && agent.value === "plan") return t("composer.placeholderPlan")
  return t("composer.placeholder")
})

/** A drag can also end without a drop - cancelled, or dropped elsewhere. */
function endDrag() {
  dragging.value = false
}

function remove(at: number) {
  attachments.value = attachments.value.filter((_, index) => index !== at)
}

/**
 * What pressing Enter does: ask the model, or run a command.
 *
 * The reference keeps one box and switches its meaning rather than offering a
 * second one, so the two modes share the history, the attachments and the
 * keyboard - only the destination changes.
 */
const mode = ref<"normal" | "shell">("normal")

/**
 * Whether the button stops the turn rather than sending.
 *
 * The reference's own test is `working() && blank()`: a turn is running AND
 * there is nothing waiting to go. Anything typed puts send back, so the box
 * never becomes a dead end while the model works.
 */
const stopping = computed(
  () => busyHere.value && !text.value.trim() && !attachments.value.length && !skills.value.length,
)

/* A compaction of this box's conversation is running; MiMo locks the box and spins the send button meanwhile. */
const compactingHere = computed(() => !props.side && !props.fresh && app.compacting)

/* The conversation as it now stands, without anything rolled back. */
const messagesHere = computed(() => (props.side ? sideMessages.value : app.visible))

/* MiMo keeps the AI note's room but hides it until the conversation has a reply. */
const hasReply = computed(() => messagesHere.value.some((message) => message.role === "assistant"))

/* Anything the send button would send. */
const hasContent = computed(
  () =>
    Boolean(text.value.trim()) || attachments.value.length > 0 || skills.value.length > 0 || waiting.value.length > 0,
)

/*
 * MiMo's 继续: the last turn broke off, nothing is running or waiting in the
 * box, and nothing is rolled back - the send button becomes a play button that
 * carries the turn on.
 */
const resumable = computed(
  () =>
    Boolean(sessionID.value) &&
    !busyHere.value &&
    !compactingHere.value &&
    !hasContent.value &&
    (props.side || !app.rolledBack.length) &&
    interruptedTurn(messagesHere.value) !== undefined,
)

async function resumeTurn() {
  if (!(await app.resume(sessionID.value))) notifyFailure(t("composer.resumeUnavailable"))
}

function setMode(next: "normal" | "shell") {
  mode.value = next
  focus()
}

/*
 * Speaking instead of typing.
 *
 * The recorder is the app's one recorder, not this box's: several boxes are
 * mounted at once and each holding its own opened two captures of the same
 * microphone. `voiceOwner` says which box has it, so only that one draws the
 * capsule, and pressing the button in another stops this one first.
 */
const boxID = nextVoiceBox()
const mine = computed(() => voiceOwner.value === boxID)
const voice = computed<VoiceState>(() => (mine.value ? voiceState.value : "idle"))
/* The microphone's level for the capsule's waveform, read once a frame while recording. */
const voiceLevel = ref(0)

const voiceConfigured = computed(() => Boolean(app.config?.voiceModel?.model))

/*
 * What the capsule says, MiMo's nine words: 启动中 between the press and the
 * microphone, then the stretch in hand - 等待语音 until a voice is heard, 录音中
 * while it is, 转写中 or 理解中 while it is written down, and 已转写 / 已识别 /
 * 无内容 / 失败 for a moment after. Draining after the stop button is 转写中.
 */
const voiceLabel = computed(() => {
  if (voice.value === "starting") return t("voice.starting")
  if (voice.value === "working") return t(`voice.${voiceStatus.value ?? "transcribing"}`)
  return t(`voice.${voiceStatus.value ?? "listening"}`)
})

let levelFrame = 0

function followLevel() {
  cancelAnimationFrame(levelFrame)
  const step = () => {
    if (!mine.value || voiceState.value !== "recording") {
      voiceLevel.value = 0
      return
    }
    voiceLevel.value = recorder.level
    levelFrame = requestAnimationFrame(step)
  }
  levelFrame = requestAnimationFrame(step)
}

onBeforeUnmount(() => {
  cancelAnimationFrame(levelFrame)
  // Only what this box started: another box's recording outlives this one being taken off screen.
  if (mine.value) dropVoice()
})

/* MiMo's five bars: 4px at rest and up to 16 at full level, the middle one the tallest. */
const WAVE_WEIGHTS = [0.5, 0.78, 1, 0.78, 0.5]
const waveHeights = computed(() => WAVE_WEIGHTS.map((weight) => `${(4 + voiceLevel.value * 12 * weight).toFixed(1)}px`))

/* MiMo's cue drawer: the command a recording was heard as, held 3s before it slides away. */
const CUE_MS = 3000
const cueText = ref("")
const cueOn = ref(false)
/* Bumped for each cue, so the ring draws itself again for a second command in a row. */
const cueRun = ref(0)
let cueTimer: ReturnType<typeof setTimeout> | undefined

function showCue(cue: VoiceCue) {
  cueText.value = t("voice.detected", { cmd: t(`voice.${cue}`) })
  cueRun.value += 1
  cueOn.value = true
  clearTimeout(cueTimer)
  // The words stay while the drawer slides down; only the next cue replaces them.
  cueTimer = setTimeout(() => (cueOn.value = false), CUE_MS)
}

onBeforeUnmount(() => clearTimeout(cueTimer))

/**
 * One stretch of speech, written down while the next is still being spoken.
 *
 * The stretches are handled strictly in turn: each reads the box as it stands
 * when its own answer comes back, so two of them cannot both edit the draft
 * they each saw at the start and undo one another.
 */
let voiceQueue: Promise<void> = Promise.resolve()

function queueSegment(recording: Recording, run: number) {
  voiceQueue = voiceQueue.then(() => hearSegment(recording, run)).catch(() => undefined)
}

async function hearSegment(recording: Recording, run: number) {
  /* A press and an immediate second press is a slip, not a message. */
  if (recording.ms < 350 || run !== voiceRun.value) return
  /* The box and its caret go along, so 智能编辑 can edit them; lib/voice decides what lands. */
  const draft = {
    text: text.value,
    selectionStart: input.value?.selectionStart ?? text.value.length,
    selectionEnd: input.value?.selectionEnd ?? text.value.length,
  }
  const quickMode = (app.config?.voiceMode ?? "smart") === "fast"
  /* MiMo names these two apart, because one is a model reading and the other one thinking. */
  if (run === voiceRun.value) reportVoiceStatus(quickMode ? "transcribing" : "understanding")
  try {
    const result = await app.client?.request({
      type: "voice.transcribe",
      audio: recording.audio,
      mime: recording.mime,
      language: language.value,
      draft,
      sessionID: sessionID.value,
    })
    // Cancelled while it was being written down.
    if (run !== voiceRun.value) return
    if (!result) return
    /*
     * 智能编辑 that did not happen. The words still land - dictation is better
     * than nothing - but the mode quietly becoming 快速输入 is what used to hide
     * a voice model with no chat endpoint behind it, so it is said once.
     */
    if (result.editFailed) showVoiceFailure({ key: `voice.smartEdit.${result.editFailed}` })
    reportVoiceStatus(result.text.trim() ? (quickMode ? "transcribed" : "understood") : "noContent")
    /* MiMo's quick input: an utterance that is only a clear word empties the box instead of being typed. */
    if (quickMode && isClearCommand(result.text)) {
      rewrite("")
      await nextTick(resize)
      // The user pressed a button to start this, so the keyboard is on the button: the box is given it back.
      input.value?.focus({ preventScroll: true })
      input.value?.setSelectionRange(0, 0)
      showCue("cleared")
      return
    }
    const next = applyVoiceResult(draft, result)
    const edited = editCue(draft.text, next.text, Boolean(result.edit))
    if (next.text !== text.value) {
      rewrite(next.text)
      await nextTick(resize)
    }
    input.value?.focus({ preventScroll: true })
    input.value?.setSelectionRange(next.selectionStart, next.selectionEnd)
    /* As in MiMo, the spoken "send" belongs to the considered mode only; quick input just types. */
    const sendsByVoice = (app.config?.voiceSend ?? false) && !quickMode
    if (next.send && sendsByVoice && text.value.trim()) {
      dropVoice()
      // MiMo sends at once and then says so; a send is named over a rewrite heard in the same breath.
      await submit()
      showCue("sent")
      return
    }
    if (edited) showCue(edited)
  } catch (err) {
    if (run !== voiceRun.value) return
    const failure = transcribeFailure(err)
    reportVoiceStatus("failed")
    showVoiceFailure(failure)
    /*
     * Nothing heard is a benign miss and the microphone stays open for the next
     * sentence, as MiMo's does. Anything else - an endpoint that is down, a
     * model that is not there - will fail the same way for every stretch after
     * it, so the recording is stopped rather than left running into nothing.
     */
    if (failure.key !== "voice.emptyResult") stopVoice(run)
  }
}

/** 停止: the last stretch is written down with the rest, then the capsule closes. */
async function stopVoice(run: number) {
  if (!mine.value || voiceState.value !== "recording") return
  voiceState.value = "working"
  reportVoiceStatus("transcribing")
  try {
    // Whatever is left since the last cut is the last stretch; the earlier ones are already in the queue.
    const last = await recorder.stop()
    if (last) queueSegment(last, run)
    await voiceQueue
  } finally {
    if (run === voiceRun.value) {
      voiceState.value = "idle"
      reportVoiceStatus(undefined)
      voiceOwner.value = undefined
    }
  }
}

async function toggleVoice() {
  if (mine.value && (voice.value === "working" || voice.value === "starting")) return
  if (mine.value && voice.value === "recording") return void (await stopVoice(voiceRun.value))

  if (!voiceConfigured.value) {
    notifyFailure(t("voice.notConfigured"))
    return
  }
  /* MiMo's rule when another box has the microphone: that one stops, and this one starts. */
  if (voiceOwner.value && voiceOwner.value !== boxID) dropVoice()
  saidFailures.clear()
  // MiMo's starting capsule, between the press and the microphone answering.
  voiceOwner.value = boxID
  voiceState.value = "starting"
  reportVoiceStatus(undefined)
  const run = voiceRun.value
  const mode = app.config?.voiceMode ?? "smart"
  try {
    /*
     * MiMo's voicePrecheck, before the microphone is touched: a service that
     * is not going to answer - offline, no key, a model the provider does not
     * offer - is said now. Without it the reader spoke a whole sentence into
     * nothing and got a toast for every stretch of it.
     */
    const ready = await app.client?.request({ type: "voice.precheck", mode, sessionID: sessionID.value })
    if (run !== voiceRun.value) return
    if (ready && !ready.ok) {
      voiceState.value = "idle"
      voiceOwner.value = undefined
      showVoiceFailure(precheckFailure(ready.reason))
      return
    }
    // MiMo's micAccess before capture: a refusal from the OS is a denial like getUserMedia's.
    if (!(await window.mcode.micAccess())) throw new DOMException("", "NotAllowedError")
    recorder.onSegment = (recording) => queueSegment(recording, run)
    // Only on becoming a voice, as MiMo does: what ends a stretch is said by the stretch's own progress.
    recorder.onActive = (speaking) => {
      if (speaking && run === voiceRun.value) reportVoiceStatus("recording")
    }
    await recorder.start(mode)
    if (run !== voiceRun.value) return
    voiceState.value = "recording"
    reportVoiceStatus("listening")
    followLevel()
  } catch (err) {
    if (run === voiceRun.value) {
      voiceState.value = "idle"
      reportVoiceStatus(undefined)
      voiceOwner.value = undefined
    }
    showVoiceFailure(micFailure(err))
  }
}

/* MiMo's ×: the recording, or the transcription on its way, is thrown away and nothing is typed. */
function cancelVoice() {
  dropVoice()
  cueOn.value = false
}

/**
 * MiMo's single danger toast; a denied microphone also opens the OS privacy
 * page for it.
 *
 * One toast of each kind per recording. The microphone stays open across a
 * failure, so an endpoint that is down used to put the same toast on screen
 * once for every stretch of speech - a dozen of them for one dictation.
 */
const saidFailures = new Set<string>()

function showVoiceFailure(failure: VoiceFailure) {
  if (saidFailures.has(failure.key)) return
  saidFailures.add(failure.key)
  notifyFailure(t(failure.key, failure.params), failure.detail)
  if (failure.guide) window.mcode.openMicSettings()
}

/*
 * The plus menu's three rows. Each closes the menu first, so the thing it
 * opens - a file dialog, the drawer, a command in the box - is what the reader
 * is looking at next rather than a menu still hanging over it.
 */
function attachFromMenu() {
  menu.value = undefined
  pick()
}

/* Always offered, as MiMo offers it: on the home screen the window opens its bottom terminal in the chosen folder. */
function terminalFromMenu() {
  menu.value = undefined
  emit("terminal")
}

/*
 * 追求目标 as the plus menu shows it: the open conversation's setting when
 * there is one, the default the next conversation will start with when there
 * is not.
 *
 * In a conversation it is that conversation's value and nothing else, with
 * absent meaning off - the server reads the same field when it decides whether
 * a message carries a goal.
 */
const goalMode = computed(() => (sessionID.value ? (session.value?.goalMode ?? false) : (app.config?.goalMode ?? false)))

/* A switch rather than a command, because it stays on; the menu stays open, as MiMo's does. */
async function toggleGoalMode() {
  const next = !goalMode.value
  await app.setGoalMode(next, sessionID.value)
  notify(t(next ? "toast.goalOn" : "toast.goalOff"))
}

/* MiMo's skill chip: a picked skill waits above the text and goes with the next message. */
function addSkill(name: string) {
  menu.value = undefined
  if (!skills.value.includes(name)) skills.value = [...skills.value, name]
  focus()
}

/* Enter in the skills search adds the first match; Enter that commits an IME candidate is left to the input method. */
function pickFirstSkill(event: KeyboardEvent) {
  event.preventDefault()
  const first = skillRows.value[0]
  if (first) addSkill(first.name)
}

function removeSkill(name: string) {
  leavingSkill.value = name
  setTimeout(() => {
    skills.value = skills.value.filter((entry) => entry !== name)
    if (leavingSkill.value === name) leavingSkill.value = undefined
  }, 200)
}

/* MiMo's chips: each chosen skill is named as `/name` ahead of the message, and the server loads what a message names. */
function withSkills(message: string, chosen: string[]): string {
  if (!chosen.length) return message
  return [chosen.map((name) => `/${name}`).join(" "), message].filter((part) => part.trim()).join(" ")
}

/* The plus menu's skills submenu: MiMo's search box over the project's skills, beside its row. */
const skillQuery = ref("")
const skillSubOpen = ref(false)
const skillMenu = ref<HTMLElement>()
const skillPlace = ref({ left: 0, top: 0 })

const skillRows = computed(() => {
  const needle = skillQuery.value.trim().toLowerCase()
  const all = app.commands.filter((command) => command.source === "skill")
  if (!needle) return all
  return all.filter(
    (command) =>
      command.name.toLowerCase().includes(needle) || (command.description?.toLowerCase().includes(needle) ?? false),
  )
})
const hasSkills = computed(() => app.commands.some((command) => command.source === "skill"))

/* A chip is named after the skill it stands for, translated as the plugins page translates it. */
function skillChipName(trigger: string): string {
  return commandTitle(serverCommand(trigger), trigger, language.value)
}

function openSkillMenu(event: Event) {
  void openSkillFrom(event.currentTarget as HTMLElement)
}

async function openSkillFrom(from: HTMLElement) {
  const row = from.getBoundingClientRect()
  skillSubOpen.value = true
  await nextTick()
  const panel = skillMenu.value
  if (!panel) return
  skillPlace.value = besideRow(row, panel.offsetWidth, panel.offsetHeight)
  panel.querySelector("input")?.focus()
}

/* Set while attached audio is being read before a send, so a second Enter does not start another. */
let probingAudio = false

/* From the draft leaving the box until the message is taken or handed back: the new conversation, the mentioned files, the send itself. */
const sending = ref(false)
let composerMounted = true
onBeforeUnmount(() => { composerMounted = false })

async function submit(delivery?: "queue") {
  if (sending.value || probingAudio) return
  sending.value = true
  try {
    await prepareSend(delivery)
  } finally {
    sending.value = false
  }
}

/** `delivery` "queue": OpenCode v2's 排队 - while a turn runs, wait for it to end instead of joining it. */
async function prepareSend(delivery?: "queue") {
  const value = text.value.trim()
  const originKey = draftKey.value
  let target = sessionID.value
  let expectedModel = JSON.stringify(session.value?.model)
  let createdHere = false
  const stillHere = () => {
    if (createdHere) {
      if (!target || (props.side ? sessionID.value !== target : app.currentID !== target)) return false
    } else if (!composerMounted || draftKey.value !== originKey || JSON.stringify(session.value?.model) !== expectedModel) return false
    return !target || (!app.replacing.has(target) && !(props.side ? false : app.compacting))
  }
  // MiMo's restricted conversation takes nothing at all: the review that took its turn said it may not be continued.
  if (restrictedHere.value) return
  if (mode.value === "shell") {
    if (!value) return
    text.value = ""
    await nextTick(resize)
    emit("shell", value)
    return
  }
  // MiMo: while an edit or retry is replacing this conversation's turn, a send is refused and the draft kept.
  if (sessionID.value && !busyHere.value && app.replacing.has(sessionID.value)) {
    notifyFailure(t("composer.replacePending"))
    return
  }
  // A waiting question takes plain text as the answer to its first question, as MiMo's composer does.
  if (value && !attachments.value.length && sessionID.value && useQuestions().answerFromComposer(sessionID.value, value)) {
    text.value = ""
    await nextTick(resize)
    return
  }
  // MiMo's /compact typed into the box runs the compaction, behind its guards.
  if (/^\/compact(\s|$)/.test(value) && !serverCommand("compact")) {
    await compactFromBox(value)
    return
  }
  // MiMo's /rebuild: with checkpoints off, as its desktop runs, it compacts; whatever follows the name is not used.
  if (/^\/rebuild(\s|$)/.test(value) && serverCommand("rebuild")?.own) {
    await compactFromBox(value, true)
    return
  }
  /*
   * An attachment on its own is a message; the model can be asked to look at
   * it. There is deliberately no test for a turn being in flight: one that is
   * running takes the message and answers it in the same turn, so refusing here
   * would only force the user to stop the model and lose its work in order to
   * say one more sentence.
   */
  if (!value && !attachments.value.length && !waiting.value.length && !skills.value.length) {
    // MiMo never disables send for an empty box; sending one says what is missing.
    notifyFailure(t("composer.emptyInput"))
    return
  }
  if (compactingHere.value) {
    notify(t("composer.compact.busy"))
    return
  }
  if (!stillHere()) {
    notifyFailure(t("composer.targetChanged"))
    return
  }
  historyIndex.value = null
  const sent = attachments.value
  const carried = mentioned.value
  const chips = skills.value
  const scopeAtSend = annotationScope.value
  const pointed = scopeAtSend ? annotations.take(scopeAtSend) : []
  const restoreOrigin = () => {
    const key = createdHere && target ? `${props.side ? "side" : "main"}:${target}` : originKey
    if (composerMounted && draftKey.value === key) saveDraft(key)
    const kept = drafts.get(key)
    drafts.set(key, {
      text: kept?.text && kept.text !== value ? `${value}\n${kept.text}` : value,
      attachments: [...sent, ...(kept?.attachments ?? []).filter((file) => !sent.some((entry) => entry.path === file.path))],
      mentioned: [...new Set([...carried, ...(kept?.mentioned ?? [])])],
      skills: [...new Set([...chips, ...(kept?.skills ?? [])])],
    })
    draftTouched.value = { key, at: Date.now() }
    if (key === "home") homeFilled.value = true
    scheduleDraftSave()
    if (scopeAtSend && pointed.length) annotations.put(scopeAtSend, [...pointed, ...annotations.list(scopeAtSend)])
  }
  /*
   * Reserve this draft before any wait, including audio checks. Anything
   * typed or attached during preparation belongs to the next draft.
   */
  text.value = ""
  attachments.value = []
  mentioned.value = new Set()
  skills.value = []
  await nextTick(resize)

  // MiMo's 发送中…: the box says so from here until the message is taken or handed back.
  sending.value = true
  try {
    /*
     * On the home screen there is nothing to send into yet. The session is made
     * here, on the way out, rather than when the screen opened: one created just
     * because somebody looked at the home screen is a row in the side column
     * that nobody asked for. If it cannot be made, the draft comes back.
     */
    if (!stillHere()) {
      restoreOrigin()
      notifyFailure(t("composer.targetChanged"))
      return
    }
    // Validate the reserved audio only; a refusal restores it beside any new draft.
    const audio = sent.filter((file) => isAudioFile(file.path))
    if (audio.length) {
      probingAudio = true
      try {
        for (const file of audio) {
          const verdict = audioVerdict(await probeAudio(file))
          if (verdict !== "ok") {
            restoreOrigin()
            notifyFailure(verdict === "unsupported" ? t("composer.audioFormatUnsupported") : t("composer.audioTooLong", { minutes: limitMinutes() }))
            return
          }
        }
      } finally {
        probingAudio = false
      }
      if (!stillHere()) {
        restoreOrigin()
        notifyFailure(t("composer.targetChanged"))
        return
      }
    }
    if (!target) {
      try {
        if (props.side) {
          // MiMo makes a side conversation on its first message; its tab hands over how.
          target = props.createSide ? await props.createSide() : undefined
          if (!target) throw new Error("")
        } else {
          const created = await app.create(props.startDirectory, { scratch: props.startScratch, activate: stillHere })
          target = created.id
          // MiMo's newChat says so whenever the first send makes a new task.
          notify(t("toast.newConvoCreated"))
        }
        createdHere = true
        expectedModel = JSON.stringify((props.side ? app.sideSessionOf(target) : app.sessions.find((entry) => entry.id === target))?.model)
      } catch (err) {
        restoreOrigin()
        await nextTick(resize)
        notifyFailure(t("home.startFailed"), (err instanceof Error ? err.message : String(err)) || undefined)
        return
      }
    }

    /*
     * 追求目标: with the switch on, what was typed becomes the goal the turn is
     * judged against. The words as typed, not the body that is sent - a body
     * standing in for attachments would make a goal nobody wrote.
     */
    const goalOnSend = !props.side && goalMode.value && value.trim() ? value.trim() : undefined

    const named = await mentionAttachments(value, carried, target)
    const filled = await fillCommand(value, target)
    const currentModel = JSON.stringify((props.side ? app.sideSessionOf(target) : app.sessions.find((entry) => entry.id === target))?.model)
    if (!stillHere() || currentModel !== expectedModel) {
      restoreOrigin()
      notifyFailure(t("composer.targetChanged"))
      return
    }
    /*
     * Files with nothing written beside them still make a message that reads as
     * one: MiMo puts a fixed short phrase in the body, so the bubble in the
     * transcript is not an empty square and the model is told plainly that the
     * files are the message. A skill chip already stands in the body, so it is
     * left to speak for itself.
     */
    const body = filled && !filled.text.trim() && sent.length && !chips.length ? t("composer.seeAttachments") : (filled?.text ?? "")
    // A file the command names that was also mentioned goes once.
    const commandFiles = filled ? filled.attachments.filter((file) => !named.some((entry) => entry.path === file.path)) : []

    // subagents: a command marked subtask is handed to a subagent in this conversation instead of sent as a prompt.
    const subtask = props.side || !filled ? undefined : subtaskOf(filled)
    /*
     * MiMo parks the question a send starts a turn with (see MessageStream):
     * asked for here, just before sending, and taken back if the send is
     * refused. Not for the side chat, and not for a message joining a turn
     * already running, which starts none.
     */
    const parkIn = !props.side && filled && !subtask && target && !app.running.has(target) ? target : undefined
    if (parkIn) requestPark(parkIn)
    // A rejected message should not cost the user what they typed, or gathered.
    const accepted = !filled
      ? false
      : subtask
        ? await app.subtask(value, subtask, target)
        : await app.send(withSkills(body, chips), [...sent, ...named, ...commandFiles], target, pointed, filled.command, goalOnSend, delivery)
    if (!accepted && parkIn) clearPark(parkIn)
    if (!accepted) {
      restoreOrigin()
      await nextTick(resize)
    }
  } finally {
    sending.value = false
  }
}

/*
 * MiMo's /compact from the box: refused with its reason when it cannot run;
 * otherwise the draft is cleared and the compaction is reported as it starts
 * and as it ends.
 */
async function compactFromBox(line: string, rebuild = false) {
  if (!rebuild && line.replace(/^\/compact/, "").trim()) {
    notifyFailure(t("composer.compact.args"))
    return
  }
  const id = sessionID.value
  if (!id || !messagesHere.value.length) {
    notifyFailure(t("composer.compact.noSession"))
    return
  }
  if (busyHere.value || compactingHere.value) {
    notify(t("composer.compact.busy"))
    return
  }
  if (attachments.value.length || skills.value.length || waiting.value.length) {
    notifyFailure(t("composer.compact.attachments"))
    return
  }
  text.value = ""
  await nextTick(resize)
  notify(t("composer.compact.starting"))
  try {
    await app.compact(id)
    notice.success(t("composer.compact.success"))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const timedOut = /timed? ?out|ETIMEDOUT/i.test(reason)
    notifyFailure(timedOut ? t("composer.compact.timeout") : t("composer.compact.failed"), reason)
  }
}

/**
 * The ``!`cmd` `` placeholders of a template the window filled in itself, run by
 * the backend in the conversation's folder.
 *
 * MiMo runs a template's backtick commands whatever the template came from, so
 * an MCP server's prompt and the arguments typed after a skill run theirs as a
 * project command's do - the user's 2026-09-16 decision. Text with no
 * placeholder in it never leaves the window, and a backend that could not run
 * them leaves the text as it was rather than losing what was typed.
 */
async function withShell(value: string, root?: string): Promise<string> {
  if (!root || !app.client || !value.includes("!`")) return value
  try {
    const done = await app.client.request({ type: "command.shell", directory: root, text: value })
    return done.text
  } catch {
    return value
  }
}

/**
 * What actually goes to the model when the draft is a command line.
 *
 * MiMo sends `session.command` and its engine fills the template in. Here a
 * project or global command is filled in by the backend the same way
 * (`command.expand`): arguments, then its ``!`cmd` `` placeholders run in the
 * conversation's folder, then the files it names with `@` come back to be
 * attached. An MCP prompt is filled in here from the listed template and runs
 * nothing; a skill's `/name` line goes as typed, for the server to load it.
 * The transcript shows the filled-in prompt, as MiMo's does.
 *
 * A command's `agent` and `model` ride along with the message: MiMo runs the
 * turn as whichever agent and model the command names, and this does too. They
 * hold for that one turn - the conversation keeps whatever it was set to - and
 * the listed command already carries both, so nothing has to be fetched for
 * them.
 *
 * Undefined when the backend could not fill the command in; the failure has
 * been said and the draft should come back.
 */
async function fillCommand(value: string, to?: string): Promise<{ text: string; attachments: Attachment[]; command?: CommandInfo } | undefined> {
  const line = splitCommandLine(value)
  const command = line && serverCommand(line.name)
  const root = commandRoot(to)
  // Not a command at all: an ordinary message is text, and nothing in it runs.
  if (!line || !command) return { text: value, attachments: [] }
  // A skill's line goes as typed for the server to load it; the backticks in its arguments run, as MiMo runs a template's.
  if (command.source === "skill") return { text: await withShell(value, root), attachments: [] }
  if (command.source === "mcp" || !root || !app.client) {
    const expanded = expandTemplate(command.template, line.args)
    // An MCP prompt whose fetch failed has no template. Sending nothing would be
    // refused by the store and the draft would bounce back with no explanation,
    // so the line goes as it was typed instead.
    return { text: expanded.trim() ? expanded : value, attachments: [], command }
  }
  let filled: { prompt: string; files: { name: string; path: string }[] }
  try {
    filled = await app.client.request({ type: "command.expand", directory: root, name: line.name, arguments: line.args })
  } catch (err) {
    notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
    return undefined
  }
  // The named files go by their absolute path, as a mention does: the server reads each when the model is asked.
  const attachments: Attachment[] = filled.files.map((file) => ({ path: file.path, mime: "", data: "", byPath: true }))
  return { text: filled.prompt.trim() ? filled.prompt : value, attachments, command }
}

/**
 * subagents: a command marked `subtask`, as MiMo runs one - its filled-in
 * template goes to a subagent, named by the command's description, and the line
 * as typed stays the user's message. Undefined for anything else.
 */
function subtaskOf(filled: { text: string; command?: CommandInfo }): { description: string; prompt: string } | undefined {
  const command = filled.command
  if (!command?.subtask) return undefined
  const prompt = filled.text.trim()
  if (!prompt) return undefined
  return { description: command.description?.trim() || `/${command.name}`, prompt }
}

/** The folder a message from this box is sent from: its conversation's, or the side chat's. */
function commandRoot(to?: string): string | undefined {
  // A side chat made by this very message is not this box's session yet, so it is read by the id it was sent to.
  const sideRoot = sideStore.sideSessionOf ? sideStore.sideSessionOf(to)?.directory : app.side?.directory
  return props.side ? (sideRoot ?? session.value?.directory) : (to ? app.sessions.find((entry) => entry.id === to)?.directory : app.current?.directory)
}

/**
 * The mentioned files, attached by their project path as MiMo attaches them.
 *
 * Nothing is read here: the server reads each file when the model is asked,
 * so what the model sees is what is on disk then, whatever its size. A file
 * that cannot be read by then reaches the model as a note saying so.
 */
async function mentionAttachments(value: string, chosen: Set<string>, to?: string): Promise<Attachment[]> {
  const root = commandRoot(to)
  if (!root || !chosen.size) return []
  const out: Attachment[] = []
  for (const path of mentionedIn(value)) {
    if (!chosen.has(path)) continue
    // The same file named twice is one file.
    if (out.some((entry) => entry.path === path)) continue
    // MiMo's mention: the file goes by its project path and is read when the model is asked.
    out.push({ path, mime: "", data: "", byPath: true })
  }
  return out
}

/* ------------------------------------------------------------- @ menu -- */

/**
 * MiMo's @ menu: the project a folder at a time, or a search inside the folder
 * being browsed.
 *
 * An empty query lists one level - a folder opens, a file goes into the draft;
 * a query searches the files under the current folder after a short pause.
 * With no project there is nothing to list, and one line says so.
 *
 * The search is the backend's, and has to be: browsing lists one folder, so
 * filtering that list finds nothing that is not in it. Typing `@Compo` at the
 * project root found no `src/renderer/src/components/Composer.vue` at all, and
 * the header above the list said "搜索文件" over results that were never
 * searched for.
 */
const atSub = ref("")
const atEntries = ref<DirEntry[]>([])
const atHits = ref<FileHit[]>([])
const atTruncated = ref(false)
const atStatus = ref<"idle" | "loading" | "ready" | "dirFailed" | "searchFailed">("idle")
const atIndex = ref(0)
/* Answers are matched to the latest ask, so a slow one cannot overwrite a newer one. */
let atAsk = 0
/* MiMo's pause before a keystroke becomes a request. */
const AT_SEARCH_DEBOUNCE = 150
const AT_SEARCH_RESULTS = 50
let atTimer: ReturnType<typeof setTimeout> | undefined

/** The mention the caret is standing in, if it is standing in one. */
const atSpan = computed(() => (mode.value === "shell" ? undefined : mentionSpan(text.value, caret.value)))

interface AtRow {
  kind: "dir" | "file"
  name: string
  rel: string
  dir?: string
}

const joinRel = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

/** Whether the menu is searching the project rather than browsing a folder. */
const atSearching = computed(() => Boolean(atSpan.value?.query.trim()))

const atRows = computed<AtRow[]>(() => {
  const span = atSpan.value
  if (!span || !projectRoot.value) return []
  /*
   * Searching: the backend's hits, which are files only and carry the folder
   * each sits in. Browsing: this folder's own entries, narrowed with the
   * matcher the settings search uses, so the first keystrokes cost nothing
   * while the request is still out.
   */
  if (atSearching.value) {
    return atHits.value.map((hit) => ({ kind: "file" as const, name: hit.name, rel: hit.rel, dir: hit.dir }))
  }
  return matchingNames(atEntries.value, span.query).map((entry) => ({
    kind: entry.type,
    name: entry.name,
    rel: joinRel(atSub.value, entry.name),
  }))
})

/* The breadcrumb: the workspace, then each folder below it. */
const atCrumbs = computed(() => [t("composer.at.workspace"), ...atSub.value.split("/").filter(Boolean)].join(" / "))

function loadAt() {
  const span = atSpan.value
  const root = projectRoot.value
  const client = app.client
  if (!span || !root || !client) return
  const ask = ++atAsk
  const sub = atSub.value
  atStatus.value = "loading"
  client
    .request({ type: "file.listDir", directory: root, sub })
    .then((result) => {
      if (ask !== atAsk) return
      atEntries.value = result.entries
      atStatus.value = "ready"
    })
    .catch(() => {
      if (ask !== atAsk) return
      atEntries.value = []
      atStatus.value = "dirFailed"
    })
}

/**
 * The search itself, after MiMo's pause.
 *
 * Only the last ask's answer is taken, and the timer is restarted on every
 * keystroke, so a long search for two letters cannot land on top of the results
 * for five.
 */
function searchAt(query: string) {
  const root = projectRoot.value
  const client = app.client
  if (!root || !client) return
  const ask = ++atAsk
  const sub = atSub.value
  atStatus.value = "loading"
  client
    .request({ type: "file.search", directory: root, query, sub, limit: AT_SEARCH_RESULTS })
    .then((result) => {
      if (ask !== atAsk) return
      atHits.value = result.entries
      atTruncated.value = result.truncated
      atStatus.value = "ready"
    })
    .catch(() => {
      if (ask !== atAsk) return
      atHits.value = []
      atTruncated.value = false
      atStatus.value = "searchFailed"
    })
}

function stopAtTimer() {
  if (atTimer === undefined) return
  clearTimeout(atTimer)
  atTimer = undefined
}

/*
 * The folder is listed once, when the menu opens on it; a query sends a search
 * instead, restarted 150ms after the last keystroke.
 */
watch(
  () => [atSpan.value?.query, atSub.value, projectRoot.value] as const,
  ([query]) => {
    stopAtTimer()
    if (query === undefined) {
      // Closed: the next @ starts from the project root again.
      atAsk += 1
      atSub.value = ""
      atHits.value = []
      atTruncated.value = false
      atStatus.value = "idle"
      return
    }
    if (!query.trim()) {
      atHits.value = []
      atTruncated.value = false
      loadAt()
      return
    }
    atTimer = setTimeout(() => {
      atTimer = undefined
      searchAt(query)
    }, AT_SEARCH_DEBOUNCE)
  },
)

onBeforeUnmount(stopAtTimer)

/*
 * Open while it has something to show: rows, a loading or failure line, or
 * the line asking for a project. An @ that finds nothing closes, as MiMo's does,
 * so a name the project lacks never holds Enter hostage.
 */
const atOpen = computed(() => {
  if (!atSpan.value || dismissed.value) return false
  if (!projectRoot.value) return true
  return atRows.value.length > 0 || ["loading", "dirFailed", "searchFailed"].includes(atStatus.value)
})

watch(atRows, (rows) => {
  if (atIndex.value >= rows.length) atIndex.value = 0
})

/* A folder opens in the menu; a file goes into the draft. */
function chooseAt(at: number) {
  const row = atRows.value[at]
  if (!row) return
  if (row.kind === "dir") enterFolder(row.rel)
  else void insertMention(row.rel, true)
}

function enterFolder(rel: string) {
  atSub.value = rel
  atIndex.value = 0
  input.value?.focus()
}

function folderUp() {
  const cut = atSub.value.lastIndexOf("/")
  atSub.value = cut < 0 ? "" : atSub.value.slice(0, cut)
  atIndex.value = 0
  input.value?.focus()
}

/*
 * `@path ` in place of what was typed after the @. A file is remembered as
 * chosen, so it travels with the message; a folder is only named in the text,
 * which is all MiMo sends for one.
 */
async function insertMention(path: string, file: boolean) {
  const span = atSpan.value
  if (!span) return
  const next = withMention(text.value, span, path)
  if (file) mentioned.value = new Set(mentioned.value).add(path)
  rememberMention(path)
  text.value = next.text
  atIndex.value = 0
  await nextTick()
  resize()
  input.value?.focus()
  input.value?.setSelectionRange(next.cursor, next.cursor)
  caret.value = next.cursor
}

/* MiMo writes `@rel ` for a folder, with no trailing slash - the same shape a file gets. */
function referenceFolder(rel: string) {
  void insertMention(rel, false)
}

/**
 * Starts a mention from somewhere other than the @ key.
 *
 * The trigger is a rule about the text - an @ opening the draft or following a
 * space - so opening the menu means writing an @ that satisfies that rule,
 * rather than raising a flag the text would then contradict.
 */
function openContext() {
  const draft = text.value
  const opened = draft && !/\s$/.test(draft) ? `${draft} @` : `${draft}@`
  text.value = opened
  void nextTick(() => {
    resize()
    input.value?.focus()
    input.value?.setSelectionRange(opened.length, opened.length)
    caret.value = opened.length
  })
}

/** A file chosen somewhere else in the app, written into the draft as a mention. */
function mention(path: string) {
  const draft = text.value
  const opened = draft && !/\s$/.test(draft) ? `${draft} @` : `${draft}@`
  const span = mentionSpan(opened, opened.length)
  if (!span) return
  const next = withMention(opened, span, path)
  mentioned.value = new Set(mentioned.value).add(path)
  rememberMention(path)
  text.value = next.text
  void nextTick(() => {
    resize()
    input.value?.focus()
    input.value?.setSelectionRange(next.cursor, next.cursor)
    caret.value = next.cursor
  })
}

/* ------------------------------------------------------------- drafts -- */

/*
 * MiMo's drafts: one per conversation (the side chat's apart), and the home
 * screen's own, all kept on disk (lib/composer-drafts). Switching
 * conversations puts the words, files, mentions and skill chips of the one
 * being left aside and brings back the other's.
 */
const draftKey = computed(() =>
  props.fresh ? "home" : `${props.side ? "side" : "main"}:${sessionID.value ?? ""}`,
)

function saveDraft(key: string) {
  // A deleted session's draft was already forgotten by the store; writing this
  // box's stale contents back would resurrect an orphan that is saved to disk
  // and never shown again. Side conversations live in sideSessions, not sessions.
  const id = key.startsWith("main:") || key.startsWith("side:") ? key.slice(key.indexOf(":") + 1) : undefined
  if (id && !app.sessions.some((entry) => entry.id === id) && !app.sideSessions.some((entry) => entry.id === id)) return
  if (text.value || attachments.value.length || skills.value.length) {
    drafts.set(key, {
      text: text.value,
      attachments: attachments.value,
      mentioned: [...mentioned.value],
      skills: skills.value,
    })
  } else drafts.delete(key)
}

watch(
  draftKey,
  (next, previous) => {
    historyIndex.value = null
    if (previous) saveDraft(previous)
    const kept = drafts.get(next)
    text.value = kept?.text ?? ""
    attachments.value = kept?.attachments ?? []
    mentioned.value = new Set(kept?.mentioned ?? [])
    skills.value = kept?.skills ?? []
    /*
     * The caret goes to the end of the restored draft, in the box as well as in
     * this component's own idea of it. Writing only the number left the two
     * disagreeing until the first keystroke, and the @ and slash menus are both
     * questions about the characters before it.
     */
    caret.value = text.value.length
    void nextTick(() => {
      if (document.activeElement === input.value) input.value?.setSelectionRange(caret.value, caret.value)
    })
    // The folder being browsed belonged to the project that conversation was in.
    atSub.value = ""
  },
  { immediate: true },
)

/* Every change is kept with its box at once and written to disk shortly after, as MiMo's are. */
watch(
  [text, attachments, mentioned, skills],
  () => {
    saveDraft(draftKey.value)
    scheduleDraftSave()
  },
  { deep: true },
)

watch(
  () => [text.value.trim(), attachments.value.length, skills.value.length] as const,
  ([words, files, chips]) => {
    if (props.fresh) homeFilled.value = Boolean(words || files || chips)
  },
  { immediate: true },
)

onBeforeUnmount(() => saveDraft(draftKey.value))

/* A chip or words put into this box's draft from elsewhere - the skill card's buttons - show at once. */
watch(draftTouched, (touched) => {
  if (touched.key !== draftKey.value) return
  const kept = drafts.get(touched.key)
  if (!kept) return
  attachments.value = [...kept.attachments]
  mentioned.value = new Set(kept.mentioned)
  skills.value = [...kept.skills]
  if (kept.text !== text.value) {
    text.value = kept.text
    caret.value = text.value.length
    void nextTick(resize)
  }
  focus()
})

/* ------------------------------------------------------------ commands -- */

/**
 * One row of the slash menu.
 *
 * MiMo's slash menu lists only what a slash can name: the project's commands,
 * its MCP prompts and its skills, each as a `/name` chip with its description
 * and a badge for where it came from - plus, inside a conversation, the one
 * command the session itself answers (`compact`). The app's own actions are
 * not in it; they live in the command palette.
 */
interface SlashEntry {
  id: string
  /** The word typed after the slash. */
  trigger: string
  description?: string
  /** Where it came from, or nothing for the session's own command. */
  badge?: string
  /** Run from the menu instead of written into the box. */
  run?: () => void
}

function serverCommand(name: string): CommandInfo | undefined {
  return app.commands.find((entry) => entry.name === name)
}

const SOURCE_BADGE: Record<CommandInfo["source"], string> = {
  command: "composer.slashCommand",
  mcp: "composer.slashMcp",
  skill: "composer.slashSkill",
}

/**
 * The project's own commands, its MCP prompts and its skills, badged by source.
 *
 * Three badges, as MiMo has three: a skill that ships with the app is still a
 * skill, and calling it out as a fourth kind said something about where it came
 * from that the user has no use for while picking one.
 */
const serverEntries = computed<SlashEntry[]>(() =>
  app.commands.map((entry) => ({
    id: `custom.${entry.name}`,
    trigger: entry.name,
    description: entry.description,
    badge: t(SOURCE_BADGE[entry.source]),
  })),
)

/*
 * The session's own command, listed ahead of the rest in a conversation as
 * MiMo lists it. It has nothing to take, so choosing it runs it.
 */
const sessionEntries = computed<SlashEntry[]>(() => {
  const id = sessionID.value
  if (!id) return []
  return [
    { id: "session.compact", trigger: "compact", description: t("composer.compactDesc"), run: () => void compactFromBox("/compact") },
  ]
})

/*
 * MiMo's slash trigger: the caret's line holds only spaces before a `/`, and
 * nothing typed since that `/` is whitespace. Any line counts. A slash inside
 * a sentence stays a slash, and the space after a name ends the search, so a
 * command's arguments are never taken for a query.
 */
const slashSpan = computed(() => (mode.value === "shell" ? undefined : slashAt(text.value, caret.value)))
const slashQuery = computed(() => slashSpan.value?.query)

/*
 * MiMo's slash filter reads the name alone, word by word: every word typed has
 * to begin a word of the name (a camelCase name counts its parts), and a query
 * in Chinese or Japanese matches anywhere in it. The description is not read.
 */
const slashMatches = computed(() => {
  const query = slashQuery.value
  if (query === undefined) return []
  /*
   * The session's own command wins a name it shares with the project's, which
   * is MiMo's order: it walks its session commands first and keeps the first of
   * each name. It used to be the other way round, and on the home screen - where
   * there is no conversation to compact - a project command called `compact`
   * was listed although MiMo hides exactly that one there.
   */
  const session = sessionEntries.value
  const taken = new Set(session.map((entry) => entry.trigger))
  const server = sessionID.value
    ? serverEntries.value.filter((entry) => !taken.has(entry.trigger))
    : serverEntries.value.filter((entry) => entry.trigger !== "compact")
  return [...session, ...server].filter((entry) => wordMatch(entry.trigger, query))
})

/*
 * Open whenever the draft is a command line, even with nothing matching: the
 * reference keeps its popover up and puts `prompt.popover.emptyCommands` in it
 * (@4482800) rather than vanishing, so a mistyped name says so instead of
 * looking like the menu was never there.
 */
const slashOpen = computed(() => !dismissed.value && slashQuery.value !== undefined)
const slashIndex = ref(0)

/* MiMo keeps no failed command list: the menu asks again the next time it opens. */
watch(slashOpen, (open) => {
  if (open && app.commandsState === "failed") void app.refreshCommands(projectRoot.value ?? session.value?.directory)
})

// Typing narrows the list, which can leave the highlight past the end of it.
watch(slashMatches, (rows) => {
  if (slashIndex.value >= rows.length) slashIndex.value = 0
})

/* MiMo's menus take the room above the box, less 12, between 120 and 300. */
const boxEl = ref<HTMLElement>()
const menuRoom = ref(300)

watch(
  () => atOpen.value || slashOpen.value,
  (open) => {
    if (!open) return
    const top = boxEl.value?.getBoundingClientRect().top ?? 318
    menuRoom.value = Math.min(300, Math.max(120, Math.round(top - 6 - 12)))
  },
)

/* The names the slash highlight answers to: the menu's commands. */
const slashNames = computed(() => new Set([...sessionEntries.value, ...serverEntries.value].map((entry) => entry.trigger)))

async function runSlash(at: number) {
  const command = slashMatches.value[at]
  const span = slashSpan.value
  if (!command || !span) return
  slashIndex.value = 0
  const before = text.value.slice(0, span.start)
  const after = text.value.slice(span.start + span.query.length + 1)
  /*
   * MiMo's pick: a skill becomes a chip and the typed `/query` goes; the
   * session's own command runs; anything else is named where `/query` was -
   * `/name ` with the caret after it, because what comes next is its arguments -
   * and the rest of the draft stays.
   */
  const skill = serverCommand(command.trigger)?.source === "skill"
  if (command.run || skill) {
    // Only the `/query` goes. MiMo leaves whatever followed it exactly as it was, space included.
    rewrite(before + after)
    await nextTick(resize)
    if (skill) addSkill(command.trigger)
    else command.run?.()
    input.value?.setSelectionRange(before.length, before.length)
    caret.value = before.length
    return
  }
  const named = `/${command.trigger} `
  rewrite(before + named + after)
  await nextTick(resize)
  // After the tick, because the text watcher clears this on every change.
  dismissed.value = true
  const end = before.length + named.length
  focus()
  input.value?.setSelectionRange(end, end)
  caret.value = end
}

/**
 * Arrow keys through an open menu. Shared by both of them: the two differing
 * here would be a difference with nothing behind it.
 *
 * The reference also walks its list on Ctrl+N and Ctrl+P. Those are not taken
 * here because this app already spends both - Ctrl+N starts a session and
 * Ctrl+P opens the file palette - and a chord that means one thing everywhere
 * except inside an open menu is worse than one meaning it always.
 */
function moveMenu(event: KeyboardEvent, count: number, index: Ref<number>): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
  if (!step || !count) return false
  event.preventDefault()
  index.value = (index.value + step + count) % count
  return true
}

/**
 * Enter and Tab both take the highlighted row, as they do in the reference.
 *
 * Modifiers are not looked at for Enter: MiMo's own test is the key and the
 * absence of Shift, so Ctrl+Enter over an open menu picks the row rather than
 * slipping past it and typing a newline.
 */
function takesRow(event: KeyboardEvent): boolean {
  if (event.key === "Enter") return !event.shiftKey
  if (event.key !== "Tab") return false
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}

/**
 * The chord the user has bound "send message" to, when it is an Enter of some
 * kind.
 *
 * MiMo reads the binding before deciding between a newline and a send: a
 * binding on an Enter combination is matched exactly and takes Ctrl+Enter's
 * newline away with it, and anything else leaves the default alone - Enter
 * sends, Ctrl+Enter breaks the line, Alt+Enter sends. Nothing read the binding
 * here at all, so rebinding the send key did nothing in the box and, worse, the
 * window's own dispatcher then sent the newline the box had just typed.
 */
const sendChord = computed(() => {
  const bound = app.config?.keybinds?.["composer.send"]
  const chord = typeof bound === "string" && bound ? normalizeChord(bound) : ""
  return /(^|\+)Enter$/i.test(chord) ? chord : ""
})

function sendsMessage(event: KeyboardEvent): boolean {
  if (event.key !== "Enter") return false
  if (sendChord.value) return chordOf(event, app.platform) === sendChord.value
  return !event.shiftKey && !event.metaKey && !event.ctrlKey
}

/**
 * OpenCode v2's 排队 key: Alt+Enter while a turn runs, as long as sending is not
 * bound to it. Otherwise Alt+Enter sends, as MiMo's does.
 */
function queuesMessage(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  return busyHere.value && mode.value !== "shell" && sendChord.value.toLowerCase() !== "alt+enter"
}

/** 撤回 from the queue: the message back in the box to be changed, ahead of anything already typed. */
function restoreQueued(item: QueuedPrompt) {
  const draft = text.value.trim()
  text.value = draft ? `${item.text}\n${draft}` : item.text
  attachments.value = [...(item.attachments ?? []), ...attachments.value]
  void nextTick(() => {
    resize()
    input.value?.focus()
  })
}

/** Ctrl+Enter breaks the line only while no Enter combination is bound to sending. */
function breaksLine(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || sendChord.value) return false
  return event.ctrlKey || event.metaKey
}

/**
 * A key the box has answered for itself, and which must not travel on.
 *
 * The window's shortcut dispatcher listens on `window` in the bubble phase, so
 * a key left to bubble is acted on twice: with Ctrl+Enter bound to sending,
 * the box typed a newline and the dispatcher then sent the draft with the
 * newline in it.
 */
function handled(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
}

function onKeydown(event: KeyboardEvent) {
  /*
   * While an IME is composing, Enter picks a candidate and the arrows move
   * through the candidate list - none of it is meant for us. Without this the
   * first Enter of every pinyin word sent a half-written message. Chromium
   * reports keyCode 229 for the same state on some layouts.
   */
  if (event.isComposing || event.keyCode === 229) return

  /*
   * While a menu is up it owns the arrows, Enter and Tab, the way the palette
   * does. Escape closes the menu and leaves the draft alone, so a trigger typed
   * by accident costs one key and nothing that was written.
   *
   * The @ menu is asked first because its trigger is the more specific one: it
   * is about the word the caret is in, where the slash menu is about the draft
   * beginning with a slash, and both can be true at once.
   */
  if (atOpen.value) {
    if (moveMenu(event, atRows.value.length, atIndex)) return
    const row = atRows.value[atIndex.value]
    // MiMo's Tab on a folder references it; Enter opens it. On a file both pick it.
    if (row && takesRow(event)) {
      event.preventDefault()
      if (event.key === "Tab" && row.kind === "dir") referenceFolder(row.rel)
      else chooseAt(atIndex.value)
      return
    }
    // Backspace with nothing typed after the @, inside a folder, climbs out of it.
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (event.key === "Backspace" && plain && atSub.value && atSpan.value?.query === "") {
      event.preventDefault()
      folderUp()
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      dismissed.value = true
      return
    }
  } else if (slashOpen.value) {
    /*
     * Only a menu with rows in it owns the arrows and Enter. The empty state
     * is a message, not a list: Enter there has to send the sentence that was
     * typed, the way it would if the menu had never opened. Escape still
     * closes it either way, because it is on screen either way.
     */
    if (slashMatches.value.length) {
      if (moveMenu(event, slashMatches.value.length, slashIndex)) return
      if (takesRow(event)) {
        event.preventDefault()
        void runSlash(slashIndex.value)
        return
      }
    }
    if (event.key === "Escape") {
      event.preventDefault()
      dismissed.value = true
      return
    }
  }

  // MiMo's Ctrl+Enter (Cmd+Enter): a newline at the caret, in place of any selection.
  if (breaksLine(event)) {
    const box = input.value
    if (!box) return
    handled(event)
    const start = box.selectionStart
    rewrite(`${text.value.slice(0, start)}\n${text.value.slice(box.selectionEnd)}`)
    void nextTick(() => {
      resize()
      box.setSelectionRange(start + 1, start + 1)
      caret.value = start + 1
    })
    return
  }

  // MiMo's whole-mention delete: Backspace just after a mention takes all of it.
  if (event.key === "Backspace" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    const box = input.value
    if (box && box.selectionStart === box.selectionEnd) {
      const known = [...new Set([...[...recentMentions].reverse(), ...mentioned.value])]
      const next = mentionBackspace(text.value, box.selectionStart, known)
      if (next) {
        handled(event)
        rewrite(next.text)
        void nextTick(() => {
          resize()
          box.setSelectionRange(next.caret, next.caret)
          caret.value = next.caret
        })
        return
      }
    }
  }

  if (queuesMessage(event)) {
    handled(event)
    if (event.repeat) return
    void submit("queue")
    return
  }

  // Enter sends; Shift+Enter is a newline. This is a chat surface, not an editor.
  if (sendsMessage(event)) {
    handled(event)
    // Held down, it sends once. The reference guards the same way, after its
    // preventDefault so the repeats do not fall through and type newlines.
    if (event.repeat) return
    void submit()
    return
  }

  /*
   * MiMo's stop keys while this conversation runs: Escape on its own, or Ctrl+C
   * with nothing selected in the box - a selection still copies. A draft does
   * not hold either back, and it stays in the box.
   */
  if (busyHere.value && !event.shiftKey && !event.metaKey && !event.altKey) {
    const escape = event.key === "Escape" && !event.ctrlKey
    const box = input.value
    const selected = box ? box.selectionStart !== box.selectionEnd : false
    const copy = (event.key === "c" || event.key === "C") && event.ctrlKey && !selected
    if (escape || copy) {
      handled(event)
      void app.abort(sessionID.value)
      return
    }
  }

  // MiMo's shell mode leaves on Escape - after the input-method guard above, not before it.
  if (event.key === "Escape" && mode.value === "shell") {
    handled(event)
    setMode("normal")
    return
  }

  /*
   * MiMo's history walk. Up starts it from a collapsed caret at the very start
   * of a one-line draft, setting that draft aside; once walking, Up and Down
   * move from anywhere, and Down past the newest puts the draft back.
   */
  const element = input.value
  if (!element || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  const collapsed = element.selectionStart === element.selectionEnd
  const walking = historyIndex.value !== null
  if (event.key === "ArrowUp" && history.value.length) {
    if (!walking && !(collapsed && element.selectionStart === 0 && !text.value.includes("\n"))) return
    handled(event)
    if (historyIndex.value === null) {
      historyStash.value = text.value
      showHistory(history.value.length - 1)
    } else showHistory(Math.max(0, historyIndex.value - 1))
  } else if (event.key === "ArrowDown" && walking) {
    handled(event)
    const next = (historyIndex.value ?? 0) + 1
    showHistory(next >= history.value.length ? null : next)
  }
}

/* Writes a history entry, or the set-aside draft for null, with the caret at its end. */
function showHistory(at: number | null) {
  walkingHistory = true
  historyIndex.value = at
  const value = at === null ? historyStash.value : (history.value[at] ?? "")
  rewrite(value)
  void nextTick(() => {
    walkingHistory = false
    resize()
    input.value?.setSelectionRange(value.length, value.length)
    caret.value = value.length
  })
}

/* A click moves the caret and ends a history walk. */
function onBoxClick() {
  historyIndex.value = null
  syncCaret()
}

/** Which pill has its menu open, if any. */
const menu = ref<"model" | "access" | "plus" | "context">()

/**
 * How full the model's context is, read from the box itself.
 *
 * The reference keeps this ring beside the model picker rather than in a
 * header, which is where the question comes up: about to send, is there room.
 * The figures come from session-context.ts like the header's, so the two never
 * disagree. Before a turn has spent anything the ring is drawn empty against
 * the current model's window. A model whose window nobody has told the app -
 * a local server that does not report one - still gets its ring, empty, and a
 * card that gives the tokens spent and says the size is not known: the
 * reference always has the control, and a control that comes and goes with a
 * provider setting is a puzzle. Not drawn on the home screen, which has no
 * conversation to measure.
 */
const contextUsage = computed(() => {
  if (!sessionID.value) return undefined
  const reading = readContext(messagesHere.value, app.providers, session.value?.compacted)
  // MiMo draws no ring until a turn has spent something: an empty conversation has nothing to show.
  if (!reading) return undefined
  const current = session.value?.model
  const limit =
    reading.window ??
    (current
      ? app.providers.find((provider) => provider.id === current.provider)?.models.find((model) => model.id === current.model)
          ?.contextWindow
      : undefined)
  // MiMo's figure leaves reasoning out: the prompt, cache reads and writes, and the output.
  const usage = reading.usage
  const used = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
  /*
   * Right after a compaction the figure is the compaction's estimate of the
   * next request, not a count a provider reported, and it says so: "≈" in
   * front of each number, in every language, until the next turn replaces it.
   */
  const about = reading.estimated ? "≈" : ""
  // The cache line only when the provider reported reads from its cache.
  const cacheBase = usage.cacheRead + usage.cacheWrite + usage.input
  const cacheLine =
    usage.cacheRead > 0 && cacheBase > 0
      ? t("composer.ctxCache", { pct: Math.round((usage.cacheRead / cacheBase) * 100) })
      : undefined
  if (!limit) {
    return { percent: 0, shareLine: undefined, tokensLine: t("composer.ctxUsedOnly", { used: about + compactTokens(used) }), cacheLine }
  }
  const share = (used / limit) * 100
  return {
    // MiMo's ring: a whole percent, at least 1, and no arc at all past the window.
    percent: used > limit ? 0 : Math.max(1, Math.round(share)),
    shareLine: t("composer.ctxPercent", { used: about + share.toFixed(1), left: about + Math.max(0, 100 - share).toFixed(1) }),
    tokensLine: t("composer.ctxTokens", { used: about + compactTokens(used), total: compactTokens(limit) }),
    cacheLine,
  }
})
const pills = ref<HTMLElement>()
const rowStart = ref<HTMLElement>()
const rowEnd = ref<HTMLElement>()

/*
 * MiMo's bar: once its two groups no longer share a line and wrap, the
 * permission and mode chips drop their words; under 480 wide the usage ring
 * goes. Measured with the words showing, so dropping them cannot decide it.
 */
const labelsCollapsed = ref(false)
const barNarrow = ref(false)
let barObserver: ResizeObserver | undefined
let barFrame = 0

function measureBar() {
  cancelAnimationFrame(barFrame)
  barFrame = requestAnimationFrame(() => {
    const bar = pills.value
    const start = rowStart.value
    const end = rowEnd.value
    if (!bar || !start || !end) return
    // Flattened into one row (the floating box), there is no bar of its own to wrap or narrow.
    if (getComputedStyle(bar).display === "contents") {
      bar.classList.remove("collapsed")
      labelsCollapsed.value = false
      barNarrow.value = false
      return
    }
    barNarrow.value = bar.clientWidth < 480
    bar.classList.remove("collapsed")
    const a = start.getBoundingClientRect()
    const b = end.getBoundingClientRect()
    const wrapped = b.top >= a.bottom - 1 || a.top >= b.bottom - 1
    bar.classList.toggle("collapsed", wrapped)
    labelsCollapsed.value = wrapped
  })
}

onMounted(() => {
  barObserver = new ResizeObserver(measureBar)
  for (const element of [pills.value, rowStart.value, rowEnd.value]) if (element) barObserver.observe(element)
  measureBar()
})

onBeforeUnmount(() => {
  barObserver?.disconnect()
  cancelAnimationFrame(barFrame)
})

/**
 * The access chip's three positions, as MiMo has them: the default, "approve
 * for me" in the middle, and full access. On the home screen the chip is the
 * app's default level; in a conversation it is that conversation's own, which
 * MiMo keeps per conversation and a conversation without one takes from the
 * default (@shared/access).
 */
const accessHere = computed(() => !props.fresh && !props.side && Boolean(sessionID.value))
const access = computed<Access>(() =>
  accessHere.value ? sessionAccess(session.value?.access, app.config) : defaultAccess(app.config),
)

/* Full access is offered only once settings allow it - or while it is already on, so it can be left. */
const accessChoices = computed(() =>
  ACCESS_LEVELS.filter((entry) => entry !== "full" || app.config?.allowFullAccess || access.value === "full"),
)

/* Set while the question before full access is on screen. */
const confirmingFull = ref(false)

/* The row the keyboard stands on in the access menu, which takes the same keys as the model menu. */
const accessHot = ref<Access>()

watch(menu, async (value) => {
  if (value !== "access") return
  accessHot.value = access.value
  await nextTick()
  accessMenu.value?.focus()
})

function onAccessKeys(event: KeyboardEvent) {
  if (event.key === "Tab") return
  event.stopPropagation()
  if (event.key === "Escape") {
    event.preventDefault()
    menu.value = undefined
    focus()
    return
  }
  if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return
  if (isRovingKey(event.key)) {
    event.preventDefault()
    accessHot.value = rovingStep(accessChoices.value, accessHot.value, event.key)
  } else if ((event.key === "Enter" || event.key === " ") && accessHot.value) {
    event.preventDefault()
    void chooseAccess(accessHot.value)
  }
}

/*
 * Each level's mark, on the chip and in the menu, measured off MiMo's: a raised
 * four-fingered hand drawn 16px on the chip, then a pencil and a shield with a
 * warning in it drawn 18px, so the pencil spans 12 and the shield 11. `box` is
 * the drawing's own square and the chip's size; the menu draws all three at 17.
 */
const ACCESS_ICONS: Record<Access, { box: number; stroke: number; paths: string[] }> = {
  ask: {
    box: 16,
    stroke: 1,
    paths: [
      "M6.16 9.25V4.45a.76.76 0 0 1 1.52 0v3.81",
      "M7.68 4.45V3.44a.76.76 0 0 1 1.52 0v4.82",
      "M9.2 4.2a.76.76 0 0 1 1.53 0v4.06",
      "M10.73 5.72a.76.76 0 0 1 1.52 0v4.31c0 1.83-1.48 3.31-3.3 3.31-1.14 0-1.96-.32-2.62-.89-.64-.56-1.13-1.4-1.57-2.42-.44-.99-.68-1.62-.84-2.01-.07-.22.04-.6.38-.61.77-.04 1.57.54 1.86 1.69",
    ],
  },
  auto: { box: 18, stroke: 1.13, paths: ["M9 14.67h6", "M12 3.67a1.41 1.41 0 0 1 2 2L5.67 14 3 14.67l.67-2.67z"] },
  full: {
    box: 18,
    stroke: 1.03,
    paths: ["M9 2.94l5.45 3.03v3.63c0 3.03-2.3 5.15-5.45 5.45-3.15-.3-5.45-2.42-5.45-5.45V5.97z", "M9 6.58V9", "M9 11.42h.01"],
  },
}

/*
 * The access and model menus open below their chips, as MiMo's do. On the home
 * screen that is always so; under a conversation the box sits at the window's
 * foot, and a menu that would run within 60px of the bottom opens above instead.
 */
const accessMenu = ref<HTMLElement>()
const plusMenu = ref<HTMLElement>()

/*
 * MiMo's plus menu is its menu primitive: focus goes to the first row when it
 * opens, Up, Down, Home and End walk the rows, Enter and Space are the row's
 * own button, and Right opens 技能 with focus in its search. Escape closes one
 * level: the skills panel back to its row, then the menu back to the box.
 */
watch(menu, async (value) => {
  if (value !== "plus") return
  await nextTick()
  plusMenu.value?.querySelector<HTMLElement>(":scope > .item")?.focus({ preventScroll: true })
})

function onPlusKeys(event: KeyboardEvent) {
  if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return
  const panel = skillMenu.value
  const skillRow = plusMenu.value?.querySelector<HTMLElement>("[data-plus-skills]")
  const inSkills = Boolean(panel?.contains(event.target as Node))
  if (inSkills) {
    const field = event.target instanceof HTMLInputElement
    // The search keeps its own caret keys; Down leaves it for the list.
    if (field && event.key !== "ArrowDown") return
    const rows = [...(panel?.querySelectorAll<HTMLElement>(".skill-item") ?? [])]
    if (isRovingKey(event.key)) {
      if (focusRow(rows, event.key)) event.preventDefault()
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      skillSubOpen.value = false
      skillRow?.focus()
    }
    return
  }
  if (isRovingKey(event.key)) {
    if (focusRow([...(plusMenu.value?.querySelectorAll<HTMLElement>(":scope > .item") ?? [])], event.key)) event.preventDefault()
  } else if (event.key === "ArrowRight" && event.target === skillRow && skillRow) {
    event.preventDefault()
    void openSkillFrom(skillRow)
  }
}

useEscapeLayerWhile(
  () => menu.value === "plus",
  () => {
    if (skillSubOpen.value) {
      skillSubOpen.value = false
      skillQuery.value = ""
      plusMenu.value?.querySelector<HTMLElement>("[data-plus-skills]")?.focus()
      return
    }
    menu.value = undefined
    focus()
  },
  () => (menu.value = undefined),
)
const menuUp = ref(false)
watch(menu, async (value) => {
  menuUp.value = false
  if (value !== "plus") {
    skillSubOpen.value = false
    skillQuery.value = ""
  }
  if ((value !== "access" && value !== "model" && value !== "plus") || props.fresh) return
  await nextTick()
  const shown = value === "access" ? accessMenu.value : value === "plus" ? plusMenu.value : modelMenu.value
  const rect = shown?.getBoundingClientRect()
  if (rect && rect.bottom > window.innerHeight - 60) menuUp.value = true
})

/**
 * Full turns every bucket that is not denied to allow, and keeps the map it
 * replaced; back from full puts that map back, so answers the user gave in
 * settings - the shell allowed, say - survive a trip through the chip. With
 * nothing kept (a config written elsewhere) each bucket goes to its default,
 * not to "ask": reading the project never asked, and a chip that made it
 * start would be a regression dressed up as a safety setting. A deny is never
 * touched in either direction.
 */
async function chooseAccess(next: Access) {
  menu.value = undefined
  if (!app.config?.permissions || next === access.value) return
  // Skipping every question is asked about once, the way MiMo asks.
  if (next === "full") {
    confirmingFull.value = true
    return
  }
  await applyAccess(next)
}

async function confirmFull() {
  confirmingFull.value = false
  await applyAccess("full")
}

/*
 * In a conversation the level is saved with that conversation alone. On the
 * home screen it is the default, written into the config; that map arithmetic
 * is shared with the settings switch, which drops full access the same way.
 */
async function applyAccess(next: Access) {
  const id = sessionID.value
  if (accessHere.value && id) {
    try {
      await app.setAccess(id, next)
      app.announceAccess(next)
    } catch (err) {
      notifyFailure(t("composer.access.failed"), err instanceof Error ? err.message : String(err))
    }
    return
  }
  const patch = app.config ? accessPatch(app.config, next) : undefined
  if (!patch) return
  try {
    await app.patchConfig(patch, { quiet: true })
    app.announceAccess(next)
  } catch (err) {
    notifyFailure(t("composer.access.failed"), err instanceof Error ? err.message : String(err))
  }
}

const AGENTS = ["build", "plan"] as const

/** What the session is running on, as the server describes it. */
const currentModel = computed<ModelInfo | undefined>(() =>
  findModel(app.providers, app.shownModel(session.value?.model) ?? app.config?.model),
)

/**
 * The reasoning steps THIS model accepts, which is not the same list for all of
 * them and is empty for most.
 *
 * The pill used to offer all five to everything, which meant asking a plain
 * chat model to think harder and a Claude 4.6 for a level it has never had -
 * both settings the provider drops on the floor. The reference decides it per
 * model and hides the control outright when there is nothing to choose:
 * main-8t-QUXax.js @4547992 is `const variants = createMemo(() => ["default",
 * ...variant.list()])` beside `const showVariantControl = createMemo(() =>
 * variant.list().length > 0)`, and its v2 composer draws the same control only
 * `when(control.options().length > 1)` (@4603381) - the same rule counted from
 * the other end.
 *
 * The list arrives on the wire as `ModelInfo.variants`, so an unloaded provider
 * list yields an empty one and the pill stays away until the models are known,
 * which is what the reference's `variantControlVisible: !model.loading` does.
 */
const variants = computed<Effort[]>(() => currentModel.value?.variants ?? [])

/*
 * The level the chip names: the conversation's own, else the default a new
 * task starts with - clamped to what this model takes, as MiMo clamps it, so a
 * model with levels always shows one.
 */
const effortLevel = computed<Effort | undefined>(() =>
  clampEffort(variants.value, session.value?.effort ?? app.config?.effort, currentModel.value?.defaultEffort),
)

const effortLabel = computed(() => {
  const model = currentModel.value
  const level = effortLevel.value
  // Thinking turned off says nothing beside the name: the menu's own row says it, the pill shows only what is on.
  return model && level && level !== "none" ? t(effortLabelKey(model.id, model.name, level)) : ""
})

/*
 * A level chosen in a model's submenu: that model and that level. On the home
 * screen the model is the default the next task starts with; in a conversation
 * it is the conversation's. The level is MiMo's global one either way.
 */
async function chooseModelEffort(provider: string, model: string, level: Effort) {
  menu.value = undefined
  const before = app.modelPick(sessionID.value)
  if (!sessionID.value) {
    await app.patchConfig({ model: { provider, model }, smart: false, effort: level })
  } else {
    await app.setModel({ provider, model }, sessionID.value)
    await app.setEffort(level, sessionID.value)
  }
  app.announceModel(before, { provider, model })
}

/*
 * The session's agent, not the stored default: the turn runs as whatever the
 * session says, and an older session keeps the agent it was opened with. The
 * model pill beside this one reads the session for the same reason.
 */
const agent = computed(() => session.value?.agent ?? app.config?.agent ?? "build")

/* Models offered in the picker: every model of every connected provider, as MiMo lists them. */
const groups = computed(() =>
  app.providers
    .filter((provider) => provider.configured)
    .map((provider) => ({ provider, models: provider.models }))
    .filter((group) => group.models.length > 0),
)

const CONFIG_KEY = "action:config"
const MORE_KEY = "action:more"
const modelMenu = ref<HTMLElement>()
const moreMenu = ref<HTMLElement>()
const activeKey = ref("")

/*
 * Which row's submenu is open: a model's reasoning levels, or "more models".
 * One at a time, as in MiMo, following the pointer or the arrow keys. Inside
 * "more models" a second one holds that list's own row.
 */
const modelSub = ref<string>()
const moreSub = ref<string>()
const morePlace = ref({ left: 0, top: 0 })
/* Where the keyboard stands inside the open submenu, and inside that submenu's own. */
const subKey = ref<string>()
const sub2Key = ref<string>()

function modelKey(provider: string, model: string) {
  return `${provider}:${model}`
}

interface ModelRow {
  key: string
  provider: string
  model: ModelInfo
}

const rowsOf = (group: { provider: { id: string }; models: ModelInfo[] }): ModelRow[] =>
  group.models.map((model) => ({ key: modelKey(group.provider.id, model.id), provider: group.provider.id, model }))

/*
 * MiMo's split: its own models at the top level, everyone else's behind "more
 * models" in one flat list, and custom models below that - since 26.920 under
 * a small heading per provider, its name, rather than in one run. Here the
 * first connected built-in provider stands where MiMo's own models do.
 */
const builtinGroups = computed(() => groups.value.filter((group) => !group.provider.custom))
const primaryGroup = computed(() => builtinGroups.value[0])
const primaryRows = computed(() => (primaryGroup.value ? rowsOf(primaryGroup.value) : []))
const moreRows = computed(() => builtinGroups.value.slice(1).flatMap(rowsOf))
const customGroups = computed(() =>
  groups.value
    .filter((group) => group.provider.custom)
    .map((group) => ({ id: group.provider.id, name: group.provider.name || group.provider.id, rows: rowsOf(group) })),
)
const customRows = computed(() => customGroups.value.flatMap((group) => group.rows))

function closeModelSubs() {
  modelSub.value = undefined
  moreSub.value = undefined
  subKey.value = undefined
  sub2Key.value = undefined
}

watch(menu, closeModelSubs)

watch(modelSub, async (value) => {
  if (value !== MORE_KEY) return
  await nextTick()
  const row = modelMenu.value?.querySelector(`[data-key="${MORE_KEY}"]`)?.getBoundingClientRect()
  if (row && moreMenu.value) morePlace.value = besideRow(row, moreMenu.value.offsetWidth, moreMenu.value.offsetHeight)
})

/* The levels a row offers - on the home screen too, as MiMo's level is global. The side chat asks for none. */
function effortsFor(model: ModelInfo): Effort[] {
  return props.side ? [] : model.variants
}

/* The pointer moves the keyboard's highlight with it, and opens that row's submenu if it has one. */
function hoverRow(key: string) {
  activeKey.value = key
  if (modelSub.value === key) return
  closeModelSubs()
  modelSub.value = key
}

/* The pointer on a row inside "more models": its levels open, and the keyboard follows. */
function hoverMore(key: string) {
  moreSub.value = key
  subKey.value = key
  sub2Key.value = undefined
}

const EFFORT_PREFIX = "effort:"
const effortKey = (level: Effort) => `${EFFORT_PREFIX}${level}`
const levelOf = (key?: string): Effort | undefined =>
  key?.startsWith(EFFORT_PREFIX) ? (key.slice(EFFORT_PREFIX.length) as Effort) : undefined

const SMART_KEY = "action:smart"

const currentKey = computed(() => {
  if (smartOn.value) return SMART_KEY
  const chosen = app.shownModel(session.value?.model) ?? app.config?.model
  return chosen ? modelKey(chosen.provider, chosen.model) : ""
})

/**
 * Every top-level row the arrow keys walk, in the order they are drawn:
 * Smart, the first provider's models, "more models", custom models, and
 * configuring models.
 */
const modelKeys = computed(() => [
  SMART_KEY,
  ...primaryRows.value.map((row) => row.key),
  ...(moreRows.value.length ? [MORE_KEY] : []),
  ...customRows.value.map((row) => row.key),
  CONFIG_KEY,
])

const topRow = (key?: string) => [...primaryRows.value, ...customRows.value].find((row) => row.key === key)
const moreRow = (key?: string) => moreRows.value.find((row) => row.key === key)

/* The rows of the open submenu: "more models" lists models, a model lists its levels. */
function subItems(): string[] {
  if (modelSub.value === MORE_KEY) return moreRows.value.map((row) => row.key)
  const row = topRow(modelSub.value)
  return row ? effortsFor(row.model).map(effortKey) : []
}

/* The levels of the model open inside "more models". */
function sub2Items(): string[] {
  const row = moreRow(moreSub.value)
  return row ? effortsFor(row.model).map(effortKey) : []
}

function scrollActiveIntoView() {
  void nextTick(() => {
    for (const key of [activeKey.value, subKey.value]) {
      if (!key || levelOf(key)) continue
      modelMenu.value?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" })
    }
  })
}

function moveIn(depth: 0 | 1 | 2, key: RovingKey) {
  if (depth === 2) sub2Key.value = rovingStep(sub2Items(), sub2Key.value, key)
  else if (depth === 1) {
    subKey.value = rovingStep(subItems(), subKey.value, key)
    moreSub.value = undefined
    sub2Key.value = undefined
  } else {
    activeKey.value = rovingStep(modelKeys.value, activeKey.value, key) ?? activeKey.value
    closeModelSubs()
  }
  scrollActiveIntoView()
}

/*
 * MiMo's submenu trigger from the keyboard: opens the row's submenu and puts
 * the keyboard on its first row. False for a row with no submenu.
 */
function openSub(depth: 0 | 1): boolean {
  if (depth === 0) {
    const key = activeKey.value
    const row = topRow(key)
    if (!(key === MORE_KEY && moreRows.value.length) && !(row && effortsFor(row.model).length)) return false
    closeModelSubs()
    modelSub.value = key
    subKey.value = subItems()[0]
    return true
  }
  const row = modelSub.value === MORE_KEY ? moreRow(subKey.value) : undefined
  if (!row || !effortsFor(row.model).length) return false
  moreSub.value = row.key
  sub2Key.value = sub2Items()[0]
  return true
}

/* Enter or Space on a row with nothing behind it: that model, that level, or that action. */
function selectAt(depth: 0 | 1 | 2) {
  if (depth === 2) {
    const row = moreRow(moreSub.value)
    const level = levelOf(sub2Key.value)
    if (row && level) void chooseModelEffort(row.provider, row.model.id, level)
    return
  }
  if (depth === 1) {
    const more = modelSub.value === MORE_KEY ? moreRow(subKey.value) : undefined
    if (more) {
      void chooseModel(more.provider, more.model.id)
      return
    }
    const row = topRow(modelSub.value)
    const level = levelOf(subKey.value)
    if (row && level) void chooseModelEffort(row.provider, row.model.id, level)
    return
  }
  selectActive()
}

/* MiMo's "configure custom models": the models page of settings, not a dialog of its own. */
function openConfig() {
  menu.value = undefined
  emit("open-settings", "models")
}

function selectActive() {
  if (activeKey.value === CONFIG_KEY) {
    openConfig()
    return
  }
  if (activeKey.value === SMART_KEY) {
    void chooseSmart()
    return
  }
  const row = topRow(activeKey.value)
  if (row) void chooseModel(row.provider, row.model.id)
}

/*
 * The menu keeps these to itself. Escape has to stop here rather than reach the
 * window, where it would close the panel behind the menu as well.
 *
 * MiMo's list and submenu keys: Up, Down, Home and End walk the level the
 * keyboard is on; Right, Enter or Space on a row with a submenu opens it on its
 * first row, and Left goes back out; Enter or Space on any other row picks it.
 */
function onModelKeys(event: KeyboardEvent) {
  if (event.key === "Tab") return
  event.stopPropagation()
  if (event.key === "Escape") {
    event.preventDefault()
    menu.value = undefined
    focus()
    return
  }
  if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return
  const depth = sub2Key.value !== undefined ? 2 : subKey.value !== undefined ? 1 : 0
  if (isRovingKey(event.key)) {
    event.preventDefault()
    moveIn(depth, event.key)
  } else if (event.key === "ArrowRight") {
    event.preventDefault()
    if (depth < 2) openSub(depth === 0 ? 0 : 1)
  } else if (event.key === "ArrowLeft") {
    event.preventDefault()
    if (depth === 2) {
      moreSub.value = undefined
      sub2Key.value = undefined
    } else if (depth === 1) {
      modelSub.value = undefined
      subKey.value = undefined
    }
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    if (depth < 2 && openSub(depth === 0 ? 0 : 1)) return
    selectAt(depth)
  }
}

/**
 * Opens the model menu, wherever the request came from.
 *
 * There is no separate model dialog: the shortcut opens this menu on its pill,
 * which is the one place the app names the model, and having two surfaces for
 * it meant the keyboard and the pointer disagreed about what the picker was.
 */
function openModelMenu() {
  menu.value = "model"
  activeKey.value = modelKeys.value.includes(currentKey.value) ? currentKey.value : modelKeys.value[0]
  void nextTick(() => {
    modelMenu.value?.focus()
    scrollActiveIntoView()
  })
}

function toggle(which: "model" | "access" | "plus" | "context") {
  if (menu.value === which) {
    menu.value = undefined
    return
  }
  if (which === "model") {
    openModelMenu()
    return
  }
  menu.value = which
}

async function chooseAgent(next: (typeof AGENTS)[number]) {
  menu.value = undefined
  const before = app.modeOf(sessionID.value)
  // No session on the home screen, so the choice is the app's default - which
  // is what the task this box creates will start as.
  if (!sessionID.value) await app.patchConfig({ agent: next })
  else await app.setAgent(next)
  app.announceMode(before, sessionID.value)
}

async function chooseModel(provider: string, model: string) {
  menu.value = undefined
  const before = app.modelPick(sessionID.value)
  const chosen = findModel(app.providers, { provider, model })
  const variants = props.side ? [] : (chosen?.variants ?? [])
  /*
   * On the home screen there is no session to set it on, so the choice is the
   * app's default - which the next task created from here will start with, and
   * which every session already falls back to.
   *
   * MiMo snaps the level to one the new model takes (the same one, else medium,
   * else its first), so the level is written whenever the one in force is not
   * on offer.
   */
  if (!sessionID.value) {
    const effort = clampEffort(variants, app.config?.effort, chosen?.defaultEffort)
    await app.patchConfig({ model: { provider, model }, smart: false, ...(effort && effort !== app.config?.effort ? { effort } : {}) })
  } else {
    await app.setModel({ provider, model }, sessionID.value)
    const effort = clampEffort(variants, session.value?.effort ?? app.config?.effort, chosen?.defaultEffort)
    if (effort && effort !== session.value?.effort) await app.setEffort(effort, sessionID.value)
  }
  app.announceModel(before, { provider, model })
}

/* Smart: the model is picked from the conversation's first message. */
async function chooseSmart() {
  menu.value = undefined
  const before = app.modelPick(sessionID.value)
  if (!sessionID.value) await app.patchConfig({ smart: true })
  else await app.setSmart(sessionID.value)
  app.announceModel(before, "smart")
}

function onPointerDown(event: MouseEvent) {
  if (!pills.value?.contains(event.target as Node)) menu.value = undefined
}

/*
 * MiMo's composer menus are non-modal popovers, which close when focus moves
 * anywhere outside them and their chip. Their rows are not Tab stops, so Tab
 * leaves a menu in one step, and this closes it behind.
 */
function onMenuFocusOut(event: FocusEvent) {
  const next = event.relatedTarget
  if (next instanceof Node && !(event.currentTarget as HTMLElement).parentElement?.contains(next)) menu.value = undefined
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("dragend", endDrag)
  // A drag the system took over never sends `dragend`; the next press is when the app knows it is over.
  window.addEventListener("pointerdown", endDrag, true)
  document.addEventListener("dragover", onDragOver)
  document.addEventListener("dragleave", onDragLeave)
  document.addEventListener("drop", onDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("dragend", endDrag)
  window.removeEventListener("pointerdown", endDrag, true)
  document.removeEventListener("dragover", onDragOver)
  document.removeEventListener("dragleave", onDragLeave)
  document.removeEventListener("drop", onDrop)
})

/**
 * Puts the keyboard in the box, with the caret at the end of whatever is there.
 *
 * Chromium leaves the caret at position 0 when a textarea that already holds
 * text is focused for the first time, so a restored draft was typed into from
 * the front. MiMo puts it at the end in both places it focuses the box.
 */
function focus() {
  const box = input.value
  if (!box) return
  box.focus({ preventScroll: true })
  box.setSelectionRange(text.value.length, text.value.length)
  caret.value = text.value.length
}

/**
 * Replaces the whole prompt - words, chips and mentions - with another one.
 *
 * A replacement rather than an append, which is the difference between this and
 * `insert` below. The reference's `set` (main-8t-QUXax.js @2454253) assigns a
 * fresh prompt array over the old one and asks nothing first: there is no
 * confirm, no merge, and nothing reads whether a draft was in progress, so a
 * revert while half a sentence is typed destroys that sentence. That is copied
 * deliberately - the only rescue there is a failed request putting the previous
 * prompt back, and here the server has already answered by the time this runs.
 *
 * Nothing is focused, also on purpose: `prompt.set(value)` is called with no
 * cursor argument and no focus call, so the box fills in while the pointer is
 * still wherever it was on the button that filled it.
 */
function set(next: Draft) {
  text.value = next.text
  attachments.value = next.attachments
  mentioned.value = next.mentioned
  skills.value = []
  historyIndex.value = null
  /*
   * The caret is put at the end rather than left where the last draft had it:
   * the @ menu is a question about the characters in front of it, and a caret
   * still claiming to be halfway up a sentence that has been replaced would
   * have the menu answering about text that is no longer there.
   */
  caret.value = next.text.length
  void nextTick(resize)
}

/** Empties it, the way sending does - the reference's `prompt.reset()`. */
function reset() {
  text.value = ""
  attachments.value = []
  mentioned.value = new Set()
  skills.value = []
  historyIndex.value = null
  caret.value = 0
  void nextTick(resize)
}

/** Drops a fragment into the draft, so what was found elsewhere becomes prompt. */
function insert(fragment: string) {
  const draft = text.value
  const next = draft && !draft.endsWith(" ") ? `${draft} ${fragment}` : `${draft}${fragment}`
  text.value = next
  void nextTick(() => {
    resize()
    input.value?.focus()
    /*
     * The caret is put at the end rather than left wherever it was, because
     * the @ menu is a question about the characters in front of it: a caret
     * that still claims to be halfway up the old draft would have the menu
     * answering about text that has moved.
     */
    input.value?.setSelectionRange(next.length, next.length)
    caret.value = next.length
  })
}

defineExpose({ focus, insert, mention, openContext, openModelMenu, pick, reset, set, setMode, submit })
</script>

<template>
  <div class="composer" :class="{ noted: sessionID && !side, side }" :data-compacting="compactingHere || undefined">
    <div class="shell">
      <!--
        追求目标: the goal and how it is going, above the box, as MiMo puts it.
        One bar per conversation: a rewrite in progress, or an expanded goal,
        never follows the composer to the next conversation.
      -->
      <GoalBar v-if="!side && sessionID" :key="sessionID" :session-i-d="sessionID" />
      <!-- OpenCode v2's queued follow-ups, where the goal bar sits. -->
      <QueueBar v-if="sessionID" :key="`queue:${sessionID}`" :session-i-d="sessionID" @edit="restoreQueued" />
      <!-- MiMo's cue drawer: tucked behind the box's top edge, it slides up with the command a recording was heard as. -->
      <div class="voice-cues" :class="{ on: cueOn }" data-voice-cues>
        <div class="voice-drawer" role="status">
          <svg :key="cueRun" class="voice-check" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M8 12.4l2.7 2.7L16 9.4" />
          </svg>
          <span>{{ cueText }}</span>
        </div>
      </div>
      <div
        ref="boxEl"
        class="box"
        :class="{
          busy: busyHere,
          dropping: dragging,
          filled: attachments.length > 0,
          resized: manualHeight !== null && resizable !== false,
        }"
      >
        <!-- MiMo's handle along the top edge: drag to resize, double-click to reset. -->
        <div
          v-if="resizable !== false"
          class="resize-handle"
          data-resize-handle
          :title="t('composer.resizeHandle')"
          @pointerdown="startResize"
          @pointermove="moveResize"
          @pointerup="endResize"
          @pointercancel="endResize"
          @dblclick="resetResize"
        />
        <!-- MiMo's order above the text: attachments, then skill chips, then annotations. -->
        <div v-if="attachments.length" class="atts">
          <template v-for="(item, at) in attachments" :key="`${at}:${item.path}`">
            <!-- A picture or a video: a bare thumbnail that opens its preview. -->
            <div v-if="preview(item) || videoUrl(item)" class="att" data-attachment-tile>
              <img
                v-if="preview(item)"
                :src="preview(item)"
                class="att-thumb"
                alt=""
                role="button"
                tabindex="0"
                v-tip="{ label: t('stream.previewTip'), placement: 'top' }"
                @click="onTileClick(item, $event)"
                @keydown.enter.space.prevent="onTileClick(item, $event)"
              />
              <video
                v-else
                :src="videoUrl(item)"
                class="att-thumb"
                data-attachment-video
                muted
                playsinline
                preload="metadata"
                role="button"
                tabindex="0"
                v-tip="{ label: t('stream.previewTip'), placement: 'top' }"
                @click="onTileClick(item, $event)"
                @keydown.enter.space.prevent="onTileClick(item, $event)"
              />
              <button
                class="att-x"
                type="button"
                :aria-label="t('attach.remove')"
                v-tip="{ label: t('attach.remove'), placement: 'top' }"
                @click.stop="remove(at)"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
            </div>
            <!-- A file: a capsule with its type mark and name, the remove at its end. -->
            <div
              v-else
              class="att-file"
              :class="{ openable: Boolean(item.path) }"
              :role="item.path ? 'button' : undefined"
              :tabindex="item.path ? 0 : undefined"
              data-attachment-tile
              @click="onTileClick(item, $event)"
              @keydown.enter.space.self.prevent="onTileClick(item, $event)"
            >
              <!-- The tree's file-page glyph in the tree's colours, so one file reads the same way in both places. -->
              <svg
                class="att-ic"
                :class="`cat-${fileCategory(fileName(item.path))}`"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M13 2v7h7" />
              </svg>
              <span class="att-name">{{ fileName(item.path) }}</span>
              <button
                class="att-x inline"
                type="button"
                :aria-label="t('attach.remove')"
                v-tip="{ label: t('attach.remove'), placement: 'top' }"
                @click.stop="remove(at)"
              >
                ✕
              </button>
            </div>
          </template>
        </div>
        <div v-if="skills.length" class="skill-chips">
          <span v-for="name in skills" :key="name" class="cchip" :class="{ leaving: leavingSkill === name }" :data-skill="name">
            <span class="cchip-ic" aria-hidden="true">
              <svg viewBox="0 0 12 12" fill="none"><path d="M6.2 2.5h2.3a1 1 0 0 1 1 1v1.2a1.3 1.3 0 1 1 0 2.6v1.2a1 1 0 0 1-1 1H7.3a1.3 1.3 0 1 0-2.6 0H3.5a1 1 0 0 1-1-1V7.3a1.3 1.3 0 1 0 0-2.6V3.5a1 1 0 0 1 1-1z" /></svg>
            </span>
            <span class="cchip-name">{{ skillChipName(name) }}</span>
            <button
              class="cchip-rm"
              type="button"
              :aria-label="t('attach.remove')"
              v-tip="{ label: t('attach.remove'), placement: 'top' }"
              @click="removeSkill(name)"
            >
              ✕
            </button>
          </span>
        </div>
        <AnnotationChips v-if="annotationScope && waiting.length" class="box-annotations" :list="waiting" :scope="annotationScope" />
        <!--
          The menus, just above the box and moving with it. Only one is up at a
          time: the @ wins, because it is about the word the caret is in.
        -->
        <div v-if="atOpen" class="slash at-menu" data-at-menu :style="{ maxHeight: `${menuRoom}px` }">
          <div v-if="!projectRoot" class="at-note">{{ t("composer.at.pickProject") }}</div>
          <template v-else>
            <!-- MiMo's head: a breadcrumb that climbs out while browsing a folder, else what the list is. -->
            <button v-if="atSub && !atSpan?.query" class="at-crumb" type="button" data-at-crumb @mousedown.prevent="folderUp">
              ‹ {{ atCrumbs }}
            </button>
            <div v-else-if="atSpan?.query && atSub" class="slash-head">{{ t("composer.at.searchLabel", { path: atCrumbs }) }}</div>
            <div v-else-if="atSpan?.query" class="slash-head">{{ t("composer.at.searchFiles") }}</div>
            <div v-else class="slash-head">{{ t("composer.at.filesGroup") }}</div>
            <div v-if="atStatus === 'searchFailed'" class="at-note">{{ t("composer.at.searchFailed") }}</div>
            <div v-else-if="atStatus === 'dirFailed'" class="at-note">{{ t("composer.at.cannotReadDir") }}</div>
            <div v-else-if="atStatus === 'loading' && !atRows.length" class="at-note">{{ t("composer.at.loading") }}</div>
            <div
              v-for="(row, at) in atRows"
              :key="row.rel"
              class="slash-row at-row"
              :class="{ on: at === atIndex }"
              role="option"
              :aria-selected="at === atIndex"
              :data-kind="row.kind"
              :data-rel="row.rel"
              @mouseenter="atIndex = at"
              @mousedown.prevent="chooseAt(at)"
            >
              <svg class="at-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path v-if="row.kind === 'dir'" d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
                <template v-else>
                  <path d="M9.2 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.3z" />
                  <path d="M9.2 2v3.3h3.3" />
                </template>
              </svg>
              <span class="at-name">{{ row.name }}</span>
              <span v-if="row.dir" class="at-sub">{{ row.dir }}</span>
              <span v-if="row.kind === 'dir'" class="at-actions">
                <button class="at-ref" type="button" data-at-ref @mousedown.prevent.stop="referenceFolder(row.rel)">
                  {{ t("composer.at.refFolder") }}
                </button>
                <!-- Not a button: the whole row already opens the folder, and MiMo draws this as a plain mark. -->
                <span class="at-enter" aria-hidden="true">›</span>
              </span>
            </div>
            <!-- MiMo's last line when there was more than the search would show. -->
            <div v-if="atTruncated && atSearching" class="at-note">{{ t("composer.at.truncated", { count: atRows.length }) }}</div>
          </template>
        </div>

        <div v-else-if="slashOpen" class="slash" :style="{ maxHeight: `${menuRoom}px` }">
          <div class="slash-head">{{ t("composer.commands") }}</div>
          <!-- Nothing matching is a line of its own, not an absent menu, so a name typed wrong says so. -->
          <!-- MiMo's order: a failed load, then a load under way, then a list with nothing in it. -->
          <div v-if="!slashMatches.length" class="slash-empty" :data-slash-state="app.commandsState">
            {{
              app.commandsState === "failed"
                ? t("composer.slashFailed")
                : app.commandsState === "loading"
                  ? t("composer.slashLoading")
                  : t("composer.slashEmpty")
            }}
          </div>
          <!-- MiMo's row: the /name chip, what it does, and where it came from at the far end. -->
          <button
            v-for="(command, at) in slashMatches"
            :key="command.id"
            class="slash-row command"
            :class="{ on: at === slashIndex }"
            @mouseenter="slashIndex = at"
            @mousedown.prevent="runSlash(at)"
          >
            <span class="slash-chip">/{{ command.trigger }}</span>
            <span v-if="command.description" class="slash-desc">{{ command.description }}</span>
            <span v-if="command.badge" class="slash-badge">{{ command.badge }}</span>
          </button>
        </div>

        <!-- MiMo's highlight behind a known /command, under the text. -->
        <SlashPill v-if="mode !== 'shell'" :input="input" :text="text" :known="slashNames" />
        <textarea
          ref="input"
          v-model="text"
          class="input"
          rows="1"
          spellcheck="false"
          :placeholder="placeholder"
          :disabled="compactingHere || restrictedHere"
          :aria-busy="compactingHere || undefined"
          @keydown="onKeydown"
          @blur="onInputBlur"
          @keyup="syncCaret"
          @click="onBoxClick"
          @select="syncCaret"
          @input="syncCaret"
          @paste="onPaste"
        />

        <!--
          Attachments, agent, model and effort sit on one bar inside the box,
          which is where the new design puts them - the controls belong to the
          message being written, not to the page around it.
        -->
        <!--
          Shell mode changes what Enter does, so it says so on the box rather
          than only in the placeholder, which vanishes as soon as one types.
        -->
        <div v-if="mode === 'shell'" class="mode-note">
          <span class="mode-tag">{{ t("composer.shellMode") }}</span>
          <span class="mode-exit">{{ t("composer.shellExit") }}</span>
        </div>

        <div ref="pills" class="row" :class="{ collapsed: labelsCollapsed, narrow: barNarrow }">
          <div ref="rowStart" class="row-start">
          <input ref="picker" class="picker" type="file" multiple @change="onPicked" />
          <!--
            MiMo's plus: a round button whose menu opens underneath it - files,
            the terminal, compose mode, and the skills behind a submenu. The
            class stays "attach" so the side column's narrow rules still find it.
          -->
          <div class="pill-wrap plus-wrap">
            <button
              class="attach"
              type="button"
              :class="{ open: menu === 'plus' }"
              :aria-expanded="menu === 'plus'"
              :aria-label="t('composer.plusTip')"
              v-tip="{ label: t('composer.plusTip'), disabled: menu === 'plus' }"
              @click="toggle('plus')"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
            </button>
            <div v-if="menu === 'plus'" ref="plusMenu" class="menu plus-menu" :class="{ up: menuUp }" role="menu" data-plus-menu @keydown="onPlusKeys" @focusout="onMenuFocusOut">
              <button class="item" role="menuitem" tabindex="-1" data-plus-files @click="attachFromMenu">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10.6 5.2 6 9.8a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5.2 5.2a4.2 4.2 0 0 0 6 6l4.2-4.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                </svg>
                <span class="item-name">{{ t("composer.addFiles") }}</span>
              </button>
              <template v-if="!side">
                <div class="rule" />
                <button class="item" role="menuitem" tabindex="-1" data-plus-terminal @click="terminalFromMenu">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" stroke="currentColor" stroke-width="1.2" />
                    <path d="M4.6 6.4 6.8 8.4 4.6 10.4M8.6 10.6h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                  </svg>
                  <span class="item-name">{{ t("composer.menuTerminal") }}</span>
                </button>
                <div class="rule" />
                <!-- 追求目标: a switch, not a command - what is typed next becomes the goal and the turn is judged against it. -->
                <button class="item goal-row" role="switch" tabindex="-1" data-mode="goal" :aria-checked="goalMode" @click="toggleGoalMode">
                  <span class="goal-text">
                    <span class="item-name">{{ t("composer.goal") }}</span>
                    <span class="goal-sub">{{ t("composer.goalSub") }}</span>
                  </span>
                  <span class="goal-switch" :class="{ on: goalMode }"><span class="goal-knob" /></span>
                </button>
              </template>
              <div class="rule" />
              <!-- MiMo's 技能 ›: a submenu with a search box, beside the row. -->
              <button
                class="item skill-row"
                :class="{ hot: skillSubOpen }"
                role="menuitem"
                tabindex="-1"
                aria-haspopup="menu"
                :aria-expanded="skillSubOpen"
                data-plus-skills
                @mouseenter="openSkillMenu"
                @click="openSkillMenu"
              >
                <svg class="skill-mark" width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6.2 2.5h2.3a1 1 0 0 1 1 1v1.2a1.3 1.3 0 1 1 0 2.6v1.2a1 1 0 0 1-1 1H7.3a1.3 1.3 0 1 0-2.6 0H3.5a1 1 0 0 1-1-1V7.3a1.3 1.3 0 1 0 0-2.6V3.5a1 1 0 0 1 1-1z" /></svg>
                <span class="item-name">{{ t("composer.menuSkills") }}</span>
                <svg class="item-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6.5 4.5 10 8l-3.5 3.5" />
                </svg>
              </button>
              <div
                v-if="skillSubOpen"
                ref="skillMenu"
                class="skill-menu"
                role="menu"
                data-skill-menu
                :style="{ left: `${skillPlace.left}px`, top: `${skillPlace.top}px` }"
              >
                <input
                  v-model="skillQuery"
                  class="skill-search"
                  type="text"
                  spellcheck="false"
                  :placeholder="t('composer.skillSearch')"
                  @keydown.enter="!composing($event) && pickFirstSkill($event)"
                />
                <div class="skill-list">
                  <div v-if="!hasSkills" class="skill-empty">{{ t("composer.skillEmpty") }}</div>
                  <div v-else-if="!skillRows.length" class="skill-empty">{{ t("composer.skillNoMatch") }}</div>
                  <button
                    v-for="skill in skillRows"
                    :key="skill.name"
                    class="item skill-item"
                    role="menuitem"
                    tabindex="-1"
                    :title="skill.description || skill.name"
                    @click="addSkill(skill.name)"
                  >
                    <svg class="skill-mark" width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6.2 2.5h2.3a1 1 0 0 1 1 1v1.2a1.3 1.3 0 1 1 0 2.6v1.2a1 1 0 0 1-1 1H7.3a1.3 1.3 0 1 0-2.6 0H3.5a1 1 0 0 1-1-1V7.3a1.3 1.3 0 1 0 0-2.6V3.5a1 1 0 0 1 1-1z" /></svg>
                    <span class="item-name">{{ skill.name }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!--
            The permission map in one control: every bucket that asks turned to
            allow, or put back to its default. Deny is left alone either way - it
            is a deliberate "never", and a shortcut has no business undoing it.
          -->
          <!-- A side chat asks nothing about access, agents or effort: it is the model and the words. -->
          <div v-if="!side" class="pill-wrap">
            <button
              class="pill access"
              :class="{ open: menu === 'access', full: access === 'full' }"
              v-tip="{ label: t('composer.accessTip'), disabled: menu === 'access' }"
              @click="toggle('access')"
            >
              <svg
                class="access-icon"
                :width="ACCESS_ICONS[access].box"
                :height="ACCESS_ICONS[access].box"
                :viewBox="`0 0 ${ACCESS_ICONS[access].box} ${ACCESS_ICONS[access].box}`"
                :stroke-width="ACCESS_ICONS[access].stroke"
                :data-access-icon="access"
                fill="none"
                aria-hidden="true"
              >
                <path v-for="d in ACCESS_ICONS[access].paths" :key="d" :d="d" />
              </svg>
              <span class="perm-label">{{ t(`composer.access.${access}`) }}</span>
              <svg class="caret" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
            <!--
              MiMo's menu: icon, name, and a check at the far end of the chosen
              row. What each level does is on hover, beside the row, rather than
              under every name.
            -->
            <div
              v-if="menu === 'access'"
              ref="accessMenu"
              class="menu access-menu"
              :class="{ up: menuUp }"
              tabindex="-1"
              @keydown="onAccessKeys"
              @focusout="onMenuFocusOut"
            >
              <button
                tabindex="-1"
                v-for="entry in accessChoices"
                :key="entry"
                v-tip="{ label: t(`composer.access.${entry}Hint`), placement: 'right', trigger: 'hover' }"
                class="item access-item"
                :class="{ on: entry === access, hot: entry === accessHot }"
                :data-access="entry"
                @mouseenter="accessHot = entry"
                @click="chooseAccess(entry)"
              >
                <svg
                  class="access-icon"
                  :viewBox="`0 0 ${ACCESS_ICONS[entry].box} ${ACCESS_ICONS[entry].box}`"
                  :stroke-width="ACCESS_ICONS[entry].stroke"
                  fill="none"
                  aria-hidden="true"
                >
                  <path v-for="d in ACCESS_ICONS[entry].paths" :key="d" :d="d" />
                </svg>
                <span class="item-name">{{ t(entry === "full" ? "composer.access.fullItem" : `composer.access.${entry}`) }}</span>
                <svg class="access-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 8.2 6.4 11.1 12.5 5" />
                </svg>
              </button>
            </div>
          </div>

          <!-- MiMo's one mode chip: shown while plan mode is on; pressing it goes back to build. -->
          <button
            v-if="!side && agent === 'plan'"
            class="mode-chip"
            data-mode="plan"
            v-tip="{ label: t('composer.modeChipTip', { mode: t('composer.planMode') }) }"
            @click="chooseAgent('build')"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5.5 2.5h5v2h-5z" />
              <path d="M5 3.5H3.5v10h9v-10H11" />
              <path d="M5.5 8h5M5.5 10.5h3.5" />
            </svg>
            <span class="mode-label">{{ t("composer.planChip") }}</span>
          </button>
          <!-- 追求目标: its own chip beside the mode's, since the two are not alternatives; pressing it turns the switch off. -->
          <button
            v-if="!side && goalMode"
            class="mode-chip"
            data-mode="goal"
            v-tip="{ label: t('composer.goalChipTip') }"
            @click="toggleGoalMode"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5.4" />
              <circle cx="8" cy="8" r="2.6" />
              <circle cx="8" cy="8" r="0.6" fill="currentColor" stroke="none" />
            </svg>
            <span class="mode-label">{{ t("composer.goalChip") }}</span>
          </button>
          </div>

          <div ref="rowEnd" class="row-end">

          <!--
            The context ring, left of the model the way the reference has it.
            Resting on it shows the figures; pressing it keeps them up until
            the next press or a click elsewhere. The slot is always present so
            the model pill's position in the row does not depend on whether
            there is a ring - the side chat's narrow rules find the pill by it.
          -->
          <span class="ctx-slot">
            <button
              v-if="contextUsage"
              class="ctx"
              :class="{ open: menu === 'context' }"
              :aria-label="t('context.usage.view')"
              :aria-expanded="menu === 'context'"
              v-tip="contextUsage && { card: { title: t('composer.ctxTitle'), lines: [contextUsage.shareLine, contextUsage.tokensLine, contextUsage.cacheLine] }, pinned: menu === 'context' }"
              @click="toggle('context')"
            >
              <ContextRing :percent="contextUsage.percent" :size="18" :stroke="2.4" />
            </button>
          </span>

          <div class="pill-wrap">
            <button
              class="pill model-pill"
              :aria-expanded="menu === 'model'"
              v-tip="{ label: t('composer.modelTip'), disabled: menu === 'model' }"
              @click="toggle('model')"
            >
              <span class="model-label">{{ modelName }}</span>
              <!-- MiMo's 「Claude Opus · 高」: on the home screen too, since the level is the next task's as well. -->
              <span v-if="!smartOn && !side && effortLabel" class="model-effort" data-model-effort>{{ effortLabel }}</span>
              <svg class="caret" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>

            <!--
              MiMo's model menu: below the chip and aligned to its end. Smart,
              the first provider's models, everyone else's behind "more models",
              and the way to set up custom ones. A model with reasoning levels
              opens them beside its row, and the level in use rides on the chip.
            -->
            <div
              v-if="menu === 'model'"
              ref="modelMenu"
              class="menu model-menu"
              :class="{ up: menuUp }"
              tabindex="-1"
              @keydown="onModelKeys"
              @focusout="onMenuFocusOut"
            >
              <button
                tabindex="-1"
                class="item model-item smart"
                :class="{ hot: activeKey === SMART_KEY, on: smartOn }"
                :data-key="SMART_KEY"
                @mouseenter="hoverRow(SMART_KEY)"
                @click="chooseSmart()"
              >
                <span class="smart-mark" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1.6 8.4 5.6 12.4 7 8.4 8.4 7 12.4 5.6 8.4 1.6 7 5.6 5.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
                  </svg>
                </span>
                <span class="smart-text">
                  <span class="item-name">{{ t("model.smart") }}</span>
                  <span class="item-desc">{{ t("model.smartDesc") }}</span>
                </span>
                <svg class="model-check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 8.2 6.4 11.1 12.5 5" />
                </svg>
              </button>

              <!-- MiMo draws the rule under Smart only when models follow it; with none, one line says so. -->
              <div v-if="groups.length" class="rule" />
              <div v-else class="model-empty" data-model-empty>
                {{ app.providers.some((p) => p.configured) ? t("model.none") : t("model.needProvider") }}
              </div>

              <ModelMenuRow
                v-for="row in primaryRows"
                :key="row.key"
                :model="row.model"
                :row-key="row.key"
                :on="currentKey === row.key"
                :hot="activeKey === row.key"
                :efforts="effortsFor(row.model)"
                :effort="effortLevel"
                :sub-open="modelSub === row.key"
                :effort-hot="modelSub === row.key ? levelOf(subKey) : undefined"
                @enter="hoverRow(row.key)"
                @choose="chooseModel(row.provider, row.model.id)"
                @effort="chooseModelEffort(row.provider, row.model.id, $event)"
                @effort-hover="subKey = effortKey($event)"
              />

              <div v-if="moreRows.length" class="more-slot" @mouseenter="hoverRow(MORE_KEY)">
                <button
                  tabindex="-1"
                  class="item model-item"
                  :class="{ hot: activeKey === MORE_KEY }"
                  :data-key="MORE_KEY"
                  aria-haspopup="menu"
                  :aria-expanded="modelSub === MORE_KEY"
                  @click="modelSub === MORE_KEY ? closeModelSubs() : hoverRow(MORE_KEY)"
                >
                  <span class="item-name">{{ t("model.moreModels") }}</span>
                  <svg class="model-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M6.5 4.5 10 8l-3.5 3.5" />
                  </svg>
                </button>
                <!-- The glass is on the outer box and the scrolling on the inner, so a row's levels are not clipped. -->
                <div
                  v-if="modelSub === MORE_KEY"
                  ref="moreMenu"
                  class="more-menu"
                  role="menu"
                  data-more-menu
                  :style="{ left: `${morePlace.left}px`, top: `${morePlace.top}px` }"
                >
                  <div class="more-scroll" @scroll="moreSub = undefined">
                    <ModelMenuRow
                      v-for="row in moreRows"
                      :key="row.key"
                      :model="row.model"
                      :row-key="row.key"
                      :on="currentKey === row.key"
                      :hot="subKey === row.key"
                      :efforts="effortsFor(row.model)"
                      :effort="effortLevel"
                      :sub-open="moreSub === row.key"
                      :effort-hot="moreSub === row.key ? levelOf(sub2Key) : undefined"
                      @enter="hoverMore(row.key)"
                      @choose="chooseModel(row.provider, row.model.id)"
                      @effort="chooseModelEffort(row.provider, row.model.id, $event)"
                      @effort-hover="sub2Key = effortKey($event)"
                    />
                  </div>
                </div>
              </div>

              <!-- MiMo's custom models: after a rule, each provider's under its own name. The headings are not rows: the keys walk past them. -->
              <template v-if="customRows.length">
                <div class="rule" />
                <div v-for="group in customGroups" :key="group.id" class="provider-group" :data-model-provider="group.id">
                  <div class="provider-head" :data-model-provider-head="group.id">{{ group.name }}</div>
                  <ModelMenuRow
                    v-for="row in group.rows"
                    :key="row.key"
                    data-custom-model
                    :model="row.model"
                    :row-key="row.key"
                    :on="currentKey === row.key"
                    :hot="activeKey === row.key"
                    :efforts="effortsFor(row.model)"
                    :effort="effortLevel"
                    :sub-open="modelSub === row.key"
                    :effort-hot="modelSub === row.key ? levelOf(subKey) : undefined"
                    @enter="hoverRow(row.key)"
                    @choose="chooseModel(row.provider, row.model.id)"
                    @effort="chooseModelEffort(row.provider, row.model.id, $event)"
                    @effort-hover="subKey = effortKey($event)"
                  />
                </div>
              </template>

              <div class="rule" />
              <button
                tabindex="-1"
                class="item model-item"
                :class="{ hot: activeKey === CONFIG_KEY }"
                :data-key="CONFIG_KEY"
                @mouseenter="hoverRow(CONFIG_KEY)"
                @click="openConfig()"
              >
                <svg class="model-config" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2 5h3.2M8.8 5H14M2 11h6.2M11.8 11H14" />
                  <circle cx="7" cy="5" r="1.7" />
                  <circle cx="10" cy="11" r="1.7" />
                </svg>
                <span class="item-name">{{ t("model.configCustom") }}</span>
              </button>
            </div>
          </div>

          <!--
            MiMo's voice capsule. Idle it is a round microphone; pressed it widens
            into a pill that says what it is doing - starting, listening with a
            live waveform, or writing down what it heard - with a × that throws the
            recording away. Drawn even with no transcription model set, and says
            so when pressed.
          -->
          <button
            class="mic"
            type="button"
            :class="{ on: voice !== 'idle', proc: voice === 'working', starting: voice === 'starting' }"
            :aria-label="voice === 'idle' ? t('voice.input') : t('voice.stopInput')"
            :aria-pressed="voice === 'recording'"
            v-tip="{ label: voice === 'idle' ? t('voice.input') : t('voice.stopInput') }"
            @mousedown.prevent
            @click="toggleVoice"
          >
            <span v-if="voice === 'recording'" class="mic-live">
              <span class="voice-wave" aria-hidden="true">
                <i v-for="(height, bar) in waveHeights" :key="bar" :style="{ height }" />
              </span>
              <span class="voice-label" data-voice-status>{{ voiceLabel }}</span>
              <span
                class="mic-x"
                role="button"
                tabindex="0"
                :aria-label="t('voice.cancel')"
                :title="t('voice.cancel')"
                @mousedown.prevent.stop
                @click.stop="cancelVoice"
                @keydown.enter.stop.prevent="cancelVoice"
                @keydown.space.stop.prevent="cancelVoice"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </span>
            </span>
            <span v-else-if="voice === 'working'" class="mic-live">
              <span class="mic-spinner" aria-hidden="true" />
              <span class="voice-label" data-voice-status>{{ voiceLabel }}</span>
              <span
                class="mic-x"
                role="button"
                tabindex="0"
                :aria-label="t('voice.cancel')"
                :title="t('voice.cancel')"
                @mousedown.prevent.stop
                @click.stop="cancelVoice"
                @keydown.enter.stop.prevent="cancelVoice"
                @keydown.space.stop.prevent="cancelVoice"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </span>
            </span>
            <span v-else-if="voice === 'starting'" class="mic-live">
              <span class="mic-spinner" aria-hidden="true" />
              <span class="voice-label" data-voice-status>{{ voiceLabel }}</span>
            </span>
            <!-- MiMo's microphone, filled: a capsule ring over an open cradle, no stand. -->
            <svg v-else width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                fill="currentColor"
                fill-rule="evenodd"
                d="M9 1.56a3.54 3.54 0 0 1 3.54 3.54v4.25a3.54 3.54 0 0 1-7.08 0V5.1A3.54 3.54 0 0 1 9 1.56zm0 1.42a2.13 2.13 0 0 0-2.13 2.12v4.25a2.13 2.13 0 0 0 4.25 0V5.1A2.13 2.13 0 0 0 9 2.98zM2.05 10.74a7.09 7.09 0 0 0 13.9 0l-1.39-.28a5.67 5.67 0 0 1-11.12 0z"
              />
            </svg>
          </button>

          <!-- OpenCode v2's 排队: while a turn runs and there is something to send, wait for the turn to end instead of joining it. -->
          <button
            v-if="!compactingHere && !(resumable && mode !== 'shell') && busyHere && hasContent && mode !== 'shell'"
            class="queue-send"
            type="button"
            data-queue-button
            :disabled="restrictedHere"
            :aria-label="t('composer.queue.button')"
            v-tip="{ label: t('composer.queue.button'), hint: sendChord.toLowerCase() === 'alt+enter' ? undefined : 'Alt+Enter', placement: 'top' }"
            @click="submit('queue')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2" />
              <path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <!--
            MiMo's one button: a spinner while the conversation is compacted,
            stop while a turn runs with nothing waiting, 继续 when the last turn
            broke off and the box is empty, and send otherwise. Send is never
            disabled for an empty box; pressing it says the box is empty.
          -->
          <button
            v-if="compactingHere"
            class="send"
            type="button"
            disabled
            :aria-label="t('composer.compact.starting')"
            v-tip="{ label: t('composer.compact.starting'), placement: 'top' }"
          >
            <span class="send-spinner" aria-hidden="true" />
          </button>
          <button
            v-else-if="resumable && mode !== 'shell'"
            id="resume-turn-btn"
            class="send ready"
            type="button"
            :aria-label="t('composer.resume')"
            v-tip="{ label: t('composer.resume'), placement: 'top' }"
            @click="resumeTurn"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M7 4.8v10.4a.8.8 0 0 0 1.2.7l8.2-5.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z" fill="currentColor" />
            </svg>
          </button>
          <button
            v-else
            class="send"
            type="button"
            :class="{ empty: !stopping && !hasContent, ready: !stopping && hasContent, stop: stopping }"
            :disabled="restrictedHere"
            :aria-label="stopping ? t('composer.stop') : t('composer.send')"
            v-tip="{ label: stopping ? t('composer.stop') : t('composer.send') }"
            @click="stopping ? app.abort(sessionID) : submit()"
          >
            <svg v-if="stopping" width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
              <rect width="9" height="9" rx="1.5" fill="currentColor" />
            </svg>
            <svg
              v-else-if="mode === 'shell'"
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4.08333 11.0859L1.75 8.7526L4.08333 6.41927M2.33333 8.7526L12.5417 8.7526L12.5417 3.21094L7 3.21094"
                stroke="currentColor"
                stroke-width="1"
                stroke-linecap="square"
              />
            </svg>
            <!-- MiMo's send mark: a stroked up-arrow, a shaft with a chevron on it, 10.5 tall at 18px. -->
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 19V5m-7 7 7-7 7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          </div>
        </div>
      </div>
    </div>

    <!--
      Under a conversation's box, as MiMo has one: answers are generated and can
      be wrong. Its room is kept, hidden, until the conversation has a reply.
    -->
    <p v-if="sessionID && !side" class="ai-note" :class="{ hidden: !hasReply }" :aria-hidden="!hasReply || undefined">
      {{ t("composer.aiNote") }}
    </p>

    <Teleport to="body">
      <!-- DL19: MiMo's own full-access confirm. -->
      <FullAccessDialog v-if="confirmingFull" @confirm="confirmFull" @close="confirmingFull = false" />
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * The @ and slash menus float over the conversation just above the box, as
 * MiMo's do: 8 in from either side and 6 clear of its top edge, on a 12px
 * corner. The box is what they are placed against, so they move with them.
 *
 * These two are the one pair MiMo does not draw with its popover shell. They
 * carry its own `.menu` class - a full pixel of --color-line over --color-bg
 * under --shadow-menu - and that rule is written after `.menu-glass` in its
 * stylesheet, so the frosted fill loses and only the blur behind it survives,
 * which an opaque fill hides. Kept here so the pair matches value for value.
 */
.box {
  position: relative;
}

.slash {
  position: absolute;
  inset: auto 8px calc(100% + 6px);
  z-index: 40;
  display: flex;
  flex-direction: column;
  max-height: 320px;
  padding: 5px;
  overflow-y: auto;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-menu);
  backdrop-filter: blur(18px) saturate(150%);
}

.slash-head {
  padding: 4px 10px 2px;
  color: var(--text-weaker);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 400;
  letter-spacing: 0.02em;
}

.slash-row {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 6px;
  text-align: start;
  border-radius: 5px;
}

/* A command row: chip, sentence, badge, 9 apart on an 8px corner. */
.slash-row.command {
  justify-content: flex-start;
  gap: 9px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.slash-chip {
  flex: none;
  padding: 1.5px 7px;
  color: var(--text-base);
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
  border-radius: 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 500;
  white-space: nowrap;
}

.slash-row.on {
  background: var(--surface-hover);
}

/* MiMo's @ rows: a 16px mark, the name, where it lives, and a folder's two actions at the end. */
.slash-row.at-row {
  justify-content: flex-start;
  gap: 9px;
  padding: 7px 10px;
  color: var(--text-strong);
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  cursor: default;
}

.at-icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--text-weak);
}

.at-icon path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* The name is kept whole and the folder behind it gives way, as MiMo cuts a search row. */
.at-name {
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.at-sub {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.at-actions {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  margin-inline-start: auto;
}

/* MiMo's capsule: no fill of its own until the pointer is on it. */
.at-ref {
  padding: 2px 6px;
  color: var(--text-weak);
  background: none;
  border: 0;
  border-radius: 6px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  cursor: pointer;
}

.at-ref:hover {
  color: var(--text-strong);
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
}

/* A mark, not a control: the row itself opens the folder. */
.at-enter {
  display: grid;
  place-items: center;
  width: calc(20px * var(--ui-font-scale, 1));
  height: calc(20px * var(--ui-font-scale, 1));
  color: var(--text-weak);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

/* The breadcrumb head: dim, and the text colour under the pointer. */
.at-crumb {
  align-self: flex-start;
  padding: 4px 10px 2px;
  color: var(--text-weaker);
  background: none;
  border: 0;
  font-size: calc(11px * var(--ui-font-scale, 1));
  letter-spacing: 0.02em;
  text-align: start;
  cursor: pointer;
}

.at-crumb:hover {
  color: var(--text-strong);
}

.at-note {
  padding: 7px 10px;
  color: var(--text-weaker);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

/*
 * What the reference says when a slash names nothing. Sized and coloured like
 * the header above it rather than like a row, because it cannot be chosen.
 */
.slash-empty {
  padding: 5px 6px;
  color: var(--text-weaker);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

/*
 * The one line a command carries about itself. It gives way to the chip it
 * belongs to - a description can be a sentence, and it must never push the
 * word that runs the command off the row.
 */
.slash-desc {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Where the command came from, at the far end in the chip's own tint. */
.slash-badge {
  flex: none;
  margin-inline-start: auto;
  padding: 1px 6px;
  color: var(--text-base);
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
  border-radius: 5px;
  font-size: calc(11px * var(--ui-font-scale, 1));
}

.composer {
  /*
   * Never squeezed. The transcript above takes a flex basis of zero, so every
   * pixel a short window is short by came out of this box instead of out of
   * the scroller that can absorb it.
   */
  flex-shrink: 0;
  /*
   * The top gap is the point: the transcript is clipped exactly at this box's
   * edge, so without it any line the scroll happens to stop on ends up pressed
   * against the input. Padding on the scroller alone only helps at the very end
   * of the conversation. The foot is not a mirror of it: that one belongs to
   * the dock region as a whole rather than to the seam above this box, and an
   * inset that only has to hold the window edge off wants less than one that
   * has to keep two things apart.
   */
  padding: 18px 24px 12px;
  /* The workspace plane runs behind the dock unbroken; only the box is lifted. */
  background: var(--surface-raised);
}

/*
 * With a permission dock overhead there is nothing left to stand off: the dock
 * is already between the transcript and this box, and the reference stacks the
 * two flush so the pair reads as one region rather than as two loose cards.
 */
.perm + .composer {
  padding-top: 0;
}

/*
 * Inside the hero the padding has nothing to do.
 *
 * It exists to hold this box off the transcript above and the window below;
 * in an empty session there is no transcript, and the column it sits in owns
 * the spacing - 32 above and 32 below, which is what opencode measures. Left
 * in, it added to that gap instead of being replaced by it. Without it the box
 * is 104 tall, which is the reference's number exactly.
 */
#hero-dock .composer,
.home-hero .composer {
  padding: 0;
}

.shell {
  margin: 0 auto;
}

/*
 * The same fill as the workspace behind it, lifted by a shadow rather than
 * outlined by a border - which is what keeps the box from reading as a second
 * panel stacked on the first.
 */
.box {
  display: flex;
  flex-direction: column;
  /* No padding of its own - the writing area and the bar below each carry
     their own insets, which is how the reference reaches 96px at rest. */
  padding: 0;
  background: var(--surface-raised);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
  transition: box-shadow 0.12s;
}

.input {
  /*
   * Taller than the one line it starts with, so an empty composer reads as
   * somewhere to write. Held here rather than in the box's padding, which would
   * put half the room above the first line and centre the text in the box.
   */
  min-height: 60px;
  /* MiMo's cap while the box fits its text; a set height has its own, below. */
  max-height: 200px;
  padding: 16px 16px 8px;
  color: var(--text-strong);
  resize: none;
  outline: none;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
}

.input::placeholder {
  color: var(--text-weaker);
}

/* The bar the controls sit on, inside the box. */
.row {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 44px;
  padding: 0 8px;
}

.picker {
  display: none;
}

/*
 * A dropped file has to look like it will land somewhere: MiMo's 2px ring of
 * the accent at 35%, and the edge in the accent with it. The card's own shadow
 * is written back into the same declaration, which otherwise replaces it and
 * flattens the box against the page for as long as the drag lasts.
 */
.box.dropping {
  border-color: #ff6a2b;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4), 0 0 0 2px color-mix(in srgb, #ff6a2b 35%, transparent);
}

/* Annotations waiting to be sent, under the attachments and skill chips. */
.box-annotations {
  padding: 12px 16px 0;
}

/* MiMo's attachments: a wrapping row, bottom-aligned, 8 apart, scrolling past 148. */
.atts {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  max-height: 148px;
  padding: 8px 8px 2px;
  overflow-y: auto;
}

.att {
  position: relative;
  flex: none;
}

/* A picture or a video: a bare 54px thumbnail on a hairline and a 9px corner. */
.att-thumb {
  display: block;
  width: 54px;
  height: 54px;
  object-fit: cover;
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  cursor: pointer;
}

/* Its remove: an 18px disc in the send colour over the corner, shown on hover or focus. */
.att-x {
  position: absolute;
  top: -6px;
  inset-inline-end: -6px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: var(--button-primary-text);
  background: var(--button-primary);
  border: 0;
  border-radius: 50%;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.12s, background-color 0.12s, color 0.12s;
}

.att:hover .att-x,
.att:focus-within .att-x,
.att-file:hover .att-x,
.att-file:focus-within .att-x {
  opacity: 1;
}

/* A file: a capsule with its type mark and name, 12px text, the remove inline at its end. */
.att-file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 7px 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
}

.att-file.openable {
  cursor: pointer;
}

.att-ic {
  flex: none;
  color: var(--text-weak);
}

.att-ic.cat-dir {
  color: var(--ft-dir);
}

.att-ic.cat-code {
  color: var(--ft-code);
}

.att-ic.cat-web {
  color: var(--ft-web);
}

.att-ic.cat-data {
  color: var(--ft-data);
}

.att-ic.cat-doc {
  color: var(--ft-doc);
}

.att-ic.cat-media {
  color: var(--ft-media);
}

.att-ic.cat-shell {
  color: var(--ft-shell);
}

.att-ic.cat-archive {
  color: var(--ft-archive);
}

.att-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-x.inline {
  position: static;
  flex: none;
  margin-inline-start: 4px;
  color: var(--text-base);
  background: transparent;
  border-radius: 6px;
  /* MiMo's mark is the character at 13px, not a drawing. */
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1;
}

.att-x.inline:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* MiMo's skill chips: 24px pills 6 apart, a 20px mark, the name and a small ×. */
.skill-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 2px 6px;
}

.cchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 480px;
  height: calc(24px * var(--ui-font-scale, 1));
  padding-block: 0;
  padding-inline: 8px 6px;
  overflow: hidden;
  background: color-mix(in srgb, var(--text-strong) 8%, transparent);
  border-radius: 999px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  transition: opacity 0.2s, max-width 0.2s, transform 0.2s;
}

/* Going: it shrinks away over MiMo's 200ms. */
.cchip.leaving {
  max-width: 0;
  opacity: 0;
  transform: scale(0.85);
  pointer-events: none;
}

.cchip-ic {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--text-strong);
}

.cchip-ic svg {
  display: block;
  width: 72%;
  height: 72%;
}

.cchip-ic path,
.skill-mark path {
  stroke: currentColor;
  stroke-width: 1.1;
  stroke-linejoin: round;
}

.cchip-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-base);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cchip-rm {
  padding: 2px;
  color: var(--text-weak);
  background: none;
  border: 0;
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1;
  cursor: pointer;
}

.cchip-rm:hover {
  color: var(--text-strong);
}

@media (prefers-reduced-motion: reduce) {
  .cchip {
    transition: none;
  }
}

.mode-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 6px;
}

.mode-tag {
  display: inline-flex;
  align-items: center;
  height: calc(16px * var(--ui-font-scale, 1));
  padding: 0 4px;
  color: var(--text-base);
  background: var(--surface-layer-02);
  border: 0.5px solid var(--border-input);
  border-radius: 2px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 530;
  letter-spacing: 0.05px;
}

.mode-exit {
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 530;
  letter-spacing: 0.05px;
}

.attach {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--icon-base);
  border-radius: var(--radius-md);
  transition: background 0.12s, color 0.12s;
}

.attach:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * Beside the send button and a size down from it: this starts something the
 * reader then decides about, where send is the decision.
 */
.ctx-slot {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.ctx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.ctx:hover,
.ctx.open {
  background: var(--surface-hover);
}

/* MiMo's voice capsule: the round button widens into a pill in the send colour while it is in use. */
.mic {
  overflow: hidden;
  white-space: nowrap;
  cursor: pointer;
  transition:
    width 0.3s cubic-bezier(0.34, 1.4, 0.5, 1),
    padding 0.3s cubic-bezier(0.34, 1.4, 0.5, 1),
    background-color 0.24s,
    border-color 0.24s,
    color 0.2s;
}

.mic.on {
  justify-content: flex-start;
  gap: 6px;
  width: 140px;
  padding-block: 0;
  padding-inline: 12px 8px;
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
  border-radius: 999px;
  animation: recpulse 1.1s infinite;
}

.mic.on.proc,
.mic.on.starting {
  animation: none;
}

.mic.on.proc {
  width: 128px;
}

.mic.on.starting {
  width: 116px;
  padding-inline: 13px;
}

.mic.on:hover {
  opacity: 0.9;
}

@keyframes recpulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--button-primary) 38%, transparent);
  }

  50% {
    box-shadow: 0 0 0 4px transparent;
  }
}

.mic-live {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  animation: mic-live-in 0.26s both;
}

@keyframes mic-live-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

/* Five 4px bars on a 16px line, each following the level at its own weight. */
.voice-wave {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  height: 16px;
}

.voice-wave i {
  width: 4px;
  height: 4px;
  background: currentColor;
  border-radius: 999px;
  transition: height 0.12s cubic-bezier(0.3, 0.85, 0.3, 1);
}

.voice-label {
  flex: 1;
  min-width: 3em;
  overflow: hidden;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mic-x {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  opacity: 0.72;
  cursor: pointer;
}

.mic-x:hover,
.mic-x:focus-visible {
  opacity: 1;
}

.mic-x svg {
  display: block;
  width: 12px;
  height: 12px;
}

/* A 13px ring, one segment solid, turning every 0.7s. */
.mic-spinner {
  flex: none;
  box-sizing: border-box;
  width: 13px;
  height: 13px;
  border: 2px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: composer-spin 0.7s linear infinite;
}

@keyframes composer-spin {
  to {
    transform: rotate(360deg);
  }
}

/*
 * MiMo's cue drawer: 48 tall behind the box's top edge with 16 of it under the
 * box, so 32 show once it slides up; it slides back down 3s later. It comes
 * before the box in the page, so the box paints over its foot.
 */
.shell {
  position: relative;
}

.voice-cues {
  position: absolute;
  inset-inline: 0;
  bottom: calc(100% - 16px);
  height: 48px;
  overflow: hidden;
  pointer-events: none;
}

.voice-drawer {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  box-sizing: border-box;
  height: 100%;
  padding: 6px 22px 20px;
  color: #ff6a2b;
  white-space: nowrap;
  background: var(--surface-layer);
  border-radius: 16px 16px 0 0;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
  transform: translateY(105%);
  transition: transform 0.34s;
}

:root[data-theme="dark"] .voice-drawer {
  color: #ff7a40;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .voice-drawer {
    color: #ff7a40;
  }
}

.voice-cues.on .voice-drawer {
  transform: translateY(0);
  transition: transform 0.26s cubic-bezier(0.32, 0.72, 0.33, 1);
}

/* A ring that draws itself, then the tick inside it. */
.voice-check {
  flex: none;
  width: 15px;
  height: 15px;
}

.voice-check circle,
.voice-check path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Drawn by growing the dash from nothing to the whole length (57 round the ring, 15 along the tick). */
.voice-check circle {
  stroke-dasharray: 0 57;
}

.voice-check path {
  stroke-dasharray: 0 15;
}

.voice-cues.on .voice-check circle {
  animation: voice-ring 0.42s 0.13s ease-out forwards;
}

.voice-cues.on .voice-check path {
  animation: voice-tick 0.28s 0.39s ease-out forwards;
}

@keyframes voice-ring {
  to {
    stroke-dasharray: 57 0;
  }
}

@keyframes voice-tick {
  to {
    stroke-dasharray: 15 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .voice-drawer,
  .voice-cues.on .voice-drawer {
    transition: none;
  }

  .voice-check circle,
  .voice-check path {
    stroke-dasharray: none;
    animation: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mic.on {
    animation: none;
  }
}

/* The one bright element in the composer, and a rounded square rather than a
   circle: six pixels, the same corner every other control on this bar carries. */
.send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-radius: 6px;
  transition: opacity 0.12s, filter 0.12s;
}

.send:hover:not(:disabled) {
  filter: brightness(0.92);
}

/*
 * Nothing to send yet: a grey button rather than a coloured one.
 *
 * The lift used to be a quarter of white laid over the panel, which was only
 * ever a dark-scheme device. In the light scheme the panel is already #ffffff,
 * so the overlay changed nothing and the disabled button came out exactly the
 * colour of the box behind it - measured at rgb(255,255,255) against a
 * rgb(255,255,255) box, invisible but for its glyph. Mixing the text colour in
 * lifts in the dark scheme and darkens in the light one, which is what "the
 * panel, but distinct from it" means in each.
 */
.send:disabled {
  color: var(--text-weak);
  background-color: color-mix(in srgb, var(--text-strong) 24%, var(--surface-raised));
  cursor: default;
}

/*
 * The agent and model pills, measured off the reference's own button-v2 rather
 * than guessed: 28 tall on a 6px radius with 11px of inline padding, its text
 * 13px on a 20px line. These were 9px, 12.5px, and whatever line-height the
 * app inherited - 24px - which made the pills read a size smaller than the
 * reference's and sat their labels differently inside the same 28px box.
 */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 11px;
  color: var(--text-base);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
  transition: background 0.12s, color 0.12s;
}

.pill:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.caret {
  color: var(--text-weaker);
}
.pill-wrap {
  position: relative;
}

/*
 * MiMo's menu surface for every composer menu: 16 round on a half-pixel line,
 * 5 of padding, rows 1 apart. Menus open upward unless placed below.
 */
.menu {
  position: absolute;
  bottom: calc(100% + 6px);
  /*
   * Aligned to the edge the pill starts on, so the menu grows into the column
   * rather than out of it. Anchored to the physical left it opened rightwards
   * in a right-to-left document, where the pills sit at the right of the bar,
   * and the wider menus were clipped by the workspace edge.
   */
  inset-inline-start: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 160px;
  padding: 5px;
  border: 0.5px solid var(--border-input);
  border-radius: 16px;
  box-shadow: var(--shadow-composer);
  transform-origin: top;
  animation: menu-in 0.15s ease-out;
}

/*
 * The glass: 92% of the menu colour over an 18px blur. It is drawn by a layer
 * under the rows rather than by the menu itself, because a blur on the menu
 * would hold the fixed submenus inside it to the menu instead of the window.
 */
.menu::before,
.more-menu::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  backdrop-filter: blur(18px) saturate(150%);
  content: "";
}

.menu.up {
  transform-origin: bottom;
  animation-name: menu-in-up;
}

/*
 * MiMo's entrance: a fade, a 95% zoom and an 8px slide from the chip -
 * `slide-in-from-top-2`, which is two of its 4px spacing steps, not two pixels.
 * No fill mode, so no transform outlasts it.
 */
@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.95);
  }
}

@keyframes menu-in-up {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.95);
  }
}

@keyframes sub-in {
  from {
    opacity: 0;
    transform: translateX(-2px) scale(0.95);
  }
}

@media (prefers-reduced-motion: reduce) {
  .menu,
  .more-menu,
  .skill-menu {
    animation: none;
  }
}

/*
 * The model menu carries its own padding on each band - search, list, footer -
 * so that the two rules between them can reach the menu's edges. Padding on
 * the menu itself would inset the rules with everything else.
 */
/* MiMo's plus menu opens under its button, and above it only where the dock would run it off the window. */
.menu.plus-menu {
  top: calc(100% + 4px);
  bottom: auto;
  min-width: 220px;
}

.menu.plus-menu.up {
  top: auto;
  bottom: calc(100% + 4px);
}

.menu.plus-menu .rule {
  margin: 4px 6px;
}

.skill-mark {
  flex: none;
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

.item-chev {
  flex: none;
  width: 14px;
  height: 14px;
  margin-inline-start: auto;
  opacity: 0.5;
}

.item-chev path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* The skills submenu: fixed beside its row, a search box over the list. */
.skill-menu {
  position: fixed;
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: 240px;
  max-height: min(360px, calc(100vh - 16px));
  padding: 5px;
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-input);
  border-radius: 16px;
  box-shadow: var(--shadow-composer);
  backdrop-filter: blur(18px) saturate(150%);
  transform-origin: top left;
  animation: sub-in 0.15s ease-out;
}

.skill-search {
  flex: none;
  height: calc(30px * var(--ui-font-scale, 1));
  margin: 2px 2px 4px;
  padding-inline: 8px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  outline: none;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.skill-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
}

/* Two taller than a menu row, level with the search box above it. Written against `.item` because the base rule is further down. */
.item.skill-item {
  flex: none;
  height: calc(30px * var(--ui-font-scale, 1));
}

.skill-empty {
  padding: 8px 10px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.item:disabled {
  opacity: 0.45;
  cursor: default;
}

.item:disabled:hover {
  background: transparent;
}

/* Smart's row: the name over a line saying what it does. */
.item.smart {
  height: auto;
  padding-block: 6px;
}

.smart-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.item-desc {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A two-line row with a switch at its end. */
.item.goal-row {
  height: auto;
  padding-block: 6px;
}

.goal-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.goal-sub {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
  line-height: calc(15px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-switch {
  position: relative;
  flex-shrink: 0;
  width: 28px;
  height: 16px;
  background: color-mix(in srgb, var(--text-strong) 22%, var(--surface-raised));
  border-radius: 999px;
  transition: background-color 0.15s;
}

.goal-switch.on {
  background: var(--icon-base);
}

.goal-knob {
  position: absolute;
  top: 2px;
  width: 12px;
  height: 12px;
  background: var(--icon-base);
  border-radius: 50%;
  inset-inline-start: 2px;
  transition: inset-inline-start 0.15s, background-color 0.15s;
}

.goal-switch.on .goal-knob {
  background: var(--surface-raised);
  inset-inline-start: 14px;
}

/* MiMo's mode chip: a filled 12/500 label with its mark, 3 by 8 at a 7px corner. */
.mode-chip {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  color: var(--text-strong);
  white-space: nowrap;
  background: var(--surface-layer);
  border: 0;
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(18px * var(--ui-font-scale, 1));
}

.mode-chip:hover {
  background: var(--surface-selected);
}

.mode-chip svg {
  flex: none;
  width: 13px;
  height: 13px;
}

/* The mark is drawn in lines, whichever shape carries them - plan's is paths, the goal's is rings. */
.mode-chip svg path,
.mode-chip svg circle {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ...except the goal's pupil, which is the one filled part of it. */
.mode-chip svg circle[stroke="none"] {
  stroke: none;
}

/* MiMo's model menu: under the chip at its end, 210 and up, rows of mark, name and check. */
.menu.model-menu {
  top: calc(100% + 4px);
  bottom: auto;
  min-width: 210px;
  max-width: 320px;
}

.menu.model-menu.up {
  top: auto;
  bottom: calc(100% + 4px);
}

.model-menu:focus {
  outline: none;
}

.model-menu .rule {
  margin: 4px 6px;
  background: var(--border-weak);
}

/* MiMo's provider heading over its custom models: 12px in the muted colour, 6 by 10 of padding. */
.model-menu .provider-head {
  padding: 6px 10px;
  overflow: hidden;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}

.model-menu .model-item {
  gap: 9px;
  height: auto;
  min-height: 32px;
  padding: 6px 10px;
  border-radius: 11px;
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

.model-menu .model-item.on {
  color: var(--text-strong);
  font-weight: 400;
  background: var(--surface-selected);
}

/* MiMo's 8px after a row mark, on top of the 9px gap: names start 17 past it. */
.smart-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-inline-end: 8px;
  color: var(--text-strong);
  background: var(--surface-hover);
  border-radius: 6px;
}

.model-menu .smart-text {
  gap: 1px;
}

.model-menu .item-desc {
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 1.3;
  white-space: normal;
}

.model-check path,
.model-chev path,
.model-config path,
.model-config circle {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* MiMo's check is drawn in its send colour. */
.model-check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-inline-start: auto;
  color: var(--button-primary);
  opacity: 0;
}

.model-item.on .model-check {
  opacity: 1;
}

.model-chev {
  flex: none;
  width: 14px;
  height: 14px;
  opacity: 0.5;
}

.model-config {
  flex: none;
  width: 16px;
  height: 16px;
  margin-inline-end: 8px;
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

.more-slot {
  position: relative;
}

/*
 * Placed fixed beside its row, so it is never cut off by the composer's edge.
 * The surface is the outer box and the list scrolls in the inner one, so a
 * row's own levels, fixed beside it, are not clipped by the scroll.
 */
.more-menu {
  position: fixed;
  z-index: 60;
  display: flex;
  min-width: 220px;
  max-height: min(420px, calc(100vh - 16px));
  border: 0.5px solid var(--border-input);
  border-radius: 16px;
  box-shadow: var(--shadow-composer);
  transform-origin: top left;
  animation: sub-in 0.15s ease-out;
}

/* One flat list, 1 apart, as MiMo's 更多模型 now draws it. */
.more-scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  padding: 5px;
  overflow-y: auto;
}

/* MiMo's level on the chip, 「· 高」: the level at 0.62, the dot at 0.7 of that and 5 before the level. */
.model-effort {
  flex: none;
  white-space: nowrap;
  opacity: 0.62;
}

.model-effort::before {
  margin-inline-end: 5px;
  opacity: 0.7;
  content: "·";
}

/* MiMo's empty menu: one 13px muted line, 8 by 10. */
.model-empty {
  padding: 8px 10px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/* Bleeds past the two pixels of padding on the band above and below it. */
.menu .rule {
  height: 1px;
  background: var(--border-muted);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: calc(28px * var(--ui-font-scale, 1));
  padding: 0 12px;
  color: var(--text-strong);
  text-align: start;
  /* MiMo's 11px corner on every menu row. */
  border-radius: 11px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 1;
  letter-spacing: -0.04px;
  cursor: default;
}

/* Drawn inside the row: it is as wide as the scroller, so a ring set outside
   it is clipped away at both edges. */
.item:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

.item:hover,
.item.hot {
  background: var(--surface-hover);
}

/*
 * The chosen model is named by weight and colour. A background would collide
 * with the one the keyboard's position already uses, and the two have to stay
 * tellable apart while arrowing over the row that is already selected.
 */
.item.on {
  color: var(--text-accent);
  font-weight: 530;
}

.item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/*
 * Sixteen wide whether or not it holds a tick, so that every name in the list
 * starts at the same place and the column does not shift as the model changes.
 */
.tick {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

/*
 * 2.0: Xiaomi MiMo's composer, measured under one of its conversations.
 *
 * A 712 card on the menu surface with a half-pixel rule, a 20px corner and
 * eight of padding all round; the writing area inside it at 14/400 on a 21
 * line, and a 32px bar of round buttons and flat chips under that. The card
 * is 103 tall at rest, which is what the 55 of writing area makes of it.
 */
.composer {
  padding: 4px 24px 24px;
}

/*
 * With the note under it the dock's foot is the note's: six under the box, a
 * 14px line, six to the edge - MiMo's 1025 / 1031 / 1045 / 1052.
 */
.composer.noted {
  padding-bottom: 6px;
}

.ai-note {
  box-sizing: border-box;
  max-width: 712px;
  margin: 6px auto 0;
  color: var(--text-weak);
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(14px * var(--ui-font-scale, 1));
  text-align: center;
}

.shell {
  max-width: 712px;
}

/*
 * MiMo's wide window: past 2000px the dock's column goes 712 -> 944, and a box
 * that fits its text gets a 70px floor.
 *
 * 944, not 1000: MiMo's `.composer-wrap` is `max-width: 768px` with
 * `padding: 0 28px 14px`, so its inner column is 712, and at 2000px the wrapper
 * goes to 1000 - leaving 944 inside. `.shell` here is that inner column (it
 * carries no padding of its own), so it takes the inner figure, the way
 * `.composer-tray` and the home hero's own 944 do.
 */
@media (min-width: 2000px) {
  .shell {
    max-width: 944px;
  }

  .box:not(.resized) .input {
    min-height: 70px;
  }
}

/* MiMo keeps the note's line but hides it until there is a reply, and never lets it take a click. */
.ai-note {
  pointer-events: none;
}

.ai-note.hidden {
  visibility: hidden;
}

/* Not under the floating chat's box, as in MiMo. */
#float-dock .ai-note {
  display: none;
}

/*
 * MiMo's card: no ring when it takes focus. Its edge is #151c130f on light and
 * #2e2e2e on dark; its shadow a soft two-step lift on light and one darker
 * drop on dark.
 *
 * The fill is MiMo's --color-composer-surface, white on light and #1f1f1f on
 * dark (below) - not the menu surface, which is a step greyer on light. The
 * conversation's dock is the same card and takes the same white, as MiMo's does.
 */
.box {
  padding: 8px;
  background: #ffffff;
  border: 0.5px solid var(--border-input);
  border-radius: 20px;
  box-shadow: var(--shadow-composer);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .box {
    background: #1f1f1f;
  }

  :root:not([data-theme="light"]) .box:not(.dropping) {
    border-color: #2e2e2e;
  }

  /* MiMo's --shadow-composer-home, which differs from the normal one on dark only. */
  :root:not([data-theme="light"]) .home-hero .box:not(.dropping) {
    box-shadow: 0 2px 10px #00000080;
  }
}

:root[data-theme="dark"] .box {
  background: #1f1f1f;
}

:root[data-theme="dark"] .box:not(.dropping) {
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .home-hero .box:not(.dropping) {
  box-shadow: 0 2px 10px #00000080;
}

/* The keyboard's ring (base.css) goes round the card rather than the bare writing area inside it. */
:root[data-focus-key] .box:has(.input:focus) {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

:root[data-focus-key] .input:focus {
  outline: none;
}

.box.dropping {
  border-color: #ff6a2b;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4), 0 0 0 2px color-mix(in srgb, #ff6a2b 35%, transparent);
}

/*
 * MiMo's 44px floor, and under it the ~6px its inline textarea leaves on the
 * line box, which a flex box has no line box to give: 0.5 + 8 + 44 + 6 + 36 +
 * 8 + 0.5 = 103, the card MiMo measures.
 */
.input {
  position: relative;
  z-index: 1;
  min-height: 44px;
  margin-bottom: 6px;
  padding: 5px 5px 8px;
  background: transparent;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(21px * var(--ui-font-scale, 1));
}

/* MiMo sets what is written at 500; its placeholder stays at the regular weight. */
.input:not(:placeholder-shown) {
  font-weight: 500;
}

/* MiMo's written text: the strongest text on light, #f4f4f5 rather than white on dark. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .input {
    color: #f4f4f5;
  }
}

:root[data-theme="dark"] .input {
  color: #f4f4f5;
}

/* Locked while the conversation is compacted. */
.input:disabled {
  cursor: progress;
}

/* MiMo's composer placeholder: its muted text on light, #a0a0a0 on dark. */
.input::placeholder {
  color: var(--text-base);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .input::placeholder {
    color: #a0a0a0;
  }
}

:root[data-theme="dark"] .input::placeholder {
  color: #a0a0a0;
}

/* A height set by dragging may go past the fitted cap, to 480px or half the window, and down to MiMo's 44. */
.box.resized .input {
  min-height: 44px;
  max-height: min(480px, 50vh);
  overflow-y: auto;
}

/* MiMo's handle: a 10px strip across the top edge, 12 in from each side, over everything in the box. */
.resize-handle {
  position: absolute;
  top: -5px;
  inset-inline: 12px;
  z-index: 3;
  height: 10px;
  cursor: ns-resize;
  touch-action: none;
}

/* A 36 by 3 bar that shows while the handle is hovered. */
.resize-handle::after {
  content: "";
  position: absolute;
  top: 4px;
  inset-inline: 0;
  width: 36px;
  height: 3px;
  margin-inline: auto;
  background: transparent;
  border-radius: 2px;
  transition: background var(--motion-fast, 0.12s);
}

.resize-handle:hover::after {
  background: var(--border-weak);
}

/* MiMo's bar: 2 above and below its 32px controls and 4 in at each end, so 36
   tall. Its two groups wrap onto a second line when the box is narrow. */
.row {
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px;
  row-gap: 6px;
  height: auto;
  min-height: 32px;
  margin-bottom: 0;
  padding: 2px 4px;
}

.row-start,
.row-end {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.row-end {
  margin-inline-start: auto;
}

/* Wrapped, the permission and mode chips keep only their marks, as MiMo's do. */
.row.collapsed .perm-label,
.row.collapsed .mode-label {
  display: none;
}

/* Under 480 wide the usage ring goes, as MiMo's container rule has it. */
.row.narrow .ctx-slot {
  display: none;
}

/* The controls' grey: the base text colour let most of the way through. */
.attach,
.pill {
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

/* MiMo's round buttons in the composer, the plus and the microphone: 30px circles with no edge and no fill until hovered. */
.attach,
.mic {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
  background: transparent;
  border: 0;
  border-radius: 50%;
}

.attach:hover,
.attach.open,
.mic:not(.on):hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Pressed, the round buttons and send give a little. */
.attach:active:not(:disabled),
.mic:active:not(:disabled),
.send:active:not(:disabled) {
  scale: 0.96;
}

.pill {
  gap: 4px;
  height: calc(32px * var(--ui-font-scale, 1));
  padding: 7px 6px;
  border: 0;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(18px * var(--ui-font-scale, 1));
}

/* Full access is the one setting on this bar worth noticing, so it is coloured - until hovered, where MiMo's hover colour takes over. */
.pill.access.full:not(:hover) {
  color: #fb8147;
}

/* MiMo's send colours: #151c13 under white on light, #ececec under #0d0d0d on dark. */
.send {
  flex: none;
  width: 30px;
  height: 30px;
  color: #fff;
  background: #151c13;
  border-radius: 50%;
}

/* OpenCode v2's 排队, beside send: the same round 30px, outlined rather than filled, so send stays the main action. */
.queue-send {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 50%;
  cursor: pointer;
  transition: background-color 0.12s;
}

.queue-send:hover:not(:disabled) {
  background: var(--surface-selected);
}

.queue-send:active:not(:disabled) {
  scale: 0.96;
}

.queue-send:disabled {
  opacity: 0.4;
  cursor: default;
}

.queue-send:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .send:not(.empty):not(:disabled) {
    color: #0d0d0d;
    background: #ececec;
  }
}

:root[data-theme="dark"] .send:not(.empty):not(:disabled) {
  color: #0d0d0d;
  background: #ececec;
}

/* High contrast drops the fill, so the send button keeps a system outline there; nothing changes outside that mode. */
@media (forced-colors: active) {
  .send {
    outline: 1px solid ButtonText;
    outline-offset: -1px;
  }
}

.send:hover:not(:disabled) {
  filter: none;
  opacity: 0.85;
}

/* MiMo's empty send: the muted fill, still pressable. */
.send.empty,
.send:disabled {
  color: var(--surface-base);
  background-color: color-mix(in srgb, var(--text-strong) 26%, var(--surface-menu));
}

/* The compaction spinner in the send slot: 16px, a 2px ring with one segment solid. */
.send-spinner {
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: composer-spin 0.7s linear infinite;
}

/* The pills in the far group sit at the card's far edge; their menus open inwards. */
.row-end .pill-wrap .menu {
  inset-inline-start: auto;
  inset-inline-end: 0;
}

/* MiMo's permission menu: below the chip, 210 wide, 32px rows of icon, name and check. */
.access-menu {
  top: calc(100% + 4px);
  bottom: auto;
  min-width: 210px;
}

.access-menu:focus {
  outline: none;
}

.access-menu.up {
  top: auto;
  bottom: calc(100% + 4px);
}

.access-icon {
  flex: none;
}

/* The level marks carry their own stroke weights (ACCESS_ICONS); the check keeps 1.2. */
.access-icon path,
.access-check path {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.access-check path {
  stroke-width: 1.2;
}

/* MiMo's hand ends its finger partings square. */
.access-icon[data-access-icon="ask"] path,
.access-item[data-access="ask"] .access-icon path {
  stroke-linecap: butt;
}

.access-item {
  flex: none;
  gap: 9px;
  height: 32px;
  padding: 6px 10px;
  font-weight: 400;
}

.access-item.on {
  color: var(--text-strong);
  font-weight: 400;
  background: var(--surface-selected);
}

.access-item .access-icon {
  width: 17px;
  height: 17px;
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

.access-check {
  flex: none;
  margin-inline-start: auto;
  color: var(--button-primary);
  opacity: 0;
}

.access-item.on .access-check {
  opacity: 1;
}

/*
 * The side chat's box: the dock around it supplies MiMo's 28px sides and 6px
 * foot, so the box adds no padding of its own, and a box that fits its text
 * holds at MiMo's 70px floor at every window width.
 */
.composer.side {
  padding: 0;
}

.composer.side .box:not(.resized) .input {
  min-height: 70px;
}

/*
 * MiMo's floating box over an expanded panel: one wrapping row - the plus, the
 * text, the permission chip, then the model and send - with anything else
 * (attachments, chips, annotations) on a full line above it.
 */
#float-dock .composer {
  padding: 0;
}

#float-dock .shell {
  max-width: 100%;
}

#float-dock .box {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 4px 2px;
  padding: 6px 8px;
}

#float-dock .row,
#float-dock .row-start,
#float-dock .row-end {
  display: contents;
}

#float-dock .box > * {
  flex-basis: 100%;
  order: -1;
}

#float-dock .plus-wrap {
  order: 0;
  margin-bottom: 4px;
}

#float-dock .input {
  flex: 1 1 0;
  order: 1;
  min-width: 0;
  min-height: 36px;
  margin-bottom: 0;
  padding: 8px 6px 8px 8px;
}

#float-dock .row-start > :not(.plus-wrap) {
  order: 2;
  margin-bottom: 4px;
}

#float-dock .row-end > * {
  order: 3;
  margin-bottom: 4px;
}

#float-dock .perm-label {
  display: none;
}
</style>
