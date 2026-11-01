<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import type { RightTab } from "../../stores/right-panel"
import { useRightPanel } from "../../stores/right-panel"
import { useOfficeVersions } from "../../stores/office-versions"
import { useApp } from "../../stores/app"
import { fileManagerName } from "../../lib/path-open"
import { annotationId, annotationRequest, requestAnnotation, type AnnotationRequest } from "../../lib/annotate"
import { sendAnnotationNow } from "../../lib/annotation-send"
import { aiTouch, aiWrite, normalPath } from "../../lib/ai-touch"
import { splitFilePath } from "../../lib/file-path"
import { dismiss, notify, notifyFailure, toastID } from "../../lib/toast"
import { t } from "../../lib/i18n"
import { useAnnotations } from "../../stores/annotations"
import { ANNOTATION_LIMIT } from "@shared/annotations"
import LucideIcon from "../LucideIcon.vue"
import VersionHistory from "./VersionHistory.vue"
import ViewerAiNote from "./ViewerAiNote.vue"

/**
 * MiMo's web page tab: the page served from its own folder (so its scripts,
 * styles and pictures load) in a frame, under a head with the globe, the name,
 * the edit toggle, undo, redo, history, open in browser and open folder.
 *
 * With edit mode on, the page outlines the module under the pointer; a click
 * picks it and a drag boxes a region, and the annotation box opens beside it -
 * send posts it into the conversation the page came from at once, "add to
 * chat" puts it in the box. The page reloads when the assistant writes it or a
 * file beside it, the write kept as a version; not when it changes otherwise.
 */
const props = defineProps<{ tab: RightTab; active: boolean }>()
const rp = useRightPanel()
const versions = useOfficeVersions()
const app = useApp()

const path = computed(() => props.tab.htmlPath ?? "")
const url = ref("")
/* Why there is no page: MiMo says 无网页 for a page that is gone or cannot be served; a server that did not start keeps its own words. */
const failed = ref<"" | "missing" | "server">("")
const reloads = ref(0)
const frame = ref<HTMLIFrameElement>()
/* Whether the pointer is over the page, learned from the frame element's own enter and leave - which the page cannot fake. */
const pointerOver = ref(false)
const nonce =`${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

const origin = computed(() => {
  try {
    return url.value ? new URL(url.value).origin : ""
  } catch {
    return ""
  }
})
const src = computed(() => (url.value ? `${url.value}?__mcodeedit=${nonce}&__r=${reloads.value}` : ""))

const splitPath = (file = path.value) => splitFilePath(file)

let lastStat: { size: number; mtimeMs: number } | undefined
let lastComment = ""

async function runInit(file: string) {
  const [dir, base] = splitPath(file)
  const read = await window.mcode.readFileBytes(dir, base)
  if (!read.ok || read.unchanged) return
  if (file === path.value) lastStat = { size: read.size, mtimeMs: read.mtimeMs }
  const { ai, prompt } = aiTouch(file, 60_000)
  await versions.init(file, read.base64, { assumeAi: ai, note: ai ? prompt.trim() : t("office.versionNoteExternal") })
}

/* One init per page at a time: opening the tab, making a note and sending it all ask, and would otherwise race. */
const initing = new Map<string, Promise<void>>()

function initVersions(): Promise<void> {
  const file = path.value
  let running = initing.get(file)
  if (!running) {
    running = runInit(file).finally(() => initing.delete(file))
    initing.set(file, running)
  }
  return running
}

/* Versions exist before the first annotation, so the assistant's edit it leads to can be undone. */
async function ensureVersions() {
  if (!versions.byPath[path.value]?.versions.length) await initVersions()
}

async function prepare() {
  url.value = ""
  failed.value = ""
  if (!path.value) return
  const served = await window.mcode.officeServe(path.value)
  if (!served.ok) {
    failed.value = served.error === "serverFailed" ? "server" : "missing"
    return
  }
  url.value = served.url
  await initVersions()
}

watch(path, () => void prepare(), { immediate: true })
watch(
  () => versions.reloadTick[path.value] ?? 0,
  (next, previous) => {
    if (next !== previous) reloads.value += 1
  },
)

/* ------------------------------------------------------------ talking to the page */

function post(message: Record<string, unknown>) {
  const target = frame.value?.contentWindow
  if (target && origin.value) target.postMessage({ __mcodeEdit: nonce, ...message }, origin.value)
}

const postEditMode = () => post({ type: "editMode", on: Boolean(props.tab.htmlEdit) })

watch([() => props.tab.htmlEdit, origin, reloads], () => {
  postEditMode()
  if (!props.tab.htmlEdit) dropBox()
})

let ownRequest: AnnotationRequest | null = null

function dropBox() {
  if (ownRequest && annotationRequest.value === ownRequest) requestAnnotation(null)
  ownRequest = null
}

interface Picked {
  selector: string
  tag: string
  text: string
  rect: { left: number; top: number; right: number; bottom: number }
}

function buildNote(picked: Picked, comment: string): Annotation {
  return {
    id: annotationId(),
    kind: "html",
    path: path.value,
    name: props.tab.name || "网页",
    selector: picked.selector,
    tag: picked.tag,
    ...(picked.text ? { quote: picked.text } : {}),
    text: comment.trim(),
  }
}

async function sendNow(note: Annotation) {
  ownRequest = null
  lastComment = note.text
  await ensureVersions()
  const result = await sendAnnotationNow(note, path.value, note.text, { origin: props.tab.origin })
  if (!result.ok && result.reason) notifyFailure(result.reason)
}

const annotations = useAnnotations()
/* Notes the box handed straight to sendNow, which it never adds to the box. */
const sentAtOnce = new Set<string>()

/*
 * MiMo's page tab: stashing a note the box refuses at the limit says
 * 批注数量已达上限. The box adds synchronously after make, so by the next
 * microtask a stashed note is either in the store or was refused. MiMo's one
 * notice slot leaves the page's words over the box's own limit notice.
 */
function sayIfRefused(note: Annotation) {
  queueMicrotask(() => {
    if (sentAtOnce.delete(note.id)) return
    if (Object.values(annotations.byScope).some((list) => list.some((item) => item.id === note.id))) return
    dismiss(toastID("danger", t("composer.annotationLimit", { max: ANNOTATION_LIMIT })))
    notifyFailure(t("html.annotateFull"))
    // MiMo closes the box either way; the pick stays outlined in the page.
    dropBox()
  })
}

function openBox(picked: Picked) {
  const box = frame.value?.getBoundingClientRect()
  if (!box) return
  const request: AnnotationRequest = {
    rect: { left: box.left + picked.rect.left, top: box.top + picked.rect.top, right: box.left + picked.rect.right, bottom: box.top + picked.rect.bottom },
    initialText: "",
    make: (comment) => {
      lastComment = comment.trim()
      void ensureVersions()
      const note = buildNote(picked, comment)
      sayIfRefused(note)
      return note
    },
    sendNow: (note) => {
      sentAtOnce.add(note.id)
      void sendNow(note)
    },
    onClose: () => post({ type: "clearSel" }),
  }
  ownRequest = request
  requestAnnotation(request)
}

function onMessage(event: MessageEvent) {
  // The nonce is in the page's own address, so the page could forge it: only this frame's window counts.
  if (!origin.value || event.origin !== origin.value || !frame.value || event.source !== frame.value.contentWindow) return
  const data = event.data as { __mcodeEdit?: string; type?: string } & Partial<Picked>
  if (!data || data.__mcodeEdit !== nonce) return
  if (data.type === "ready") postEditMode()
  else if (data.type === "clear") dropBox()
  /*
   * A real pick is a press in the page, so the pointer is over the frame. The
   * page can post on its own and even focus itself, but it cannot move the
   * pointer onto the frame: a pick posted while the pointer is elsewhere (the
   * user typing in the box, say) is ignored.
   */
  else if (data.type === "select" && props.tab.htmlEdit && data.rect && pointerOver.value) {
    openBox({ selector: String(data.selector ?? ""), tag: String(data.tag ?? ""), text: String(data.text ?? ""), rect: data.rect })
  }
}

/* ------------------------------------------------------------ the assistant's writes */

/* One batch can hold the page and files beside it: reload once, and keep a version when the page itself is among them. */
watch(aiWrite, async (write) => {
  if (!write || !path.value) return
  const page = normalPath(path.value)
  const folder = page.slice(0, page.lastIndexOf("/") + 1)
  const files = write.files.map(normalPath)
  const beside = files.some((file) => file !== page && file.startsWith(folder))
  if (!files.includes(page)) {
    if (beside) reloads.value += 1
    return
  }
  const [dir, base] = splitPath()
  try {
    const read = await window.mcode.readFileBytes(dir, base, lastStat)
    if (read.ok && read.unchanged) {
      if (beside) reloads.value += 1
      return
    }
    dropBox()
    if (read.ok) {
      lastStat = { size: read.size, mtimeMs: read.mtimeMs }
      const { prompt } = aiTouch(path.value)
      await versions.record(path.value, read.base64, "ai_local", prompt.trim() || lastComment)
    }
  } catch (err) {
    console.error("[HtmlTab] record AI version error:", err)
  }
  reloads.value += 1
})

/* ------------------------------------------------------------ head */

const history = ref<DOMRect | null>(null)
function toggleHistory(event: MouseEvent) {
  history.value = history.value ? null : (event.currentTarget as HTMLElement).getBoundingClientRect()
}

async function reveal() {
  const result = await window.mcode.revealPath(path.value)
  // MiMo names the platform's file manager; the generic wording is only for a platform not yet known.
  if (result.ok) notify(app.platform ? t("menu.revealedIn", { manager: fileManagerName(app.platform) }) : t("office.revealed"))
  else notifyFailure(t("office.revealFail", { err: result.error ?? "" }))
}

function openInBrowser() {
  if (url.value) window.mcode.openExternal(url.value)
}

watch(
  () => props.active,
  (active) => {
    if (!active) dropBox()
  },
)

onMounted(() => window.addEventListener("message", onMessage))
onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage)
  dropBox()
})
</script>

<template>
  <div class="html-tab" data-rp-html :data-edit-mode="tab.htmlEdit ? 'on' : 'off'">
    <div v-if="!path" class="html-empty">{{ t("html.noPage") }}</div>
    <template v-else>
      <div class="html-head">
        <span class="html-globe"><LucideIcon name="globe" :size="16" /></span>
        <span class="html-name">{{ tab.name }}</span>
        <button
          type="button"
          class="fc-btn html-edit"
          data-html-edit-toggle
          :aria-pressed="tab.htmlEdit ? 'true' : 'false'"
          :aria-label="tab.htmlEdit ? t('html.exitEdit') : t('html.edit')"
          :class="{ on: tab.htmlEdit }"
          v-tip="{ label: tab.htmlEdit ? t('html.exitEdit') : t('html.edit') }"
          @click="rp.toggleHtmlEdit(tab.id)"
        >
          <!-- MiMo's pen: a long baseline, a ferrule tick, and the nib at the bottom left. -->
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-html-edit-glyph>
            <path d="M12 22.2h9.6M15 4.8l4.2 3.6M4.2 15.6 16.03 3.36a3.29 3.29 0 0 1 4.61 4.61L8.4 19.8l-6 1.8Z" />
          </svg>
        </button>
        <button
          type="button"
          class="fc-btn"
          data-office-undo
          :title="t('office.undo')"
          :aria-label="t('office.undo')"
          :disabled="!versions.canUndo(path)"
          :style="versions.canUndo(path) ? undefined : { opacity: 0.4 }"
          @click="versions.undo(path)"
        >
          <LucideIcon name="undo-2" :size="15" />
        </button>
        <button
          type="button"
          class="fc-btn"
          data-office-redo
          :title="t('office.redo')"
          :aria-label="t('office.redo')"
          :disabled="!versions.canRedo(path)"
          :style="versions.canRedo(path) ? undefined : { opacity: 0.4 }"
          @click="versions.redo(path)"
        >
          <LucideIcon name="redo-2" :size="15" />
        </button>
        <button
          type="button"
          class="fc-btn"
          data-office-history
          :title="t('office.history')"
          :aria-label="t('office.history')"
          aria-haspopup="dialog"
          :aria-expanded="history ? 'true' : 'false'"
          @click="toggleHistory"
        >
          <LucideIcon name="history" :size="15" />
        </button>
        <!-- MiMo's button is never disabled: it opens whatever the tab is showing. -->
        <button type="button" class="fc-btn" data-html-open-browser :title="t('html.openBrowser')" :aria-label="t('html.openBrowser')" @click="openInBrowser">
          <LucideIcon name="external-link" :size="15" />
        </button>
        <button type="button" class="fc-btn" data-office-folder :title="t('office.openFolder')" :aria-label="t('office.openFolder')" @click="reveal">
          <LucideIcon name="folder-open" :size="15" />
        </button>
      </div>
      <div v-if="tab.htmlEdit" class="html-hint" data-html-edit-hint>{{ t("html.editHint") }}</div>
      <div class="html-body">
        <!-- No top navigation and no popups: a served page must never be able to take over the app's window. -->
        <iframe
          v-if="src"
          ref="frame"
          class="rp-html-frame"
          :title="tab.name"
          :src="src"
          sandbox="allow-scripts allow-modals allow-downloads"
          :data-pointer-over="pointerOver ? 'true' : 'false'"
          @mouseenter="pointerOver = true"
          @mouseleave="pointerOver = false"
        />
        <div v-else class="html-empty" data-html-empty>
          {{ failed === "missing" ? t("html.noPage") : failed === "server" ? t("office.serveFailed") : t("office.loadingConvert") }}
        </div>
      </div>
      <!-- MiMo 26.920's footer line under every document view. -->
      <ViewerAiNote viewer="html" />
      <VersionHistory v-if="history" :path="path" :anchor="history" @close="history = null" />
    </template>
  </div>
</template>

<style scoped>
.html-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--text-strong);
  background: var(--surface-raised);
}

.html-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 20px;
  color: var(--text-base);
  font-size: 13px;
  text-align: center;
}

.html-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-weak);
}

.html-globe {
  display: flex;
  flex-shrink: 0;
  color: #4f46e5;
}

.html-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's .fc-btn with the tab's override: 5 by 8, a 1px line on an 8px corner. */
.fc-btn {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  color: var(--text-body);
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

/* As MiMo's rule, which also fills a disabled button under the pointer and dims it to .55. */
.fc-btn:hover {
  background: var(--surface-hover);
}

.fc-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.fc-btn:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: -2px;
}

.fc-btn.html-edit {
  border-radius: 7px;
}

.fc-btn.html-edit.on,
.fc-btn.html-edit.on:hover {
  color: #fff;
  background: #3295fb;
  border-color: transparent;
}

.html-hint {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 10px;
  color: #fff;
  background: color-mix(in srgb, #4f46e5 90%, black);
  border-bottom: 1px solid var(--border-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.html-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #fff;
}

.rp-html-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  background: #fff;
  border: none;
}
</style>
