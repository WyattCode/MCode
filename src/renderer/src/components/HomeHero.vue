<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { pickProjectFolder } from "../lib/native-pick"
import { notify, notifyFailure } from "../lib/toast"
import { reducedMotion } from "../lib/modal"
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

/*
 * Held by the window rather than by this screen.
 *
 * MiMo's project pick - 不使用项目 included - is a navigation state, so opening
 * a conversation and coming back finds the same answer. This screen is
 * unmounted the moment a conversation opens, which is how an explicit
 * 不使用项目 used to be forgotten and the next message fell back into the last
 * project used.
 */
const picked = computed({
  get: () => app.homeProject,
  set: (value?: string) => (app.homeProject = value),
})

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

/*
 * A project the window names - one opened from the side column - replaces the
 * pick. Leaving the home screen and coming back does not: the window then says
 * nothing new, and the reader's own answer stands.
 */
watch(
  () => props.directory,
  (next, before) => {
    if (next && next !== before) picked.value = undefined
  },
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

/**
 * A branch already checked out in another worktree: the next task goes into
 * that worktree.
 *
 * MiMo's scope store adds the worktree to the project list before it browses to
 * it. Without that step the folder was only this screen's pick: it left the
 * picker the moment the home screen did, never appeared on the environment
 * page, and conversations started in it were filed under the main repository
 * instead of under the worktree, which is a project of its own in MiMo.
 */
async function useWorktree(directory: string) {
  added.value = directory
  try {
    await app.addProject(directory, { used: true })
  } catch (err) {
    notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
    return
  }
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
    if (!made) {
      notifyFailure(t("home.blankFailed", { error: t("common.requestFailed") }))
      return
    }
    await app.addProject(made.directory, { switched: true })
    take(made.directory)
  } catch (err) {
    // DL13: MiMo's one line, 「创建失败：{error}」.
    notifyFailure(t("home.blankFailed", { error: err instanceof Error ? err.message : String(err) }))
  }
}

async function existing() {
  const [directory] = await pickProjectFolder(t("dialog.pickProjectFolder"), false)
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
  // The appearance setting first, as everywhere else: a Web Animation is beyond the reach of the stylesheet that turns CSS motion off.
  if (reducedMotion()) return
  hopping.value = true
  const animation = mark.animate(HOP, { duration: HOP_MS, easing: "ease-out" })
  // `finished` can be held by a throttled page, so the hop also ends on its own clock.
  await Promise.race([animation.finished.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, HOP_MS + 120))])
  animation.cancel()
  hopping.value = false
}

/* The window's new task puts the keyboard in this box, as MiMo's newChatGlobal does. */
defineExpose({ focus: () => box.value?.focus() })
</script>

<template>
  <div class="home-hero">
    <div class="drag" aria-hidden="true" />
    <div class="core">
      <!--
        MiMo's hero: a fixed 527 x 299 block pulled 48 into the tray below it,
        the mark centred at 49.95%, and the greeting absolutely placed at 65.5%
        of its height. MiMo fills the block with a background drawing; the user
        looked at MCode's own (a blueprint of dashed guides) on 2026-09-24 and
        chose a bare block instead, so nothing is drawn behind the mark. The
        mark itself is MCode's wordmark rather than MiMo's app icon.
      -->
      <div class="hero" data-home-hero>
        <div class="mark-slot">
          <div
            ref="wordmark"
            class="wordmark"
            role="img"
            aria-label="MCode"
            :data-hopping="hopping ? 'true' : 'false'"
            @click="hop"
          />
        </div>
        <p class="slogan">{{ t("home.slogan") }}</p>
      </div>

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
  </div>
</template>

<style scoped>
/*
 * MiMo's home layout: a scroll area whose content is a three-row grid, the
 * hero and tray centred in the middle row and lifted 64px. The two outer rows
 * share what is left. MiMo 26.920 dropped the example tasks that used to hang
 * from the last row; the grid, and so the tray's place, stayed as it was.
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

/*
 * MiMo's hero block: 527 by 299, centred, and pulled 48 up into the tray so
 * 251px of it stands above the box. Everything inside is placed against its
 * height rather than stacked, which is what holds the greeting on 195.8.
 */
.hero {
  position: relative;
  width: 527px;
  max-width: 100%;
  height: 299px;
  margin: 0 auto -48px;
}

/*
 * The mark's place - MiMo's icon sits at 49.95% of the block's height. The
 * centring lives on this slot rather than on the mark, so the hop animation's
 * own transform has the element to itself.
 */
.mark-slot {
  position: absolute;
  top: 49.95%;
  left: 50%;
  z-index: 1;
  transform: translate(-50%, -50%);
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

/* 18/600 at 0.4px on MiMo's greeting, absolutely placed at 65.5% - 195.8px down the block. */
.slogan {
  position: absolute;
  top: 65.5%;
  left: 0;
  width: 100%;
  margin: 0;
  color: var(--text-strong);
  font-size: calc(18px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: calc(28.8px * var(--ui-font-scale, 1));
  letter-spacing: 0.4px;
  text-align: center;
}

/*
 * The tray the box sits in, with the project strip at its foot. MiMo's
 * --color-composer-tray-bg is an opaque plate rather than a wash: #f8f7f5 in
 * light, #151515 in dark (below).
 */
.tray {
  position: relative;
  width: 100%;
  background: #f8f7f5;
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

/* MiMo's wide window: the tray grows to 944. */
@media (min-width: 2000px) {
  .core {
    width: min(944px, 100%);
  }
}

:root[data-theme="dark"] .tray {
  background: #151515;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .tray {
    background: #151515;
  }
}
</style>
