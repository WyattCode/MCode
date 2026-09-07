<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import SessionTabs from "./SessionTabs.vue"

defineProps<{
  rightPanel: boolean
  /** The launcher has no project open, so most controls are hidden. */
  home: boolean
}>()

const emit = defineEmits<{
  menu: [x: number, y: number]
  palette: []
  server: []
  back: []
  forward: []
  terminal: []
  "go-home": []
  "toggle-right": []
  "new-session": []
  "close-tab": [id: string]
  "select-tab": [id: string]
}>()

const app = useApp()
const mac = computed(() => app.platform === "darwin")

/**
 * Full screen, told to the page by the window that is in it.
 *
 * The lights are the system's and are drawn outside the web contents, so their
 * absence is not something the page can see - and the room reserved for them
 * has to go when they do, or the row starts ninety pixels in beside nothing.
 */
const fullScreen = ref(false)
let offFullScreen: (() => void) | undefined
onMounted(async () => {
  offFullScreen = window.mcode.onFullScreen((value) => (fullScreen.value = value))
  // The window may already be in it: restoring one that was left full screen
  // puts it there before this page exists to be told.
  fullScreen.value = await window.mcode.isFullScreen()
})
onBeforeUnmount(() => offFullScreen?.())

/**
 * The menu hangs from the edge its button begins at, just under the bar. A
 * rectangle is measured from the viewport's left whichever way the text runs,
 * so in a mirrored layout the distance the menu wants is the one back from the
 * opposite edge.
 */
function openMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const rtl = getComputedStyle(document.documentElement).direction === "rtl"
  const start = rtl ? document.documentElement.clientWidth - rect.right : rect.left
  emit("menu", start, rect.bottom + 4)
}
</script>

<template>
  <header class="titlebar" :class="{ mac, 'full-screen': fullScreen }">
    <div class="bar">
      <button
        class="ico"
        v-tip="{ label: t('title.menu'), placement: 'bottom' }"
        @click="openMenu"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 8H14M2 4.664H14M2 11.336H14" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>

      <!-- The way back to the launcher, which is where projects are chosen. -->
      <button
        class="ico wide home"
        :class="{ on: home }"
        v-tip="{ label: t('tabs.home'), placement: 'bottom' }"
        @click="emit('go-home')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13.9948 11.668H9.32812M11.6641 9.33203V13.9987M6.66667 9.33203V13.9987H2V9.33203H6.66667ZM6.66667 2V6.66667H2V2H6.66667ZM13.9948 2V6.66667H9.32812V2H13.9948Z"
            stroke="currentColor"
            stroke-width="1"
            stroke-miterlimit="10"
            stroke-linecap="square"
          />
        </svg>
      </button>

      <!--
        The row of open conversations, which is how the app is navigated now.
        Shown on the launcher too - a tab the user left open is the quickest
        way back into it, and hiding the row there would make the home button
        a one-way trip.
      -->
      <SessionTabs @close="emit('close-tab', $event)" @select="emit('select-tab', $event)" />

      <button
        v-if="!home"
        class="ico"
        v-tip="{ label: t('title.newSession'), hint: 'Ctrl+T', placement: 'bottom' }"
        @click="emit('new-session')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.88867V13.1109" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
          <path d="M2.88867 8H13.1109" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- A blank stretch that is always draggable, even when the bar is full. -->
      <!--
        Two controls opencode keeps behind a setting, and so does this: both
        default off, so the bar is unchanged until a reader turns one on. The
        chords they duplicate - Ctrl+[ and Ctrl+] for the history, Ctrl+` for
        the drawer - work whether or not the buttons are drawn.
      -->
      <template v-if="!home && app.config?.showNavigation">
        <button class="ico" v-tip="{ label: t('title.back'), hint: 'Ctrl+[', placement: 'bottom' }" @click="emit('back')">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M12.5 4.16675L6.66667 10.0001L12.5 15.8334" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </button>
        <button
          class="ico"
          v-tip="{ label: t('title.forward'), hint: 'Ctrl+]', placement: 'bottom' }"
          @click="emit('forward')"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M7.5 4.16675L13.3333 10.0001L7.5 15.8334" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </button>
      </template>

      <span class="grab" />

      <template v-if="!home">
        <!--
          Both of these are off by default and turned on in settings, which is
          how opencode carries them: its bar holds the review toggle alone
          unless you ask for more.
        -->
        <button
          v-if="app.config?.showPaletteButton"
          class="ico"
          v-tip="{ label: t('menu.palette'), hint: 'Ctrl+K', placement: 'bottom' }"
          @click="emit('palette')"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
        </button>

        <button
          v-if="app.config?.showServerButton"
          class="ico server-trigger"
          v-tip="{ label: app.connected ? t('title.serverOn') : t('title.serverOff'), placement: 'bottom' }"
          @click="emit('server')"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor" stroke-width="1" />
          </svg>
          <!--
            The light. It used to be absent, so an MCP server that failed to
            start reported it only inside a dialog nobody had a reason to open -
            the one control that is about the runtime said nothing about it.
            Nothing is drawn when everything is well, because a light that is
            always on is not a light.
          -->
          <span v-if="app.runtimeStatus !== 'ok'" class="lamp" :class="app.runtimeStatus" />
        </button>

        <!-- The drawer, on the key it already answers to. -->
        <button
          v-if="app.config?.showTerminal"
          class="ico"
          v-tip="{ label: t('term.title'), hint: 'Ctrl+`', placement: 'bottom' }"
          @click="emit('terminal')"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4.5 6.5L8 10L4.5 13.5M10.5 13.5H15.5" stroke="currentColor" stroke-linecap="square" />
            <rect x="2" y="3" width="16" height="14" stroke="currentColor" />
          </svg>
        </button>

        <button
          class="ico wide"
          :class="{ on: rightPanel }"
          :aria-expanded="rightPanel"
          aria-controls="review-panel"
          v-tip="{ label: t('title.toggleFiles'), hint: 'Ctrl+\\', placement: 'bottom' }"
          @click="emit('toggle-right')"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.91536 2.91406H2.36536V2.36406H2.91536V2.91406ZM2.91536 17.0807V17.6307H2.36536V17.0807H2.91536ZM17.082 17.0807H17.632V17.6307H17.082V17.0807ZM17.082 2.91406V2.36406H17.632V2.91406H17.082ZM6.9987 2.91406H6.4487V2.36406H6.9987V2.91406ZM6.9987 17.0807V17.6307H6.4487V17.0807H6.9987ZM2.91536 2.91406H3.46536V17.0807H2.91536H2.36536V2.91406H2.91536ZM2.91536 17.0807V16.5307H17.082V17.0807V17.6307H2.91536V17.0807ZM17.082 17.0807H16.532V2.91406H17.082H17.632V17.0807H17.082ZM17.082 2.91406V3.46406H2.91536V2.91406V2.36406H17.082V2.91406ZM6.9987 2.91406H7.5487V17.0807H6.9987H6.4487V2.91406H6.9987ZM17.082 17.0807L17.082 17.6307L6.9987 17.6307V17.0807V16.5307L17.082 16.5307L17.082 17.0807ZM6.9987 2.91406V2.36406H17.082V2.91406V3.46406H6.9987V2.91406Z" fill="currentColor" /></svg>
        </button>
      </template>
    </div>

  </header>
</template>

<style scoped>
/*
 * Stops where the OS caption buttons begin.
 *
 * Windows draws minimise, maximise and close into the bar itself. It is meant
 * to report the room it took through env(titlebar-area-width), but the Window
 * Controls Overlay is not active here - navigator.windowControlsOverlay says
 * visible: false - so that env resolves to nothing and the fallback is what
 * actually runs. Falling back to the full viewport put this bar's own buttons
 * underneath the caption buttons; 138px is the width the three of them take,
 * and is the same figure opencode falls back to.
 *
 * On macOS the traffic lights sit on the left, so the bar stays full width
 * and the padding below does the work instead.
 */
.titlebar {
  display: flex;
  align-items: stretch;
  width: env(titlebar-area-width, calc(100vw - 138px));
  max-width: env(titlebar-area-width, calc(100vw - 138px));
  /*
   * Offset by where the usable area starts rather than assuming it is the left
   * edge: Windows keeps its caption buttons at the right on this system, but a
   * mirrored one puts them on the left, and then the bar has to move over.
   *
   * Both of these stay physical. Windows decides where it paints minimise,
   * maximise and close from its own settings, not from the language this app is
   * being read in, so the room left for them cannot follow the text direction -
   * an Arabic window still has its caption buttons on the right, and a bar that
   * moved with the text would slide straight underneath them.
   */
  margin-left: env(titlebar-area-x, 0px);
  margin-right: auto;
  min-height: var(--titlebar-height);
  height: var(--titlebar-height);
  background: var(--surface-base);
  /* The bar drags the window; interactive children opt out. */
  -webkit-app-region: drag;
  user-select: none;
}

/*
 * Controls are 28px in a 36px bar, sat against the bottom edge: the 8px of
 * padding above them is what leaves the row of tabs looking joined to the
 * page below rather than floating in the middle of the bar.
 */
.bar {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-block: 8px 0;
  /* The wider lead-in belongs at the end the row starts from, where the menu
     button is, and the narrower one where the row runs out. */
  padding-inline: 20px 12px;
}

/* No overlay to dodge: the traffic lights sit outside the web contents. */
.titlebar.mac {
  width: 100vw;
  max-width: 100vw;
}

/*
 * Room for the traffic lights, and physical for the same reason the Windows
 * offset above is: they sit on the left whatever direction the row is read in,
 * so the reservation has to stay on the left even when the row mirrors.
 *
 * The number is derived, not guessed: the window places the group at x=20 (see
 * trafficLightPosition in the main process) and the group measures 60px, so it
 * ends at 80. A control is 28px around a 12px glyph, so starting the row at 90
 * leaves 18px of clear space between the last light and the first glyph -
 * measured off the system's own toolbars, where the gap runs about one and a
 * third times a light's width.
 */
.titlebar.mac .bar {
  padding-left: 90px;
}

/* No lights to leave room for; the row takes its ordinary lead-in back. */
.titlebar.mac.full-screen .bar {
  padding-left: 20px;
}

/* Only the controls themselves opt out of dragging - marking their containers
   no-drag would cover the whole bar, leaving nowhere to grab the window. */
.ico,
.ctl {
  -webkit-app-region: no-drag;
}

/*
 * A small light over the server icon's trailing corner. Sat on the icon rather
 * than beside it so the bar's spacing does not change when it appears, and
 * placed logically so it stays in the trailing corner when the bar mirrors.
 */
.lamp {
  position: absolute;
  top: 4px;
  inset-inline-end: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  /* A ring the colour of the bar, so the light reads as a badge on the icon
     rather than as part of the drawing underneath it. */
  box-shadow: 0 0 0 1.5px var(--surface-base);
}

.lamp.down {
  background: var(--error);
}

.lamp.warning {
  background: var(--warning);
}

.lamp.attention {
  background: var(--accent);
}

.ico {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}

/* The reference draws its ghost buttons a touch wider than they are tall. */
.ico.wide {
  width: 36px;
}

/* Ten pixels from the menu rather than the row's six: the pair reads as two
   separate things - one opens a menu, the other leaves the workspace. */
.ico.home {
  margin-inline-start: 4px;
}

.ico:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.ico:disabled {
  color: var(--icon-weak);
  cursor: default;
}

.ico.on {
  color: var(--text-strong);
}

.grab {
  flex: 1;
  min-width: 24px;
  align-self: stretch;
}

</style>
