<script setup lang="ts">
import { computed } from "vue"

/*
 * The handful of Lucide glyphs (ISC licence) MiMo's document views draw, at
 * Lucide's own 24 grid and 2-unit round stroke, sized by the caller.
 */
const ICONS: Record<string, string[]> = {
  "undo-2": ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"],
  "redo-2": ["m15 14 5-5-5-5", "M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"],
  history: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"],
  play: ["M6 3 20 12 6 21 6 3z"],
  "folder-open": [
    "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
  ],
  "file-spreadsheet": ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M8 13h2", "M14 13h2", "M8 17h2", "M14 17h2"],
  "file-text": ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
  presentation: ["M2 3h20", "M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3", "m7 21 5-5 5 5"],
  "file-type": ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M9 13v-1h6v1", "M12 12v6", "M11 18h2"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  bot: ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
  pencil: [
    "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    "m15 5 4 4",
  ],
  "file-clock": ["M16 22h2a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3", "M14 2v4a2 2 0 0 0 2 2h4", "M14 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0z", "M9.5 17.5 8 16.25V14"],
  "zoom-in": ["M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z", "m21 21-4.3-4.3", "M11 8v6", "M8 11h6"],
  "zoom-out": ["M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z", "m21 21-4.3-4.3", "M8 11h6"],
  "move-horizontal": ["m18 8 4 4-4 4", "M2 12h20", "m6 8-4 4 4 4"],
  "chevron-up": ["m18 15-6-6-6 6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  globe: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
  "external-link": ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  "chevron-left": ["m15 18-6-6 6-6"],
  "chevron-right": ["m9 18 6-6-6-6"],
}

const props = withDefaults(defineProps<{ name: string; size?: number; strokeWidth?: number; fill?: boolean }>(), { size: 16, strokeWidth: 2, fill: false })
const paths = computed(() => ICONS[props.name] ?? [])
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="fill ? 'currentColor' : 'none'"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="d in paths" :key="d" :d="d" />
  </svg>
</template>
