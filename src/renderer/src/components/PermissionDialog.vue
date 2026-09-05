<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue"
import type { PermissionRequest } from "@shared/protocol"
import { useApp } from "../stores/app"
import DiffView from "./parts/DiffView.vue"
import { t } from "../lib/i18n"

const props = withDefaults(
  defineProps<{
    request: PermissionRequest
    /** True while a dialog or the palette is open over this panel. */
    covered?: boolean
  }>(),
  { covered: false },
)
const app = useApp()

const isDiff = computed(() => props.request.preview?.startsWith("--- a/") ?? false)

/** True from the moment a button is pressed until the server has the answer. */
const busy = computed(() => app.responding === props.request.id)

/*
 * Escape only.
 *
 * There were y/a/n shortcuts on a capture-phase listener. That was survivable
 * while this was a modal, but the panel now sits above a usable composer: the
 * "a" in a sentence would have granted standing access to a directory, and the
 * keystroke never even reached the textarea. Approving a side effect has to
 * take a deliberate click. Escape stays because refusing is the safe direction.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  // Whatever is open above owns Escape: dismissing a palette should not answer
  // the request underneath it.
  if (props.covered) return
  event.preventDefault()
  void app.respond("reject")
}

onMounted(() => window.addEventListener("keydown", onKeydown, true))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown, true))
</script>

<template>
  <!--
    Anchored above the composer rather than floating in the middle of the
    screen: the question is about the work still visible behind it, and a modal
    that covers the transcript hides the very thing being judged.
  -->
  <div class="perm">
    <!--
      Two surfaces, not one card. The shell carries the question and the tray
      carries the answer, and the tray is pulled up under the shell so the
      question appears to rest on the buttons rather than to contain them.
    -->
    <div class="dock">
      <div class="body">
        <div class="header">
          <div class="row head">
            <span class="icon">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2.2 14.4 13H1.6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                <path d="M8 6.4v3.1M8 11.2h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </span>
            <div class="title">{{ request.titleCode ? t(request.titleCode) : request.title }}</div>
          </div>
        </div>

        <!--
          Every body row repeats the header's two columns with the icon cell
          left empty, so the subject and the preview hang under the title
          instead of running back out to the edge of the shell.
        -->
        <div class="content">
          <div class="row">
            <span class="spacer" aria-hidden="true"></span>
            <div class="subject">{{ request.subject }}</div>
          </div>

          <div v-if="request.preview" class="row">
            <span class="spacer" aria-hidden="true"></span>
            <div class="preview">
              <DiffView v-if="isDiff" :diff="request.preview" />
              <pre v-else class="cmd">{{ request.preview }}</pre>
            </div>
          </div>
        </div>
      </div>

      <div class="tray">
        <!-- The empty half of the split: the buttons are pushed to the end by
             a leading cell rather than by an alignment on the row. -->
        <div></div>
        <div class="actions">
          <button class="btn quiet" :disabled="busy" @click="app.respond('reject')">{{ t("perm.reject") }}</button>
          <button class="btn" :disabled="busy" @click="app.respond('always')">{{ t("perm.alwaysShort") }}</button>
          <button class="btn primary" :disabled="busy" @click="app.respond('once')">{{ t("perm.once") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * The same column as the composer it sits on, to the pixel: 776px centred
 * inside a 24px inset, which is what Composer draws too. The reference states
 * the same column as an 800px cap on a box-sizing: border-box element carrying
 * 12px of its own side padding - the 776px of content that leaves is the number
 * that matters, and it is the one the box directly beneath this one uses.
 *
 * Nothing below it. The reference stacks this dock and the prompt input flush
 * and pads only the foot of the one region that holds them both, so an inset
 * here would open a seam through what is meant to read as a single surface.
 */
.perm {
  padding: 0 24px;
}

/*
 * A cap rather than a size. Nothing here is tall enough to reach it in
 * practice, but every box down to the preview keeps min-height: 0 so that when
 * something does, the scroll lands in the preview and the buttons stay put.
 */
.dock {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  max-width: 776px;
  min-height: 0;
  max-height: 100dvh;
  margin: 0 auto;
}

.body {
  position: relative;
  z-index: 10;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  /* No bottom inset: the tray's overlap supplies the space below the content. */
  padding: 12px 12px 0;
  overflow: clip;
  background: var(--surface-raised);
  border-radius: var(--radius-2xl);
  /*
   * A dock's edge, not an input's. The two shadows differ by a hair of ring
   * weight, but this surface is a card lying on the page rather than a field
   * waiting to be typed in, and the reference draws it with the heavier ring.
   */
  box-shadow: var(--shadow-xs-border);
}

.header {
  padding: 0;
}

.row {
  display: grid;
  grid-template-columns: 20px 1fr;
  align-items: start;
  column-gap: 8px;
}

.row.head {
  align-items: center;
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--warning);
}

.title {
  min-width: 0;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 500;
  line-height: 150%;
}

.content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.subject {
  color: var(--text-base);
  font-family: var(--font-mono);
  font-size: 14px;
  /*
   * The same leading as the title above it. opencode gives both
   * `line-height: var(--line-height-large)`, which is 150% there - so its title
   * and its hint sit on one rhythm. This was 1.6, making the hint 22.4 against
   * the title's 21 and the two lines fractionally out of step.
   */
  line-height: 150%;
  overflow-wrap: anywhere;
}

/*
 * The shell carries no bottom inset, so the space under the question comes
 * from the last row of it - which is where the reference puts it too.
 */
.content > .row:last-child {
  margin-bottom: 16px;
  padding-bottom: 8px;
}

.preview {
  max-height: 220px;
  min-height: 0;
  margin-top: 8px;
  overflow: auto;
  border: 1px solid var(--border-weaker);
  border-radius: var(--radius-md);
}

.cmd {
  margin: 0;
  padding: 10px;
  color: var(--text-base);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
}

/*
 * Drawn behind the shell and lifted into it, so its top edge never shows: the
 * 32px top inset is 24px of hidden overlap plus the 8px the buttons actually
 * sit on.
 */
.tray {
  position: relative;
  z-index: 0;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  margin-top: -24px;
  padding: 32px 8px 8px;
  overflow: clip;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-2xl);
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn {
  height: 28px;
  padding: 0 12px;
  font-weight: 500;
  color: var(--text-strong);
  /*
   * Lifted off the tray rather than level with it. Both read --surface-base
   * before, which in a dark theme left this button the same colour as the
   * surface behind it - visible only as a one-pixel outline.
   */
  background: var(--surface-raised);
  /*
   * Its edge arrives with the shadow rather than from a border, because what
   * this button wears is an elevation - the same one the shell above it rests
   * on - and the ring is only the topmost layer of it. A drawn border gives
   * the outline without the lift, and at this size the lift is the difference
   * between a control and a rectangle.
   */
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs-border);
  font-size: 13px;
}

.btn:hover {
  /*
   * The raised step, not the translucent overlay: --surface-hover is an alpha
   * wash meant to sit on the page ground, and replacing a raised fill with it
   * would make the button darker on hover rather than lighter.
   */
  background: var(--surface-raised-hover);
}

/* Nothing to lift: refusing is the quiet half of the row. */
.btn.quiet {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  color: var(--text-strong);
}

.btn.quiet:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.btn.quiet:active {
  background: var(--surface-selected);
}

.btn.primary {
  /*
   * The label is the invert token rather than the page colour. Read as
   * --surface-base it came out near-black on the light fill of a dark theme,
   * where what the reference asks for is the softer step the rest of the app's
   * primary buttons already carry.
   */
  color: var(--button-primary-text);
  background: var(--text-strong);
  border-color: transparent;
  box-shadow: none;
}

/*
 * Hovered and pressed by laying the same overlays the other two buttons use
 * over the fill, rather than by fading it. Opacity blends this button towards
 * the tray behind it, which lightens it in the light theme and darkens it in
 * the dark one - wrong both times, since every state the reference gives this
 * button drives it further from the page rather than nearer.
 */
.btn.primary:hover {
  background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
}

/*
 * Pressing and arriving by keyboard land on the same step, which is the one
 * the reference makes them share: both mean the button is about to act.
 */
.btn.primary:active,
.btn.primary:focus-visible {
  background-image: linear-gradient(var(--surface-selected), var(--surface-selected));
}

/*
 * Inert while an answer is in flight. The panel stays up until the server has
 * it, so without this the three buttons still look pressable and a second
 * click would send a second answer for the same request.
 */
.btn:disabled {
  opacity: 0.55;
  pointer-events: none;
}
</style>
