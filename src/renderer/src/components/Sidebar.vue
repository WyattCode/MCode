<script setup lang="ts">
import { computed, ref } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

/**
 * The 2.0 side column.
 *
 * Laid out from Xiaomi MiMo's window, measured over its debugging port: 256
 * wide on the deepest surface, a 44px row of window controls at the top that
 * also drags the window, the name, the main destinations as 240x38 rows, then
 * two collapsible lists - projects with their tasks under them, and recent
 * tasks - and the settings row at the foot. Only the layout and the numbers
 * are theirs; the icons, the name and the wording are MCode's own.
 *
 * MCode has no task outside a project - every session is opened in a folder -
 * so "Recent" is every task by when it last changed, across projects, which
 * is the view a project-less list would otherwise give.
 */
/** Which page the pane is showing, so the row that opened it stays lit. */
defineProps<{ page?: string }>()

const emit = defineEmits<{
  artifacts: []
  newTask: []
  plugins: []
  search: []
  back: []
  forward: []
  toggle: []
  browse: []
  open: [sessionID: string]
  createIn: [directory: string]
  settings: []
}>()

const app = useApp()

const RECENT_LIMIT = 12

const name = (directory: string) =>
  app.config?.projectNames?.[directory] || directory.split(/[\\/]/).filter(Boolean).pop() || directory

const title = (text?: string) => (text && text.trim() ? text : t("side.newTask"))

const projects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const byDirectory = new Map<string, { directory: string; updated: number; sessions: typeof app.sessions }>()
  for (const session of app.sessions) {
    if (session.archived || closed.has(session.directory)) continue
    const entry = byDirectory.get(session.directory) ?? { directory: session.directory, updated: 0, sessions: [] }
    entry.updated = Math.max(entry.updated, session.updated)
    entry.sessions.push(session)
    byDirectory.set(session.directory, entry)
  }
  return [...byDirectory.values()]
    .map((entry) => ({ ...entry, sessions: [...entry.sessions].sort((a, b) => b.updated - a.updated) }))
    .sort((a, b) => b.updated - a.updated)
})

const recent = computed(() =>
  app.sessions
    .filter((session) => !session.archived)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, RECENT_LIMIT),
)

const projectsOpen = ref(true)
const recentOpen = ref(true)
/** Which projects show their tasks. The one holding the open task always does. */
const expanded = ref(new Set<string>())
const isExpanded = (directory: string) =>
  expanded.value.has(directory) || app.current?.directory === directory
function toggleProject(directory: string) {
  const next = new Set(expanded.value)
  if (next.has(directory)) next.delete(directory)
  else next.add(directory)
  expanded.value = next
}
</script>

<template>
  <aside class="side">
    <div class="top">
      <button class="ico" :aria-label="t('side.toggle')" v-tip="{ label: t('side.toggle'), hint: 'Ctrl+B', placement: 'bottom' }" @click="emit('toggle')">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="3" y="3.5" width="14" height="13" rx="2" stroke="currentColor" />
          <path d="M8 3.5V16.5" stroke="currentColor" />
        </svg>
      </button>
      <button class="ico" :aria-label="t('title.back')" v-tip="{ label: t('title.back'), hint: 'Ctrl+[', placement: 'bottom' }" @click="emit('back')">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M16 10H4.5M9 5L4 10L9 15" stroke="currentColor" stroke-linecap="square" />
        </svg>
      </button>
      <button class="ico" :aria-label="t('title.forward')" v-tip="{ label: t('title.forward'), hint: 'Ctrl+]', placement: 'bottom' }" @click="emit('forward')">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4 10H15.5M11 5L16 10L11 15" stroke="currentColor" stroke-linecap="square" />
        </svg>
      </button>
      <button class="ico" :aria-label="t('side.search')" v-tip="{ label: t('side.search'), hint: 'Ctrl+K', placement: 'bottom' }" @click="emit('search')">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="5.5" stroke="currentColor" />
          <path d="M13 13L16.5 16.5" stroke="currentColor" stroke-linecap="square" />
        </svg>
      </button>
    </div>

    <div class="brand">
      <span class="brand-name">MCode</span>
      <span class="badge">2.0</span>
    </div>

    <nav class="nav">
      <button class="row" @click="emit('newTask')">
        <svg class="row-ico" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7" stroke="currentColor" />
          <path d="M10 6.5V13.5M6.5 10H13.5" stroke="currentColor" stroke-linecap="square" />
        </svg>
        <span class="row-label">{{ t("side.newTask") }}</span>
      </button>
      <button class="row" @click="emit('plugins')">
        <svg class="row-ico" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M8 3.5H12V6.5H15.5V16.5H4.5V6.5H8V3.5Z" stroke="currentColor" stroke-linejoin="round" />
          <path d="M8 11H12" stroke="currentColor" stroke-linecap="square" />
        </svg>
        <span class="row-label">{{ t("side.plugins") }}</span>
      </button>

      <!-- Third, where MiMo keeps it: new task, plugins, then what came out. -->
      <button class="row" :class="{ on: page === 'artifacts' }" @click="emit('artifacts')">
        <svg class="row-ico" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M2.9 11.5h3.4l1 1.9h5.4l1-1.9h3.4M2.9 11.5 5 4.6h10l2.1 6.9M2.9 11.5v3.9h14.2v-3.9"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>
        <span class="row-label">{{ t("side.artifacts") }}</span>
      </button>
    </nav>

    <div class="lists">
      <div class="section">
        <button class="section-head" :aria-expanded="projectsOpen" @click="projectsOpen = !projectsOpen">
          <span>{{ t("side.projects") }}</span>
          <svg class="chev" :class="{ shut: !projectsOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
          </svg>
        </button>
        <button class="ico add" :aria-label="t('side.newProject')" v-tip="{ label: t('side.newProject'), hint: 'Ctrl+O' }" @click="emit('browse')">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 5V15M5 10H15" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </button>
      </div>
      <template v-if="projectsOpen">
        <template v-for="project in projects" :key="project.directory">
          <div class="row project" :class="{ on: app.current?.directory === project.directory && !isExpanded(project.directory) }">
            <button class="project-toggle" v-tip="{ label: project.directory, placement: 'right' }" @click="toggleProject(project.directory)">
              <svg class="row-ico" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3.5 5.5H8L9.5 7H16.5V15H3.5V5.5Z" stroke="currentColor" stroke-linejoin="round" />
              </svg>
              <span class="row-label plain">{{ name(project.directory) }}</span>
            </button>
            <button class="ico inline" :aria-label="t('side.newTask')" v-tip="{ label: t('side.newTask') }" @click="emit('createIn', project.directory)">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 5V15M5 10H15" stroke="currentColor" stroke-linecap="square" />
              </svg>
            </button>
          </div>
          <template v-if="isExpanded(project.directory)">
            <button
              v-for="session in project.sessions.slice(0, 8)"
              :key="session.id"
              class="row task"
              :class="{ on: app.currentID === session.id }"
              @click="emit('open', session.id)"
            >
              <span class="row-label task-label">{{ title(session.title) }}</span>
            </button>
          </template>
        </template>
      </template>

      <div class="section">
        <button class="section-head" :aria-expanded="recentOpen" @click="recentOpen = !recentOpen">
          <span>{{ t("side.recent") }}</span>
          <svg class="chev" :class="{ shut: !recentOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
          </svg>
        </button>
      </div>
      <template v-if="recentOpen">
        <div v-if="recent.length === 0" class="empty">{{ t("side.noTasks") }}</div>
        <button
          v-for="session in recent"
          :key="session.id"
          class="row task"
          :class="{ on: app.currentID === session.id }"
          @click="emit('open', session.id)"
        >
          <span class="row-label task-label">{{ title(session.title) }}</span>
        </button>
      </template>
    </div>

    <div class="foot">
      <button class="row" @click="emit('settings')">
        <span class="avatar" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="2.5" stroke="currentColor" />
            <path d="M10 3.5V5.5M10 14.5V16.5M3.5 10H5.5M14.5 10H16.5M5.4 5.4L6.8 6.8M13.2 13.2L14.6 14.6M5.4 14.6L6.8 13.2M13.2 6.8L14.6 5.4" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </span>
        <span class="row-label plain">{{ t("rail.settings") }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* Numbers from Xiaomi MiMo's side column, measured in CSS pixels. */
.side {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 256px;
  height: 100%;
  background: var(--surface-base);
  color: var(--text-strong);
  font-size: 14px;
  user-select: none;
}

/* The window-control row: 44 tall, buttons 24x24 at 32px pitch from x=65.
   It drags the window; the buttons opt out. */
.top {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 8px;
  height: 44px;
  padding-block: 13px 0;
  padding-inline: 65px 8px;
  -webkit-app-region: drag;
}

.ico {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text-base);
  border-radius: 7px;
  -webkit-app-region: no-drag;
  transition: background var(--motion-fast, 0.12s), color var(--motion-fast, 0.12s);
}

.ico:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* The name row: 28 tall, 14 in from the 8px inset. */
.brand {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  height: 28px;
  margin: 0 8px;
  padding-inline-start: 14px;
}

.brand-name {
  color: var(--text-strong);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 7px;
  color: #ffffff;
  background: #2a3f52;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14px;
}

.nav {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 2px;
  margin: 8px 8px 0;
}

/* A destination: 240x38, radius 8, icon 14 in, label 14 after it. */
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 38px;
  padding: 0 14px;
  color: var(--text-strong);
  border-radius: 8px;
  text-align: start;
  transition: background var(--motion-fast, 0.12s);
}

.row:hover {
  background: var(--surface-hover);
}

.row.on {
  background: var(--surface-selected);
}

.row-ico {
  flex-shrink: 0;
}

.row-label {
  overflow: hidden;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-label.plain {
  font-weight: 400;
  line-height: 22px;
}

.lists {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  margin: 0 8px;
  overflow-y: auto;
}

/* A list heading: 12/500 in the secondary colour, 9 in from the inset. */
.section {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  margin-top: 36px;
  padding: 0 7px 0 9px;
}

.section + .row,
.section + .empty {
  margin-top: 6px;
}

.section-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-base);
  font-size: 12px;
  font-weight: 500;
  /* Normal, as MiMo's heading is: 15 tall, where the inherited 24 made it 24. */
  line-height: normal;
}

.chev {
  transition: transform var(--motion-fast, 0.12s);
}

.chev.shut {
  transform: rotate(-90deg);
}

.add {
  width: 24px;
  height: 24px;
}

.project {
  padding-inline-end: 6px;
}

.project-toggle {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 14px;
  min-width: 0;
  color: inherit;
  text-align: start;
}

.ico.inline {
  opacity: 0;
}

.project:hover .ico.inline,
.ico.inline:focus-visible {
  opacity: 1;
}

/* A task sits under its project's name, in a softer white. */
.task {
  padding-inline-start: 46px;
}

.task-label {
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
  font-weight: 400;
  line-height: 22px;
}

.empty {
  padding: 7px 9px;
  color: var(--text-weak);
  font-size: 12px;
  line-height: 19.2px;
}

/* The foot row sits 10 above the window's bottom edge. */
.foot {
  flex-shrink: 0;
  margin: 8px 8px 10px;
}

.avatar {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 26px;
  height: 26px;
  margin-inline-start: -4px;
  color: var(--text-base);
  background: var(--surface-layer);
  border-radius: 50%;
}
</style>
