<script setup lang="ts">
import { computed, ref } from "vue"
import ContextMenu from "./ContextMenu.vue"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import type { MenuItem } from "../lib/menu"
import { projectHue, projectName } from "../lib/project"

/**
 * The launcher.
 *
 * Two columns: what the work is attached to on the left, what has actually
 * been worked on down the right. The old screen listed projects only, which
 * meant getting back to a conversation took a project click and then a second
 * pass through a panel - so the thing people return to was the one thing the
 * home screen did not show.
 */
const emit = defineEmits<{
  open: [directory: string]
  browse: []
  session: [id: string]
  create: [directory: string]
  /*
   * How every other panel reaches the project dialog. A popover closes itself
   * the moment the choice is made, so the dialog is mounted a level up rather
   * than inside whatever offered it.
   */
  edit: [directory: string]
  settings: []
  help: []
}>()

const app = useApp()

const query = ref("")

/** Distinct project directories, most recently touched first. */
const projects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const seen = new Map<string, number>()
  for (const session of app.sessions) {
    if (closed.has(session.directory)) continue
    seen.set(session.directory, Math.max(seen.get(session.directory) ?? 0, session.updated))
  }
  return [...seen.entries()]
    .map(([directory, updated]) => ({ directory, updated }))
    .sort((a, b) => b.updated - a.updated)
})

/*
 * Which project the right-hand column is showing.
 *
 * opencode scopes the list to one project and says so in the search box - "in
 * Test, search sessions". Listing every project's work at once and labelling
 * each row with where it came from is a different screen: it answers "what did
 * I do lately" where the reference answers "what did I do here".
 */
const picked = ref<string>()
const selected = computed(() => {
  const list = projects.value
  if (picked.value && list.some((entry) => entry.directory === picked.value)) return picked.value
  return list[0]?.directory
})

/** Where a new session goes when the button is pressed rather than a project. */
const defaultDirectory = computed(() => selected.value ?? app.config?.directory ?? "")

/** The name the search box borrows, so the box says what it is searching. */
const selectedName = computed(() =>
  selected.value ? projectName(selected.value, app.config?.projectNames) : "",
)

function initial(directory: string): string {
  const name = projectName(directory, app.config?.projectNames)
  return (name.match(/[a-z0-9]/i)?.[0] ?? name[0] ?? "?").toUpperCase()
}

function hue(directory: string): string {
  return app.config?.projectColors?.[directory] ?? String(projectHue(directory))
}

function icon(directory: string): string | undefined {
  return app.config?.projectIcons?.[directory]
}

/*
 * What a project row offers beyond being clicked.
 *
 * The same list a right-click raises and the row's own overflow button opens,
 * because they are one menu: growing a second one here would be a second place
 * to forget an action. The shared context menu is what draws it, so the whole
 * screen has one way of putting a list of choices under the pointer.
 */
const projectMenu = ref<{ x: number; y: number; directory: string }>()

const projectMenuItems = computed<MenuItem[]>(() => [
  { key: "new", label: t("title.newSession") },
  { key: "edit", label: t("proj.editTitle") },
  /*
   * Resolving a directory to something the shell can be pointed at is this
   * process's job, so a project held by a server on another machine has no
   * folder here to show.
   */
  ...(app.config?.serverURL ? [] : [{ key: "reveal", label: t("files.reveal") }]),
  // Nothing clears them yet; the entry says the capability is meant to be here.
  { key: "notifications", label: t("proj.clearNotifications"), enabled: false },
  { key: "close", label: t("proj.close"), divided: true },
])

/**
 * Hangs the menu off the row's own overflow button.
 *
 * A right-click anywhere on the row raises the same list, and opencode drops it
 * from the button either way rather than from the pointer - which is what keeps
 * the two ways of asking for it looking like one thing. The shared menu is
 * placed from a point rather than against an edge, so it opens from the
 * button's leading side with the six pixels of air opencode leaves there.
 */
function openProjectMenu(event: MouseEvent, directory: string) {
  const from = event.currentTarget as HTMLElement
  const anchor = from.classList.contains("project-act")
    ? from
    : from.querySelector<HTMLElement>(".project-act")
  const rect = (anchor ?? from).getBoundingClientRect()
  projectMenu.value = { x: rect.left, y: rect.bottom + 6, directory }
}

function pickProjectMenu(key: string) {
  const directory = projectMenu.value?.directory
  projectMenu.value = undefined
  if (!directory) return
  if (key === "new") emit("create", directory)
  else if (key === "edit") emit("edit", directory)
  else if (key === "reveal") void window.mcode.openFile(directory, "")
  else if (key === "close") void closeProject(directory)
}

/**
 * Takes a project off the launcher without touching what is in it.
 *
 * Hiding, not deleting: the sessions stay, so opening the directory again
 * brings the whole history back. The workspace has to let go of it too - an
 * open session pointing into a project that is no longer listed reads as the
 * close having done nothing.
 */
async function closeProject(directory: string) {
  if (app.current?.directory === directory) app.currentID = undefined
  const current = app.config?.closedProjects ?? []
  if (current.includes(directory)) return
  await app.patchConfig({ closedProjects: [...current, directory] })
}

const visible = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const needle = query.value.trim().toLowerCase()
  return app.sessions
    .filter((session) => !session.archived && !closed.has(session.directory))
    // One project at a time, which is what the search box promises.
    .filter((session) => !selected.value || session.directory === selected.value)
    .filter((session) => !needle || sessionTitle(session.title).toLowerCase().includes(needle))
    .sort((a, b) => b.updated - a.updated)
})

/**
 * Split by the day it was last touched.
 *
 * Dates are compared as local days rather than by elapsed hours: something
 * touched at 23:50 last night is "yesterday" at 00:10, not "today".
 */
const groups = computed(() => {
  const startOfDay = (value: number) => {
    const date = new Date(value)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const today = startOfDay(Date.now())
  const yesterday = today - 86_400_000

  const buckets: { key: string; label: string; rows: typeof visible.value }[] = [
    { key: "today", label: t("home.today"), rows: [] },
    { key: "yesterday", label: t("home.yesterday"), rows: [] },
    { key: "earlier", label: t("home.earlier"), rows: [] },
  ]
  for (const session of visible.value) {
    const day = startOfDay(session.updated)
    const bucket = day >= today ? buckets[0] : day >= yesterday ? buckets[1] : buckets[2]
    bucket.rows.push(session)
  }
  return buckets.filter((bucket) => bucket.rows.length > 0)
})

/*
 * The two utility actions, held as data rather than as markup.
 *
 * The pair is drawn in two places - down the side of a wide window, and across
 * the foot of a narrow one, where there is no side to put it on. Writing the
 * buttons twice would make a second place to forget an edit, so only the
 * wrapper is repeated and the contents come from here.
 */
const utilities: { label: string; paths: string[]; linecap?: "square"; open: () => void }[] = [
  {
    label: "rail.settings",
    paths: [
      "M7.99998 1.3335L14 4.66683V11.3335L7.99998 14.6668L2 11.3335V4.66683L7.99998 1.3335Z",
      "M9.99998 8.00016C9.99998 9.10476 9.10458 10.0002 7.99998 10.0002C6.89538 10.0002 5.99998 9.10476 5.99998 8.00016C5.99998 6.89556 6.89538 6.00016 7.99998 6.00016C9.10458 6.00016 9.99998 6.89556 9.99998 8.00016Z",
    ],
    open: () => emit("settings"),
  },
  {
    label: "rail.help",
    paths: [
      "M6.33345 6.33349V5.00015H9.66679V7.00015L8.00015 8.00015V9.66679M8.27485 11.6819H7.71897M14.4446 8.00011C14.4446 11.5593 11.5593 14.4446 8.00011 14.4446C4.44094 14.4446 1.55566 11.5593 1.55566 8.00011C1.55566 4.44094 4.44094 1.55566 8.00011 1.55566C11.5593 1.55566 14.4446 4.44094 14.4446 8.00011Z",
    ],
    linecap: "square",
    open: () => emit("help"),
  },
]
</script>

<template>
  <div class="home">
    <div class="content">
      <!-- The search sits over the sessions, which is what it filters. -->
      <div class="search-slot">
        <div class="search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z" stroke="currentColor" stroke-width="1" />
          </svg>
          <input
            v-model="query"
            :placeholder="
              selectedName ? t('home.searchIn', { project: selectedName }) : t('home.searchSessions')
            "
            spellcheck="false"
          />
        </div>
        <!--
          The button belongs to the pinned search rather than to the heading it
          lines up with: headings hand over to each other as the list scrolls,
          and a button riding inside one would be buried by the next.
        -->
        <button
          v-if="groups.length > 0"
          class="new"
          v-tip="{ label: t('title.newSession'), hint: 'Ctrl+T' }"
          @click="emit('create', defaultDirectory)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M13.5555 8.21534V13.5556H2.44434L2.44434 2.4445H7.78462M6.88878 9.11119C6.88878 9.11119 8.96327 9.0367 9.69678 8.3032L14.0301 3.96986C14.5824 3.4176 14.5824 2.52213 14.0301 1.96986C13.4778 1.4176 12.5824 1.4176 12.0301 1.96986L7.69678 6.3032C7.00513 6.99484 6.88878 9.11119 6.88878 9.11119Z" stroke="currentColor" stroke-width="1" />
          </svg>
          <span>{{ t("title.newSession") }}</span>
        </button>
      </div>

      <aside class="left">
        <div class="head">
          <span class="head-label strong">{{ t("home.projects") }}</span>
          <button class="head-ico" v-tip="{ label: t('home.addProject'), hint: 'Ctrl+O' }" @click="emit('browse')">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M7.5 13.3333H1.5V2H6.83333L8.83333 4H14.8333V6M10.1667 11.3333H15.5M12.8333 8.66667V14" stroke="currentColor" stroke-width="1" stroke-miterlimit="10" stroke-linecap="square" />
            </svg>
          </button>
        </div>

        <!-- The list scrolls inside the column, so the wrapper can hold the edge fades still. -->
        <div class="projects">
          <div class="projects-scroll">
            <!--
              A row around the button rather than the button alone: the controls
              that appear on hover sit over its trailing end, and a button
              cannot hold buttons.
            -->
            <div
              v-for="project in projects"
              :key="project.directory"
              class="project-row"
              @contextmenu.prevent.stop="openProjectMenu($event, project.directory)"
            >
              <button
                class="project"
                :class="{ on: selected === project.directory }"
                :aria-current="selected === project.directory ? 'page' : undefined"
                @click="picked = project.directory"
                @dblclick="emit('open', project.directory)"
              >
                <span class="avatar" :style="{ '--h': hue(project.directory) }">
                  <img v-if="icon(project.directory)" :src="icon(project.directory)" alt="" />
                  <template v-else>{{ initial(project.directory) }}</template>
                </span>
                <span class="project-name">{{ projectName(project.directory, app.config?.projectNames) }}</span>
              </button>

              <!--
                Quiet until the row is pointed at or holds the focus, which is
                what keeps the column reading as a list of projects rather than
                as a list of controls.
              -->
              <div class="project-acts" :data-menu="projectMenu?.directory === project.directory">
                <button class="project-act" :aria-label="t('proj.more')" @click="openProjectMenu($event, project.directory)">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor" stroke-width="1" />
                    <path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor" stroke-width="1" />
                    <path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor" stroke-width="1" />
                  </svg>
                </button>
                <button class="project-act" :aria-label="t('title.newSession')" @click="emit('create', project.directory)">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M13.5555 8.21534V13.5556H2.44434L2.44434 2.4445H7.78462M6.88878 9.11119C6.88878 9.11119 8.96327 9.0367 9.69678 8.3032L14.0301 3.96986C14.5824 3.4176 14.5824 2.52213 14.0301 1.96986C13.4778 1.4176 12.5824 1.4176 12.0301 1.96986L7.69678 6.3032C7.00513 6.99484 6.88878 9.11119 6.88878 9.11119Z" stroke="currentColor" stroke-width="1" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <nav class="utility">
          <button v-for="item in utilities" :key="item.label" class="util" @click="item.open()">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path v-for="d in item.paths" :key="d" :d="d" stroke="currentColor" stroke-width="1" :stroke-linecap="item.linecap" />
            </svg>
            <span>{{ t(item.label) }}</span>
          </button>
        </nav>
      </aside>

      <section class="right">
        <!--
          Until the first list arrives there is nothing true to say: the empty
          state below would claim there are no sessions, which is a different
          fact from not knowing yet.

          The socket opening is not the moment it is known - the store reports
          itself connected and only then asks what there is - so the config
          landing is what the wait is measured against.
        -->
        <div v-if="!app.ready" class="skeleton">
          <div class="skeleton-head">
            <span class="head-label">{{ t("common.loading") }}</span>
          </div>
          <div class="skeleton-rows" aria-hidden="true">
            <span v-for="bar in 4" :key="bar" class="skeleton-row" />
          </div>
        </div>

        <div v-else-if="groups.length === 0" class="empty">
          <div class="empty-title">{{ query.trim() ? t("home.noMatch") : t("home.noSessions") }}</div>
          <!--
            A search that found nothing is not an empty project, so it gets the
            heading alone - the invitation to start something belongs to the
            list that has never had anything in it.
          -->
          <template v-if="!query.trim()">
            <p class="empty-note">{{ t("home.sessions.empty.description") }}</p>
            <button class="start" @click="emit('create', defaultDirectory)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M13.5555 8.21534V13.5556H2.44434L2.44434 2.4445H7.78462M6.88878 9.11119C6.88878 9.11119 8.96327 9.0367 9.69678 8.3032L14.0301 3.96986C14.5824 3.4176 14.5824 2.52213 14.0301 1.96986C13.4778 1.4176 12.5824 1.4176 12.0301 1.96986L7.69678 6.3032C7.00513 6.99484 6.88878 9.11119 6.88878 9.11119Z" stroke="currentColor" stroke-width="1" />
              </svg>
              <span>{{ t("title.newSession") }}</span>
            </button>
          </template>
        </div>

        <template v-else>
          <div class="head">
            <span class="head-label">{{ groups[0]?.label }}</span>
          </div>

          <template v-for="(group, at) in groups" :key="group.key">
            <!-- The first heading is drawn in the bar above, beside the button. -->
            <div v-if="at > 0" class="head later">
              <span class="head-label">{{ group.label }}</span>
            </div>

            <button
              v-for="session in group.rows"
              :key="session.id"
              class="session"
              @click="emit('session', session.id)"
            >
              <!--
                Just the avatar. This used to set a 2px bar outside it when the
                session already had a tab - opencode's row has nothing of the
                kind, and outside the row's padding it read as a stray mark
                floating in the gutter rather than as a state.
              -->
              <span class="mark">
                <span class="avatar" :style="{ '--h': hue(session.directory) }">
                  <img v-if="icon(session.directory)" :src="icon(session.directory)" alt="" />
                  <template v-else>{{ initial(session.directory) }}</template>
                </span>
              </span>
              <span class="session-title">{{ sessionTitle(session.title) }}</span>
            </button>
          </template>
        </template>
      </section>

      <!--
        Once the window is too narrow for a side column, the utility pair has no
        side to sit on, so it becomes the page's last row instead - scrolled
        past at the end rather than wedged in above the sessions.
      -->
      <nav class="utility foot">
        <button v-for="item in utilities" :key="item.label" class="util" @click="item.open()">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path v-for="d in item.paths" :key="d" :d="d" stroke="currentColor" stroke-width="1" :stroke-linecap="item.linecap" />
          </svg>
          <span>{{ t(item.label) }}</span>
        </button>
      </nav>
    </div>

    <!--
      Out to the body, because the page it would otherwise sit in is a size
      container - and a size container is what a fixed position measures itself
      against, which would leave the menu wherever the launcher happens to
      start rather than under the pointer.
    -->
    <Teleport to="body">
      <ContextMenu
        v-if="projectMenu"
        :x="projectMenu.x"
        :y="projectMenu.y"
        :items="projectMenuItems"
        @pick="pickProjectMenu"
        @close="projectMenu = undefined"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.home {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  /*
   * The projects column has to know how tall the scroll port is before it can
   * decide where its own list should stop; the page it sits on is taller than
   * the port and would give the wrong answer.
   */
  container-type: size;
}

/*
 * A fixed pair of columns, centred: the sessions column holds the same 720 the
 * composer does, so the width the app reads at does not change between writing
 * in a session and looking for one.
 *
 * The top inset belongs to the search rather than to the grid, because the
 * search is pinned and has to carry its own clearance with it.
 */
.content {
  /*
   * The foot is named because the projects column has to know about it. That
   * column is measured against the scroll port, so a column that ran the whole
   * port pushed this inset out past the bottom of it and the page scrolled
   * forty pixels that had nothing in them - on every wide window, however few
   * sessions there were to look at.
   */
  --home-foot: 40px;
  display: grid;
  grid-template-columns: 268px minmax(0, 720px);
  column-gap: 44px;
  justify-content: center;
  padding: 0 24px var(--home-foot);
}

/*
 * The search never leaves: it filters the list below it, and a filter you have
 * to scroll back up to reach is a filter that gets forgotten mid-list.
 */
.search-slot {
  position: sticky;
  top: 0;
  z-index: 30;
  grid-column: 2;
  margin-bottom: 12px;
  padding: 48px 0 12px;
  background: var(--surface-raised);
}

/*
 * The box is not evenly inset: the magnifier needs a full step of air on the
 * left, while the right edge only has to clear the text, so the padding is
 * asymmetric.
 *
 * At rest the fill is held back to six tenths, which reads as a hint of a field
 * rather than a filled control; pointing at it or typing in it brings the same
 * fill up to full. That step is the whole affordance - there is no ring.
 */
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  /* Stated as inline rather than left/right: the wide side is the one the
     magnifier is on, which swaps with the document's direction. */
  padding-block: 4px;
  padding-inline: 12px 8px;
  color: var(--text-weak);
  /* A step above the panel it sits on - the same fill a selected tab takes. */
  background: color-mix(in oklab, var(--surface-layer) 60%, transparent);
  border-radius: 6px;
  transition: background-color 0.12s ease-in-out;
}

.search:hover,
.search:focus-within {
  background: var(--surface-layer);
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: none;
  border: none;
  outline: none;
  font-size: 13px;
}

.search input::placeholder {
  color: var(--text-weak);
}

.left,
.right {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/*
 * The projects column holds its place while the sessions run past it. It is
 * pinned exactly where it starts, so nothing about it appears to move; only
 * its own list scrolls, and only once there is more of it than fits.
 */
.left {
  position: sticky;
  top: 108px;
  align-self: start;
  height: calc(100cqh - 108px - var(--home-foot));
  overflow: hidden;
}

.head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  margin-bottom: 16px;
  /* The indent that lines the label up with the rows under it, so it has to
     follow them to whichever side the document starts on. */
  padding-inline-start: 6px;
}

/*
 * A group's heading stays with its rows: scrolling into the middle of a long
 * day should not leave you reading a list with no idea which day it is.
 */
.right .head {
  position: sticky;
  top: 108px;
  z-index: 10;
  padding-inline-start: 12px;
  background: var(--surface-raised);
}

/*
 * The first heading is the one that spends the day pinned, so it carries the
 * seam: a block of the page's own colour filling the gap up to the search, and
 * a fade below so rows dissolve into it rather than being cut off by it.
 */
.right .head:not(.later) {
  z-index: 5;
}

.right .head:not(.later)::before {
  content: "";
  position: absolute;
  top: -12px;
  left: 0;
  width: 100%;
  height: 12px;
  background: var(--surface-raised);
}

.right .head:not(.later)::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 0;
  width: 100%;
  height: 16px;
  background: linear-gradient(180deg, var(--surface-raised) 0%, transparent 100%);
  pointer-events: none;
}

/* A later group needs room above it, but not the first one. */
.head.later {
  margin-top: 24px;
}

.head-label {
  color: var(--text-base);
  font-size: 13px;
  line-height: 24px;
}

.head-label.strong {
  font-weight: 530;
}

.head-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  border-radius: var(--radius-md);
  transition: background 0.12s, color 0.12s;
}

.head-ico:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.project,
.util {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding-block: 0;
  padding-inline: 6px;
  color: var(--text-base);
  border-radius: var(--radius-md);
  font-size: 13px;
  text-align: start;
  transition: background 0.12s, color 0.12s;
}

/*
 * The frame the hover controls hang in. It takes no fill of its own: the
 * button inside fills the whole of it, so the selected row is one unbroken
 * block rather than a block with a pair of holes punched in its end.
 */
.project-row {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  height: 28px;
  border-radius: var(--radius-md);
}

/*
 * The gutter the controls open into. Reserved whether or not the pointer is
 * near, because a name that reflowed as the buttons arrived would make the
 * whole column twitch on the way past it.
 */
/*
 * The reference's home-project-row, measured: `0px 64px 0px 6px` of padding on
 * an 8px gap. The trailing 64 was already here - it is the gutter the hover
 * actions sit in - but the row began flush at its start edge, and the avatar
 * and the name were separated only by the word-space the markup's newline
 * happens to produce. Declaring the row a flex line makes that 8px deliberate
 * rather than incidental.
 */
.project {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding-inline: 6px 64px;
}

.project:hover,
.util:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * A row says it has focus by filling, not by drawing a ring around itself.
 *
 * This is opencode's treatment for anything row-shaped - its palette rows, its
 * list items and its collapsible triggers all set `outline: none` and change
 * their background instead, and it has no global focus rule at all. A 268px
 * blue rectangle around the word "Settings" was the whole width of the column
 * announcing something the fill says quietly.
 */
.util:focus-visible,
.project:focus-visible,
.session:focus-visible {
  color: var(--text-strong);
  background: var(--surface-hover);
  outline: none;
}

/*
 * An icon button keeps its ring - opencode draws one on `icon-button-v2` - but
 * at the offset it uses. 1px put the ring hard against a 28px button; 2.5px is
 * what the reference measures, and it is the difference between a ring and a
 * border.
 */
.head-ico:focus-visible,
.ico:focus-visible {
  outline-offset: 2.5px;
}

/* The project whose sessions are on show, marked the way opencode marks it. */
.project.on,
.project.on:hover {
  color: var(--text-strong);
  background: var(--surface-key);
}

/*
 * And it still has to say when it has focus.
 *
 * `--surface-hover` is an overlay - `#0000000a` light, `#ffffff0f` dark, the
 * same kind of value as opencode's `overlay-simple-overlay-hover` - so on an
 * ordinary row it composes with the page. On the selected row it did not:
 * `background` is one property, `.project.on` sets it to the key fill, and the
 * two selectors weigh the same so the later one simply won. A selected row
 * took focus and nothing at all changed, which for a keyboard reader is the
 * row going silent exactly when they need it to speak.
 *
 * Layering it as a gradient over the key colour is the overlay actually
 * overlaying, which is what the token was for.
 */
.project.on:focus-visible {
  background:
    linear-gradient(var(--surface-hover), var(--surface-hover)),
    var(--surface-key);
}

/* Equivalent to a 4px gap on a wrapper: no space before the first row. */
.project-row + .project-row {
  margin-top: 4px;
}

.project-name {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * Laid over the row's trailing gutter rather than laid out in it, so the
 * button underneath keeps the full width of the row to be pressed anywhere on.
 */
.project-acts {
  position: absolute;
  top: 50%;
  inset-inline-end: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transform: translateY(-50%);
}

/*
 * The menu holds them open while it is up: they are what it was opened from,
 * and a trigger that vanishes the moment its menu appears reads as a misfire.
 */
.project-row:hover .project-acts,
.project-row:focus-within .project-acts,
.project-acts[data-menu="true"] {
  opacity: 1;
}

/* Nothing hovers on a touch screen, so there the pair simply stays. */
@media (hover: none) {
  .project-acts {
    opacity: 1;
  }
}

.project-act {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--icon-weak);
  border-radius: var(--radius-sm);
  transition: background 0.12s, color 0.12s;
}

.project-act:hover {
  color: var(--icon-base);
  background: var(--surface-hover);
}

/*
 * The two fades are what tell you the list is cut rather than finished, so each
 * one appears only on the side there is actually more list on. The scroll
 * timeline drives them off the viewport's own position, which means no scroll
 * handler and no state to keep in step.
 */
.projects {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-shrink: 1;
  min-width: 0;
  min-height: 0;
  timeline-scope: --home-projects;
}

.projects-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
}

.projects-scroll::-webkit-scrollbar {
  display: none;
}

.projects::before,
.projects::after {
  content: "";
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  height: 16px;
  visibility: hidden;
  pointer-events: none;
}

.projects::before {
  top: 0;
  background: linear-gradient(to bottom, var(--surface-raised), transparent);
}

.projects::after {
  bottom: 0;
  background: linear-gradient(to top, var(--surface-raised), transparent);
}

@supports (animation-timeline: --home-projects) and (timeline-scope: --home-projects) {
  .projects-scroll {
    scroll-timeline: --home-projects y;
  }

  .projects::before {
    animation: linear both projects-fade-top;
    animation-timeline: --home-projects;
    animation-range: 0 0.1px;
  }

  .projects::after {
    animation: linear both projects-fade-bottom;
    animation-timeline: --home-projects;
    animation-range: calc(100% - 1.1px) calc(100% - 1px);
  }
}

@keyframes projects-fade-top {
  from {
    visibility: hidden;
  }

  to {
    visibility: visible;
  }
}

@keyframes projects-fade-bottom {
  from {
    visibility: visible;
  }

  to {
    visibility: hidden;
  }
}

.utility {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 0;
  gap: 4px;
  margin-top: 32px;
}

/* Only one of the two copies is ever on show; the wide window uses the aside's. */
.utility.foot {
  display: none;
  margin-top: 16px;
}

/*
 * Two pixels narrower than a project's avatar, which is what sets the utility
 * labels a touch left of the project names above them.
 */
.util svg {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: var(--text-weak);
}

/*
 * Hung off the search rather than laid out with it, so it lands on the first
 * heading's line while riding above every heading that pins there.
 */
.new {
  position: absolute;
  top: 108px;
  /*
   * The far end of the sessions column, whichever end that is. Pinned to the
   * physical right it landed on top of the day heading once the document ran
   * right to left, because that is the side the heading starts on there.
   */
  inset-inline-end: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  /* 11px, which is what the reference pads every button-v2 by - the composer's
     agent and model pills included. */
  padding: 0 11px;
  color: var(--text-base);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.04px;
  transition: background 0.12s, color 0.12s;
}

.new:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * Taller than a project row: a session is a thing you return to, and the extra
 * room is what keeps a long list from reading as a wall of text.
 *
 * The height is stated rather than assembled out of padding and leading, so
 * the row stays 40px whatever the title's script needs vertically.
 */
.session {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  min-width: 0;
  /* The deep trailing inset is a gutter for what a row reveals on hover; it
     belongs at the end of the row, not on a fixed side of the window. */
  padding-block: 12px;
  padding-inline: 12px 40px;
  border-radius: var(--radius-md);
  font-size: 13px;
  text-align: start;
  transition: background 0.12s;
}

/* Equivalent to a 1px gap on a wrapper: no space after the last row. */
.session + .session {
  margin-top: 1px;
}

.session:hover {
  background: var(--surface-hover);
}

.session-title {
  overflow: hidden;
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-strong);
  font-weight: 530;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * Anchors the open marker, which hangs off the leading edge of the avatar
 * rather than taking a column of its own - a row for a session that is not
 * open would otherwise carry an empty gutter.
 */
.mark {
  position: relative;
  display: flex;
  flex-shrink: 0;
}


.avatar {
  overflow: hidden;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  /*
   * The one literal colour in this file, and deliberately so: the initial is
   * always set on a saturated mid-tone of the project's own hue, so it has to
   * stay white in both schemes. A token that turns over with the theme would
   * put dark type on a mid-dark fill in exactly one of them. opencode's avatar
   * foreground is fixed white for the same reason.
   */
  color: #fff;
  background: hsl(var(--h) 42% 46%);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 530;
  line-height: 1;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/*
 * A column down the middle rather than a line in the corner. An empty list is
 * the one moment the screen has nothing else to say, so it says the whole
 * thing - what is missing, and the one action that fixes it.
 */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 52px 24px 0;
  text-align: center;
}

.empty-title {
  flex-shrink: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 530;
  line-height: 13px;
  letter-spacing: -0.04px;
}

.empty-note {
  margin: 0 0 4px;
  color: var(--text-base);
  font-size: 13px;
  line-height: 20px;
  letter-spacing: -0.04px;
}

.start {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  color: var(--text-strong);
  /*
   * A neutral button's own fill rather than the panel's, which matters in dark:
   * the raised surface is darker than the page the button sits on, so the one
   * control on an empty screen was reading as a dent instead of a button.
   */
  background: var(--button-neutral);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-input);
  font-size: 13px;
  font-weight: 530;
  line-height: 20px;
  letter-spacing: -0.04px;
}

/* Laid over the fill rather than replacing it, so the button keeps its edge. */
.start:hover {
  background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
}

.skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/*
 * A step deeper than the headings it stands in for. Nothing lines up with a
 * placeholder, so it is inset evenly rather than to the rows' own indent.
 */
.skeleton-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  height: 28px;
  padding-block: 0;
  padding-inline: 16px;
}

.skeleton-rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

/* The row's own shape, in the colour of the surface under the panel. */
.skeleton-row {
  height: 40px;
  background: var(--surface-base);
  border-radius: var(--radius-md);
  opacity: 0.7;
}

/* Narrow windows drop to one column rather than clipping the sessions. */
@media (max-width: 1023px) {
  .content {
    grid-template-columns: minmax(0, 720px);
    padding-inline: 12px;
  }

  .search-slot,
  .left,
  .right {
    grid-column: 1;
  }

  .search-slot {
    padding-top: 24px;
  }

  /* One column means the projects scroll with the page, like everything else. */
  .left {
    position: static;
    height: auto;
    margin-bottom: 28px;
    overflow: visible;
  }

  .left .utility {
    display: none;
  }

  .utility.foot {
    display: flex;
  }

  /*
   * A day heading pins under the search, and the search is a row taller here
   * than it is wide - the new-session button joins it rather than hanging
   * below. Anything less and the heading slides behind the box on the way up.
   */
  .right .head {
    top: 116px;
  }

  /*
   * In one column there is no second heading to ride above, and the projects
   * header is directly below - so the absolute placement has nothing to gain
   * and a control to collide with.
   */
  .new {
    position: static;
    width: fit-content;
    margin-top: 4px;
    margin-inline-start: auto;
  }
}
</style>
