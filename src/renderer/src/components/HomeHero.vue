<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notify, notifyFailure } from "../lib/toast"
import ProjectPicker from "./ProjectPicker.vue"
import type { PickerProject } from "./ProjectPicker.vue"
import RenameDialog from "./RenameDialog.vue"
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
  /** The project a task started from here should go into, when one was named. */
  directory?: string
}>()

/* What the box asks the window for, passed straight through. */
const emit = defineEmits<{
  terminal: []
  "open-settings": [section?: "models"]
  connect: []
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
 * "No project" is a pick of its own rather than the absence of one, so it
 * outlasts the fallbacks below. It cannot be an absolute path, so it cannot
 * collide with a project.
 */
const NO_PROJECT = "mcode:no-project"

/** A folder brought in or made from here, listed until it has a task of its own. */
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

const segments = (directory: string) => directory.split(/[\\/]+/).filter(Boolean)

/*
 * For projects that share a name, the fewest parent folders that tell each
 * apart - "dupA" and "dupB" rather than two full paths - joined the way a path
 * reads. A group that never separates (the same path twice) says nothing.
 */
function hints(group: string[]): Map<string, string> {
  const parents = group.map((directory) => segments(directory).slice(0, -1))
  const deepest = Math.max(...parents.map((parts) => parts.length))
  const result = new Map<string, string>()
  for (let depth = 1; depth <= deepest; depth++) {
    const tails = parents.map((parts) => parts.slice(-depth).join("/"))
    if (new Set(tails).size === tails.length) {
      group.forEach((directory, index) => result.set(directory, tails[index]))
      return result
    }
  }
  return result
}

/* The picker's rows, most recent first; two that share a name each say where they live. */
const pickerProjects = computed<PickerProject[]>(() => {
  const listed = [...projects.value]
  for (const extra of [props.directory, added.value]) {
    if (extra && !listed.includes(extra)) listed.unshift(extra)
  }
  const groups = new Map<string, string[]>()
  for (const entry of listed) groups.set(name(entry), [...(groups.get(name(entry)) ?? []), entry])
  const hinted = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.length > 1) for (const [directory, hint] of hints(group)) hinted.set(directory, hint)
  }
  return listed.map((entry) => ({ directory: entry, name: name(entry), hint: hinted.get(entry) }))
})

function choose(directory: string) {
  picked.value = directory
  box.value?.focus()
}

function none() {
  picked.value = NO_PROJECT
  notify(t("home.noProjectSet"))
}

/* Set while the blank project's name is being asked for. */
const naming = ref(false)

/* A new empty folder under the default project location, which the next task goes into. */
async function createBlank(title: string) {
  naming.value = false
  try {
    const made = await app.client?.request({ type: "project.createBlank", name: title })
    if (!made) return
    added.value = made.directory
    picked.value = made.directory
    box.value?.focus()
  } catch (err) {
    notifyFailure(t("home.blankFailed"), err instanceof Error ? err.message : String(err))
  }
}

async function existing() {
  const [directory] = await window.mcode.pickDirectory(t("home.useExisting"), false)
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

/*
 * The wordmark answers a press with a small hop - a lift, a drop past rest and a
 * settle - and nothing more. A press while it is still in the air is ignored,
 * and with reduced motion it stays put.
 */
const wordmark = ref<HTMLElement>()
const hopping = ref(false)

const HOP: Keyframe[] = [
  { transform: "translateY(0) scale(1, 1)" },
  { transform: "translateY(2px) scale(1.04, 0.92)", offset: 0.12 },
  { transform: "translateY(-12px) scale(0.98, 1.04)", offset: 0.42 },
  { transform: "translateY(0) scale(1.03, 0.95)", offset: 0.7 },
  { transform: "translateY(-3px) scale(1, 1)", offset: 0.85 },
  { transform: "translateY(0) scale(1, 1)" },
]
const HOP_MS = 560

async function hop() {
  const mark = wordmark.value
  if (hopping.value || !mark || typeof mark.animate !== "function") return
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
  hopping.value = true
  const animation = mark.animate(HOP, { duration: HOP_MS, easing: "ease-out" })
  // `finished` can be held by a throttled page, so the hop also ends on its own clock.
  await Promise.race([animation.finished.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, HOP_MS + 120))])
  animation.cancel()
  hopping.value = false
}
</script>

<template>
  <div class="home-hero">
    <div class="drag" aria-hidden="true" />
    <div class="column">
      <div
        ref="wordmark"
        class="wordmark"
        role="img"
        aria-label="MCode"
        :data-hopping="hopping ? 'true' : 'false'"
        @click="hop"
      />
      <p class="slogan">{{ t("home.slogan") }}</p>

      <!-- MiMo's tray: the box, and fastened under it a 40px strip holding the project chip. -->
      <div class="tray">
        <div class="dock-slot">
          <Composer
            ref="box"
            :start-directory="scratch ? undefined : chosen"
            :start-scratch="scratch"
            fresh
            @open-settings="emit('open-settings', $event)"
            @connect="emit('connect')"
            @shell="emit('shell', $event)"
            @terminal="emit('terminal')"
          />
        </div>
        <div class="scope">
          <ProjectPicker
            :projects="pickerProjects"
            :chosen="scratch ? undefined : chosen"
            @choose="choose"
            @none="none"
            @existing="existing"
            @blank="naming = true"
          />
        </div>
      </div>

      <RenameDialog
        v-if="naming"
        :value="t('home.blankDefault')"
        :heading="t('home.blankTitle')"
        :confirm="t('home.blankCreate')"
        @close="naming = false"
        @submit="createBlank"
      />

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
  cursor: pointer;
  transform-origin: 50% 100%;
  -webkit-app-region: no-drag;
}

/* 18/600/28.8 at 0.4px, measured on MiMo's greeting. */
.slogan {
  margin: 22px 0 26px;
  color: var(--text-strong);
  font-size: calc(18px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: 28.8px;
  letter-spacing: 0.4px;
  text-align: center;
}

/* The tray the box sits in: a darker plate of the same corner, with the project strip at its foot. */
.tray {
  width: 100%;
  background: color-mix(in srgb, var(--surface-sunken) 50%, transparent);
  border-radius: 20px;
}

/* Where the box lands on this screen; the composer brings its own shape. */
.dock-slot {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.tray :deep(.composer) {
  padding: 0;
}

.scope {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  height: 40px;
  padding-block: 0;
  padding-inline: 6px 10px;
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
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 20px;
}

.starter-note {
  overflow: hidden;
  min-width: 0;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
