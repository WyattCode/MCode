<script setup lang="ts">
import { computed, ref } from "vue"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import SelectMenu from "./SelectMenu.vue"

/**
 * The 2.0 home screen: what a new task starts from.
 *
 * Laid out from Xiaomi MiMo's, measured: a centred column with a line of
 * greeting over a 712-wide composer card (#1f1f1f on the dark scheme, radius
 * 20, a half-pixel line and a soft drop shadow), and under it a picker for
 * the project the task goes into. The greeting is MCode's own, and so is the
 * mark above it.
 *
 * A task here is a session, and a session is created on the server as soon
 * as it exists - so the card does not take typing itself. Clicking it starts
 * the task in the chosen project and hands the keyboard to that session's
 * composer, which is the real one, with everything it carries.
 */
const emit = defineEmits<{ start: [directory: string | undefined] }>()

const app = useApp()

const name = (directory: string) =>
  app.config?.projectNames?.[directory] || directory.split(/[\\/]/).filter(Boolean).pop() || directory

const projects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const latest = new Map<string, number>()
  for (const session of app.sessions) {
    if (closed.has(session.directory)) continue
    latest.set(session.directory, Math.max(latest.get(session.directory) ?? 0, session.updated))
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([directory]) => directory)
})

const picked = ref<string>()
const directory = computed(() => picked.value ?? projects.value[0] ?? app.config?.directory ?? undefined)
const options = computed(() => projects.value.map((entry) => ({ value: entry, label: name(entry) })))
</script>

<template>
  <div class="home-hero">
    <div class="drag" aria-hidden="true" />
    <div class="column">
      <div class="wordmark" role="img" aria-label="MCode" />
      <p class="slogan">{{ t("home.slogan") }}</p>

      <button class="card" @click="emit('start', directory)">
        <span class="placeholder">{{ t("home.describe") }}</span>
        <span class="bar">
          <span class="round" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" stroke-linecap="square" />
            </svg>
          </span>
          <span class="spacer" />
          <span class="round send" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M10 15.5V4.5M5 9.5L10 4.5L15 9.5" stroke="currentColor" stroke-linecap="square" />
            </svg>
          </span>
        </span>
      </button>

      <div v-if="options.length" class="enter">
        <SelectMenu
          :model-value="directory ?? ''"
          :options="options"
          :aria-label="t('home.enterProject')"
          @update:model-value="picked = $event"
        />
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

/* 712x103, radius 20, half-pixel line, 0 2px 10px shadow, 8 padding. */
.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-height: 103px;
  padding: 8px;
  color: var(--text-strong);
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 20px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.5);
  cursor: text;
  text-align: start;
}

.placeholder {
  padding: 5px 5px 8px;
  color: var(--text-weak);
  font-size: 14px;
  line-height: 21px;
}

.bar {
  display: flex;
  align-items: center;
  margin-top: auto;
}

.spacer {
  flex: 1;
}

/* 30x30 round controls, as MiMo's composer draws them. */
.round {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--text-base);
  border-radius: 50%;
}

.send {
  color: #0d0d0d;
  background: #5a5a5a;
}

.enter {
  align-self: flex-start;
  margin-top: 12px;
}
</style>
