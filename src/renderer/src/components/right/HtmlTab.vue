<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import type { RightTab } from "../../stores/right-panel"
import { useRightPanel } from "../../stores/right-panel"
import { useOfficeVersions } from "../../stores/office-versions"
import { annotationId, annotationRequest, requestAnnotation, type AnnotationRequest } from "../../lib/annotate"
import { sendAnnotationNow } from "../../lib/annotation-send"
import { aiTouch, aiWrite } from "../../lib/ai-touch"
import { notify, notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"
import LucideIcon from "../LucideIcon.vue"
import VersionHistory from "./VersionHistory.vue"

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

const path = computed(() => props.tab.htmlPath ?? "")
const url = ref("")
const failed = ref(false)
const reloads = ref(0)
const frame = ref<HTMLIFrameElement>()
const nonce = `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

const origin = computed(() => {
  try {
    return url.value ? new URL(url.value).origin : ""
  } catch {
    return ""
  }
})
const src = computed(() => (url.value ? `${url.value}?__mcodeedit=${nonce}&__r=${reloads.value}` : ""))

const splitPath = () => {
  const cut = Math.max(path.value.lastIndexOf("/"), path.value.lastIndexOf("\\"))
  return [path.value.slice(0, cut), path.value.slice(cut + 1)] as const
}

let lastStat: { size: number; mtimeMs: number } | undefined
let lastComment = ""

async function initVersions() {
  const [dir, base] = splitPath()
  const read = await window.mcode.readFileBytes(dir, base)
  if (!read.ok || read.unchanged) return
  lastStat = { size: read.size, mtimeMs: read.mtimeMs }
  const { ai, prompt } = aiTouch(path.value, 60_000)
  await versions.init(path.value, read.base64, { assumeAi: ai, note: ai ? prompt.trim() : t("office.versionNoteExternal") })
}

/* Versions exist before the first annotation, so the assistant's edit it leads to can be undone. */
async function ensureVersions() {
  if (!versions.byPath[path.value]?.versions.length) await initVersions()
}

async function prepare() {
  url.value = ""
  failed.value = false
  if (!path.value) return
  const served = await window.mcode.officeServe(path.value)
  if (!served.ok) {
    failed.value = true
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

function openBox(picked: Picked) {
  const box = frame.value?.getBoundingClientRect()
  if (!box) return
  const request: AnnotationRequest = {
    rect: { left: box.left + picked.rect.left, top: box.top + picked.rect.top, right: box.left + picked.rect.right, bottom: box.top + picked.rect.bottom },
    initialText: "",
    make: (comment) => {
      lastComment = comment.trim()
      void ensureVersions()
      return buildNote(picked, comment)
    },
    sendNow: (note) => void sendNow(note),
    onClose: () => post({ type: "clearSel" }),
  }
  ownRequest = request
  requestAnnotation(request)
}

function onMessage(event: MessageEvent) {
  if (!origin.value || event.origin !== origin.value) return
  const data = event.data as { __mcodeEdit?: string; type?: string } & Partial<Picked>
  if (!data || data.__mcodeEdit !== nonce) return
  if (data.type === "ready") postEditMode()
  else if (data.type === "clear") dropBox()
  else if (data.type === "select" && props.tab.htmlEdit && data.rect) {
    openBox({ selector: String(data.selector ?? ""), tag: String(data.tag ?? ""), text: String(data.text ?? ""), rect: data.rect })
  }
}

/* ------------------------------------------------------------ the assistant's writes */

const normal = (file: string) => file.replace(/\\/g, "/").toLowerCase()

watch(aiWrite, async (write) => {
  if (!write || !path.value) return
  const file = normal(write.file)
  const page = normal(path.value)
  if (file !== page) {
    if (file.startsWith(page.slice(0, page.lastIndexOf("/") + 1))) reloads.value += 1
    return
  }
  const [dir, base] = splitPath()
  try {
    const read = await window.mcode.readFileBytes(dir, base, lastStat)
    if (read.ok && read.unchanged) return
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
  if (result.ok) notify(t("office.revealed"))
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
          :class="{ on: tab.htmlEdit }"
          v-tip="{ label: tab.htmlEdit ? t('html.exitEdit') : t('html.edit'), placement: 'bottom' }"
          @click="rp.toggleHtmlEdit(tab.id)"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
        <button
          type="button"
          class="fc-btn"
          data-office-undo
          :title="t('office.undo')"
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
          :disabled="!versions.canRedo(path)"
          :style="versions.canRedo(path) ? undefined : { opacity: 0.4 }"
          @click="versions.redo(path)"
        >
          <LucideIcon name="redo-2" :size="15" />
        </button>
        <button type="button" class="fc-btn" data-office-history :title="t('office.history')" @click="toggleHistory">
          <LucideIcon name="history" :size="15" />
        </button>
        <button type="button" class="fc-btn" data-html-open-browser :title="t('html.openBrowser')" :disabled="!url" @click="openInBrowser">
          <LucideIcon name="external-link" :size="15" />
        </button>
        <button type="button" class="fc-btn" data-office-folder :title="t('office.openFolder')" @click="reveal">
          <LucideIcon name="folder-open" :size="15" />
        </button>
      </div>
      <div v-if="tab.htmlEdit" class="html-hint" data-html-edit-hint>{{ t("html.editHint") }}</div>
      <div class="html-body">
        <iframe v-if="src" ref="frame" class="rp-html-frame" :title="tab.name" :src="src" />
        <div v-else class="html-empty">{{ failed ? t("office.serveFailed") : t("office.loadingConvert") }}</div>
      </div>
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
  color: var(--text-weak);
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
  justify-content: center;
  padding: 5px 8px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.fc-btn:hover:not(:disabled) {
  background: var(--surface-hover);
}

.fc-btn:disabled {
  cursor: default;
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
