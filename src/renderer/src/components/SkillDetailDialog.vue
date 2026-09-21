<script setup lang="ts">
import { computed, ref } from "vue"
import type { SkillSummary } from "@shared/protocol"
import { language, t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"
import { skillBrief, skillDescription, skillHue, skillTitle, type SkillContentState } from "../lib/skill-display"

/**
 * MiMo's skill card: opened from a skill on the plugins page.
 *
 * A header with the skill's mark, its name, the word 技能 and its switch; the
 * one-line summary; the description; 查看内容, which reads the whole SKILL.md
 * on first opening; and a footer with 卸载 for a skill of the user's own, 让
 * 智能体配置 for any but a built-in one, and 在对话中试用. As in MiMo, 卸载
 * asks nothing first - the folder goes to the app's skill trash, not away.
 */
const props = defineProps<{ skill: SkillSummary; busy: boolean; content: SkillContentState }>()
const emit = defineEmits<{
  close: []
  toggle: [enabled: boolean]
  uninstall: []
  configure: []
  "try-skill": []
  "load-content": []
}>()

const open = ref(false)
const title = computed(() => skillTitle(props.skill, language.value))
const brief = computed(() => skillBrief(props.skill, language.value))
const description = computed(() => skillDescription(props.skill, language.value))
const hue = computed(() => skillHue(props.skill.name))

function toggleContent() {
  open.value = !open.value
  if (open.value && props.content.status === "idle") emit("load-content")
}

useEscapeLayer(() => emit("close"))
</script>

<template>
  <div class="scrim" data-skill-overlay @mousedown.self="emit('close')">
    <div v-modal class="card" role="dialog" aria-labelledby="skill-card-title" :data-skill-card="skill.name">
      <button class="close" data-skill-close :aria-label="t('skillDetail.close')" @click="emit('close')">✕</button>
      <div class="head">
        <span class="mark" aria-hidden="true">
          <template v-if="skill.icon">{{ skill.icon }}</template>
          <span v-else class="puzzle" :style="{ '--h': hue }">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path
                d="M15.39 4.39a1 1 0 0 0 1.68-.47 2.5 2.5 0 1 1 3.01 3.01 1 1 0 0 0-.47 1.68l1.57 1.57a2.4 2.4 0 0 1 0 3.4l-1.57 1.57a1 1 0 0 1-1.68-.47 2.5 2.5 0 1 0-3.01 3.01 1 1 0 0 1 .47 1.68l-1.57 1.57a2.4 2.4 0 0 1-3.4 0l-1.57-1.57a1 1 0 0 0-1.68.47 2.5 2.5 0 1 1-3.01-3.01 1 1 0 0 0 .47-1.68l-1.57-1.57a2.4 2.4 0 0 1 0-3.4l1.57-1.57a1 1 0 0 1 1.68.47 2.5 2.5 0 1 0 3.01-3.01 1 1 0 0 1-.47-1.68l1.57-1.57a2.4 2.4 0 0 1 3.4 0z"
              />
            </svg>
          </span>
        </span>
        <div class="head-text">
          <b id="skill-card-title">{{ title }}</b>
          {{ " " }}
          <span class="kind">{{ t("skillDetail.kind") }}</span>
        </div>
        <button
          class="switch"
          :class="{ on: skill.enabled }"
          role="switch"
          data-skill-toggle
          :aria-checked="skill.enabled"
          :aria-label="t('skillDetail.toggle')"
          @click="emit('toggle', !skill.enabled)"
        >
          <span class="knob" />
        </button>
      </div>
      <div v-if="brief" class="brief" dir="auto">{{ brief }}</div>
      <div class="body">
        <div v-if="description" class="desc" dir="auto">{{ description }}</div>
        <button class="content-toggle" data-skill-content-toggle :aria-expanded="open" @click="toggleContent">
          {{ open ? "▾" : "▸" }} {{ t("skillDetail.viewContent") }}
        </button>
        <div v-if="open" class="content" data-skill-content>
          <div v-if="content.status === 'loading'" class="hint">{{ t("skillDetail.contentLoading") }}</div>
          <div v-else-if="content.status === 'failed'" class="hint">{{ t("skillDetail.contentUnavailable") }}</div>
          <template v-else-if="content.status === 'ready'">
            <div class="path" dir="ltr">{{ content.path }}</div>
            <pre class="pre" dir="auto">{{ content.text || t("skillDetail.contentEmpty") }}</pre>
            <div v-if="content.truncated" class="hint">{{ t("skillDetail.contentTruncated") }}</div>
          </template>
        </div>
      </div>
      <div class="foot">
        <button v-if="skill.removable" class="uninstall" data-skill-uninstall :disabled="busy" @click="emit('uninstall')">
          {{ busy ? t("skillDetail.processing") : t("skillDetail.uninstall") }}
        </button>
        <div class="foot-end">
          <button v-if="!skill.builtin" class="configure" data-skill-configure @click="emit('configure')">✨ {{ t("skillDetail.agentConfig") }}</button>
          <button class="try" data-skill-try @click="emit('try-skill')">↩ {{ t("skillDetail.tryInChat") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * MiMo's skill card, measured: 520 wide (at most 90% of the window) and 80% of
 * its height, a 16 corner and 22 inside, the close mark 14 in from the corner;
 * a 30px mark, a 16px title, the summary 13 and muted, the description on a
 * faint 10-cornered panel, and a footer 18 below with 32-tall buttons.
 */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 520px;
  max-width: 90vw;
  max-height: 80vh;
  padding: 22px;
  background: var(--surface-raised);
  border-radius: 16px;
  box-shadow: var(--shadow-overlay);
}

.close {
  position: absolute;
  top: 14px;
  inset-inline-end: 14px;
  padding: 0;
  color: var(--text-weak);
  font-size: calc(16px * var(--ui-font-scale, 1));
  background: transparent;
  border: 0;
}

.close:hover {
  color: var(--text-strong);
}

.head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  padding-inline-end: 28px;
}

.mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  font-size: calc(30px * var(--ui-font-scale, 1));
  line-height: 1;
}

.puzzle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  color: hsl(var(--h) 52% 32%);
  background: hsl(var(--h) 60% 91%);
  border-radius: 12px;
}

.head-text {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  font-size: calc(16px * var(--ui-font-scale, 1));
  overflow-wrap: anywhere;
}

.head-text b {
  font-weight: 600;
}

.kind {
  color: var(--text-weak);
  font-weight: 400;
}

.brief {
  flex: none;
  margin: 6px 0 0;
  padding: 0 12px 10px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.desc {
  margin-top: 14px;
  padding: 12px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
  white-space: pre-wrap;
  background: color-mix(in srgb, var(--text-strong) 3%, transparent);
  border-radius: 10px;
}

.brief + .body .desc {
  margin-top: 6px;
}

.content-toggle {
  display: block;
  margin-top: 12px;
  padding: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  background: transparent;
  border: 0;
}

.content-toggle:hover {
  color: var(--text-strong);
}

.path {
  margin-top: 8px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  word-break: break-all;
}

.hint {
  margin-top: 8px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.pre {
  margin: 6px 0 0;
  padding: 12px;
  color: var(--text-strong);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  background: color-mix(in srgb, var(--text-strong) 3%, transparent);
  border-radius: 10px;
}

.foot {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  margin-top: 18px;
}

.uninstall {
  padding: 0;
  color: var(--text-error);
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: transparent;
  border: 0;
}

.uninstall:disabled {
  opacity: 0.6;
}

.foot-end {
  display: flex;
  gap: 8px;
  margin-inline-start: auto;
}

.configure,
.try {
  height: calc(32px * var(--ui-font-scale, 1));
  padding: 0 14px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  border-radius: 8px;
}

.configure {
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
}

.configure:hover {
  background: color-mix(in srgb, var(--text-strong) 4%, transparent);
}

.try {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border: 0;
}

.try:hover {
  filter: brightness(0.92);
}

/* The plugins page's round switch, so one control reads one way. */
.switch {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  width: 32px;
  height: 20px;
  background: color-mix(in srgb, var(--text-strong) 22%, var(--surface-raised));
  border: 0;
  border-radius: 999px;
  transition: background-color 0.15s;
}

.switch.on {
  background: var(--icon-base);
}

.knob {
  position: absolute;
  top: 2px;
  width: 16px;
  height: 16px;
  background: var(--icon-base);
  border-radius: 50%;
  inset-inline-start: 2px;
  transition: inset-inline-start 0.15s, background-color 0.15s;
}

.switch.on .knob {
  background: var(--surface-raised);
  inset-inline-start: 14px;
}
</style>
