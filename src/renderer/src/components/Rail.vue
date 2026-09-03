<script setup lang="ts">
import { computed } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { projectHue, projectName } from "../lib/project"

const emit = defineEmits<{
  select: [payload: { directory: string; anchor: number; menu?: boolean }]
  add: []
  settings: []
  help: []
}>()

const app = useApp()

/**
 * One badge per project directory, newest first. Projects are derived from
 * sessions rather than stored separately - a directory is a project exactly
 * when some session works in it, so there is no second list to keep in sync.
 */
const projects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const named = app.config?.projectNames ?? {}
  const seen = new Map<string, { directory: string; name: string; updated: number }>()
  for (const session of app.sessions) {
    // Archived sessions still count towards the project existing. Skipping them
    // meant archiving the last session erased the project itself - its badge
    // vanished from the rail with no way back except picking the folder again.
    if (closed.has(session.directory)) continue
    const existing = seen.get(session.directory)
    if (existing) {
      existing.updated = Math.max(existing.updated, session.updated)
      continue
    }
    seen.set(session.directory, {
      directory: session.directory,
      name: projectName(session.directory, named),
      updated: session.updated,
    })
  }
  return [...seen.values()].sort((a, b) => b.updated - a.updated)
})

const activeDirectory = computed(() => app.current?.directory)

/** An explicit choice wins; otherwise the hue derived from the path stands. */
function colorOf(directory: string): string {
  return app.config?.projectColors?.[directory] ?? String(projectHue(directory))
}

function iconOf(directory: string): string | undefined {
  return app.config?.projectIcons?.[directory]
}

/** Stable per-project hue so a badge keeps its colour across restarts. */
/** Anchors the panel to the badge that was clicked. */
function pick(event: MouseEvent, directory: string, menu: boolean) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit("select", { directory, anchor: rect.top, menu })
}

function initial(name: string): string {
  return (name.match(/[a-z0-9]/i)?.[0] ?? name[0] ?? "?").toUpperCase()
}
</script>

<template>
  <nav class="rail">
    <div class="stack">
      <button
        v-for="project in projects"
        :key="project.directory"
        class="badge"
        :class="{ active: project.directory === activeDirectory }"
        :style="{ '--h': colorOf(project.directory) }"
        v-tip="project.directory"
        @click="pick($event, project.directory, false)"
        @contextmenu.prevent.stop="pick($event, project.directory, true)"
      >
        <img v-if="iconOf(project.directory)" :src="iconOf(project.directory)" alt="" />
        <template v-else>{{ initial(project.name) }}</template>
      </button>

      <button class="plus" v-tip="{ label: t('rail.openProject'), hint: 'Ctrl+O' }" @click="emit('add')">
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="foot">
      <button class="ico" v-tip="{ label: t('rail.settings'), hint: 'Ctrl+,' }" @click="emit('settings')">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M10 2.2v1.9M10 15.9v1.9M17.8 10h-1.9M4.1 10H2.2M15.5 4.5l-1.35 1.35M5.85 14.15 4.5 15.5M15.5 15.5l-1.35-1.35M5.85 5.85 4.5 4.5"
            stroke="currentColor"
            stroke-width="2.6"
            stroke-linecap="butt"
          />
          <circle cx="10" cy="10" r="5.6" stroke="currentColor" stroke-width="1.5" />
          <circle cx="10" cy="10" r="2.2" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>

      <button class="ico" v-tip="t('rail.help')" @click="emit('help')">
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.2" />
          <path
            d="M8 7.9a2 2 0 1 1 2.6 1.9c-.5.2-.7.6-.7 1.1v.4"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
          <circle cx="10" cy="13.7" r="0.75" fill="currentColor" />
        </svg>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 62px;
  min-width: 62px;
  padding: 8px 0 12px;
  background: var(--surface-base);
}

.stack,
.foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.badge img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.badge {
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  color: #fff;
  /* Hue comes from the path so the colour is stable, not assignment order. */
  background: hsl(var(--h) 42% 46%);
  border: 2px solid transparent;
  border-radius: var(--radius-lg);
  font-size: 14px;
  font-weight: 530;
  transition: border-color 0.12s, transform 0.12s;
}

.badge:hover {
  transform: translateY(-1px);
}

.badge.active {
  border-color: var(--text-strong);
}

.plus,
.ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  color: var(--icon-base);
  border-radius: var(--radius-lg);
  transition: background 0.12s, color 0.12s;
}

.plus:hover,
.ico:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}
</style>
