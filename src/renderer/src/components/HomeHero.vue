<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import SelectMenu from "./SelectMenu.vue"
import Composer from "./Composer.vue"

/**
 * The 2.0 home screen: what a new task starts from.
 *
 * Laid out from Xiaomi MiMo's, measured: a centred column with a line of
 * greeting over a 712-wide composer card (#1f1f1f on the dark scheme, radius
 * 20, a half-pixel line and a soft drop shadow), and under it a picker for
 * the project the task goes into. The greeting is MCode's own, and so is the
 * mark above it.
 *
 * The box is the real composer - the same component a conversation carries,
 * with the same controls. MiMo lets you type here and creates the task when the
 * message is sent rather than when the screen opens, so looking at this screen
 * no longer leaves an empty session behind it; the picker underneath says which
 * project that task will be created in.
 */
const props = defineProps<{
  commands?: { id: string; title: string; hint?: string; run: () => void }[]
  /** The project a task started from here should go into, when one was named. */
  directory?: string
}>()

/* What the box asks the window for, passed straight through. */
const emit = defineEmits<{
  terminal: []
  "open-settings": []
  connect: []
  "manage-models": []
  shell: [command: string]
}>()

const app = useApp()

const name = (directory: string) =>
  app.config?.projectNames?.[directory] || directory.split(/[\\/]/).filter(Boolean).pop() || directory

const projects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const latest = new Map<string, number>()
  for (const session of app.sessions) {
    if (session.scratch || closed.has(session.directory)) continue
    latest.set(session.directory, Math.max(latest.get(session.directory) ?? 0, session.updated))
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([directory]) => directory)
})

const picked = ref<string>()

/*
 * The picker's two rows that are not projects, as the reference has them under
 * its list: one to bring a folder in, one to start with none. Neither value can
 * be an absolute path, so neither can collide with a project.
 */
const ADD_PROJECT = "mcode:add-project"
const NO_PROJECT = "mcode:no-project"

/** A folder brought in from here, listed until it has a task of its own. */
const added = ref<string>()

/*
 * What the next task will be created in: whatever the reader last picked here,
 * else what the window asked for, else the project used most recently.
 */
const chosen = computed(
  () => picked.value ?? props.directory ?? projects.value[0] ?? app.config?.directory ?? undefined,
)

/* A fresh request from the window replaces a stale pick from a previous visit. */
watch(
  () => props.directory,
  () => (picked.value = undefined),
)
/* Whether the task this screen starts works in a folder of its own. */
const scratch = computed(() => chosen.value === NO_PROJECT)

const options = computed(() => {
  const listed = [...projects.value]
  for (const extra of [props.directory, added.value]) {
    if (extra && !listed.includes(extra)) listed.unshift(extra)
  }
  return [
    ...listed.map((entry) => ({ value: entry, label: name(entry) })),
    { value: ADD_PROJECT, label: t("home.newProject"), divider: listed.length > 0 },
    { value: NO_PROJECT, label: t("home.noProject") },
  ]
})

async function pick(value: string) {
  if (value !== ADD_PROJECT) {
    picked.value = value
    return
  }
  const [directory] = await window.mcode.pickDirectory(t("home.newProject"), false)
  if (!directory) return
  // Bringing back a folder that was closed opens it again, as opening it does.
  const closed = app.config?.closedProjects ?? []
  if (closed.includes(directory)) {
    await app.patchConfig({ closedProjects: closed.filter((entry) => entry !== directory) })
  }
  added.value = directory
  picked.value = directory
  box.value?.focus()
}

/** The box below, so a starting point can be put into it rather than run. */
const box = ref<InstanceType<typeof Composer>>()

/*
 * What the chosen project offers to start from.
 *
 * MiMo lists example tasks of its own here; this lists the commands and skills
 * the project itself carries, which is the same offer made out of something
 * real. They are read per project, so changing the picker re-reads them.
 */
const starters = computed(() => app.commands.slice(0, 3))

watch(chosen, (next) => next && next !== NO_PROJECT && void app.refreshCommands(next), { immediate: true })

function start(name: string) {
  // A starting point names no files, so it carries no chips and no mentions.
  box.value?.set({ text: `/${name} `, attachments: [], mentioned: new Set() })
  box.value?.focus()
}
</script>

<template>
  <div class="home-hero">
    <div class="drag" aria-hidden="true" />
    <div class="column">
      <div class="wordmark" role="img" aria-label="MCode" />
      <p class="slogan">{{ t("home.slogan") }}</p>

      <div class="dock-slot">
        <Composer
          ref="box"
          :commands="commands"
          :start-directory="scratch ? undefined : chosen"
          :start-scratch="scratch"
          fresh
          @open-settings="emit('open-settings')"
          @connect="emit('connect')"
          @manage-models="emit('manage-models')"
          @shell="emit('shell', $event)"
          @terminal="emit('terminal')"
        />
      </div>

      <div class="enter">
        <SelectMenu
          :model-value="chosen ?? ''"
          :options="options"
          :aria-label="t('home.enterProject')"
          @update:model-value="pick"
        >
          <template #icon>
            <svg class="folder" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M1.9 4.2c0-.6.5-1.1 1.1-1.1h2.6l1.3 1.5h6.1c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
          </template>
        </SelectMenu>
      </div>

      <!-- Under the project row, which is the order MiMo reads in: the box,
           what it points at, and then what you might start with. -->
      <div v-if="starters.length" class="starters" :aria-label="t('home.starters')">
        <button v-for="command in starters" :key="command.name" class="starter" @click="start(command.name)">
          <svg class="starter-mark" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.8 4.2h10.4M2.8 8h10.4M2.8 11.8h6.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          <span class="starter-name">/{{ command.name }}</span>
          <span v-if="command.description" class="starter-note">{{ command.description }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-hero {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 0 24px 12vh;
}

/* With no header on this screen, the top strip is what drags the window. */
.drag {
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  -webkit-app-region: drag;
}

.column {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(712px, 100%);
}

.wordmark {
  width: 132px;
  height: 36px;
  background: var(--wordmark) center / contain no-repeat;
  opacity: 0.92;
}

/* 18/600/28.8 at 0.4px, measured on MiMo's greeting. */
.slogan {
  margin: 22px 0 26px;
  color: var(--text-strong);
  font-size: 18px;
  font-weight: 600;
  line-height: 28.8px;
  letter-spacing: 0.4px;
  text-align: center;
}

/* Where the box lands on this screen; the composer brings its own shape. */
.dock-slot {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.enter {
  align-self: flex-start;
  margin-top: 12px;
}

/* Under the box, as MiMo keeps them: a row each, parted by a dashed rule. */
.starters {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  margin-top: 14px;
}

.starter {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: 46px;
  padding: 0 8px;
  color: var(--text-strong);
  border-bottom: 1px dashed var(--border-weak);
  border-radius: 8px;
  text-align: start;
}

.starter:last-child {
  border-bottom: 0;
}

.starter:hover {
  background: var(--surface-hover);
}

.starter-mark {
  flex-shrink: 0;
  color: var(--text-weak);
}

.starter-name {
  flex-shrink: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}

.folder {
  flex-shrink: 0;
  color: var(--text-weak);
}

.starter-note {
  overflow: hidden;
  min-width: 0;
  color: var(--text-weak);
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
