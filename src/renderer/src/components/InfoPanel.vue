<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { GitSummary } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { dialogOpen } from "../lib/escape-layer"
import { openDocument, openFileInViewer } from "../lib/office-open"
import {
  artifactGroups,
  baseName,
  folderOf,
  infoTasks,
  readSectionsOpen,
  readSubgroupsOpen,
  sessionArtifacts,
  sessionReferences,
  writeSectionsOpen,
  writeSubgroupsOpen,
  type InfoSectionKey,
  type InfoSubgroupKey,
  type SessionArtifact,
} from "../lib/session-info"
import InfoSection from "./InfoSection.vue"
import InfoSubgroup from "./InfoSubgroup.vue"
import InfoEnvironment from "./InfoEnvironment.vue"
import InfoArtifactRow from "./InfoArtifactRow.vue"

/**
 * The card beside a conversation, laid out after Xiaomi MiMo's: the project's
 * git state, the plan the turn is working to, the files the session has
 * produced, and the files it was given or read.
 *
 * The last three are read off the transcript; the first is asked of git while
 * the card is on show. Which sections are folded is remembered per machine.
 */
const props = defineProps<{
  visible: boolean
  /** Floating over a narrow conversation rather than standing beside it. */
  floating?: boolean
  /** The height of whatever is docked along the foot of the conversation. */
  bottomInset?: number
}>()
const emit = defineEmits<{ close: [] }>()

const app = useApp()
const card = ref<HTMLElement>()

const directory = computed(() => app.current?.directory ?? "")
const sessionId = computed(() => app.currentID ?? undefined)

const tasks = computed(() => infoTasks(app.current?.tasks, app.messages, app.busy))
const tasksDone = computed(() => tasks.value.filter((task) => task.status === "done").length)
const artifacts = computed(() => sessionArtifacts(app.messages, directory.value))
const groups = computed(() => artifactGroups(artifacts.value))
const references = computed(() => sessionReferences(app.messages, directory.value))

// ----------------------------------------------------------------- git

const summary = ref<GitSummary>()
/** Bumped by a commit, a push, a branch switch, or the window coming back into focus. */
const nonce = ref(0)

/* What changes the answer: the transcript growing, a file tool finishing, or something done here. */
const fileSteps = computed(
  () =>
    app.messages.reduce(
      (sum, message) =>
        sum +
        (message.role === "assistant"
          ? message.parts.filter((part) => part.type === "tool" && part.status === "completed" && ["write", "edit", "apply_patch", "bash"].includes(part.name)).length
          : 0),
      0,
    ),
)
const refreshKey = computed(() => `${directory.value}|${app.messages.length}|${fileSteps.value}|${nonce.value}`)

let fetchSeq = 0
async function loadSummary() {
  const root = directory.value
  if (!props.visible || !root) return
  const seq = ++fetchSeq
  try {
    const next = await app.client?.request({ type: "git.summary", directory: root })
    if (seq === fetchSeq) summary.value = next
  } catch {
    if (seq === fetchSeq) {
      summary.value = { repo: true, ok: false, detached: false, fileCount: 0, additions: 0, deletions: 0, files: [] }
    }
  }
}

watch(directory, () => {
  fetchSeq += 1
  summary.value = undefined
})
watch([() => props.visible, refreshKey], () => void loadSummary(), { immediate: true })

const onFocus = () => (nonce.value += 1)

// ------------------------------------------------------------- folding

const sections = ref(readSectionsOpen())
const subgroups = ref(readSubgroupsOpen())

function toggleSection(key: InfoSectionKey) {
  sections.value = { ...sections.value, [key]: !sections.value[key] }
  writeSectionsOpen(sections.value)
}

function toggleSubgroup(key: InfoSubgroupKey) {
  subgroups.value = { ...subgroups.value, [key]: !subgroups.value[key] }
  writeSubgroupsOpen(subgroups.value)
}

/*
 * MiMo opens a folded section when its count rises in the conversation on
 * show. A count not known yet (git still answering) and a conversation just
 * switched to, or just loaded, only set the baseline - otherwise every switch
 * would unfold everything that has anything in it.
 */
const counts = computed<Record<InfoSectionKey, number | null>>(() => ({
  environment: summary.value ? (summary.value.repo ? (summary.value.ok ? summary.value.fileCount : 1) : 0) : null,
  tasks: tasks.value.length,
  artifacts: artifacts.value.length,
  sources: references.value.uploads.length + references.value.project.length,
}))

let baseline: { scope: string; counts: Record<InfoSectionKey, number | null> } | undefined
watch(
  [counts, () => `${app.currentID ?? ""}:${app.messages.length > 0}`],
  ([next, scope]) => {
    if (baseline?.scope === scope) {
      let opened = false
      const updated = { ...sections.value }
      for (const key of Object.keys(next) as InfoSectionKey[]) {
        const before = baseline.counts[key]
        const now = next[key]
        if (before !== null && now !== null && now > before && !updated[key]) {
          updated[key] = true
          opened = true
        }
      }
      if (opened) {
        sections.value = updated
        writeSectionsOpen(updated)
      }
    }
    baseline = { scope, counts: { ...next } }
  },
  { immediate: true, flush: "post" },
)

// --------------------------------------------------------------- opening

const isAbsolute = (file: string) => /^([a-zA-Z]:)?[\\/]/.test(file)
const absoluteOf = (file: string) => (isAbsolute(file) || !directory.value ? file : `${directory.value}/${file}`)

/* MiMo opens a produced file in its own preview: web pages and documents in their tabs, the rest in the files tab. */
function openArtifact(artifact: SessionArtifact) {
  void openDocument({ path: absoluteOf(artifact.path), name: baseName(artifact.path) }, directory.value || undefined)
}

function canOpenReference(file: string): boolean {
  return isAbsolute(file) || Boolean(directory.value)
}

function openReference(file: string) {
  if (!canOpenReference(file)) return
  openFileInViewer(absoluteOf(file), directory.value || undefined)
}

// ------------------------------------------------- closing, as MiMo does

function onPointerDown(event: PointerEvent) {
  if (!props.visible || !props.floating) return
  const target = event.target as Element | null
  if (!target || card.value?.contains(target)) return
  // The card's own popovers, and the header button that toggles it, are not "outside".
  if (target.closest?.("[data-info-popover]") || target.closest?.(".ico.info")) return
  emit("close")
}

/*
 * Escape shuts the card when nothing else took it: every menu and confirmation
 * marks the key as taken, and a dialog over the page keeps it. Checked a tick
 * later too, so that every other listener - the window's shortcuts included,
 * whichever registered first - has had its chance to claim the key. A pending
 * permission request keeps the card open.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || !props.visible || dialogOpen()) return
  setTimeout(() => {
    if (event.defaultPrevented || !props.visible || app.permission) return
    if (document.querySelector("[data-info-popover]")) return
    emit("close")
  }, 0)
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("keydown", onKeydown)
  window.addEventListener("focus", onFocus)
})
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown, true)
  window.removeEventListener("keydown", onKeydown)
  window.removeEventListener("focus", onFocus)
})
</script>

<template>
  <Transition name="info-card">
    <aside
      v-if="visible"
      ref="card"
      class="info-card"
      :class="{ floating }"
      :data-info-mode="floating ? 'overlay' : 'inline'"
      :style="bottomInset ? { maxHeight: `calc(100% - ${66 + bottomInset}px)` } : undefined"
      :aria-label="t('info.tip')"
      data-info-card
    >
      <InfoSection
        v-if="summary?.repo"
        name="environment"
        :title="t('info.environment')"
        :open="sections.environment"
        @toggle="toggleSection('environment')"
      >
        <InfoEnvironment :directory="directory" :session-id="sessionId" :summary="summary" :reload-key="refreshKey" @mutated="nonce += 1" />
      </InfoSection>

      <InfoSection
        name="tasks"
        :title="t('info.tasks')"
        :open="sections.tasks"
        :count="tasks.length ? t('info.taskProgress', { done: tasksDone, total: tasks.length }) : undefined"
        :complete="tasks.length > 0 && tasksDone === tasks.length"
        @toggle="toggleSection('tasks')"
      >
        <template v-if="tasks.length">
          <div
            v-for="task in tasks"
            :key="task.id"
            class="task"
            :class="[task.status, { settled: task.status === 'done' }]"
            :style="task.depth ? { paddingInlineStart: `${task.depth * 16}px` } : undefined"
            :title="t(`info.status.${task.status}`)"
            :data-info-task="task.status"
          >
            <svg v-if="task.status === 'in_progress'" class="mark spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
            <svg v-else-if="task.status === 'stalled'" class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
              <path d="M6.5 5.8v4.4M9.5 5.8v4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <svg v-else-if="task.status === 'blocked'" class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
              <path d="M3.6 12.4 12.4 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <svg v-else-if="task.status === 'done'" class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
              <path d="M5.3 8.2 7.2 10l3.5-3.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
            </svg>
            <span class="summary">{{ task.summary }}</span>
          </div>
        </template>
        <p v-else class="empty">{{ t("info.noTasks") }}</p>
      </InfoSection>

      <InfoSection
        name="artifacts"
        :title="t('info.artifacts')"
        :open="sections.artifacts"
        :count="artifacts.length || undefined"
        @toggle="toggleSection('artifacts')"
      >
        <template v-if="artifacts.length">
          <InfoArtifactRow v-for="artifact in groups.shown" :key="artifact.path" :artifact="artifact" @open="openArtifact" />
          <InfoSubgroup
            v-if="groups.more.length"
            name="artifacts.deliverable.more"
            :title="t('info.artifactsMore')"
            :count="groups.more.length"
            :open="subgroups['artifacts.deliverable.more']"
            @toggle="toggleSubgroup('artifacts.deliverable.more')"
          >
            <InfoArtifactRow v-for="artifact in groups.more" :key="artifact.path" :artifact="artifact" @open="openArtifact" />
          </InfoSubgroup>
          <InfoSubgroup
            v-if="groups.intermediate.length"
            name="artifacts.intermediate"
            :title="t('info.artifactsIntermediate')"
            :count="groups.intermediate.length"
            :open="subgroups['artifacts.intermediate']"
            @toggle="toggleSubgroup('artifacts.intermediate')"
          >
            <InfoArtifactRow v-for="artifact in groups.intermediate" :key="artifact.path" :artifact="artifact" @open="openArtifact" />
          </InfoSubgroup>
        </template>
        <p v-else class="empty">{{ t("info.noArtifacts") }}</p>
      </InfoSection>

      <InfoSection
        name="sources"
        :title="t('info.references')"
        :open="sections.sources"
        :count="references.uploads.length + references.project.length || undefined"
        @toggle="toggleSection('sources')"
      >
        <template v-if="references.uploads.length || references.project.length">
          <InfoSubgroup
            v-if="references.uploads.length"
            name="sources.upload"
            :title="t('info.sourcesUpload')"
            :count="references.uploads.length"
            :open="subgroups['sources.upload']"
            @toggle="toggleSubgroup('sources.upload')"
          >
            <component
              :is="canOpenReference(file) ? 'button' : 'div'"
              v-for="file in references.uploads"
              :key="`up-${file}`"
              :type="canOpenReference(file) ? 'button' : undefined"
              class="path"
              :class="{ clickable: canOpenReference(file) }"
              :title="file"
              data-info-reference="upload"
              @click="openReference(file)"
            >
              <span class="path-name">{{ baseName(file) }}</span>
              <span v-if="folderOf(file)" class="path-dir">{{ folderOf(file) }}</span>
            </component>
          </InfoSubgroup>
          <InfoSubgroup
            v-if="references.project.length"
            name="sources.project"
            :title="t('info.projectFiles')"
            :count="references.project.length"
            :open="subgroups['sources.project']"
            @toggle="toggleSubgroup('sources.project')"
          >
            <component
              :is="canOpenReference(file) ? 'button' : 'div'"
              v-for="file in references.project"
              :key="`project-${file}`"
              :type="canOpenReference(file) ? 'button' : undefined"
              class="path"
              :class="{ clickable: canOpenReference(file) }"
              :title="file"
              data-info-reference="project"
              @click="openReference(file)"
            >
              <span class="path-name">{{ baseName(file) }}</span>
              <span v-if="folderOf(file)" class="path-dir">{{ folderOf(file) }}</span>
            </component>
          </InfoSubgroup>
        </template>
        <p v-else class="empty">{{ t("info.noReferences") }}</p>
      </InfoSection>
    </aside>
  </Transition>
</template>

<style scoped>
/*
 * Measured off MiMo's info card beside an open conversation: 280 wide, eight
 * under the header and sixteen in from the window edge, on the workspace's own
 * fill with a half-pixel rule, a 20px corner and the composer's shadow; 14 by
 * 16 of padding. Its outer edge is 24 from the window's: MiMo's 16 of margin
 * plus the scrollbar gutter.
 */
.info-card {
  position: absolute;
  top: 54px;
  inset-inline-end: 24px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  width: 280px;
  max-height: calc(100% - 66px);
  padding-block: 14px;
  padding-inline: 16px;
  overflow-y: auto;
  background: var(--surface-raised);
  border: 0.5px solid var(--border-weak);
  border-radius: 20px;
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.05),
    0 6px 18px rgb(0 0 0 / 0.106);
  /*
   * No scrollbar-width here. Setting it switches Chromium over to the standard
   * scrollbar for this element, which ignores the app's ::-webkit-scrollbar
   * rules and drew the platform bar - arrows and a grey track - down the card.
   */
}

/* Floating over a narrow conversation, above the transcript and the box. */
.info-card.floating {
  z-index: 40;
}

/* MiMo's entrance and exit: a fade with a 12px slide, on its emphasised curve. */
.info-card-enter-active,
.info-card-leave-active {
  transition:
    opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1),
    translate 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.info-card-enter-from,
.info-card-leave-to {
  opacity: 0;
  translate: 12px 0;
}

.info-card-enter-from:dir(rtl),
.info-card-leave-to:dir(rtl) {
  translate: -12px 0;
}

.task {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.mark {
  flex: none;
  margin-top: 2.5px;
  color: var(--text-weak);
}

.task.in_progress .mark {
  color: var(--text-base);
}

.task.blocked .mark {
  color: #d97706;
}

.task.done .mark {
  color: #21a366;
}

.summary {
  min-width: 0;
  line-height: 1.45;
  word-break: break-word;
}

.task.settled .summary {
  color: var(--text-weak);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-decoration-thickness: 1px;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.empty {
  margin: 0;
  color: var(--text-weak);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

/* Two lines: the name at 14, its folder dim at 12. */
.path {
  display: block;
  width: calc(100% + 12px);
  margin-block: -3px;
  margin-inline: -6px;
  padding-block: 3px;
  padding-inline: 6px;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font: inherit;
  text-align: start;
}

.path.clickable:hover {
  background: var(--surface-hover);
}

.path-name,
.path-dir {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path-name {
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.path-dir {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .info-card {
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
  }

  :root:not([data-theme="light"]) .task.blocked .mark {
    color: #d97706;
  }

  :root:not([data-theme="light"]) .task.done .mark {
    color: #21a366;
  }
}

:root[data-theme="dark"] .info-card {
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
}

:root[data-theme="dark"] .task.blocked .mark {
  color: #d97706;
}

:root[data-theme="dark"] .task.done .mark {
  color: #21a366;
}
</style>
