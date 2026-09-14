<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { LocalServer } from "@shared/protocol"
import { useApp } from "../../stores/app"
import { notify, notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"

/**
 * MiMo's browser tab: an address bar - a status dot, back and forward, the
 * address, reload, open in the real browser, a screenshot, and a menu of the
 * rest - over the page. A tab that has been nowhere shows what is answering on
 * this machine instead; a page that failed says why and offers to try again.
 *
 * The page is a view the main process owns and places; this tab is the frame
 * it is placed in. Each tab holds its own page, and only the tab on show asks
 * for it to be drawn - the panel hides the page when no browser tab is showing.
 */
const props = defineProps<{ active: boolean; pageId?: string }>()
const emit = defineEmits<{ page: [pageId: string] }>()
const app = useApp()

interface State {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  tabs: { id: string }[]
  active: string
  zoom: number
  error?: { code: number; url: string }
}

const state = ref<State>({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false, tabs: [], active: "", zoom: 100 })
const address = ref("")
const editing = ref(false)
const root = ref<HTMLElement>()
const bar = ref<HTMLElement>()
const stage = ref<HTMLElement>()
const addressInput = ref<HTMLInputElement>()
const servers = ref<LocalServer[]>([])
const barWidth = ref(400)
const menuOpen = ref(false)

const showingPage = computed(() => Boolean(state.value.url) && state.value.url !== "about:blank")
/* MiMo's narrow bar: under 300 the secondary buttons give way. */
const mini = computed(() => barWidth.value < 300)

function apply(next: unknown) {
  if (!next || typeof next !== "object") return
  const incoming = next as State
  // The panel speaks for whichever page is open; only this tab's page is this tab's news.
  if (props.pageId && incoming.active && incoming.active !== props.pageId) return
  state.value = incoming
  if (!editing.value) address.value = incoming.url === "about:blank" ? "" : incoming.url
  remeasure()
}

function measure() {
  if (!props.active) return
  const box = stage.value?.getBoundingClientRect()
  const hidden = !box || !showingPage.value || Boolean(state.value.error)
  window.mcode.browserBounds({
    x: hidden ? 0 : box.left,
    y: hidden ? 0 : box.top,
    width: hidden ? 0 : box.width,
    height: hidden ? 0 : box.height,
  })
}

function remeasure() {
  void nextTick(measure)
}

/* Makes sure this tab has its page, and that it is the one the panel draws. */
async function claim() {
  if (!props.active) return
  const box = stage.value?.getBoundingClientRect()
  const bounds = { x: box?.left ?? 0, y: box?.top ?? 0, width: 0, height: 0 }
  if (props.pageId) {
    const selected = await window.mcode.browserTab("select", props.pageId)
    if (selected) {
      apply(selected)
      return
    }
  }
  // No page yet, or its page is gone: a new one, which opens the panel's pages if there were none.
  const fresh = (await window.mcode.browserOpen(bounds)) as State | undefined
  if (!fresh?.active) return
  emit("page", fresh.active)
  state.value = fresh
  address.value = ""
  remeasure()
}

let stopState: (() => void) | undefined
const observer = new ResizeObserver(() => {
  barWidth.value = bar.value?.getBoundingClientRect().width ?? barWidth.value
  remeasure()
})

onMounted(() => {
  stopState = window.mcode.onBrowserState(apply)
  if (root.value) observer.observe(root.value)
  if (bar.value) observer.observe(bar.value)
  window.addEventListener("resize", remeasure)
  void claim()
  void scan()
})

onBeforeUnmount(() => {
  stopState?.()
  observer.disconnect()
  window.removeEventListener("resize", remeasure)
})

watch(() => props.active, (active) => {
  if (active) void claim()
})
watch([showingPage, () => state.value.error], () => remeasure())

async function go() {
  editing.value = false
  apply(await window.mcode.browserNavigate(address.value))
}

async function act(what: "back" | "forward" | "reload" | "forceReload" | "zoomIn" | "zoomOut" | "zoomReset") {
  apply(await window.mcode.browserAct(what))
}

function openExternal() {
  if (showingPage.value) window.mcode.openExternal(state.value.url)
}

async function screenshot() {
  const ok = await window.mcode.browserScreenshot().catch(() => false)
  if (ok) notify(t("rp.browser.toast.screenshotOk"))
  else notifyFailure(t("rp.browser.toast.screenshotFail"))
}

async function clearSite(what: "cookies" | "cache") {
  menuOpen.value = false
  const failure = await window.mcode.browserClearSite(what)
  if (what === "cookies") failure ? notifyFailure(t("rp.browser.toast.clearCookiesError")) : notify(t("rp.browser.toast.clearCookies"))
  else failure ? notifyFailure(t("rp.browser.toast.clearCacheError")) : notify(t("rp.browser.toast.clearCache"))
}

async function scan() {
  servers.value =
    (await app.client
      ?.request({ type: "local.servers" })
      .then((result) => result.servers)
      .catch(() => [])) ?? []
}

function openServer(server: LocalServer) {
  address.value = server.url
  void go()
}

/* Chromium's network error numbers, sorted into MiMo's four explanations. */
const errorKind = computed(() => {
  const code = state.value.error?.code
  if (code === undefined) return undefined
  if (code === -105 || code === -137) return "dns"
  if (code === -106) return "offline"
  if ([-100, -101, -102, -104, -109, -118, -7].includes(code)) return "connection"
  return "generic"
})

defineExpose({
  focusAddress: () => {
    addressInput.value?.focus()
    addressInput.value?.select()
  },
  reload: (force = false) => act(force ? "forceReload" : "reload"),
})
</script>

<template>
  <div ref="root" class="rp-browser" data-rp-browser>
    <div ref="bar" class="rb-bar" :class="{ mini }">
      <span class="rb-dot" aria-hidden="true" />
      <template v-if="!mini">
        <button type="button" class="rb-round" :disabled="!state.canGoBack" :aria-label="t('rp.browser.back')" v-tip="{ label: t('rp.browser.back'), placement: 'bottom' }" @click="act('back')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <button type="button" class="rb-round" :disabled="!state.canGoForward" :aria-label="t('rp.browser.forward')" v-tip="{ label: t('rp.browser.forward'), placement: 'bottom' }" @click="act('forward')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      </template>
      <input
        ref="addressInput"
        v-model="address"
        class="rb-url"
        data-rb-url
        spellcheck="false"
        :placeholder="t('rp.browser.urlPlaceholder')"
        @focus="editing = true"
        @blur="editing = false"
        @keydown.enter.prevent="go"
      />
      <button type="button" class="rb-round" :aria-label="t('rp.browser.reload')" v-tip="{ label: t('rp.browser.reload'), placement: 'bottom' }" @click="act('reload')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>
      </button>
      <template v-if="showingPage && !mini">
        <button type="button" class="rb-round" :aria-label="t('rp.browser.openExternal')" v-tip="{ label: t('rp.browser.openExternal'), placement: 'bottom' }" @click="openExternal">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
        </button>
        <button type="button" class="rb-round" :aria-label="t('rp.browser.screenshotToClipboard')" v-tip="{ label: t('rp.browser.screenshotToClipboard'), placement: 'bottom' }" @click="screenshot">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><circle cx="12" cy="12" r="3" /></svg>
        </button>
      </template>
      <div class="rb-more-wrap">
        <button type="button" class="rb-round" data-rb-more :aria-label="t('rp.browser.more')" v-tip="{ label: t('rp.browser.more'), placement: 'bottom' }" @click="menuOpen = !menuOpen">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
        <template v-if="menuOpen">
          <div class="rb-scrim" @mousedown="menuOpen = false" />
          <div class="rb-menu" role="menu" @keydown.esc="menuOpen = false">
            <button type="button" class="rb-item" :disabled="!showingPage" @click="menuOpen = false; act('forceReload')">{{ t("rp.browser.dotMenu.forceReload") }}</button>
            <div class="rb-zoom">
              <span class="rb-zoom-label">{{ t("rp.browser.dotMenu.zoom") }}</span>
              <button type="button" class="rb-step" :disabled="!showingPage" aria-label="-" @click="act('zoomOut')">−</button>
              <span class="rb-zoom-value">{{ state.zoom }}%</span>
              <button type="button" class="rb-step" :disabled="!showingPage" aria-label="+" @click="act('zoomIn')">+</button>
              <button type="button" class="rb-step" :disabled="!showingPage" aria-label="100%" @click="act('zoomReset')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 5v6h6" /></svg>
              </button>
            </div>
            <div class="rb-rule" />
            <button type="button" class="rb-item danger" @click="clearSite('cookies')">{{ t("rp.browser.dotMenu.clearCookies") }}</button>
            <button type="button" class="rb-item danger" @click="clearSite('cache')">{{ t("rp.browser.dotMenu.clearCache") }}</button>
          </div>
        </template>
      </div>
    </div>

    <div v-show="showingPage && !state.error" ref="stage" class="rb-frame" />

    <div v-if="state.error" class="rb-error" data-rb-error>
      <div class="rb-error-title">{{ t("rp.browser.error.title") }}</div>
      <div class="rb-error-desc">{{ t(`rp.browser.error.${errorKind}`) }}</div>
      <div class="rb-error-url">{{ state.error.url }}</div>
      <button type="button" class="rb-error-retry" @click="act('reload')">{{ t("rp.browser.error.retry") }}</button>
    </div>

    <div v-else-if="!showingPage" class="rb-local" data-rb-local>
      <template v-if="servers.length">
        <div class="rb-local-head">{{ t("rp.browser.local") }}</div>
        <button v-for="server in servers" :key="server.url" type="button" class="rb-server" @click="openServer(server)">
          <span class="rb-server-title">{{ server.title || server.url }}</span>
          <span class="rb-server-url">{{ server.url }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.rp-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* MiMo's address bar: 14 in on three sides, 8 between its parts. */
.rb-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin: 14px 14px 0;
}

.rb-dot {
  flex: none;
  width: 8px;
  height: 8px;
  background: var(--text-success);
  border-radius: 50%;
}

.rb-round {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 50%;
}

.rb-round:hover:not(:disabled) {
  background: var(--surface-hover);
}

.rb-round:disabled {
  opacity: 0.4;
}

.rb-url {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  border-radius: 8px;
  outline: none;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
}

.rb-url:hover,
.rb-url:focus {
  background: var(--surface-hover);
}

.rb-more-wrap {
  position: relative;
  flex: none;
}

.rb-scrim {
  position: fixed;
  inset: 0;
  z-index: 200;
}

/* MiMo's more menu: at least 230 wide, hung from the button's end. */
.rb-menu {
  position: absolute;
  top: calc(100% + 4px);
  inset-inline-end: 0;
  z-index: 201;
  display: flex;
  flex-direction: column;
  min-width: 230px;
  padding: 4px;
  background: var(--surface-menu);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
}

.rb-item {
  padding: 6px 10px;
  color: var(--text-strong);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.rb-item:hover:not(:disabled) {
  background: var(--surface-hover);
}

.rb-item:disabled {
  opacity: 0.45;
}

.rb-item.danger {
  color: var(--text-error);
}

.rb-zoom {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.rb-zoom-label {
  flex: 1;
}

.rb-zoom-value {
  min-width: 44px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.rb-step {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 6px;
}

.rb-step:disabled {
  opacity: 0.45;
}

.rb-rule {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-weak);
}

/* MiMo's page frame: 10 below the bar, 14 in, on a 10px corner. */
.rb-frame {
  flex: 1;
  min-height: 0;
  margin: 10px 14px 14px;
  border-radius: 10px;
  overflow: hidden;
}

.rb-local {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 14px;
  overflow: auto;
}

.rb-local-head {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

/* MiMo's server card: 1px line, 12px corner, 10 by 14, 14 between its lines. */
.rb-server {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  color: var(--text-strong);
  text-align: start;
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 12px;
}

.rb-server:hover {
  background: var(--surface-hover);
}

.rb-server-title {
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.rb-server-url {
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
}

.rb-error {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.rb-error-title {
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.rb-error-desc {
  max-width: 320px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.rb-error-url {
  max-width: 100%;
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  overflow-wrap: anywhere;
}

.rb-error-retry {
  margin-top: 4px;
  padding: 6px 18px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
}

.rb-error-retry:hover {
  background: var(--surface-hover);
}
</style>
