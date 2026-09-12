<script setup lang="ts">
import { computed, ref } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"
import { latestTodos, sessionFiles } from "../lib/session-info"

/**
 * The card beside a conversation, laid out after Xiaomi MiMo's: the plan the
 * turn is working to, the files the session has produced, and the files it
 * has read.
 *
 * All three are read off the transcript. Nothing here is stored; a session
 * opened on another machine shows the same card, and one that has done nothing
 * yet says so in each section rather than hiding the section.
 */
const app = useApp()

const todos = computed(() => latestTodos(app.messages))
const done = computed(() => todos.value.filter((todo) => todo.status === "completed").length)
const directory = computed(() => app.current?.directory ?? "")
const files = computed(() => sessionFiles(app.messages, directory.value))

type Section = "tasks" | "artifacts" | "references"
const shut = ref<Record<Section, boolean>>({ tasks: false, artifacts: false, references: false })
const projectFilesOpen = ref(false)

function base(file: string): string {
  const at = file.lastIndexOf("/")
  return at === -1 ? file : file.slice(at + 1)
}

function folder(file: string): string {
  const at = file.lastIndexOf("/")
  return at === -1 ? "" : file.slice(0, at)
}

/** Handed to the desktop's own choice of app, the way the file tree's Open is. */
async function open(file: string) {
  if (!directory.value) return
  const refused = await window.mcode.openFile(directory.value, file)
  if (refused) notifyFailure(t("info.openFailed"), refused)
}
</script>

<template>
  <aside class="info" :aria-label="t('info.toggle')">
    <section class="section">
      <button class="head" :aria-expanded="!shut.tasks" @click="shut.tasks = !shut.tasks">
        <span class="head-label">{{ t("info.tasks") }}</span>
        <svg class="chev" :class="{ shut: shut.tasks }" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="todos.length" class="count progress">{{ done }}/{{ todos.length }}</span>
      </button>
      <template v-if="!shut.tasks">
        <ul v-if="todos.length" class="tasks">
          <li v-for="todo in todos" :key="todo.id" class="task" :class="todo.status">
            <svg v-if="todo.status === 'completed'" class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
              <path d="M5.3 8.2 7.2 10l3.5-3.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else-if="todo.status === 'in_progress'" class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
              <circle cx="8" cy="8" r="2.6" fill="currentColor" />
            </svg>
            <svg v-else-if="todo.status === 'cancelled'" class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
              <path d="M5.4 8h5.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <svg v-else class="mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3" />
            </svg>
            <span class="task-text">{{ todo.content }}</span>
          </li>
        </ul>
        <p v-else class="empty">{{ t("info.noTasks") }}</p>
      </template>
    </section>

    <section class="section">
      <button class="head" :aria-expanded="!shut.artifacts" @click="shut.artifacts = !shut.artifacts">
        <span class="head-label">{{ t("info.artifacts") }}</span>
        <svg class="chev" :class="{ shut: shut.artifacts }" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="files.written.length" class="count">{{ files.written.length }}</span>
      </button>
      <template v-if="!shut.artifacts">
        <div v-if="files.written.length" class="files">
          <button v-for="file in files.written" :key="file.path" class="file" :title="file.path" @click="open(file.path)">
            <svg class="file-mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 1.8h5.2L12.5 5v9.2H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              <path d="M9 1.8V5.2h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            <span class="file-name">{{ base(file.path) }}</span>
            <span class="file-dir">{{ folder(file.path) }}</span>
          </button>
        </div>
        <p v-else class="empty">{{ t("info.noArtifacts") }}</p>
      </template>
    </section>

    <section class="section">
      <button class="head" :aria-expanded="!shut.references" @click="shut.references = !shut.references">
        <span class="head-label">{{ t("info.references") }}</span>
        <svg class="chev" :class="{ shut: shut.references }" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="files.read.length" class="count">{{ files.read.length }}</span>
      </button>
      <template v-if="!shut.references">
        <template v-if="files.read.length">
          <button class="group" :aria-expanded="projectFilesOpen" @click="projectFilesOpen = !projectFilesOpen">
            <svg class="group-chev" :class="{ open: projectFilesOpen }" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="group-label">{{ t("info.projectFiles") }}</span>
            <span class="group-count">{{ files.read.length }}</span>
          </button>
          <div v-if="projectFilesOpen" class="files nested">
            <button v-for="file in files.read" :key="file.path" class="file" :title="file.path" @click="open(file.path)">
              <span class="file-name">{{ base(file.path) }}</span>
              <span class="file-dir">{{ folder(file.path) }}</span>
            </button>
          </div>
        </template>
        <p v-else class="empty">{{ t("info.noReferences") }}</p>
      </template>
    </section>
  </aside>
</template>

<style scoped>
/*
 * Measured off MiMo's info card beside an open conversation: 280 wide, eight
 * under the header and sixteen in from the window edge, on the workspace's own
 * fill with a half-pixel rule, a 20px corner and a shallow shadow; 14 by 16 of
 * padding, and each section after the first opened by a rule. Its outer edge
 * is 24 from the window's: MiMo's 16 of margin plus the scrollbar gutter.
 */
.info {
  position: absolute;
  top: 54px;
  inset-inline-end: 24px;
  z-index: 2;
  width: 280px;
  max-height: calc(100% - 66px);
  padding: 14px 16px;
  overflow-y: auto;
  background: var(--surface-raised);
  border: 0.5px solid var(--border-weak);
  border-radius: 20px;
  /*
   * Weighted per scheme. A shadow is a hole in the light, and how dark a hole
   * may be depends on how bright the room is: 40% black under a white card is
   * a smudge, while the same value under a near-black one is barely a lift.
   */
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
  scrollbar-width: thin;
}

.section + .section {
  margin-top: 13px;
  padding-top: 14px;
  border-top: 1px solid var(--border-weak);
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  text-align: start;
}

.chev {
  flex-shrink: 0;
  color: var(--text-weak);
  transition: transform 0.12s;
}

.chev.shut {
  transform: rotate(-90deg);
}

.count {
  height: 16px;
  margin-inline-start: auto;
  padding: 0 6px;
  color: var(--text-weak);
  background: color-mix(in srgb, var(--text-strong) 9.5%, var(--surface-raised));
  border-radius: 999px;
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}

.count.progress {
  color: #21a366;
  background: rgb(33 163 102 / 0.12);
}

.tasks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.task {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--text-base);
  font-size: 14px;
  font-weight: 400;
  line-height: 20.3px;
}

.mark {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--text-weak);
}

.task.completed .mark {
  color: #21a366;
}

.task.in_progress {
  color: var(--text-strong);
}

.task.in_progress .mark {
  color: var(--interactive);
}

.task.completed .task-text,
.task.cancelled .task-text {
  color: var(--text-weak);
  text-decoration: line-through;
}

.task-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.empty {
  margin: 6px 0 0;
  color: var(--text-weak);
  font-size: 14px;
  line-height: 22.4px;
}

.files {
  display: flex;
  flex-direction: column;
  margin-top: 6px;
}

.files.nested {
  margin-top: 2px;
  padding-inline-start: 17px;
}

.file {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 28px;
  margin-inline: -6px;
  padding: 0 6px;
  color: var(--text-base);
  border-radius: 7px;
  font-size: 13px;
  text-align: start;
}

.file:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.file-mark {
  flex-shrink: 0;
  color: var(--text-weak);
}

.file-name {
  flex-shrink: 0;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-dir {
  min-width: 0;
  overflow: hidden;
  color: var(--text-weak);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  margin-top: 6px;
  color: var(--text-weak);
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  text-align: start;
}

.group:hover {
  color: var(--text-base);
}

.group-chev {
  flex-shrink: 0;
  transition: transform 0.12s;
}

.group-chev.open {
  transform: rotate(90deg);
}

.group-count {
  margin-inline-start: auto;
  padding-inline-end: 6px;
  font-size: 12px;
  font-weight: 400;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .info {
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
  }
}

:root[data-theme="dark"] .info {
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
}
</style>
