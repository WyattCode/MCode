<script setup lang="ts">
import { computed, nextTick, ref } from "vue"
import { useApp } from "../stores/app"
import ContextRing from "./ContextRing.vue"
import { language, sessionTitle, t } from "../lib/i18n"
import { readContext } from "./session-context"

/**
 * The bar across the top of an open conversation.
 *
 * The title used to live only in the window's own chrome, which the new design
 * gives over to tabs - so the session states its own name here, next to how
 * much of the model's context it has used and the things that can be done to
 * it.
 */
const app = useApp()

/** Whether the Context view this header's ring opens is currently up. */
defineProps<{ contextOpen?: boolean }>()

const emit = defineEmits<{ rename: [title: string]; menu: [x: number, y: number]; context: [] }>()

const title = computed(() => (app.current ? sessionTitle(app.current.title) : ""))

/*
 * Renaming happens here, in the title itself.
 *
 * The reference turns this exact box into a focused input - measured at
 * `18,56 42x24` with `4px 8px` of padding and 13px/530 type, which is the
 * static title's own geometry - so the name is edited where it is read. A modal
 * used to open instead: a scrim, a heading and two buttons to change one word.
 */
const editing = ref(false)
const draft = ref("")
const field = ref<HTMLInputElement>()

async function begin() {
  if (!app.current) return
  draft.value = title.value
  editing.value = true
  await nextTick()
  field.value?.focus()
  field.value?.select()
}

function commit() {
  if (!editing.value) return
  editing.value = false
  const next = draft.value.trim()
  // An empty name is a cancel: a session with no title cannot be found again.
  if (next && next !== title.value) emit("rename", next)
}

function cancel() {
  editing.value = false
}

defineExpose({ begin })

/**
 * How full the model's context is.
 *
 * The arithmetic is shared with the Context view the ring opens, so the two
 * cannot come to different answers about the same session.
 *
 * Undefined until a turn has reported usage against a model whose window is
 * known. The readout is drawn anyway, at zero - which is what opencode does:
 * every figure it renders is `context()?.usage ?? 0`, `info()?.cost ?? 0`,
 * `total.toLocaleString() ?? "0"`. This app used to hide the whole control
 * until the first turn finished, so a new session had no ring at all where the
 * reference shows US$0.00 / 0% / 0 from the moment it opens.
 */
const context = computed(() => {
  const reading = readContext(app.messages, app.providers)
  if (!reading?.window || reading.percent === undefined) return undefined
  return { used: reading.used, window: reading.window, percent: reading.percent }
})

/** Read out here rather than in the template, so the ring takes a plain number. */
const percent = computed(() => context.value?.percent ?? 0)

/*
 * Money and thousands separators in the language the app is set to, not the
 * one the machine happens to be in. Someone who has put this interface into
 * German is reading German, and 1.234 is how German writes that number however
 * the operating system is configured; Arabic goes further and wants its own
 * digits. The language ids are already BCP-47 tags, which is what Intl asks
 * for.
 *
 * Dollars whatever the language, because the number is dollars: providers
 * price in them and nothing here converts it. Dressing it as the reader's own
 * currency would change what it says without changing what it is.
 */
const money = computed(
  () => new Intl.NumberFormat(language.value, { style: "currency", currency: "USD" }),
)

/**
 * What the readout says when the pointer rests on it.
 *
 * Cost is the session's running total rather than the last turn's, because
 * that is the number anyone asking "what has this cost me" means; the other
 * two describe the turn the ring is drawn from.
 */
const rows = computed(() => {
  const reading = context.value
  return [
    { key: "cost", name: t("context.usage.cost"), value: money.value.format(app.current?.usage.cost ?? 0) },
    { key: "usage", name: t("context.usage.usage"), value: `${reading?.percent ?? 0}%` },
    { key: "tokens", name: t("context.usage.tokens"), value: (reading?.used ?? 0).toLocaleString(language.value) },
  ]
})

/**
 * What the button points its description at.
 *
 * A constant rather than a generated id because exactly one session header is
 * ever on screen; two of them would need two ids and this would be the thing
 * that broke.
 */
const TIP_ID = "session-context-figures"

function openMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit("menu", rect.right, rect.bottom + 4)
}
</script>

<template>
  <div class="head">
    <div class="left">
      <input
        v-if="editing"
        ref="field"
        v-model="draft"
        class="title title-field"
        spellcheck="false"
        v-enter="commit"
        @keydown.esc="cancel"
        @blur="commit"
      />
      <h1 v-else class="title" :title="title" @click="begin">{{ title }}</h1>
    </div>

    <div class="right">
      <!--
        A control again, and this time one with somewhere to go.

        It spent a while as a plain readout: it had been a button with a hover
        fill and no click handler, which invited a press and swallowed it, and
        the honest answer at the time was to stop looking like a button, because
        the Context view the reference opens from here did not exist. It does
        now, so the press is real - and the tooltip says so on its last line, in
        the reference's own words.
      -->
      <button
        class="readout"
        :aria-label="t('context.usage.view')"
        :aria-describedby="TIP_ID"
        :aria-pressed="Boolean(contextOpen)"
        @click="emit('context')"
      >
        <!--
          The header's geometry, which the reference keeps deliberately smaller
          than the same ring in the Context tab: 14px on a 1.5 stroke here,
          16px on a 2 stroke there. Those are this component's defaults, so
          they are not repeated at the call.
        -->
        <ContextRing :percent="percent" />

        <!--
          Left in the page rather than mounted on hover, and so left in the
          accessibility tree: the ring itself is a picture, and this is the only
          statement of what it is a picture of. Someone who cannot bring a
          pointer to rest on it still gets the three numbers read out.

          Reached by aria-describedby rather than simply by being inside the
          button, because the button carries an aria-label and a label replaces
          whatever a control contains: without this the figures would have gone
          silent the moment the ring became pressable again. The id can be a
          fixed string because there is one session header on screen.
        -->
        <div :id="TIP_ID" class="tip">
          <div v-for="row in rows" :key="row.key" class="tip-row">
            <span class="tip-name">{{ row.name }}</span>
            <span class="tip-value">{{ row.value }}</span>
          </div>
          <!-- What pressing it does, which is the one thing the three figures
               above do not say. -->
          <div class="tip-hint">{{ t("context.usage.clickToView") }}</div>
        </div>
      </button>

      <button class="ico" v-tip="{ label: t('session.options'), placement: 'bottom' }" @click="openMenu">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor" stroke-width="1" /><path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor" stroke-width="1" /><path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 48px;
  padding-block: 0;
  /* The narrower inset goes where the title starts and the wider where the row
     of icons runs out, so the pair follows the reading rather than the window. */
  padding-inline: 10px 20px;
}

.left {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
}

/*
 * Padded and rounded rather than plain text: it is the rename control, and the
 * hover background is the only thing that says so.
 */
.title {
  overflow: hidden;
  width: fit-content;
  max-width: 100%;
  margin: 0;
  padding: 4px 8px;
  color: var(--text-strong);
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  line-height: 16px;
  letter-spacing: -0.04px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s;
}

/*
 * The same box, now typeable. The reference's editor measures identically to
 * its static title - `42x24` on `4px 8px`, transparent, no ring - so the name
 * is edited exactly where it sat rather than the line reflowing around a field.
 *
 * `field-sizing` is what keeps that true: an input is 20-odd characters wide by
 * default, which would push the header's controls sideways the moment editing
 * began.
 */
.title-field {
  field-sizing: content;
  min-width: 6ch;
  background: transparent;
  border: 0;
  outline: none;
  cursor: text;
}

.title:hover {
  background: var(--surface-hover);
}

.right {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-weak);
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}

.ico:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * The same 28px box as the button beside it, and now the same behaviour: the
 * fill on hover is what tells a reader the ring can be pressed, which is the
 * whole difference between this and the readout it was while there was nothing
 * behind it.
 */
.readout {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  transition: background 0.12s;
}

.readout:hover,
/* Held open, so the control stays lit while the view it opened is on screen. */
.readout[aria-pressed="true"] {
  background: var(--surface-hover);
}

/*
 * Built here rather than through v-tip, which draws one line in a box that
 * never wraps and so cannot hold a column of name-and-value rows.
 *
 * The box itself is the reference's, measured: 5px by 6px of padding, a 4px
 * radius, 11px type at the emphasis weight on a 12px line, and the whole 120px
 * wide with 8px between rows. That is also all but exactly what v-tip draws,
 * so the two do not read as coming from different applications.
 *
 * What it does not share is v-tip's warm window - move here straight from the
 * button beside it and this one still waits its half second, where two v-tips
 * in a row would not.
 */
.tip {
  position: absolute;
  z-index: 300;
  /* Clear of the ring by the same gap v-tip leaves its own controls. */
  inset-block-start: calc(100% + 8px);
  /* Anchored to the end of the row, growing inwards: the ring sits against the
     window's edge, and a box hung from its start would leave the window. */
  inset-inline-end: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 120px;
  padding: 5px 6px;
  color: var(--text-strong);
  background: var(--surface-raised-hover);
  border-radius: 4px;
  box-shadow: var(--shadow-lg);
  font-size: 11px;
  font-weight: 500;
  line-height: 12px;
  letter-spacing: 0.05px;
  /* Figures that change as a turn runs, so the columns must not shift under
     them as digits swap. */
  font-variant-numeric: tabular-nums;
  /* Nothing here is a control, so nothing here should look selectable. */
  user-select: none;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease;
}

/*
 * The pause matches the half second v-tip waits, which is roughly what the
 * platform's own tooltips wait: long enough that a pointer crossing the header
 * on its way elsewhere does not set the box off. Only on the way in - a tip
 * that lingered after the pointer left would follow it down the page.
 */
.readout:hover .tip {
  opacity: 1;
  transition-delay: 0.5s;
}

/*
 * No pause for the keyboard. The delay exists to keep a pointer crossing the
 * header from setting off a trail of boxes; arriving here by Tab is a decision,
 * not a passing-through, and waiting half a second after it looks broken.
 */
.readout:focus-visible .tip {
  opacity: 1;
}

.tip-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.tip-name {
  flex-shrink: 0;
  color: var(--text-base);
}

/*
 * Pushed to the far end so the three values line up as a column, and cut with
 * an ellipsis rather than allowed to widen the box: a currency some locale
 * writes long would otherwise stretch the tooltip out of shape.
 */
.tip-value {
  overflow: hidden;
  min-width: 0;
  margin-inline-start: auto;
  color: var(--text-strong);
  text-align: end;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * Set below the figures by a rule, because it is not one of them: the three
 * rows above describe the session, and this one describes the control. Allowed
 * to wrap - it is a sentence, and cutting it off is worse than two lines.
 */
.tip-hint {
  padding-block-start: 6px;
  color: var(--text-weak);
  border-block-start: 1px solid var(--border-weaker);
  /* The rows above are single lines and take the box's tight 12px leading. A
     sentence that wraps needs the room between the two lines that a row does
     not, or the descenders of the first sit on the second. */
  line-height: 1.35;
  text-align: start;
}
</style>
