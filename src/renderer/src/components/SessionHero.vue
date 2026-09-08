<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { ago, t } from "../lib/i18n"
import { projectHue, projectName } from "../lib/project"

/**
 * A session with nothing in it yet.
 *
 * Not a heading and a list of facts about the directory - the new design gives
 * the empty session one thing to say, which is where it is pointed. The
 * wordmark is set almost to the background, and what the session is attached to
 * is stated quietly underneath it.
 *
 * The composer is not part of this. It is docked below, as its own region, in
 * every state a session can be in - so an empty session and a conversation
 * offer the same box in the same place rather than two boxes that happen to
 * look alike.
 */
const app = useApp()

const directory = computed(() => app.current?.directory ?? "")

/** Read from disk: a branch line that cannot be backed by a fact is not drawn. */
const info = ref<{ exists: boolean; branch?: string; modified?: number }>()

watch(
  directory,
  async (next) => {
    info.value = undefined
    if (!next) return
    info.value = await app.workspaceInfo(next).catch(() => undefined)
  },
  { immediate: true },
)

const name = computed(() => projectName(directory.value, app.config?.projectNames))
const icon = computed(() => app.config?.projectIcons?.[directory.value])
const hue = computed(() => app.config?.projectColors?.[directory.value] ?? String(projectHue(directory.value)))
const initial = computed(() => (name.value.match(/[a-z0-9]/i)?.[0] ?? name.value[0] ?? "?").toUpperCase())
</script>

<template>
  <div class="hero">
    <!--
      The room a conversation's header takes, held open here as well, so the
      block below finds the middle of the same box in either state.
    -->
    <div class="gap" aria-hidden="true" />

    <div class="stage">
      <div class="column">
        <div class="wordmark" role="img" :aria-label="t('hero.title')" />

        <div class="foot">
          <button class="chip" v-tip="{ label: directory, placement: 'top' }">
            <span class="avatar" :style="{ '--h': hue }">
              <img v-if="icon" :src="icon" alt="" />
              <template v-else>{{ initial }}</template>
            </span>
            <span class="chip-name">{{ name }}</span>
          </button>

          <template v-if="info?.branch">
            <span class="sep">/</span>
            <span class="chip flat">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5.118 5.686V10.314M5.118 5.686C5.97 5.686 6.661 4.995 6.661 4.143C6.661 3.291 5.97 2.6 5.118 2.6C4.266 2.6 3.575 3.291 3.575 4.143C3.575 4.995 4.266 5.686 5.118 5.686ZM5.118 10.314C4.266 10.314 3.575 11.005 3.575 11.857C3.575 12.709 4.266 13.4 5.118 13.4C5.97 13.4 6.661 12.709 6.661 11.857M5.118 10.314C5.97 10.314 6.661 11.005 6.661 11.857M10.882 5.686C11.734 5.686 12.425 4.995 12.425 4.143C12.425 3.291 11.734 2.6 10.882 2.6C10.03 2.6 9.339 3.291 9.339 4.143C9.339 4.995 10.03 5.686 10.882 5.686ZM10.882 5.686V9.457C10.882 10.783 9.807 11.857 8.482 11.857H6.661" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="chip-name">{{ info.branch }}</span>
            </span>
          </template>

          <template v-if="info?.modified">
            <span class="sep">/</span>
            <span class="modified">{{ t("hero.modified") }}&nbsp;{{ ago(info.modified) }}</span>
          </template>
        </div>

        <div v-if="info && !info.exists" class="missing">{{ t("hero.missing") }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * A region of the workspace column rather than a layer floating over it. Held
 * at a fixed fraction of the height, the block slid down the window as the
 * window grew; the reference gives the empty session a flex region and lets the
 * contents find the middle of it, so a resize re-centres them instead.
 */
.hero {
  overflow: hidden;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

/*
 * What a conversation spends on its header. Reserved here too, so the block
 * below centres in the same box whether or not there is a header above it.
 */
.gap {
  flex-shrink: 0;
  height: 48px;
}

/*
 * Centred, less the room kept clear at the foot. That inset is what puts the
 * mark above the middle rather than in it, so a first message long enough to
 * grow the box below rises into empty space instead of meeting the wordmark.
 */
.stage {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding-inline: 24px;
  padding-bottom: 120px;
}

.column {
  width: 100%;
  max-width: 800px;
}

/*
 * Barely there: the mark is set at the background's own weight, so it reads as
 * part of the surface rather than as something placed on it.
 */
.wordmark {
  width: 100%;
  height: 129px;
  background-image: var(--wordmark);
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: 0.07;
}

/* One step below the mark, which is the gap the reference sets between the
   thing the screen is named after and the facts stated under it. */
.foot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  margin-top: 16px;
  color: var(--text-weak);
  font-size: 13px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 203px;
  height: 28px;
  padding: 0 6px;
  color: inherit;
  border-radius: var(--radius-sm);
  transition: background 0.12s;
}

.chip:not(.flat):hover {
  background: var(--surface-hover);
}

/* The branch is a statement, not a control, so it takes no hover. */
.chip.flat {
  padding: 0 8px;
  cursor: default;
}

.chip-name {
  overflow: hidden;
  min-width: 0;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.avatar {
  overflow: hidden;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: #fff;
  background: hsl(var(--h) 42% 46%);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sep {
  margin: 0 4px;
  opacity: 0.5;
  user-select: none;
}

/* Sits in the same quiet row as the project and branch chips. */
.modified {
  color: var(--text-weak);
  white-space: nowrap;
}

.missing {
  margin-top: 6px;
  color: var(--error);
  font-size: 12.5px;
  text-align: center;
}
</style>
