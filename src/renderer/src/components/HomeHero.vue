<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { HomeSuggestion } from "@shared/protocol"
import { useApp } from "../stores/app"
import { language, t } from "../lib/i18n"
import { notify, notifyFailure } from "../lib/toast"
import { SUGGESTION_ICON_PATHS, builtinSuggestions, rememberedSuggestions } from "../lib/home-suggestions"
import ProjectPicker from "./ProjectPicker.vue"
import type { PickerProject } from "./ProjectPicker.vue"
import NewProjectDialog from "./NewProjectDialog.vue"
import BranchPicker from "./BranchPicker.vue"
import Composer from "./Composer.vue"

/**
 * The 2.0 home screen: what a new task starts from.
 *
 * Laid out from Xiaomi MiMo's, measured: a scrolling grid of three rows, the
 * middle one holding a line of greeting over a 712-wide composer card (#1f1f1f
 * on the dark scheme, radius 20, a half-pixel line and a soft drop shadow) with
 * a picker for the project underneath, and the example tasks hanging in the
 * row below - so they never move the card when they change. The greeting is
 * MCode's own, and so is the mark above it.
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
  /** The project folder picked here, or nothing for a task without one. */
  directory: [directory?: string]
}>()

const app = useApp()

const name = (directory: string) =>
  app.config?.projectNames?.[directory] || directory.split(/[\\/]/).filter(Boolean).pop() || directory

/*
 * The stored project list, most recent first, where "recent" is the later of
 * the project's newest task and when it was last picked here - MiMo's picker
 * lists by the pick, so a project just chosen comes first even before it has a task.
 */
const projects = computed(() => app.projects)

const picked = ref<string>()

/*
 * "No project" is a pick of its own rather than the absence of one, so it
 * outlasts the fallbacks below. It cannot be an absolute path, so it cannot
 * collide with a project.
 */
const NO_PROJECT = "mcode:no-project"

/** A folder picked here that may not be on the project list, such as another worktree of a project. */
const added = ref<string>()

/*
 * What the next task will be created in: whatever the reader last picked here,
 * else what the window asked for, else the project used most recently.
 */
const chosen = computed(() => picked.value ?? props.directory ?? projects.value[0] ?? undefined)

/* A fresh request from the window replaces a stale pick from a previous visit. */
watch(
  () => props.directory,
  () => (picked.value = undefined),
)
/*
 * Whether the task this screen starts works in a folder of its own.
 *
 * Picking 不使用项目 is one way in; having no project at all is the other. A
 * fresh profile used to fall back to `config.directory`, which is the folder
 * the app happened to be launched from: the first message went to work there
 * and that folder was adopted as a project, while the chip still read 进入项目
 * 工作. MiMo has no such fallback - with no project it simply starts a task
 * that has none - so neither does this.
 */
const scratch = computed(() => chosen.value === NO_PROJECT || !chosen.value)

/* Told to the window, so its bottom panel can open a terminal in that folder before any task exists. */
watch(chosen, (value) => emit("directory", value === NO_PROJECT ? undefined : value), { immediate: true })

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

/* Remembered in config, so the picker lists this project first next time. */
function markUsed(directory: string) {
  void app.patchConfig({ projectUsed: { ...(app.config?.projectUsed ?? {}), [directory]: Date.now() } }).catch(() => {})
}

/*
 * MiMo opens its sidebar when a project is browsed to. The side column belongs
 * to the window, so it is asked for rather than reached into.
 */
function revealSide() {
  window.dispatchEvent(new CustomEvent("mcode:reveal-side"))
}

/* MiMo's browseProject: the pick, its place at the top of the list, the sidebar, and a toast naming it. */
function choose(directory: string) {
  picked.value = directory
  markUsed(directory)
  revealSide()
  notify(t("home.currentProject", { name: name(directory) }))
  box.value?.focus()
}

/* A branch already checked out in another worktree: the next task goes into that worktree. */
function useWorktree(directory: string) {
  added.value = directory
  choose(directory)
}

function none() {
  picked.value = NO_PROJECT
  notify(t("home.noProjectSet"))
}

/* Set while the blank project's name is being asked for. */
const naming = ref(false)

/* A folder brought in or made here becomes the pick, is remembered, and opens the side column as MiMo's does. */
function take(directory: string) {
  added.value = directory
  picked.value = directory
  markUsed(directory)
  revealSide()
  box.value?.focus()
}

/*
 * The dialog's answer: with a source folder, that folder under the name given;
 * without, a new empty folder under the default project location. Either way
 * the next task goes into it.
 */
async function createBlank(title: string, source?: string) {
  naming.value = false
  if (source) {
    await app.addProject(source, { switched: true })
    const folderName = source.split(/[\\/]/).filter(Boolean).pop()
    if (title !== folderName) await app.patchConfig({ projectNames: { ...(app.config?.projectNames ?? {}), [source]: title } })
    take(source)
    return
  }
  try {
    const made = await app.client?.request({ type: "project.createBlank", name: title })
    if (!made) return
    await app.addProject(made.directory, { switched: true })
    take(made.directory)
  } catch (err) {
    // DL13: MiMo's one line, 「创建失败：{error}」.
    notifyFailure(t("home.blankFailed", { error: err instanceof Error ? err.message : String(err) }))
  }
}

async function existing() {
  const [directory] = await window.mcode.pickProjectFolder(t("dialog.pickProjectFolder"), false)
  if (!directory) return
  // Onto the project list, or back onto it if it was removed, with no conversation made.
  await app.addProject(directory, { switched: true })
  take(directory)
}

/** The box below, so a starting point can be put into it rather than run. */
const box = ref<InstanceType<typeof Composer>>()

/* The slash menu on this screen lists the chosen project's commands, so they are read per project. */
watch(chosen, (next) => next && next !== NO_PROJECT && void app.refreshCommands(next), { immediate: true })

/*
 * MiMo's example tasks under the tray: shown only once a project is chosen.
 * MCode's own three are there at once; the three the model writes for that
 * project (asked once per project) replace them when they arrive, and if none
 * come the built-in ones stay. A click puts the task's request into the box
 * without sending it.
 */
const hasProject = computed(() => Boolean(chosen.value) && chosen.value !== NO_PROJECT)
const suggestions = ref<HomeSuggestion[]>([])

watch(
  () => [chosen.value, language.value, Boolean(app.client)] as const,
  async ([directory, lang]) => {
    if (!directory || directory === NO_PROJECT) {
      suggestions.value = []
      return
    }
    suggestions.value = builtinSuggestions((key) => t(key))
    const client = app.client
    if (!client) return
    const rows = await rememberedSuggestions(directory, lang, async () => {
      const result = await client.request({ type: "home.suggest", directory, language: lang })
      return result.suggestions
    })
    // A newer pick may have overtaken this answer.
    if (chosen.value !== directory || language.value !== lang) return
    if (rows.length) suggestions.value = rows
  },
  { immediate: true },
)

function start(suggestion: HomeSuggestion) {
  // A task's request names no files, so it carries no chips and no mentions.
  box.value?.set({ text: suggestion.query, attachments: [], mentioned: new Set() })
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
    <div class="core">
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
          <BranchPicker :directory="scratch ? undefined : chosen" @worktree="useWorktree" />
        </div>
      </div>

      <NewProjectDialog v-if="naming" :value="t('home.blankDefault')" @close="naming = false" @submit="createBlank" />
    </div>

    <!-- The row under the tray, which is the order MiMo reads in: the box, what it points at, and what you might start with. -->
    <div v-if="hasProject && suggestions.length" id="home-suggest" class="home-suggest" :aria-label="t('home.starters')">
      <button
        v-for="item in suggestions"
        :key="item.title"
        class="sug"
        type="button"
        :data-sug="item.title"
        @click="start(item)"
      >
        <svg class="sug-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-for="d in SUGGESTION_ICON_PATHS[item.icon]" :key="d" :d="d" />
        </svg>
        <span class="sug-t">{{ item.title }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * MiMo's home layout: a scroll area whose content is a three-row grid, the
 * hero and tray centred in the middle row and the suggestions hanging from the
 * top of the last one, both lifted 64px. The two outer rows share what is left,
 * so the tray sits where it sits however many suggestions there are.
 */
.home-hero {
  position: relative;
  display: grid;
  flex: 1;
  grid-template-rows: minmax(0, 1fr) auto minmax(0, 1fr);
  justify-items: center;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 28px 60px;
}

/* With no header on this screen, the top strip is what drags the window. */
.drag {
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  -webkit-app-region: drag;
}

/*
 * Lifted by a relative offset rather than a transform: a transform would hold
 * the composer's fixed submenus to this box instead of the window.
 */
.core {
  position: relative;
  top: -64px;
  display: flex;
  flex-direction: column;
  grid-row: 2;
  align-items: center;
  align-self: center;
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

/* MiMo's suggestion list: 8 under the tray, at the top of the last row, lifted with it. */
.home-suggest {
  position: relative;
  top: -64px;
  display: flex;
  flex-direction: column;
  grid-row: 3;
  align-self: start;
  width: min(712px, 100%);
  margin-top: 8px;
}

/* A row: 34 in at the start, icon and title 11 apart, 13/20 in the muted text colour. */
.sug {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding-block: 10px;
  padding-inline: 34px 8px;
  color: var(--text-base);
  background: none;
  border: 0;
  font-family: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 20px;
  text-align: start;
  cursor: pointer;
}

/* A dotted hairline, 2 on and 2 off, across the top of every row but the first, held to the column. */
.sug::before {
  content: "";
  position: absolute;
  top: 0;
  inset-inline: 0;
  height: 1px;
  background: var(--border-weak);
  -webkit-mask: repeating-linear-gradient(90deg, #000 0 2px, transparent 2px 4px);
  mask: repeating-linear-gradient(90deg, #000 0 2px, transparent 2px 4px);
  pointer-events: none;
}

.sug:first-child::before {
  display: none;
}

.sug:hover {
  color: var(--text-strong);
}

.sug:hover .sug-t {
  text-decoration: underline;
}

.sug-icon {
  flex: none;
  color: var(--text-weak);
  opacity: 0.7;
}

.sug-icon path {
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.sug-t {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* MiMo's wide window: the tray grows to 944 and the suggestions with it. */
@media (min-width: 2000px) {
  .core,
  .home-suggest {
    width: min(944px, 100%);
  }
}
</style>
