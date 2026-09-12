<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { LocalServer } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"

/**
 * The browser panel.
 *
 * Everything here is chrome. The page itself is a view the main process owns
 * and places, and this component's job is to tell it where: `.stage` is an
 * empty box whose position on screen is measured and sent across whenever the
 * layout moves. Drawing the page in here instead would mean letting an
 * arbitrary site run inside the renderer that draws this app.
 *
 * That division is also why the stage is deliberately empty in the markup. It
 * looks like a hole in the component, and it is: the hole is where the page
 * shows through.
 */
const app = useApp()
const emit = defineEmits<{ close: [] }>()

interface State {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

const state = ref<State>({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false })
const address = ref("")
/* While the reader is typing, the bar is theirs; the page stops rewriting it. */
const editing = ref(false)
const stage = ref<HTMLElement>()
const servers = ref<LocalServer[]>([])
const scanning = ref(false)

let stopState: (() => void) | undefined
let frame = 0

const showingPage = computed(() => Boolean(state.value.url))

function apply(next: unknown) {
  if (!next || typeof next !== "object") return
  state.value = next as State
  if (!editing.value) address.value = state.value.url
}

/** Where the page goes, in the window's own pixels. */
function measure() {
  const box = stage.value?.getBoundingClientRect()
  if (!box) return
  const zoom = window.devicePixelRatio === 0 ? 1 : 1
  window.mcode.browserBounds({
    x: box.left * zoom,
    y: box.top * zoom,
    width: box.width * zoom,
    height: box.height * zoom,
  })
}

/* Cheap, and it has to happen on every layout change, so it rides a frame. */
function remeasure() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(measure)
}

onMounted(async () => {
  stopState = window.mcode.onBrowserState(apply)
  const box = stage.value?.getBoundingClientRect()
  const opened = await window.mcode.browserOpen({
    x: box?.left ?? 0,
    y: box?.top ?? 0,
    width: box?.width ?? 0,
    height: box?.height ?? 0,
  })
  apply(opened)
  window.addEventListener("resize", remeasure)
  if (stage.value) observer.observe(stage.value)
  remeasure()
  void scan()
})

onBeforeUnmount(() => {
  window.removeEventListener("resize", remeasure)
  cancelAnimationFrame(frame)
  observer.disconnect()
  stopState?.()
  window.mcode.browserClose()
})

/*
 * The hole changes size for three different reasons - the window, the panel's
 * own layout, and the moment a page arrives and the starting list gives up its
 * room - so all three are watched. The first version watched the template ref,
 * which never changes after mount: the observer was attached to nothing and the
 * page sat at zero height while the chrome around it looked right.
 */
const observer = new ResizeObserver(() => remeasure())

watch(showingPage, () => remeasure())

async function go() {
  editing.value = false
  apply(await window.mcode.browserNavigate(address.value))
}

async function act(what: "back" | "forward" | "reload" | "stop") {
  apply(await window.mcode.browserAct(what))
}

function openServer(server: LocalServer) {
  address.value = server.url
  void go()
}

/** What is answering on this machine, asked again whenever the reader asks. */
async function scan() {
  scanning.value = true
  servers.value =
    (await app.client
      ?.request({ type: "local.servers" })
      .then((result) => result.servers)
      .catch(() => [])) ?? []
  scanning.value = false
}
</script>

<template>
  <section class="browser" :aria-label="t('browser.title')">
    <header class="tabs">
      <div class="tab">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2" />
          <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.6 3.9 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.3 5.4 8S6.3 3.6 8 1.8z" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <span class="tab-name">{{ state.title || t("browser.title") }}</span>
      </div>
      <button class="ico" :aria-label="t('common.close')" @click="emit('close')">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <div class="bar">
      <button class="ico" :disabled="!state.canGoBack" :aria-label="t('title.back')" @click="act('back')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="ico" :disabled="!state.canGoForward" :aria-label="t('title.forward')" @click="act('forward')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <input
        v-model="address"
        class="address"
        spellcheck="false"
        autocomplete="off"
        :placeholder="t('browser.address')"
        :aria-label="t('browser.address')"
        @focus="editing = true"
        @blur="editing = false"
        @keydown.enter="go"
      />
      <button
        class="ico"
        :aria-label="state.loading ? t('browser.stop') : t('browser.reload')"
        @click="act(state.loading ? 'stop' : 'reload')"
      >
        <svg v-if="state.loading" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" />
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.4V5h-2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!--
      The page shows through here. Empty on purpose: see the note at the top.
    -->
    <div ref="stage" class="stage" :class="{ blank: !showingPage }" />

    <div v-if="!showingPage" class="start">
      <div class="start-head">
        <span class="start-title">{{ t("browser.local") }}</span>
        <button class="rescan" :disabled="scanning" @click="scan">{{ t("browser.rescan") }}</button>
      </div>
      <button v-for="server in servers" :key="server.port" class="server" @click="openServer(server)">
        <span class="server-name">{{ server.title || t("browser.untitled") }}</span>
        <span class="server-url">{{ server.url.replace(/^https?:\/\//, "").replace(/\/$/, "") }}</span>
      </button>
      <p v-if="!servers.length" class="none">
        {{ scanning ? t("browser.scanning") : t("browser.noneLocal") }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--surface-base);
  border-inline-start: 1px solid var(--border-weak);
}

.tabs {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 8px;
}

.tab {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 26px;
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border-radius: 8px;
}

.tab-name {
  overflow: hidden;
  font-size: 12px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 0 8px 8px;
}

.ico {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--icon-base);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.ico:hover:not(:disabled) {
  background: var(--surface-hover);
}

.ico:disabled {
  opacity: 0.4;
  cursor: default;
}

.address {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid transparent;
  border-radius: 8px;
  outline: none;
  font-size: 12px;
}

.address:focus {
  border-color: var(--border-strong);
}

/*
 * The hole the page shows through. It takes the room whether or not a page is
 * loaded, so the starting list below it does not jump when one arrives.
 */
.stage {
  flex: 1;
  min-height: 0;
}

.stage.blank {
  flex: 0 0 0;
}

.start {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 6px 12px 14px;
  overflow-y: auto;
}

.start-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.start-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

.rescan {
  color: var(--text-base);
  background: transparent;
  border: 0;
  font-size: 12px;
  cursor: pointer;
}

.rescan:hover:not(:disabled) {
  color: var(--text-strong);
}

.server {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  text-align: start;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 12px;
  cursor: pointer;
}

.server:hover {
  border-color: var(--border-strong);
}

.server-name {
  color: var(--text-strong);
  font-size: 13px;
  line-height: 18px;
}

.server-url {
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.none {
  margin: 0;
  color: var(--text-weak);
  font-size: 12px;
}
</style>
