<script setup lang="ts">
import { computed } from "vue"
import { subagentTone } from "@shared/subagent"

/**
 * subagents: a subagent's avatar. MCode's own drawing - a round face in one of
 * six tones - at MiMo's sizes: 28 in a tab row, 20 in a pill, with the status
 * dot at its lower corner when asked for.
 */
const props = withDefaults(
  defineProps<{
    seed?: string
    status?: string
    compact?: boolean
    showStatus?: boolean
  }>(),
  { compact: false, showStatus: false },
)

const tone = computed(() => subagentTone(props.seed))
</script>

<template>
  <span
    class="subagent-icon"
    :class="[status, { compact }]"
    data-subagent-avatar
    :data-subagent-tone="tone"
    aria-hidden="true"
  >
    <svg class="subagent-face" viewBox="0 0 24 24" fill="none">
      <circle class="face-ground" cx="12" cy="12" r="11" />
      <path class="face-ink" d="M12 1.6v2.2" stroke-width="1.6" stroke-linecap="round" />
      <circle class="face-ink-fill" cx="12" cy="1.8" r="1.2" />
      <circle class="face-ink-fill" cx="8.6" cy="11" r="1.5" />
      <circle class="face-ink-fill" cx="15.4" cy="11" r="1.5" />
      <path class="face-ink" d="M8.8 15.2c1.8 1.5 4.6 1.5 6.4 0" stroke-width="1.6" stroke-linecap="round" />
    </svg>
    <span v-if="showStatus" class="subagent-status-dot" />
  </span>
</template>

<style scoped>
/* MiMo's subagent-icon: a 28px cell holding a 24px face; compact is 20 all through. */
.subagent-icon {
  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
}

.subagent-face {
  display: block;
  width: 24px;
  height: 24px;
}

.subagent-icon.compact,
.subagent-icon.compact > .subagent-face {
  width: 20px;
  height: 20px;
}

/* Six tones: a pale ground with deep ink in light, the reverse in dark. */
.face-ground {
  fill: var(--ground);
}

.face-ink {
  stroke: var(--ink);
}

.face-ink-fill {
  fill: var(--ink);
}

.subagent-icon[data-subagent-tone="0"] { --ground: #dbe7fb; --ink: #2553b8; }
.subagent-icon[data-subagent-tone="1"] { --ground: #d9f2df; --ink: #1f7a3d; }
.subagent-icon[data-subagent-tone="2"] { --ground: #fbeccb; --ink: #9a5a08; }
.subagent-icon[data-subagent-tone="3"] { --ground: #e9e2fb; --ink: #6135c2; }
.subagent-icon[data-subagent-tone="4"] { --ground: #fbe0e4; --ink: #b12c4a; }
.subagent-icon[data-subagent-tone="5"] { --ground: #d4f1ec; --ink: #0f6f66; }

:root[data-theme="dark"] .subagent-icon[data-subagent-tone="0"] { --ground: #22375c; --ink: #a9c6fa; }
:root[data-theme="dark"] .subagent-icon[data-subagent-tone="1"] { --ground: #1f3f2a; --ink: #9bdcaf; }
:root[data-theme="dark"] .subagent-icon[data-subagent-tone="2"] { --ground: #463515; --ink: #f0c77a; }
:root[data-theme="dark"] .subagent-icon[data-subagent-tone="3"] { --ground: #352a55; --ink: #c8b6f6; }
:root[data-theme="dark"] .subagent-icon[data-subagent-tone="4"] { --ground: #4a2430; --ink: #f2a8b8; }
:root[data-theme="dark"] .subagent-icon[data-subagent-tone="5"] { --ground: #173f3b; --ink: #8fdcd1; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .subagent-icon[data-subagent-tone="0"] { --ground: #22375c; --ink: #a9c6fa; }
  :root:not([data-theme="light"]) .subagent-icon[data-subagent-tone="1"] { --ground: #1f3f2a; --ink: #9bdcaf; }
  :root:not([data-theme="light"]) .subagent-icon[data-subagent-tone="2"] { --ground: #463515; --ink: #f0c77a; }
  :root:not([data-theme="light"]) .subagent-icon[data-subagent-tone="3"] { --ground: #352a55; --ink: #c8b6f6; }
  :root:not([data-theme="light"]) .subagent-icon[data-subagent-tone="4"] { --ground: #4a2430; --ink: #f2a8b8; }
  :root:not([data-theme="light"]) .subagent-icon[data-subagent-tone="5"] { --ground: #173f3b; --ink: #8fdcd1; }
}

/* MiMo's status dot: 6px with a 2px ring of the panel, at the lower corner; dim until a status colours it. */
.subagent-status-dot {
  position: absolute;
  inset-block-end: -2px;
  inset-inline-end: -2px;
  box-sizing: content-box;
  width: 6px;
  height: 6px;
  background: color-mix(in srgb, var(--text-strong) 40%, transparent);
  border: 2px solid var(--surface-raised);
  border-radius: 50%;
}

.subagent-icon.running .subagent-status-dot {
  background: #2f8f5b;
  box-shadow: 0 0 0 3px #2f8f5b1f;
}

.subagent-icon.completed .subagent-status-dot {
  background: #6f766f;
}

.subagent-icon.error .subagent-status-dot {
  background: #e5484d;
}

.subagent-icon.rejected .subagent-status-dot {
  background: #d28a32;
}

.subagent-icon.skipped .subagent-status-dot {
  background: #8b918b;
}
</style>
