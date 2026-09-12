<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { language, sessionTitle, t } from "../lib/i18n"
import { renderMarkdown } from "../lib/markdown"
import { estimateBreakdown, readContext } from "./session-context"

/**
 * Everything the app knows about what this conversation has cost.
 *
 * The ring in the session header is one number, and one number cannot be
 * questioned: someone who reads 78% has no way to find out whether that is the
 * transcript, the tools, or a system prompt they never wrote. This is where the
 * ring goes when it is pressed - the same figures broken apart, the turn they
 * were read off named, and the messages themselves available exactly as they
 * are held.
 *
 * The System Prompt section sits between the breakdown and the raw messages,
 * which is where the reference puts it: the instructions every turn is given
 * before a word of the conversation, and the largest single thing in the
 * context window that nobody in the conversation wrote.
 */
const app = useApp()

const emit = defineEmits<{ close: []; export: [] }>()

/**
 * The instructions the model is given before the conversation.
 *
 * Asked for when the panel opens rather than held on the session, because the
 * server assembles it per request out of the agent, the project's own files and
 * the machine it is running on - so there is nothing to keep in step with, and
 * a cached copy would go stale the moment an AGENTS.md changed.
 *
 * Undefined until it arrives, and if the request fails it stays undefined: a
 * panel of figures is not the place to report that one of them is missing, and
 * the section simply does not appear.
 */
const prompt = ref<string>()

/**
 * Whether the request came back with nothing.
 *
 * Kept apart from `prompt` being unset, which is also true for the moment
 * between the panel opening and the answer arriving. Only the failure is worth
 * saying anything about; the wait is not, and a line that appeared for a
 * heartbeat on every open would be worse than no line at all.
 */
const promptFailed = ref(false)

watch(
  () => app.currentID,
  (id) => {
    prompt.value = undefined
    promptFailed.value = false
    if (!id) return
    void app
      .systemPrompt(id)
      .then((value) => {
        // The reader can change session while this is in flight, and an answer
        // for a session they have left would be captioned with the wrong one.
        if (app.currentID === id) prompt.value = value
      })
      .catch(() => {
        if (app.currentID === id) promptFailed.value = true
      })
  },
  { immediate: true },
)

const promptHtml = computed(() => (prompt.value ? renderMarkdown(prompt.value) : ""))

const reading = computed(() => readContext(app.messages, app.providers))

/**
 * Nothing to say, rather than nothing to see.
 *
 * A session that has not had a reply yet has no turn to read figures off, and
 * every one of them is genuinely unknown. The reference writes them out as a
 * dash apiece rather than hiding the rows, which keeps the shape of the panel
 * steady as the first answer arrives.
 */
const UNKNOWN = "—"

/*
 * Money and thousands separators in the language the app is set to, not the one
 * the machine happens to be in. Someone who has put this interface into German
 * is reading German, and 1.234 is how German writes that number however the
 * operating system is configured; Arabic goes further and wants its own digits.
 * The language ids are already BCP-47 tags, which is what Intl asks for.
 *
 * Dollars whatever the language, because the number is dollars: providers price
 * in them and nothing here converts it.
 */
const money = computed(
  () => new Intl.NumberFormat(language.value, { style: "currency", currency: "USD" }),
)

/**
 * A date and time at the length the reference prints them: month by name, so
 * there is no question which half is the day.
 */
const stamp = computed(
  () =>
    new Intl.DateTimeFormat(language.value, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
)

const count = (value: number | undefined): string =>
  value === undefined ? UNKNOWN : value.toLocaleString(language.value)

const when = (value: number | undefined): string =>
  value === undefined ? UNKNOWN : stamp.value.format(value)

const counts = computed(() => ({
  all: app.messages.length,
  user: app.messages.filter((message) => message.role === "user").length,
  assistant: app.messages.filter((message) => message.role === "assistant").length,
}))

/**
 * The panel's figures, in the reference's own order.
 *
 * Written out one by one rather than generated, because the keys have to be
 * visible to `npm run i18ncheck` as literals: a key assembled at runtime is a
 * key nothing can confirm exists.
 */
const stats = computed(() => {
  const found = reading.value
  return [
    { key: "session", name: t("context.stats.session"), value: app.current ? sessionTitle(app.current.title) : UNKNOWN },
    { key: "messages", name: t("context.stats.messages"), value: count(counts.value.all) },
    { key: "provider", name: t("context.stats.provider"), value: found?.provider ?? UNKNOWN },
    { key: "model", name: t("context.stats.model"), value: found?.model ?? UNKNOWN },
    { key: "limit", name: t("context.stats.limit"), value: count(found?.window) },
    { key: "total", name: t("context.stats.totalTokens"), value: count(found?.used) },
    {
      key: "usage",
      name: t("context.stats.usage"),
      value: found?.percent === undefined ? UNKNOWN : `${count(found.percent)}%`,
    },
    { key: "input", name: t("context.stats.inputTokens"), value: count(found?.usage.input) },
    { key: "output", name: t("context.stats.outputTokens"), value: count(found?.usage.output) },
    { key: "reasoning", name: t("context.stats.reasoningTokens"), value: count(found?.usage.reasoning) },
    {
      key: "cache",
      name: t("context.stats.cacheTokens"),
      value: found ? `${count(found.usage.cacheRead)} / ${count(found.usage.cacheWrite)}` : UNKNOWN,
    },
    { key: "userMessages", name: t("context.stats.userMessages"), value: count(counts.value.user) },
    {
      key: "assistantMessages",
      name: t("context.stats.assistantMessages"),
      value: count(counts.value.assistant),
    },
    {
      key: "cost",
      // The session's running total, not the last turn's: that is the number
      // anyone asking "what has this cost me" means.
      name: t("context.stats.totalCost"),
      value: money.value.format(app.current?.usage.cost ?? 0),
    },
    { key: "created", name: t("context.stats.sessionCreated"), value: when(app.current?.created) },
    // The turn the figures above were read off, which is the last one that
    // spent anything - not necessarily the last message in the transcript.
    { key: "activity", name: t("context.stats.lastActivity"), value: when(found?.message.time.created) },
  ]
})

const breakdown = computed(() =>
  estimateBreakdown(app.messages, reading.value?.usage.input ?? 0, prompt.value?.length ?? 0),
)

/**
 * Whether the bar is lumping the system prompt in with the overhead.
 *
 * That is what the note under the bar exists to warn about, and it is now only
 * true when the prompt could not be fetched at all. The reference builds that
 * note and hides it, because its "other" really is only overhead; the same is
 * true here whenever the prompt can be measured, so the line goes away with the
 * reason for it.
 */
const promptUnmeasured = computed(
  () => promptFailed.value && !breakdown.value.some((segment) => segment.key === "system"),
)

/**
 * A colour per segment.
 *
 * The reference reaches into its syntax palette for these. This app has no
 * syntax tokens, so each one is matched to the theme token that carries the
 * same meaning - and "other" lands exactly, because the reference's own comment
 * colour is defined as the weak text colour.
 */
const COLOUR: Record<string, string> = {
  system: "var(--info)",
  user: "var(--success)",
  assistant: "var(--accent)",
  tool: "var(--warning)",
  other: "var(--text-weak)",
}

/** Which raw messages are unfolded. Several at once, as in the reference. */
const unfolded = ref(new Set<string>())

function toggle(id: string): void {
  const next = new Set(unfolded.value)
  if (!next.delete(id)) next.add(id)
  unfolded.value = next
}

/**
 * The messages that are open, exactly as the app holds them.
 *
 * Serialised only for the rows someone has actually unfolded: a conversation
 * carrying a pinned file holds that file's whole text on the message, and
 * writing all of them out to lay a list of headings on screen would cost
 * megabytes for something nobody has asked to see.
 *
 * It has to be a computed rather than a value cached when the row opens,
 * because a turn that is still running keeps changing - a cache filled on the
 * click would freeze the message at the moment it was unfolded and go on
 * showing that while the model wrote.
 */
const rendered = computed(() => {
  const out = new Map<string, string>()
  for (const message of app.messages) {
    if (unfolded.value.has(message.id)) out.set(message.id, JSON.stringify(message, null, 2))
  }
  return out
})
</script>

<template>
  <!--
    A tab's contents rather than a panel: no width, no border and no bar of its
    own. It carried a title and a close button while it was a panel in its own
    right, and both are now the tab's job - leaving them here put the word
    "Context" on screen twice, one line under the other, and offered two closes
    that did the same thing.

    Escape stays, because the tab's close button is a small target and the
    reader's hands are already on the keyboard by the time they have read this
    far down a column of figures.
  -->
  <div class="view" tabindex="-1" @keydown.escape="emit('close')">
    <div class="scroll">
      <div class="stats">
        <div v-for="stat in stats" :key="stat.key" class="stat">
          <div class="stat-name">{{ stat.name }}</div>
          <div class="stat-value" :title="stat.value">{{ stat.value }}</div>
        </div>
      </div>

      <section v-if="breakdown.length" class="block">
        <h3 class="block-title">{{ t("context.breakdown.title") }}</h3>

        <div class="bar">
          <div
            v-for="segment in breakdown"
            :key="segment.key"
            class="bar-part"
            :style="{ width: `${segment.share}%`, background: COLOUR[segment.key] }"
          />
        </div>

        <div class="legend">
          <div v-for="segment in breakdown" :key="segment.key" class="legend-item">
            <span class="swatch" :style="{ background: COLOUR[segment.key] }" />
            <span>{{ t(`context.breakdown.${segment.key}`) }}</span>
            <span class="legend-share">{{ count(segment.percent) }}%</span>
          </div>
        </div>

        <!--
          The reference builds this line and then hides it, because its "other"
          is only tool definitions and provider overhead. Here it appears in the
          one case where that is not true of this app either: the prompt could
          not be read, so "other" is quietly holding something that can be a
          third of the bar.
        -->
        <p v-if="promptUnmeasured" class="note">{{ t("context.breakdown.note") }}</p>
      </section>

      <!--
        What every turn is told before the conversation starts. Absent until the
        server answers, and absent for good if it cannot.
      -->
      <section v-if="prompt" class="block">
        <h3 class="block-title">{{ t("context.systemPrompt.title") }}</h3>
        <!-- Safe to bind as HTML: renderMarkdown escapes the source before
             formatting it, the same guarantee the transcript relies on. -->
        <div class="prompt" v-html="promptHtml" />
      </section>

      <!-- Absent rather than empty on a session that has not said anything yet:
           there is nothing raw to unfold and nothing to write to a file. -->
      <section v-if="app.messages.length" class="block">
        <div class="block-head">
          <h3 class="block-title">{{ t("context.rawMessages.title") }}</h3>
          <button class="export" @click="emit('export')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 2.5V10M5 7L8 10L11 7M3 13H13"
                stroke="currentColor"
                stroke-width="1"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {{ t("context.export.session") }}
          </button>
        </div>

        <div class="rows">
          <div v-for="message in app.messages" :key="message.id" class="row">
            <button class="row-head" :aria-expanded="unfolded.has(message.id)" @click="toggle(message.id)">
              <span class="row-who">{{ message.role }}</span>
              <span class="row-dot">•</span>
              <span class="row-id">{{ message.id }}</span>
              <span class="row-when">{{ when(message.time.created) }}</span>
              <svg
                class="row-chevron"
                :class="{ up: unfolded.has(message.id) }"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
            <pre v-if="unfolded.has(message.id)" class="row-body">{{ rendered.get(message.id) }}</pre>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/*
 * One tab of the review panel, filling whatever the panel gives it.
 *
 * This used to set its own width, its own minimum and its own divider, because
 * it was mounted beside the conversation as a panel in its own right and the
 * review panel disappeared while it was up. It is a tab now, so the panel owns
 * all three - and the reader's own dragged width survives switching tabs
 * instead of being replaced by a second, different one.
 */
.view {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  /* Without this the scrolling child below refuses to shrink and pushes the
     column past the bottom of the panel instead of scrolling inside it. */
  min-height: 0;
  /*
   * The grid below asks about the width it has been given rather than the
   * window's, and the panel it now sits in is both resizable and a different
   * shape from the window. Kept here rather than moved to the panel because
   * the review side has its own idea of what a narrow column means.
   */
  container-type: inline-size;
}

/* A container, not a control - the ring belongs on whatever inside it has
   focus. */
.view:focus,
.view:focus-visible {
  outline: none;
}

.scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 40px;
  min-height: 0;
  overflow-y: auto;
  padding-block: 16px 40px;
  padding-inline: 24px;
}

/*
 * One column while the panel is narrow, two once there is room.
 *
 * Asked of the panel rather than of the window, because the panel can be the
 * narrow one inside a wide window. 32rem is the reference's own threshold.
 */
.stats {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

@container (min-width: 32rem) {
  .stats {
    grid-template-columns: 1fr 1fr;
  }
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.stat-name {
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 1.5;
}

/*
 * Cut with an ellipsis rather than allowed to widen the column: a model name or
 * a session title can be long enough to push the second column off the panel,
 * and the whole of it is on the element's title.
 */
.stat-value {
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 530;
  line-height: 1.5;
  /* Figures that change as a turn runs, so the columns must not shift under
     them as digits swap. */
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.block-title {
  margin: 0;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 1.5;
}

.export {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding-block: 3px;
  padding-inline: 8px;
  color: var(--text-weak);
  border-radius: 6px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  transition: background 0.12s, color 0.12s;
}

.export:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* A single track the segments butt against, so no gap can open between them
   and read as a sixth, unnamed share. */
.bar {
  display: flex;
  overflow: hidden;
  width: 100%;
  height: 8px;
  background: var(--surface-base);
  border-radius: 999px;
}

.bar-part {
  height: 100%;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 1.5;
}

.swatch {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

/*
 * A step lighter than its label, not two.
 *
 * The reference puts this figure on its weakest text colour. That token is
 * #dbdbdb in this app's light scheme, which on the raised panel behind it is
 * about as legible as nothing at all - and the number is the point of the row.
 */
.legend-share {
  color: var(--text-weak);
  font-variant-numeric: tabular-nums;
}

.note {
  margin: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 440;
  line-height: 1.5;
}

/*
 * The prompt itself, in a box of its own.
 *
 * Capped and scrolled because a system prompt runs to thousands of words: left
 * to its full height it would push the raw-message list, which is the thing
 * most people open this panel for, several screens down.
 */
.prompt {
  max-height: 260px;
  padding: 8px 12px;
  overflow-y: auto;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.55;
  background: var(--surface-base);
  border: 1px solid var(--border-weaker);
  border-radius: var(--radius-md);
}

.prompt :deep(p) {
  margin: 0 0 8px;
}

.prompt :deep(p:last-child) {
  margin-bottom: 0;
}

.prompt :deep(pre),
.prompt :deep(code) {
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--ui-font-scale, 1));
}

.prompt :deep(pre) {
  overflow-x: auto;
}

.rows {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border-weaker);
  border-radius: 6px;
}

.row {
  min-width: 0;
  border-bottom: 1px solid var(--border-weaker);
}

.row:last-child {
  border-bottom: none;
}

.row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding-block: 7px;
  padding-inline: 10px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
  text-align: start;
  transition: background 0.12s;
}

.row-head:hover {
  background: var(--surface-hover);
}

.row-who {
  flex-shrink: 0;
  color: var(--text-strong);
  font-weight: 530;
}

.row-dot {
  flex-shrink: 0;
  color: var(--text-base);
}

/*
 * The identifier gives way first. It is the least useful half of the heading to
 * a reader scanning the list, and it is the only part with no natural length.
 */
.row-id {
  overflow: hidden;
  min-width: 0;
  color: var(--text-base);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-when {
  flex-shrink: 0;
  margin-inline-start: auto;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.row-chevron {
  flex-shrink: 0;
  color: var(--text-weak);
  transition: transform 0.15s ease;
}

.row-chevron.up {
  transform: rotate(180deg);
}

/*
 * Wrapped rather than scrolled sideways.
 *
 * A pinned file arrives on the message as one unbroken string, and a horizontal
 * scrollbar under a line several thousand characters long is not a way of
 * reading it. `anywhere` is what lets that string break at all - `break-word`
 * leaves an unspaced run intact and the panel scrolls anyway.
 */
.row-body {
  margin: 0;
  padding-block: 8px 10px;
  padding-inline: 10px;
  color: var(--text-base);
  background: var(--surface-base);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  /* The one place in the panel where reading means copying. */
  user-select: text;
}
</style>
