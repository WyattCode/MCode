<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import type { ModelInfo } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { isLatest, withoutLatest } from "../lib/model"
import ProviderIcon from "./ProviderIcon.vue"
import ModelTooltip from "./ModelTooltip.vue"

/**
 * Which models the picker offers.
 *
 * The same switches live in Settings, but reaching them meant leaving the
 * composer, opening Settings and finding the page - a long way round from the
 * menu that is showing too many models right now.
 */

const emit = defineEmits<{ close: []; connect: [] }>()
const app = useApp()

const query = ref("")

const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return app.providers
    .filter((provider) => provider.configured)
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) =>
          !needle || model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0)
})

function key(provider: string, model: string) {
  return `${provider}/${model}`
}

/**
 * The row the pointer is on, and where it is.
 *
 * The same hover tooltip the composer's picker draws, for the same reason: this
 * is the other list of models in the app, and a reader deciding which ones to
 * keep needs what the model can do rather more than a reader picking one to
 * send the next message with. Kept in step with Composer.vue deliberately -
 * these were the two consumers of the same wire data, and only one of them had
 * it.
 */
const hovered = ref<{ model: ModelInfo; provider: string; anchor: DOMRect }>()

function hoverModel(model: ModelInfo, provider: string, event: MouseEvent) {
  hovered.value = { model, provider, anchor: (event.currentTarget as HTMLElement).getBoundingClientRect() }
}

/**
 * An empty list means "not curated yet", in which case everything is offered -
 * so the first toggle has to seed the list from what is currently visible,
 * otherwise turning one model off would appear to turn every other one off.
 */
function enabled(provider: string, model: string) {
  const chosen = app.config?.enabledModels ?? []
  return chosen.length === 0 || chosen.includes(key(provider, model))
}

async function toggle(provider: string, model: string) {
  const chosen = app.config?.enabledModels ?? []
  const seeded = chosen.length
    ? chosen
    : app.providers.flatMap((entry) =>
        entry.configured ? entry.models.map((candidate) => key(entry.id, candidate.id)) : [],
      )
  const target = key(provider, model)
  const next = seeded.includes(target) ? seeded.filter((entry) => entry !== target) : [...seeded, target]
  await app.patchConfig({ enabledModels: next })
}

/*
 * Escape closes, as it does in every other dialog here. The back arrow is the
 * way to step back; a key that sometimes closes and sometimes retreats is a key
 * nobody presses with confidence.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  event.preventDefault()
  emit("close")
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')">
    <div v-modal class="dialog">
      <header class="bar">
        <h2 class="title">{{ t("model.manage") }}</h2>
        <span class="gap" />
        <button class="add" @click="emit('connect')">
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 2.6v8.8M2.6 7h8.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          {{ t("connect.title") }}
        </button>
        <button class="icon" v-tip="{ label: t('common.close'), placement: 'bottom' }" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <p class="lead">{{ t("model.manageSub") }}</p>

      <div class="search">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7.2" cy="7.2" r="4.4" stroke="currentColor" stroke-width="1.3" />
          <path d="M10.6 10.6 13.4 13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <input v-model="query" class="search-in" :placeholder="t('model.search')" spellcheck="false" />
      </div>

      <div class="list">
        <div v-if="!groups.length" class="empty">
          {{ app.providers.some((p) => p.configured) ? t("model.none") : t("model.needProvider") }}
        </div>

        <template v-for="group in groups" :key="group.provider.id">
          <div class="group-head">
            <ProviderIcon :id="group.provider.id" :name="group.provider.name" />
            <span>{{ group.provider.name }}</span>
          </div>
          <div
            v-for="model in group.models"
            :key="model.id"
            class="row"
            @mouseenter="hoverModel(model, group.provider.name, $event)"
            @mouseleave="hovered = undefined"
          >
            <!--
              The word taken out of the name and shown as a tag, which is what
              the reference's own picker row does rather than leaving "(latest)"
              written into the middle of a list of names.
            -->
            <span class="row-name">{{ withoutLatest(model.name) }}</span>
            <span v-if="isLatest(model.name)" class="tag">{{ t("model.tag.latest") }}</span>
            <button
              class="switch"
              :class="{ on: enabled(group.provider.id, model.id) }"
              role="switch"
              :aria-checked="enabled(group.provider.id, model.id)"
              :aria-label="model.name"
              @click="toggle(group.provider.id, model.id)"
            >
              <span class="knob" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <!--
      Beside the list rather than inside it, for the reason the composer's
      picker teleports its own: the rows scroll inside a clipped box, and a
      panel drawn next to a row from in there is cut off at that box's edge.
    -->
    <Teleport to="body">
      <ModelTooltip v-if="hovered" :model="hovered.model" :provider="hovered.provider" :anchor="hovered.anchor" />
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * The picker's own tag, copied rather than shared: it is six declarations, and
 * both components style their rows in their own scoped block.
 */
.tag {
  flex: none;
  padding: 0 5px;
  color: var(--text-weaker);
  border: 1px solid var(--border-weaker);
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: var(--scrim);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 64px));
  max-height: min(640px, calc(100vh - 96px));
  padding: 20px 26px 22px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  outline: none;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gap {
  flex: 1;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 500;
  line-height: 20px;
  letter-spacing: -0.13px;
}

.add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  color: var(--text-strong);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: 12.5px;
}

.add:hover {
  border-color: var(--border-strong);
}

/* Twenty square, pulled two pixels out of the header's padding so the glyph
   lines up with the title rather than the button's box doing. */
.icon {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: -2px;
  margin-inline-end: -2px;
  color: var(--icon-weak);
  border-radius: 4px;
}

.icon:hover {
  background: var(--surface-hover);
}

.icon:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.lead {
  margin: 4px 0 0;
  color: var(--text-base);
  font-size: 13px;
  font-weight: 440;
  line-height: 20px;
  letter-spacing: -0.04px;
}

.search {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 36px;
  margin: 14px 0 4px;
  padding: 0 12px;
  color: var(--text-weaker);
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
}

.search:focus-within {
  border-color: var(--border-strong);
}

.search-in {
  flex: 1;
  color: var(--text-strong);
  background: none;
  border: none;
  font-size: 13px;
  outline: none;
}

.list {
  margin: 0 -6px;
  overflow-y: auto;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px 6px 6px;
  color: var(--text-weaker);
  font-size: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-block: 7px;
  /* The name's lead-in and the switch's, which are the row's two ends. */
  padding-inline: 10px 6px;
  /* Transparent at rest so gaining an outline on hover shifts nothing. */
  border: 1px solid transparent;
  border-radius: var(--radius-md);
}

.row:hover {
  background: var(--surface-hover);
  border-color: var(--border-weak);
}

.row-name {
  flex: 1;
  color: var(--text-strong);
  font-size: 13.5px;
}

.switch {
  flex-shrink: 0;
  width: 32px;
  height: 18px;
  padding: 2px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
  transition:
    background 0.14s,
    border-color 0.14s;
}

.switch.on {
  background: var(--text-strong);
  border-color: transparent;
}

.knob {
  display: block;
  width: 12px;
  height: 12px;
  background: var(--text-weaker);
  border-radius: 50%;
  transition:
    margin-inline-start 0.14s,
    background 0.14s;
}

.switch.on .knob {
  background: var(--surface-base);
  margin-inline-start: 14px;
}

.empty {
  padding: 26px 6px;
  color: var(--text-weaker);
  font-size: 13px;
  text-align: center;
}
</style>
