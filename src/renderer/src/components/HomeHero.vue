<script setup lang="ts">
import { computed, ref } from "vue"
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
defineProps<{ commands?: { id: string; title: string; hint?: string; run: () => void }[] }>()

/* What the box asks the window for, passed straight through. */
const emit = defineEmits<{
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

      <div class="dock-slot">
        <Composer
          :commands="commands"
          :start-directory="directory"
          @open-settings="emit('open-settings')"
          @connect="emit('connect')"
          @manage-models="emit('manage-models')"
          @shell="emit('shell', $event)"
        />
      </div>

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
</style>
