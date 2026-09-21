<script setup lang="ts">
import type { StepIconName } from "../../lib/tool-meta"

/**
 * The marks in front of MiMo's step rows, in MCode's own drawing.
 *
 * The same families MiMo uses - a page for reading, a pencil for editing, a
 * terminal window for a command - drawn here on a 24 grid at stroke 2 and
 * shown at 14px in the row's own colour, so a running row's shimmer and a
 * failed row's red never have to reach inside the icon.
 */
withDefaults(defineProps<{ name: StepIconName; size?: number }>(), { size: 14 })
</script>

<template>
  <svg
    class="step-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    :data-step-icon="name"
  >
    <template v-if="name === 'read'">
      <path d="M6 3h8.5L19 7.5V21H6z" />
      <path d="M9.5 11.5h6M9.5 15h6M9.5 18.5h3" />
    </template>
    <template v-else-if="name === 'edit'">
      <path d="M15.2 4.8a2.3 2.3 0 0 1 3.3 3.3L8 18.6l-4 1.2 1.2-4z" />
      <path d="M13 20h7" />
    </template>
    <template v-else-if="name === 'write'">
      <path d="M12 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V12" />
      <path d="M18 3.6a2 2 0 0 1 2.8 2.8L13 14.2l-3.6.9.9-3.6z" />
    </template>
    <template v-else-if="name === 'bash'">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 8.5h18" />
      <path d="m7.5 12 2.8 2.5-2.8 2.5" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </template>
    <template v-else-if="name === 'list'">
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="3" />
    </template>
    <template v-else-if="name === 'globe'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </template>
    <template v-else-if="name === 'todo'">
      <rect x="3.5" y="4.5" width="6" height="6" rx="1.2" />
      <path d="m4.8 17 1.6 1.6 3-3.2" />
      <path d="M13 7.5h7.5M13 17h7.5" />
    </template>
    <template v-else-if="name === 'invalid' || name === 'alert'">
      <path d="M10.3 4.2 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
    </template>
    <template v-else-if="name === 'browser'">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18" />
      <path d="M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01" />
    </template>
    <template v-else-if="name === 'fetch'">
      <path d="M12 3.5v10" />
      <path d="m8 10 4 4 4-4" />
      <path d="M4 14.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5" />
    </template>
    <template v-else-if="name === 'permission'">
      <path d="M12 3 19 6v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6z" />
      <path d="M10 10a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.4" />
      <path d="M12 16h.01" />
    </template>
    <template v-else-if="name === 'question'">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.3" />
      <path d="M12 16.6h.01" />
    </template>
    <template v-else-if="name === 'reconnect'">
      <path d="M4.5 9.5a11 11 0 0 1 15 0" />
      <path d="M7.5 12.8a6.5 6.5 0 0 1 9 0" />
      <path d="M12 16.5h.01" stroke-width="3" />
    </template>
    <template v-else-if="name === 'skill'">
      <path d="M19.5 4.5c-5.8.4-10.4 4.4-12 10.6L6 20" />
      <path d="M19.5 4.5c.3 5.6-3.4 10-9.9 10.9" />
      <path d="M10.2 11.2 13 8.4" />
    </template>
    <template v-else-if="name === 'memory'">
      <path d="M12 5.5a3.5 3.5 0 0 0-6.6 1.6A3.3 3.3 0 0 0 4 13a3.4 3.4 0 0 0 3 5 3 3 0 0 0 5 .5z" />
      <path d="M12 5.5a3.5 3.5 0 0 1 6.6 1.6A3.3 3.3 0 0 1 20 13a3.4 3.4 0 0 1-3 5 3 3 0 0 1-5 .5z" />
      <path d="M12 5.5v13" />
    </template>
    <template v-else-if="name === 'actor'">
      <rect x="5" y="8" width="14" height="11" rx="3.5" />
      <path d="M12 4.5V8" />
      <path d="M9.5 13h.01M14.5 13h.01" stroke-width="2.6" />
    </template>
    <template v-else-if="name === 'speaker'">
      <path d="M11.5 5 7 8.8H3.8v6.4H7l4.5 3.8z" />
      <path d="M15.4 9.6a3.4 3.4 0 0 1 0 4.8" />
      <path d="M18.2 6.8a7.3 7.3 0 0 1 0 10.4" />
    </template>
    <template v-else>
      <path d="M14.5 5.5a4.2 4.2 0 0 0-5.3 5.3L4 16a1.9 1.9 0 0 0 2.7 2.7l5.2-5.2a4.2 4.2 0 0 0 5.3-5.3l-2.5 2.5-2.4-.5-.5-2.4z" />
    </template>
  </svg>
</template>
