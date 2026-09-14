<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { VoiceRecorder, splitSendWord, type VoiceState } from "../lib/voice"
import type { Ref } from "vue"
import type { Attachment, CommandInfo, Effort, ModelInfo } from "@shared/protocol"
import { DEFAULT_PERMISSIONS, PERMISSION_ACTIONS, PERMISSION_KINDS } from "@shared/protocol"
import { expandTemplate, splitCommandLine } from "@shared/command"
import { preview, readFiles, MAX_BYTES } from "../lib/attach"
import type { Draft } from "../lib/draft"
import { badgeStyle, fileBadge } from "../lib/filetype"
import { findModel, resolveVariant, withoutLatest } from "../lib/model"
import {
  absolutePath,
  fileDirectory,
  fileName,
  mentionAttachment,
  mentionSpan,
  mentionedIn,
  withMention,
} from "../lib/mention"
import { notify, notifyFailure } from "../lib/toast"
import { useApp } from "../stores/app"
import ModelMenuRow from "./ModelMenuRow.vue"
import { besideRow } from "../lib/submenu"
import ConfirmDialog from "./ConfirmDialog.vue"
import ContextRing from "./ContextRing.vue"
import { readContext } from "./session-context"
import ProviderIcon from "./ProviderIcon.vue"
import { t, language } from "../lib/i18n"

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
  /** Whether its top edge drags it taller; off where MiMo docks it without one, over an expanded panel. */
  resizable?: boolean
}>()

const app = useApp()

/* The conversation this box speaks for: none in a box that starts a new task. */
const sessionID = computed(() => (props.fresh ? undefined : props.side ? app.sideID : app.currentID))
const session = computed(() => (props.fresh ? undefined : props.side ? app.side : app.current))
const busyHere = computed(() => (props.side ? app.sideBusy : app.busy))
const text = ref("")
const input = ref<HTMLTextAreaElement>()
/**
 * Prompt history, newest last; -1 means "editing a fresh prompt".
 *
 * Read off the session rather than collected as you type: a local array only
 * ever held what this window had sent, so pressing Up in a session reopened
 * after a restart recalled nothing at all.
 */
const history = computed(() =>
  (props.side ? app.sideMessages : app.messages).filter((message) => message.role === "user").map((message) => message.text),
)
const historyIndex = ref(-1)

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
  const chosen = session.value?.model ?? app.config?.model
  if (!chosen) return "no model"
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
  element.style.height = "auto"
  element.style.height = `${element.scrollHeight}px`
}

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
onMounted(() => window.addEventListener(DOCK_HEIGHT_EVENT, followDockHeight))
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

/**
 * Paths that were chosen from the @ menu rather than merely typed.
 *
 * Only these are read and carried with the message. Something that reads like
 * a mention but names nothing - a half-typed path, an @handle - stays the
 * words it is and reaches the model inside the sentence it was written in.
 */
const mentioned = ref(new Set<string>())

watch(text, (value) => {
  void nextTick(resize)
  /*
   * Whatever the box says now is what the menus answer to. A menu closed with
   * Escape comes back as soon as anything is typed, which is the reference's
   * rule and the only one that keeps Escape from being a trapdoor.
   */
  dismissed.value = false
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

async function take(files: readonly File[]) {
  if (!files.length) return
  const { attachments: taken, rejected } = await readFiles(files)
  attachments.value = [...attachments.value, ...taken]
  for (const item of rejected) {
    notifyFailure(t(item.reason === "too-large" ? "attach.tooLarge" : "attach.unreadable"), item.name)
  }
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
  const pasted = event.clipboardData?.getData("text/plain") ?? ""
  // Anything shorter pastes as text, the way it always has.
  if (pasted.length < PASTE_AS_FILE) return
  event.preventDefault()
  const name = `mcode-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  if (new Blob([pasted]).size > MAX_BYTES) {
    notifyFailure(t("attach.tooLarge"), name)
    return
  }
  attachments.value = [...attachments.value, { path: name, mime: "text/plain", data: pasted }]
  notify(t("composer.pasteAttached"))
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

function onDragOver(event: DragEvent) {
  if (dialogOpen()) return
  const types = event.dataTransfer?.types
  if (!types?.includes("Files") && !types?.includes("text/plain")) return
  // Without this the window navigates to the dropped file instead.
  event.preventDefault()
  dragging.value = true
}

function onDragLeave(event: DragEvent) {
  if (dialogOpen()) return
  if (!event.relatedTarget) dragging.value = false
}

async function onDrop(event: DragEvent) {
  if (dialogOpen()) return
  event.preventDefault()
  dragging.value = false

  /*
   * A path dragged as text becomes a mention rather than a copy of the file:
   * the reference reads `file:` off the plain text and inserts `@path`, which
   * keeps a file that is already in the project referred to rather than sent.
   */
  const dropped = event.dataTransfer?.getData("text/plain") ?? ""
  if (dropped.startsWith("file:")) {
    const path = decodeURI(dropped.slice("file:".length).replace(/^\/{2,3}/, ""))
    if (path) {
      text.value = text.value ? `${text.value.replace(/\s+$/, "")} @${path} ` : `@${path} `
      focus()
      return
    }
  }

  const files = [...(event.dataTransfer?.files ?? [])]
  if (!files.length) return
  await take(files)
}

/**
 * Silent once something has been attached; the tiles say what is going.
 *
 * It no longer changes while the model is working. It used to read "Working -
 * Esc to stop", which was the box telling you it would not take anything, and
 * it will: a prompt sent now joins the turn that is running. Inviting the same
 * thing it always invites is the truthful version, and it is also what the
 * reference does - its placeholder does not know whether a turn is in flight.
 */
const placeholder = computed(() => {
  if (mode.value === "shell") return t("composer.shellPlaceholder")
  /*
   * It names both triggers now that both exist. The reference's own placeholder
   * has always said this, and MCode's could not: for a long time neither a
   * slash nor an @ did anything, and a box that advertises keys it ignores is
   * worse than one that says nothing.
   */
  return attachments.value.length ? "" : t("composer.placeholder", { slash: "/", at: "@" })
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
const stopping = computed(() => busyHere.value && !text.value.trim() && !attachments.value.length)

function setMode(next: "normal" | "shell") {
  mode.value = next
  focus()
}

/*
 * Speaking instead of typing.
 *
 * The recorder is held for the life of the box so a second press finds the
 * same one; it opens the microphone on the first press and closes it on the
 * second, and `cancel` on unmount makes sure a window closed mid-recording
 * does not leave the device open.
 */
const recorder = new VoiceRecorder()
const voice = ref<VoiceState>("idle")

const voiceConfigured = computed(() => Boolean(app.config?.voiceModel?.model))

onBeforeUnmount(() => recorder.cancel())

async function toggleVoice() {
  if (voice.value === "working") return
  if (voice.value === "recording") {
    voice.value = "working"
    try {
      const recording = await recorder.stop()
      /* A press and an immediate second press is a slip, not a message. */
      if (!recording || recording.ms < 350) return
      const result = await app.client?.request({
        type: "voice.transcribe",
        audio: recording.audio,
        mime: recording.mime,
        language: language.value,
      })
      const said = (result?.text ?? "").trim()
      if (!said) return
      const { text: spoken, send } = splitSendWord(said)
      if (spoken) {
        const existing = text.value.trim()
        text.value = existing ? `${existing} ${spoken}` : spoken
        await nextTick(resize)
      }
      /* As in MiMo, the spoken "send" belongs to the considered mode only; quick input just types. */
      const sendsByVoice = (app.config?.voiceSend ?? false) && (app.config?.voiceMode ?? "smart") === "smart"
      if (send && sendsByVoice && text.value.trim()) await submit()
    } catch (err) {
      notifyFailure(t("voice.failed"), reasonForVoice(err))
    } finally {
      voice.value = "idle"
    }
    return
  }

  if (!voiceConfigured.value) {
    notifyFailure(t("voice.failed"), t("voice.notConfigured"))
    return
  }
  try {
    await recorder.start()
    voice.value = "recording"
  } catch (err) {
    voice.value = "idle"
    notifyFailure(t("voice.failed"), reasonForVoice(err))
  }
}

/** The app's own phrasing for the failures it can recognise. */
function reasonForVoice(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes("voice.notConfigured")) return t("voice.notConfigured")
  if (message.includes("voice.noEndpoint")) return t("voice.noEndpoint")
  if (message.includes("voice.noRecorder")) return t("voice.noRecorder")
  if (message.includes("NotAllowedError") || message.includes("Permission")) return t("voice.noPermission")
  if (message.includes("NotFoundError")) return t("voice.noDevice")
  return message
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

function terminalFromMenu() {
  if (!sessionID.value) return
  menu.value = undefined
  emit("terminal")
}

/*
 * Staged mode as the plus menu shows it: the open conversation's setting when
 * there is one, the default the next conversation will start with when there
 * is not.
 *
 * In a conversation it is that conversation's value and nothing else, with
 * absent meaning off - which is what the server reads when it builds the
 * prompt. Falling back to the default here made the switch lie: with the
 * default turned on, every conversation from before the setting existed showed
 * "on" while its turns ran without the section at all.
 */
const staged = computed(() =>
  sessionID.value ? (session.value?.staged ?? false) : (app.config?.staged ?? false),
)

async function toggleStaged() {
  // A box starting a new task sets what that task will start with.
  if (!sessionID.value) {
    await app.patchConfig({ staged: !staged.value })
    return
  }
  await app.setStaged(!staged.value)
}

/* A skill is started the way typing its name would start it. */
async function useSkill(name: string) {
  menu.value = undefined
  text.value = `/${name} `
  await nextTick(resize)
  focus()
}

async function submit() {
  const value = text.value.trim()
  if (mode.value === "shell") {
    if (!value) return
    text.value = ""
    await nextTick(resize)
    emit("shell", value)
    return
  }
  /*
   * An attachment on its own is a message; the model can be asked to look at
   * it. There is deliberately no test for a turn being in flight: one that is
   * running takes the message and answers it in the same turn, so refusing here
   * would only force the user to stop the model and lose its work in order to
   * say one more sentence.
   */
  if (!value && !attachments.value.length) return
  historyIndex.value = -1
  const sent = attachments.value
  const carried = mentioned.value
  /*
   * Emptied before anything is awaited. The mentioned files still have to be
   * read off disk, and leaving the draft on screen across that read would let
   * a second Enter - a double tap, an impatient one - start a second send of
   * the same sentence.
   */
  text.value = ""
  attachments.value = []
  mentioned.value = new Set()
  await nextTick(resize)

  /*
   * On the home screen there is nothing to send into yet. The session is made
   * here, on the way out, rather than when the screen opened: one created just
   * because somebody looked at the home screen is a row in the side column
   * that nobody asked for. If it cannot be made, the draft comes back.
   */
  if (!sessionID.value) {
    try {
      await app.create(props.startDirectory, { scratch: props.startScratch })
    } catch (err) {
      text.value = value
      attachments.value = sent
      mentioned.value = carried
      await nextTick(resize)
      notifyFailure(t("home.startFailed"), err instanceof Error ? err.message : String(err))
      return
    }
  }

  const named = await mentionAttachments(value, carried)

  // A rejected message should not cost the user what they typed, or gathered.
  if (!(await app.send(outgoing(value), [...sent, ...named], props.side ? app.sideID : undefined))) {
    text.value = value
    attachments.value = sent
    mentioned.value = carried
    await nextTick(resize)
  }
}

/**
 * What actually goes to the model when the draft is a command line.
 *
 * The reference sends `session.command` and lets its server look the name up
 * and fill the template in (main-8t-QUXax.js @4461049 into
 * `SessionPrompt.command` @32957943); this app has no such request, so the
 * template travels with the command list and is filled in here. The visible
 * result is the same either way: the transcript shows the expanded prompt,
 * because the reference's server puts the template's own parts on the user
 * message rather than the slash line.
 *
 * NOT carried across, because `session.prompt` has nowhere to put them: a
 * command's `agent`, `model` and `subtask`. The reference runs the turn as
 * whichever agent and model the command names and can hand it to a subagent;
 * here it runs as whatever the session is already set to. That is a real gap
 * and it is reported rather than papered over.
 */
function outgoing(value: string): string {
  const line = splitCommandLine(value)
  const command = line && serverCommand(line.name)
  if (!command) return value
  const expanded = expandTemplate(command.template, line!.args)
  // An MCP prompt whose fetch failed has no template. Sending nothing would be
  // refused by the store and the draft would bounce back with no explanation,
  // so the line goes as it was typed instead.
  return expanded.trim() ? expanded : value
}

/**
 * The mentioned files, read at the moment the message goes.
 *
 * Reading them when they were named would send what the file said several
 * minutes and a few edits ago; what the model should be looking at is what is
 * on disk when it is asked. A file that cannot be read is named out loud - the
 * sentence still goes, mention and all, but the user has to know the file did
 * not go with it.
 */
async function mentionAttachments(value: string, chosen: Set<string>): Promise<Attachment[]> {
  const root = (props.side ? app.side : app.current)?.directory
  if (!root || !app.client || !chosen.size) return []
  const out: Attachment[] = []
  for (const path of mentionedIn(value)) {
    if (!chosen.has(path)) continue
    // The same file named twice is one file.
    if (out.some((entry) => entry.path === path)) continue
    try {
      const result = await app.client.request({ type: "file.read", path: absolutePath(root, path) })
      const attachment = mentionAttachment(path, result)
      if (attachment) out.push(attachment)
      else notifyFailure(t("attach.unreadable"), path)
    } catch {
      notifyFailure(t("attach.unreadable"), path)
    }
  }
  return out
}

watch(
  () => app.currentID,
  () => {
    historyIndex.value = -1
    // What was gathered belonged to the conversation being left.
    attachments.value = []
    mentioned.value = new Set()
    // And the file list belonged to the project that conversation was in.
    files.value = []
    listedFor.value = undefined
  },
)

/* --------------------------------------------------------------- files -- */

/**
 * The project's files, fetched once and filtered here.
 *
 * The server caps the list and walks the tree to build it, so asking again on
 * every keystroke would cost a directory crawl per letter. The palette settled
 * the same question the same way.
 */
const files = ref<string[]>([])
const listedFor = ref<string>()

async function loadFiles() {
  // A box starting a new task lists the folder that task will be made in.
  const directory = props.fresh ? props.startDirectory : session.value?.directory
  if (!directory || !app.client || listedFor.value === directory) return
  listedFor.value = directory
  try {
    const result = await app.client.request({ type: "file.list", directory })
    files.value = result.files.map((file) => file.path)
  } catch {
    // Nothing is said: the menu simply does not appear and the @ stays text.
    // Cleared so the next @ tries again rather than being stuck on one failure.
    listedFor.value = undefined
  }
}

/** The mention the caret is standing in, if it is standing in one. */
const atSpan = computed(() =>
  mode.value === "shell" ? undefined : mentionSpan(text.value, caret.value),
)

// Nobody wants the file list until they have typed an @, so that is when it is
// fetched - rather than on opening a session that may never mention a file.
watch(atSpan, (span) => {
  if (span) void loadFiles()
})

/**
 * A hit in the file's own name beats one further up the path.
 *
 * Someone typing "conf" is nearly always after config.ts, not after the
 * eighty files that happen to live under a directory called config.
 */
function nameFirst(path: string, needle: string): number {
  if (!needle) return 0
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase().includes(needle) ? 0 : 1
}

const atMatches = computed(() => {
  const span = atSpan.value
  if (!span || dismissed.value) return []
  const needle = span.query.toLowerCase()
  const found = needle ? files.value.filter((path) => path.toLowerCase().includes(needle)) : files.value
  return [...found]
    .sort((a, b) => nameFirst(a, needle) - nameFirst(b, needle) || a.length - b.length)
    // Enough to choose from without covering the conversation behind it.
    .slice(0, 8)
})

/*
 * An @ that matches nothing closes the menu rather than showing an empty one.
 *
 * The reference leaves it open on "No matching items", and while it is open it
 * swallows Enter - so a prompt that mentions a name the project does not have
 * cannot be sent at all until the menu is dismissed. The slash menu here has
 * always closed instead, and closing is both the kinder answer and the one
 * that keeps the two triggers behaving alike.
 */
const atOpen = computed(() => atMatches.value.length > 0)
const atIndex = ref(0)

watch(atMatches, (rows) => {
  if (atIndex.value >= rows.length) atIndex.value = 0
})

/** Puts the chosen path into the draft, and remembers that it was chosen. */
async function chooseMention(at: number) {
  const span = atSpan.value
  const path = atMatches.value[at]
  if (!span || !path) return
  const next = withMention(text.value, span, path)
  mentioned.value = new Set(mentioned.value).add(path)
  text.value = next.text
  atIndex.value = 0
  await nextTick()
  resize()
  input.value?.focus()
  input.value?.setSelectionRange(next.cursor, next.cursor)
  caret.value = next.cursor
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
  void loadFiles()
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
  text.value = next.text
  void nextTick(() => {
    resize()
    input.value?.focus()
    input.value?.setSelectionRange(next.cursor, next.cursor)
    caret.value = next.cursor
  })
}

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

/** The project's own commands, its MCP prompts and its skills, badged by source. */
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
  if (!id || serverCommand("compact")) return []
  return [{ id: "session.compact", trigger: "compact", description: t("composer.compactDesc"), run: () => void app.compact(id) }]
})

/*
 * A slash at the very start opens the list, and only there: a slash inside a
 * sentence is a slash, and a path pasted into the box is not a command.
 */
const slashQuery = computed(() => {
  if (mode.value === "shell") return undefined
  const value = text.value
  if (!value.startsWith("/") || value.includes("\n")) return undefined
  /*
   * Once the first word names a project command and a space has been typed,
   * what follows is that command's arguments rather than a search. Without
   * this the menu stayed up over `/deploy west`, and Enter - which a menu owns
   * while it is open - would pick the row again and throw the arguments away.
   * A UI command is exempt: those are matched on their titles, which contain
   * spaces, and none of them takes an argument.
   */
  const line = splitCommandLine(value)
  if (line && value.includes(" ") && serverCommand(line.name)) return undefined
  return value.slice(1)
})

const slashMatches = computed(() => {
  const query = slashQuery.value
  if (query === undefined) return []
  const needle = query.trim().toLowerCase()
  const all = [...sessionEntries.value, ...serverEntries.value]
  const found = needle
    ? all.filter(
        (entry) =>
          entry.trigger.toLowerCase().includes(needle) ||
          (entry.description?.toLowerCase().includes(needle) ?? false),
      )
    : all
  // Enough to choose from without covering the conversation behind it.
  return found.slice(0, 8)
})

/*
 * Open whenever the draft is a command line, even with nothing matching: the
 * reference keeps its popover up and puts `prompt.popover.emptyCommands` in it
 * (@4482800) rather than vanishing, so a mistyped name says so instead of
 * looking like the menu was never there.
 */
const slashOpen = computed(() => !dismissed.value && slashQuery.value !== undefined)
const slashIndex = ref(0)

// Typing narrows the list, which can leave the highlight past the end of it.
watch(slashMatches, (rows) => {
  if (slashIndex.value >= rows.length) slashIndex.value = 0
})

async function runSlash(at: number) {
  const command = slashMatches.value[at]
  if (!command) return
  slashIndex.value = 0
  if (!command.run) {
    /*
     * A project command is not run from the menu. The reference writes
     * `/${trigger} ` into the editor, closes the popover and leaves the caret
     * at the end (@4534200), because what comes next is the command's
     * arguments - choosing the row is naming the command, not sending it.
     */
    text.value = `/${command.trigger} `
    await nextTick(resize)
    // After the tick, because the text watcher clears this on every change.
    dismissed.value = true
    const end = text.value.length
    focus()
    input.value?.setSelectionRange(end, end)
    caret.value = end
    return
  }
  text.value = ""
  await nextTick(resize)
  command.run()
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

/** Enter and Tab both take the highlighted row, as they do in the reference. */
function takesRow(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  return event.key === "Enter" || event.key === "Tab"
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
    if (moveMenu(event, atMatches.value.length, atIndex)) return
    if (takesRow(event)) {
      event.preventDefault()
      void chooseMention(atIndex.value)
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

  // Enter sends; Shift+Enter is a newline. This is a chat surface, not an editor.
  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
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
      event.preventDefault()
      void app.abort(sessionID.value)
      return
    }
  }

  // Arrow history, but only from the edges of the text so it never fights
  // with normal cursor movement in a multi-line draft.
  const element = input.value
  if (!element) return

  if (event.key === "ArrowUp" && element.selectionStart === 0 && history.value.length) {
    event.preventDefault()
    const next = historyIndex.value === -1 ? history.value.length - 1 : Math.max(0, historyIndex.value - 1)
    historyIndex.value = next
    text.value = history.value[next]
  } else if (event.key === "ArrowDown" && element.selectionStart === text.value.length && historyIndex.value !== -1) {
    event.preventDefault()
    const next = historyIndex.value + 1
    if (next >= history.value.length) {
      historyIndex.value = -1
      text.value = ""
    } else {
      historyIndex.value = next
      text.value = history.value[next]
    }
  }
}


/** Which pill has its menu open, if any. */
const menu = ref<"model" | "access" | "plus" | "context">()

/** Token counts the way a context window is talked about: 39.2K, 1.0M. */
function compactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

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
  const reading = readContext(props.side ? app.sideMessages : app.messages, app.providers)
  // MiMo draws no ring until a turn has spent something: an empty conversation has nothing to show.
  if (!reading) return undefined
  const current = session.value?.model
  const window =
    reading?.window ??
    (current
      ? app.providers.find((provider) => provider.id === current.provider)?.models.find((model) => model.id === current.model)
          ?.contextWindow
      : undefined)
  const used = reading?.used ?? 0
  if (!window) {
    return {
      percent: 0,
      shareLine: t("composer.ctxUsedOnly", { used: compactTokens(used) }),
      tokensLine: t("composer.ctxUnknown"),
    }
  }
  const share = (used / window) * 100
  const decimal = new Intl.NumberFormat(language.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return {
    percent: share,
    shareLine: t("composer.ctxPercent", {
      used: decimal.format(share),
      left: decimal.format(Math.max(0, 100 - share)),
    }),
    tokensLine: t("composer.ctxTokens", { used: compactTokens(used), total: compactTokens(window) }),
  }
})
const pills = ref<HTMLElement>()

/**
 * The access chip's three positions, as MiMo has them: the default, "approve
 * for me" in the middle, and full access. "full" is what is left once nothing
 * asks - a map with a deny in it still counts, since a deny never prompts
 * either. The middle one is carried by `accessLevel`, and the server applies
 * it on top of whatever the map says.
 */
const ACCESS_CHOICES = ["ask", "auto", "full"] as const
type Access = (typeof ACCESS_CHOICES)[number]

const access = computed<Access>(() => {
  if (app.config?.accessLevel === "auto") return "auto"
  const map = app.config?.permissions
  if (!map) return "ask"
  return PERMISSION_KINDS.some((kind) => map[kind] === "ask") ? "ask" : "full"
})

/* Full access is offered only once settings allow it - or while it is already on, so it can be left. */
const accessChoices = computed(() =>
  ACCESS_CHOICES.filter((entry) => entry !== "full" || app.config?.allowFullAccess || access.value === "full"),
)

/* Set while the question before full access is on screen. */
const confirmingFull = ref(false)

/* Each level's mark, on the chip and in the menu: a raised hand, a pencil, a shield with a warning in it. */
const ACCESS_ICONS: Record<Access, string[]> = {
  ask: [
    "M5.4 8.6V4.1a.95.95 0 0 1 1.9 0v3.4",
    "M7.3 7.2V3.2a.95.95 0 0 1 1.9 0v4",
    "M9.2 7.3V3.9a.95.95 0 0 1 1.9 0v3.8",
    "M11.1 7.6V5.6a.95.95 0 0 1 1.9 0v4.1a4.6 4.6 0 0 1-4.6 4.6h-.5a4 4 0 0 1-3.1-1.5L2.7 10a.95.95 0 0 1 1.4-1.3l1.3 1.2",
  ],
  auto: ["M2.8 13.4h10.4", "M10.4 2.4l2.2 2.2-6.8 6.8H3.6V9.2z"],
  full: ["M8 1.8 13 3.7v4c0 3.1-2.1 5.4-5 6.5-2.9-1.1-5-3.4-5-6.5v-4z", "M8 5.3v2.9", "M8 10.6h.01"],
}

/*
 * The access and model menus open below their chips, as MiMo's do. On the home
 * screen that is always so; under a conversation the box sits at the window's
 * foot, and a menu that would run within 60px of the bottom opens above instead.
 */
const accessMenu = ref<HTMLElement>()
const menuUp = ref(false)
watch(menu, async (value) => {
  menuUp.value = false
  if ((value !== "access" && value !== "model") || props.fresh) return
  await nextTick()
  const rect = (value === "access" ? accessMenu.value : modelMenu.value)?.getBoundingClientRect()
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
 * Moving between the default and the middle level leaves the map alone - the
 * middle level is applied on top of it. Only entering and leaving full access
 * rewrites the map, and leaving it puts back what was there.
 */
async function applyAccess(next: Access) {
  const map = app.config?.permissions
  if (!map) return
  const leavingFull = access.value === "full"
  let permissions = map
  let accessBefore = app.config?.accessBefore
  if (next === "full") {
    permissions = { ...map }
    for (const kind of PERMISSION_KINDS) if (permissions[kind] !== "deny") permissions[kind] = "allow"
    accessBefore = { ...map }
  } else if (leavingFull) {
    const kept = app.config?.accessBefore ?? {}
    permissions = { ...map }
    for (const kind of PERMISSION_KINDS) {
      if (permissions[kind] === "deny") continue
      const restored = kept[kind]
      permissions[kind] =
        restored && (PERMISSION_ACTIONS as readonly string[]).includes(restored) ? restored : DEFAULT_PERMISSIONS[kind]
    }
    accessBefore = undefined
  }
  try {
    await app.patchConfig({ permissions, accessBefore, accessLevel: next })
  } catch (err) {
    notifyFailure(t("composer.access.failed"), err instanceof Error ? err.message : String(err))
  }
}

const AGENTS = ["build", "plan"] as const

/** What the session is running on, as the server describes it. */
const currentModel = computed<ModelInfo | undefined>(() =>
  findModel(app.providers, session.value?.model ?? app.config?.model),
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


/**
 * The session's step, if this model still takes it.
 *
 * The reference's `resolveModelVariant` (@2829318) returns nothing when the
 * stored variant is absent from the model's list, and deliberately does not
 * erase what was stored: switching to a model that lacks `xhigh` reads as
 * Default, and switching back brings `xhigh` up again. Clearing it here would
 * be tidier on the wire and lose the setting on every model change, so the
 * resolution stays a reading of the state rather than a write to it.
 */
const effortLevel = computed<Effort | undefined>(() => resolveVariant(variants.value, session.value?.effort))

/* A level chosen in a model's submenu: that model, then that level on the conversation. */
async function chooseModelEffort(provider: string, model: string, level?: Effort) {
  await chooseModel(provider, model)
  await app.setEffort(level)
}

/*
 * The session's agent, not the stored default: the turn runs as whatever the
 * session says, and an older session keeps the agent it was opened with. The
 * model pill beside this one reads the session for the same reason.
 */
const agent = computed(() => session.value?.agent ?? app.config?.agent ?? "build")

/**
 * Models offered in the picker: every connected provider, minus anything the
 * user switched off in Settings. An empty enabled list means "not curated",
 * so everything shows rather than nothing.
 */
const groups = computed(() => {
  const chosen = new Set(app.config?.enabledModels ?? [])
  return app.providers
    .filter((provider) => provider.configured)
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => !chosen.size || chosen.has(`${provider.id}/${model.id}`)),
    }))
    .filter((group) => group.models.length > 0)
})

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

/*
 * MiMo's split: its own models at the top level, everyone else's behind "more
 * models" under a heading per vendor. Here the first connected provider stands
 * where MiMo's own models do.
 */
const primaryGroup = computed(() => groups.value[0])
const moreGroups = computed(() => groups.value.slice(1))

watch(menu, () => {
  modelSub.value = undefined
  moreSub.value = undefined
})

watch(modelSub, async (value) => {
  moreSub.value = undefined
  if (value !== MORE_KEY) return
  await nextTick()
  const row = modelMenu.value?.querySelector(`[data-key="${MORE_KEY}"]`)?.getBoundingClientRect()
  if (row && moreMenu.value) morePlace.value = besideRow(row, moreMenu.value.offsetWidth, moreMenu.value.offsetHeight)
})

/* The levels a row offers: none where there is no conversation of this box's to set them on. */
function effortsFor(model: ModelInfo): (Effort | undefined)[] {
  return sessionID.value && !props.side && model.variants.length ? [undefined, ...model.variants] : []
}

/* The pointer moves the keyboard's highlight with it, and opens that row's submenu if it has one. */
function hoverRow(key: string) {
  activeKey.value = key
  modelSub.value = key
}

function modelKey(provider: string, model: string) {
  return `${provider}:${model}`
}

const SMART_KEY = "action:smart"

const currentKey = computed(() => {
  if (smartOn.value) return SMART_KEY
  const chosen = session.value?.model ?? app.config?.model
  return chosen ? modelKey(chosen.provider, chosen.model) : ""
})

/**
 * Every top-level row the arrow keys walk, in the order they are drawn:
 * Smart, the first provider's models, "more models", and configuring models.
 */
const modelKeys = computed(() => {
  const primary = primaryGroup.value
  return [
    SMART_KEY,
    ...(primary ? primary.models.map((model) => modelKey(primary.provider.id, model.id)) : []),
    ...(moreGroups.value.length ? [MORE_KEY] : []),
    CONFIG_KEY,
  ]
})

function scrollActiveIntoView() {
  void nextTick(() => {
    modelMenu.value
      ?.querySelector(`[data-key="${CSS.escape(activeKey.value)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  })
}

function moveActive(by: number) {
  const keys = modelKeys.value
  if (!keys.length) return
  const index = keys.indexOf(activeKey.value)
  const start = index === -1 ? 0 : index
  activeKey.value = keys[(start + by + keys.length) % keys.length]
  modelSub.value = undefined
  scrollActiveIntoView()
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
  if (activeKey.value === MORE_KEY) {
    modelSub.value = MORE_KEY
    return
  }
  if (activeKey.value === SMART_KEY) {
    void chooseSmart()
    return
  }
  const primary = primaryGroup.value
  const model = primary?.models.find((entry) => modelKey(primary.provider.id, entry.id) === activeKey.value)
  if (primary && model) void chooseModel(primary.provider.id, model.id)
}

/*
 * The menu keeps these to itself. Escape has to stop here rather than reach the
 * window, where it would close the panel behind the menu as well.
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
  if (event.altKey || event.metaKey) return
  if (event.key === "ArrowDown") {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === "ArrowUp") {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === "ArrowRight") {
    event.preventDefault()
    modelSub.value = activeKey.value
  } else if (event.key === "ArrowLeft") {
    event.preventDefault()
    modelSub.value = undefined
  } else if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault()
    selectActive()
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
  // No session on the home screen, so the choice is the app's default - which
  // is what the task this box creates will start as.
  if (!sessionID.value) {
    await app.patchConfig({ agent: next })
    return
  }
  await app.setAgent(next)
}

async function chooseModel(provider: string, model: string) {
  menu.value = undefined
  /*
   * On the home screen there is no session to set it on, so the choice is the
   * app's default - which the next task created from here will start with, and
   * which every session already falls back to.
   */
  if (!sessionID.value) {
    await app.patchConfig({ model: { provider, model }, smart: false })
    return
  }
  await app.setModel({ provider, model }, sessionID.value)
}

/* Smart: the model is picked from the conversation's first message. */
async function chooseSmart() {
  menu.value = undefined
  if (!sessionID.value) {
    await app.patchConfig({ smart: true })
    return
  }
  await app.setSmart(sessionID.value)
}

function onPointerDown(event: MouseEvent) {
  if (!pills.value?.contains(event.target as Node)) menu.value = undefined
}

onMounted(() => {
  window.addEventListener("mousedown", onPointerDown, true)
  window.addEventListener("dragend", endDrag)
  document.addEventListener("dragover", onDragOver)
  document.addEventListener("dragleave", onDragLeave)
  document.addEventListener("drop", onDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onPointerDown, true)
  window.removeEventListener("dragend", endDrag)
  document.removeEventListener("dragover", onDragOver)
  document.removeEventListener("dragleave", onDragLeave)
  document.removeEventListener("drop", onDrop)
})

function focus() {
  input.value?.focus()
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
  historyIndex.value = -1
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
  historyIndex.value = -1
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

defineExpose({ focus, insert, mention, openContext, openModelMenu, pick, reset, set, setMode })
</script>

<template>
  <div class="composer" :class="{ noted: sessionID }">
    <div class="shell">
      <div
        class="box"
        :class="{ busy: busyHere, dropping: dragging, filled: attachments.length > 0, resized: manualHeight !== null }"
      >
        <!-- MiMo's handle along the top edge: drag to resize, double-click to reset. -->
        <div
          v-if="resizable !== false"
          class="resize-handle"
          data-resize-handle
          v-tip="{ label: t('composer.resizeHandle'), placement: 'top' }"
          @pointerdown="startResize"
          @pointermove="moveResize"
          @pointerup="endResize"
          @pointercancel="endResize"
          @dblclick="resetResize"
        />
        <!--
          What was gathered, above the text it belongs to.

          One row that scrolls, not a block that wraps: the reference keeps its
          attachments on a single line with a fade at whichever end still has
          more (`prompt-attachments-fade-left/right`, driven by the row's own
          scroll timeline). Wrapping made the box grow a row taller for every
          four files and pushed the conversation up the screen.
        -->
        <div v-if="attachments.length" class="tiles-wrap">
          <span class="tiles-fade start" aria-hidden="true" />
          <span class="tiles-fade end" aria-hidden="true" />
          <div class="tiles">
            <div v-for="(item, at) in attachments" :key="at" class="tile" :class="{ picture: !!preview(item) }">
              <img v-if="preview(item)" :src="preview(item)" class="tile-image" alt="" />
              <svg v-else class="tile-mark" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M13.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5L13.5 3Z"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linejoin="round"
                />
                <path d="M13.4 3.2V9.6H19.8" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              </svg>
              <span class="tile-name" v-tip="{ label: item.path, placement: 'top' }">{{ item.path }}</span>
              <button
                class="tile-x"
                v-tip="{ label: t('attach.remove'), placement: 'top' }"
                @click="remove(at)"
              >
                <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <!--
          The menu, above the text that is narrowing it. Drawn inside the box
          so it moves with the composer rather than floating over the
          conversation at a fixed place.

          Two triggers share the one shape: an @ naming a file and a slash
          naming a command are the same gesture with different subjects, so
          they should not look like two different things. Only one is ever up -
          the @ wins, because its trigger is about the word the caret is in
          while the slash's is about the whole draft, and both can be true.
        -->
        <div v-if="atOpen" class="slash">
          <div class="slash-head">{{ t("composer.context") }}</div>
          <button
            v-for="(path, at) in atMatches"
            :key="path"
            class="slash-row"
            :class="{ on: at === atIndex }"
            @mouseenter="atIndex = at"
            @mousedown.prevent="chooseMention(at)"
          >
            <span class="badge" :style="badgeStyle(fileBadge(fileName(path)))">
              {{ fileBadge(fileName(path)).label }}
            </span>
            <span class="slash-title">{{ fileName(path) }}</span>
            <span v-if="fileDirectory(path)" class="slash-hint">{{ fileDirectory(path) }}</span>
          </button>
        </div>

        <div v-else-if="slashOpen" class="slash">
          <div class="slash-head">{{ t("composer.commands") }}</div>
          <!--
            Nothing matching is a row of its own, not an absent menu: the
            reference keeps the popover up with `prompt.popover.emptyCommands`
            in it, so a name typed wrong says so.
          -->
          <div v-if="!slashMatches.length" class="slash-empty">
            {{ t("prompt.popover.emptyCommands") }}
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

        <textarea
          ref="input"
          v-model="text"
          class="input"
          rows="1"
          spellcheck="false"
          :placeholder="placeholder"
          @keydown.escape="mode === 'shell' && setMode('normal')"
          @keydown="onKeydown"
          @keyup="syncCaret"
          @click="syncCaret"
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

        <div ref="pills" class="row">
          <input ref="picker" class="picker" type="file" multiple @change="onPicked" />
          <!--
            The plus opens a menu rather than a file dialog, as the reference's
            does: adding context is one of the things it offers, not the only
            one. The class stays "attach" so everything that sizes or places
            the button - including the side column's narrow layout - still
            finds it.
          -->
          <div class="pill-wrap">
            <button
              class="attach"
              :class="{ open: menu === 'plus' }"
              :aria-expanded="menu === 'plus'"
              v-tip="{ label: t('composer.attach'), placement: 'top' }"
              @click="toggle('plus')"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
            </button>
            <div v-if="menu === 'plus'" class="menu plus-menu">
              <button class="item" @click="attachFromMenu">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10.6 5.2 6 9.8a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5.2 5.2a4.2 4.2 0 0 0 6 6l4.2-4.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                </svg>
                <span class="item-name">{{ t("composer.attach") }}</span>
              </button>
              <button v-if="!side" class="item" :disabled="!sessionID" @click="terminalFromMenu">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" stroke="currentColor" stroke-width="1.2" />
                  <path d="M4.6 6.4 6.8 8.4 4.6 10.4M8.6 10.6h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                </svg>
                <span class="item-name">{{ t("composer.menuTerminal") }}</span>
              </button>
              <!--
                Plan mode, as a switch beside staged mode now that the bar has
                no agent picker: the chip it raises in the bar turns it off.
              -->
              <button
                v-if="!side"
                class="item staged-row"
                role="switch"
                data-mode="plan"
                :aria-checked="agent === 'plan'"
                @click="chooseAgent(agent === 'plan' ? 'build' : 'plan')"
              >
                <span class="staged-text">
                  <span class="item-name">{{ t("composer.planMode") }}</span>
                  <span class="staged-sub">{{ t("composer.planModeSub") }}</span>
                </span>
                <span class="staged-switch" :class="{ on: agent === 'plan' }"><span class="staged-knob" /></span>
              </button>
              <!--
                Staged mode. A switch rather than a command, because it stays on:
                it changes how the whole conversation is worked, not one reply.
              -->
              <button
                v-if="!side"
                class="item staged-row"
                role="switch"
                :aria-checked="staged"
                @click="toggleStaged"
              >
                <span class="staged-text">
                  <span class="item-name">{{ t("composer.staged") }}</span>
                  <span class="staged-sub">{{ t("composer.stagedSub") }}</span>
                </span>
                <span class="staged-switch" :class="{ on: staged }"><span class="staged-knob" /></span>
              </button>
              <div class="rule" />
              <div class="plus-head">{{ t("composer.menuSkills") }}</div>
              <div class="plus-skills">
                <button
                  v-for="skill in app.commands"
                  :key="skill.name"
                  class="item"
                  :title="skill.description || skill.name"
                  @click="useSkill(skill.name)"
                >
                  <span class="item-name">/{{ skill.name }}</span>
                </button>
                <div v-if="!app.commands.length" class="plus-none">{{ t("composer.menuNoSkills") }}</div>
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
              @click="toggle('access')"
            >
              <svg class="access-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path v-for="d in ACCESS_ICONS[access]" :key="d" :d="d" />
              </svg>
              <span>{{ t(`composer.access.${access}`) }}</span>
              <svg class="caret" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
            <!--
              MiMo's menu: icon, name, and a check at the far end of the chosen
              row. What each level does is on hover, beside the row, rather than
              under every name.
            -->
            <div v-if="menu === 'access'" ref="accessMenu" class="menu access-menu" :class="{ up: menuUp }">
              <button
                v-for="entry in accessChoices"
                :key="entry"
                v-tip="{ label: t(`composer.access.${entry}Hint`), placement: 'right', wrap: true }"
                class="item access-item"
                :class="{ on: entry === access }"
                :data-access="entry"
                @click="chooseAccess(entry)"
              >
                <svg class="access-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path v-for="d in ACCESS_ICONS[entry]" :key="d" :d="d" />
                </svg>
                <span class="item-name">{{ t(entry === "full" ? "composer.access.fullItem" : `composer.access.${entry}`) }}</span>
                <svg class="access-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 8.2 6.4 11.1 12.5 5" />
                </svg>
              </button>
            </div>
          </div>

          <!--
            MiMo keeps no agent switcher in the bar. A mode other than the
            everyday one shows as a chip - plan, or working in stages - and
            pressing the chip turns it off again. Both are switched on from the
            plus menu.
          -->
          <button
            v-if="!side && agent === 'plan'"
            class="mode-chip"
            data-mode="plan"
            v-tip="{ label: t('composer.modeChipTip', { mode: t('composer.planMode') }), placement: 'top' }"
            @click="chooseAgent('build')"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5.5 2.5h5v2h-5z" />
              <path d="M5 3.5H3.5v10h9v-10H11" />
              <path d="M5.5 8h5M5.5 10.5h3.5" />
            </svg>
            <span>{{ t("composer.planChip") }}</span>
          </button>
          <button
            v-if="!side && staged"
            class="mode-chip"
            data-mode="staged"
            v-tip="{ label: t('composer.modeChipTip', { mode: t('composer.staged') }), placement: 'top' }"
            @click="toggleStaged"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 4v6a2 2 0 0 0 2 2h4" />
              <path d="M4.5 1.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z" />
              <path d="M12.2 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z" />
            </svg>
            <span>{{ t("composer.staged") }}</span>
          </button>

          <span class="grow" />

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
              @click="toggle('context')"
            >
              <ContextRing :percent="contextUsage.percent" :size="18" :stroke="2.4" />
            </button>
            <span v-if="contextUsage" class="ctx-card" :class="{ shown: menu === 'context' }" role="status">
              <span class="ctx-title">{{ t("composer.ctxTitle") }}</span>
              <span>{{ contextUsage.shareLine }}</span>
              <span>{{ contextUsage.tokensLine }}</span>
            </span>
          </span>

          <div class="pill-wrap">
            <button class="pill model-pill" :class="{ open: menu === 'model' }" @click="toggle('model')">
              <span class="model-label">{{ modelName }}</span>
              <span v-if="!smartOn && !side && sessionID && variants.length && effortLevel" class="model-effort">{{ effortLevel }}</span>
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
            >
              <button
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

              <div class="rule" />
              <div v-if="groups.length === 0" class="model-empty">
                {{ app.providers.some((p) => p.configured) ? t("model.none") : t("model.needProvider") }}
              </div>

              <template v-for="group in primaryGroup ? [primaryGroup] : []" :key="group.provider.id">
                <ModelMenuRow
                  v-for="model in group.models"
                  :key="model.id"
                  :model="model"
                  :provider="group.provider"
                  :row-key="modelKey(group.provider.id, model.id)"
                  :on="currentKey === modelKey(group.provider.id, model.id)"
                  :hot="activeKey === modelKey(group.provider.id, model.id)"
                  :efforts="effortsFor(model)"
                  :effort="effortLevel"
                  :sub-open="modelSub === modelKey(group.provider.id, model.id)"
                  @enter="hoverRow(modelKey(group.provider.id, model.id))"
                  @choose="chooseModel(group.provider.id, model.id)"
                  @effort="chooseModelEffort(group.provider.id, model.id, $event)"
                />
              </template>

              <div v-if="moreGroups.length" class="more-slot" @mouseenter="hoverRow(MORE_KEY)">
                <button
                  class="item model-item"
                  :class="{ hot: activeKey === MORE_KEY }"
                  :data-key="MORE_KEY"
                  aria-haspopup="menu"
                  :aria-expanded="modelSub === MORE_KEY"
                  @click="modelSub = modelSub === MORE_KEY ? undefined : MORE_KEY"
                >
                  <span class="item-name">{{ t("model.moreModels") }}</span>
                  <svg class="model-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M6.5 4.5 10 8l-3.5 3.5" />
                  </svg>
                </button>
                <div
                  v-if="modelSub === MORE_KEY"
                  ref="moreMenu"
                  class="more-menu"
                  role="menu"
                  :style="{ left: `${morePlace.left}px`, top: `${morePlace.top}px` }"
                  @scroll="moreSub = undefined"
                >
                  <div v-for="group in moreGroups" :key="group.provider.id" class="vendor">
                    <div class="vendor-head">{{ group.provider.name }}</div>
                    <ModelMenuRow
                      v-for="model in group.models"
                      :key="model.id"
                      :model="model"
                      :provider="group.provider"
                      :row-key="modelKey(group.provider.id, model.id)"
                      :on="currentKey === modelKey(group.provider.id, model.id)"
                      :hot="false"
                      :efforts="effortsFor(model)"
                      :effort="effortLevel"
                      :sub-open="moreSub === modelKey(group.provider.id, model.id)"
                      @enter="moreSub = modelKey(group.provider.id, model.id)"
                      @choose="chooseModel(group.provider.id, model.id)"
                      @effort="chooseModelEffort(group.provider.id, model.id, $event)"
                    />
                  </div>
                </div>
              </div>

              <div class="rule" />
              <button
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
            The microphone. Three states and a different shape for each: idle,
            listening, and writing down what it heard. It is drawn even when no
            transcription model is set, and says so when pressed - a control
            that vanishes because of a setting elsewhere is a puzzle.
          -->
          <button
            class="mic"
            :class="{ live: voice === 'recording', busy: voice === 'working' }"
            :disabled="voice === 'working'"
            :aria-label="t('voice.input')"
            :aria-pressed="voice === 'recording'"
            v-tip="{ label: voice === 'recording' ? t('voice.stop') : t('voice.input'), placement: 'top' }"
            @click="toggleVoice"
          >
            <svg v-if="voice === 'recording'" width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" />
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="7.4" y="2.6" width="5.2" height="9.2" rx="2.6" stroke="currentColor" stroke-width="1.3" />
              <path d="M4.8 9.6a5.2 5.2 0 0 0 10.4 0M10 14.8v2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>

          <!--
            One button, which is what the reference has. It stops the turn only
            when there is nothing to send; type during a turn and it becomes
            send again, because a message sent now joins the turn rather than
            replacing it. That is the same capability the pair of buttons was
            there to offer, without the pair - the reference never shows two.
          -->
          <button
            class="send"
            :disabled="!busyHere && !text.trim() && !attachments.length"
            v-tip="{ label: stopping ? t('composer.stop') : t('composer.send'), placement: 'top' }"
            @click="stopping ? app.abort(sessionID) : submit()"
          >
            <!-- The reference's own shapes: a square with square corners, a
                 solid arrow, and a turned arrow while the box runs commands. -->
            <svg v-if="stopping" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="5" y="5" width="10" height="10" fill="currentColor" />
            </svg>
            <svg
              v-else-if="mode === 'shell'"
              width="16"
              height="16"
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
            <svg v-else width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
              <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M9.99991 2.24121L16.0921 8.33343L15.2083 9.21731L10.6249 4.63397V17.5001H9.37492V4.63398L4.7916 9.21731L3.90771 8.33343L9.99991 2.24121Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Under a conversation's box, as MiMo has one: answers are generated, and can be wrong. -->
    <p v-if="sessionID" class="ai-note">{{ t("composer.aiNote") }}</p>

    <Teleport to="body">
      <ConfirmDialog
        v-if="confirmingFull"
        :title="t('composer.access.confirmTitle')"
        :body="t('composer.access.confirmBody')"
        :confirm-label="t('composer.access.confirmOk')"
        @confirm="confirmFull"
        @close="confirmingFull = false"
      />
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * The @ and slash menus float over the conversation just above the box, as
 * MiMo's do: 8 in from either side and 6 clear of its top edge, on a 12px
 * corner with the menu's frosted fill and shadow. The box is what they are
 * placed against, so they move with it.
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
  background: color-mix(in srgb, var(--surface-menu) 92%, transparent);
  border: 0.5px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
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

/*
 * The type mark a file row leads with, the same one the palette and the tree
 * use - a file should not read as a different kind of thing depending on which
 * list it is being offered from.
 */
.badge {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 15px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: calc(8.5px * var(--ui-font-scale, 1));
  font-weight: 530;
}

.slash-title {
  /*
   * Takes the middle of the row so the hint stays against the far edge whether
   * the row has two things on it or three.
   */
  flex: 1;
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
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

.slash-hint {
  /*
   * A keyboard hint is short and must never be clipped; a directory can be
   * half a screen wide, so it gets a ceiling and an ellipsis rather than the
   * right to squeeze the name it belongs to off the row.
   */
  flex-shrink: 0;
  max-width: 55%;
  overflow: hidden;
  color: var(--text-weaker);
  font-family: var(--font-mono);
  font-size: calc(11px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: ltr;
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
  max-width: 776px;
  margin: 0 auto;
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
  .shell {
    /* 1000 less the twelve of padding each side, the way 776 comes off 800. */
    max-width: 976px;
  }
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

/* The tiles are the room now; the writing area need not hold any of its own. */
.box.filled .input {
  min-height: 0;
}

.box:focus-within {
  box-shadow: var(--shadow-md), 0 0 0 1px var(--border-strong);
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
  line-height: 20px;
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

.grow {
  flex: 1;
}

.picker {
  display: none;
}

/* A dropped file has to look like it will land somewhere: MiMo's 2px ring of the accent at 35%. */
.box.dropping {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive) 35%, transparent);
}

.tiles-wrap {
  position: relative;
  timeline-scope: --tiles-scroll;
}

.tiles {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  padding: 12px 16px 0;
  overflow-x: auto;
  scrollbar-width: none;
  scroll-timeline: --tiles-scroll x;
}

.tiles::-webkit-scrollbar {
  display: none;
}

/*
 * A fade at whichever end still has more, over the box's own fill so the row
 * runs out rather than being cut off. Hidden by default and shown by the
 * scroll timeline, which is how the reference drives its pair: the near edge
 * appears as soon as the row has moved at all, and the far one goes at the
 * last pixel (`animation-range: 0 0.1px` and `calc(100% - 1.1px)`).
 */
.tiles-fade {
  position: absolute;
  top: 12px;
  bottom: 0;
  z-index: 1;
  width: 24px;
  pointer-events: none;
  visibility: hidden;
}

.tiles-fade.start {
  inset-inline-start: 0;
  background: linear-gradient(to inline-end, var(--surface-raised), transparent);
}

.tiles-fade.end {
  inset-inline-end: 0;
  background: linear-gradient(to inline-start, var(--surface-raised), transparent);
}

@supports (animation-timeline: --tiles-scroll) and (timeline-scope: --tiles-scroll) {
  .tiles-fade.start {
    animation: tiles-fade-start linear both;
    animation-timeline: --tiles-scroll;
    animation-range: 0 0.1px;
  }

  .tiles-fade.end {
    animation: tiles-fade-end linear both;
    animation-timeline: --tiles-scroll;
    animation-range: calc(100% - 1.1px) calc(100% - 1px);
  }
}

@keyframes tiles-fade-start {
  from {
    visibility: hidden;
  }
  to {
    visibility: visible;
  }
}

@keyframes tiles-fade-end {
  from {
    visibility: visible;
  }
  to {
    visibility: hidden;
  }
}

/* A row that scrolls cannot let its tiles shrink to fit. */
.tiles .tile {
  flex: 0 0 auto;
}

.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 60px;
  height: 60px;
  padding: 6px;
  color: var(--text-weaker);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

/* An image is its own label; the name rides over the foot of it. */
.tile.picture {
  padding: 0;
}

.tile-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile-mark {
  flex-shrink: 0;
}

.tile-name {
  position: relative;
  max-width: 100%;
  overflow: hidden;
  color: var(--text-base);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: 1.25;
}

.tile.picture .tile-name {
  align-self: stretch;
  margin-top: auto;
  padding: 5px 3px 3px;
  color: #fff;
  text-align: start;
  /*
   * Only as much shading as the line of text needs. Sized by the padding above
   * it, this reached the middle of the thumbnail and left the picture murky.
   */
  background: linear-gradient(to top, rgb(0 0 0 / 78%) 55%, transparent);
}

.tile-x {
  position: absolute;
  top: 3px;
  inset-inline-end: 3px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  color: #fff;
  background: rgb(0 0 0 / 55%);
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.12s;
}

.tile:hover .tile-x,
.tile-x:focus-visible {
  opacity: 1;
}

.tile-x:hover {
  background: rgb(0 0 0 / 78%);
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
  height: 16px;
  padding: 0 4px;
  color: var(--text-base);
  background: var(--surface-layer-02);
  border: 0.5px solid var(--border-weak);
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
  margin-inline-end: 2px;
  padding: 0;
  color: var(--icon-base);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.ctx:hover,
.ctx.open {
  background: var(--surface-hover);
}

/*
 * Measured from the reference: centred over the ring, six pixels clear of it,
 * a 20px corner on a hairline, three centred 12px lines. Symmetric about the
 * ring, so it needs no mirroring for right-to-left.
 */
.ctx-card {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  z-index: 20;
  display: none;
  box-sizing: border-box;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 208px;
  padding: 10px 14px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 15px;
  white-space: nowrap;
  color: var(--text-strong);
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 20px;
  transform: translateX(-50%);
  pointer-events: none;
}

.ctx-slot:hover .ctx-card,
.ctx-card.shown {
  display: flex;
}

.ctx-title {
  color: var(--text-base);
}

.mic {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-inline-end: 4px;
  color: var(--icon-base);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.mic:hover:not(:disabled) {
  background: var(--surface-hover);
}

/* Listening says so in the warning hue: the microphone is open. */
.mic.live {
  color: var(--error);
  background: color-mix(in srgb, var(--error) 14%, transparent);
}

.mic.busy {
  opacity: 0.6;
  cursor: default;
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
  height: 28px;
  padding: 0 11px;
  color: var(--text-base);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 20px;
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

.pill.open {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Menus open upward: the pills sit at the bottom of the window. */
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
  min-width: 160px;
  padding: 2px;
  background: var(--surface-menu);
  border-radius: 6px;
  box-shadow: var(--shadow-lg);
}

/*
 * The model menu carries its own padding on each band - search, list, footer -
 * so that the two rules between them can reach the menu's edges. Padding on
 * the menu itself would inset the rules with everything else.
 */
/* The plus menu: its skills scroll rather than growing past the window. */
.menu.plus-menu {
  min-width: 220px;
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
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A two-line row with a switch at its end. */
.item.staged-row {
  height: auto;
  padding-block: 6px;
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
  line-height: 18px;
}

.mode-chip:hover {
  background: var(--surface-selected);
}

.mode-chip svg {
  flex: none;
  width: 13px;
  height: 13px;
}

.mode-chip svg path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.staged-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.staged-sub {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.staged-switch {
  position: relative;
  flex-shrink: 0;
  width: 28px;
  height: 16px;
  background: color-mix(in srgb, var(--text-strong) 22%, var(--surface-raised));
  border-radius: 999px;
  transition: background-color 0.15s;
}

.staged-switch.on {
  background: var(--icon-base);
}

.staged-knob {
  position: absolute;
  top: 2px;
  width: 12px;
  height: 12px;
  background: var(--icon-base);
  border-radius: 50%;
  inset-inline-start: 2px;
  transition: inset-inline-start 0.15s, background-color 0.15s;
}

.staged-switch.on .staged-knob {
  background: var(--surface-raised);
  inset-inline-start: 14px;
}

.plus-head {
  padding: 8px 12px 4px;
  color: var(--text-weak);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
  line-height: 16px;
}

.plus-skills {
  max-height: 180px;
  overflow-y: auto;
}

.plus-none {
  padding: 4px 12px 8px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

/* MiMo's model menu: under the chip at its end, 210 and up, rows of mark, name and check. */
.menu.model-menu {
  top: calc(100% + 4px);
  bottom: auto;
  min-width: 210px;
  max-width: 320px;
  padding: 4px;
  border-radius: 12px;
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

.model-menu .model-item {
  gap: 9px;
  height: auto;
  min-height: 32px;
  padding: 6px 10px;
  border-radius: 8px;
  font-weight: 400;
  line-height: 20px;
}

.model-menu .model-item.on {
  color: var(--text-strong);
  font-weight: 400;
  background: var(--surface-selected);
}

.smart-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
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

.model-check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-inline-start: auto;
  color: var(--text-strong);
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
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

.more-slot {
  position: relative;
}

/* Placed fixed beside its row, so it is never cut off by the composer's edge. */
.more-menu {
  position: fixed;
  z-index: 60;
  min-width: 220px;
  max-height: min(420px, calc(100vh - 16px));
  padding: 4px;
  overflow-y: auto;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
}

.vendor-head {
  padding: 6px 10px 2px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 16px;
}

.model-effort {
  color: var(--text-weak);
  text-transform: capitalize;
}

.model-empty {
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 20px;
  letter-spacing: -0.04px;
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
  height: 28px;
  padding: 0 12px;
  color: var(--text-strong);
  text-align: start;
  border-radius: 4px;
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
  line-height: 20px;
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
  line-height: 14px;
  text-align: center;
}

.shell {
  max-width: 712px;
}

@media (min-width: 1536px) {
  .shell {
    max-width: 712px;
  }
}

.box {
  padding: 8px;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 20px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
}

.box:focus-within {
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4), 0 0 0 0.5px var(--border-strong);
}

.box.dropping {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive) 35%, transparent);
}

.input {
  min-height: 52px;
  padding: 5px 5px 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 21px;
}

.input::placeholder {
  color: var(--text-weak);
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

.tiles {
  padding: 4px 5px 0;
}

.tiles-fade {
  top: 4px;
}

.tiles-fade.start {
  background: linear-gradient(to inline-end, var(--surface-menu), transparent);
}

.tiles-fade.end {
  background: linear-gradient(to inline-start, var(--surface-menu), transparent);
}

/* Measured in MiMo: the first and last buttons twelve in from the card's
   edge, and the bar three clear of its padding at the foot. */
.row {
  gap: 4px;
  height: 32px;
  margin-bottom: 3px;
  padding: 0 4px;
}

/* The controls' grey: the base text colour let most of the way through. */
.attach,
.pill {
  color: color-mix(in srgb, var(--text-base) 87%, transparent);
}

.attach {
  width: 30px;
  height: 30px;
  border-radius: 50%;
}

.pill {
  gap: 4px;
  height: 32px;
  padding: 7px 6px;
  border: 0;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 18px;
}

/* Full access is the one setting on this bar worth noticing, so it is coloured. */
.pill.access.full,
.pill.access.full:hover {
  color: #fb8147;
}

.send {
  width: 30px;
  height: 30px;
  border-radius: 50%;
}

.send:disabled {
  color: var(--surface-base);
  background-color: color-mix(in srgb, var(--text-strong) 26%, var(--surface-menu));
}

/* The pills past the spacer sit at the card's far edge; their menus open inwards. */
.grow ~ .pill-wrap .menu {
  inset-inline-start: auto;
  inset-inline-end: 0;
}

/* MiMo's permission menu: below the chip, 210 wide, 32px rows of icon, name and check. */
.access-menu {
  top: calc(100% + 4px);
  bottom: auto;
  min-width: 210px;
  padding: 4px;
  border-radius: 12px;
}

.access-menu.up {
  top: auto;
  bottom: calc(100% + 4px);
}

.access-icon {
  flex: none;
}

.access-icon path,
.access-check path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.access-item {
  gap: 9px;
  height: 32px;
  padding: 6px 10px;
  border-radius: 8px;
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
  color: var(--text-strong);
  opacity: 0;
}

.access-item.on .access-check {
  opacity: 1;
}
</style>
