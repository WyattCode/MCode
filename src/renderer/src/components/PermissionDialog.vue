<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import type { PermissionRequest, PermissionResponse } from "@shared/protocol"
import { useApp } from "../stores/app"
import { useQuestions } from "../stores/questions"
import DiffView from "./parts/DiffView.vue"
import { t } from "../lib/i18n"

/**
 * MiMo's permission card, drawn inside the confirm dock. The dock around it
 * holds the surface, the focus and the keys; this is only the card.
 */
const props = defineProps<{ request: PermissionRequest; queueTotal: number }>()
const app = useApp()

/** True from the moment a button is pressed until the server has the answer. */
const busy = computed(() => app.responding === props.request.id)

const isBash = computed(() => props.request.kind === "bash")
const isDiff = computed(() => props.request.preview?.startsWith("--- a/") ?? false)

const VERBS: Record<string, string> = {
  bash: "perm.verb.bash",
  edit: "perm.verb.edit",
  // Creating a file has been judged as an edit since R16-C6; kept for records written before that.
  write: "perm.verb.write",
  outside: "perm.verb.outside",
  webfetch: "perm.verb.webfetch",
}

const verb = computed(() => {
  if (props.request.forced) return t("perm.verb.bashDelete")
  const key = VERBS[props.request.kind]
  return t(key ?? "perm.verb.fallback")
})

/*
 * The small chip after the verb. For a command it is the model's own one-line
 * account of what the command is for; for a request the verb cannot name - an
 * MCP tool, a read - it is the request's title, so nothing it said is lost.
 */
const chip = computed(() => {
  const { request } = props
  // The app tool asks in the command bucket about things that are not commands; its own words say what.
  if (request.titleCode?.startsWith("perm.app.")) return t(request.titleCode)
  if (isBash.value) return request.title && request.title !== "Run command" ? request.title : ""
  if (VERBS[request.kind]) return ""
  return request.titleCode ? t(request.titleCode) : request.title
})

/** The command or subject in full, capped so a runaway argument cannot flood the dock. */
const full = computed(() => (isBash.value && !props.request.titleCode?.startsWith("perm.app.") ? `$ ${props.request.subject}` : props.request.subject).slice(0, 3000))

/*
 * One line at most, at most 120 characters of it. Anything longer, or anything
 * past the first line, is folded behind the toggle at the end of the box.
 */
const folded = computed(() => {
  const first = full.value.split("\n", 1)[0] ?? ""
  const lossy = full.value.includes("\n") || first.length > 120
  return { text: first.length > 120 ? `${first.slice(0, 120)}…` : first, lossy }
})

const showFull = ref(false)
const showDiff = ref(false)
const reasoning = ref(false)
const reason = ref("")

const reasonInput = ref<HTMLInputElement>()
watch(reasoning, (open) => {
  if (open) void nextTick(() => reasonInput.value?.focus())
})

const questions = useQuestions()

function answer(response: PermissionResponse) {
  // Approvals pressed here are what MiMo counts before offering to ask less.
  if (response !== "reject") questions.noteAllowed(props.request.sessionID)
  void app.respond(response)
}

function rejectWithReason() {
  if (reason.value.trim()) void app.respond("reject", reason.value)
  else void app.respond("reject")
}

function onReasonKey(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  rejectWithReason()
}
</script>

<template>
  <div class="card" data-confirm-perm>
    <div class="head">
      <span class="icon" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
          <path d="M8 5.6v2.8M8 10.4h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </span>
      <span id="confirm-dock-title" data-perm-title>{{ t("perm.request", { verb }) }}</span>
      <span v-if="chip" id="confirm-dock-chip" class="chip" data-perm-chip>{{ chip }}</span>
      <span class="queue-slot">
        <span v-if="queueTotal > 1" class="queue" data-confirm-queue :title="t('perm.queueTitle', { total: queueTotal })">
          1/{{ queueTotal }}
        </span>
      </span>
    </div>

    <div class="cmd-wrap">
      <pre id="confirm-dock-desc" class="cmd" :class="{ lossy: folded.lossy }" data-perm-cmd>{{ folded.lossy && !showFull ? folded.text : full }}</pre>
      <button
        v-if="folded.lossy"
        type="button"
        class="cmd-toggle"
        data-perm-cmd-toggle
        v-tip="t(showFull ? 'perm.hideCmd' : 'perm.viewCmd')"
        :aria-label="t(showFull ? 'perm.hideCmd' : 'perm.viewCmd')"
        :aria-expanded="showFull"
        @click="showFull = !showFull"
      >
        <svg v-if="showFull" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m5 2.5 3 3 3-3M5 13.5l3-3 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m5 5.5 3-3 3 3M5 10.5l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <template v-if="isDiff && request.preview">
      <button type="button" class="diff-toggle" data-perm-diff-toggle :aria-expanded="showDiff" @click="showDiff = !showDiff">
        {{ (showDiff ? "▾ " : "▸ ") + t(showDiff ? "perm.hideDiff" : "perm.viewDiff") }}
      </button>
      <div v-if="showDiff" class="diff" data-perm-diff>
        <DiffView :diff="request.preview" />
      </div>
    </template>

    <div v-if="request.forced" class="forced" data-perm-forced>{{ t("perm.forcedHint") }}</div>

    <div class="actions">
      <button type="button" class="perm-btn" data-cnav data-perm-reject :disabled="busy" @click="answer('reject')">
        {{ t("perm.reject") }}
      </button>
      <button
        type="button"
        class="perm-btn muted"
        data-cnav
        data-perm-reason-toggle
        :disabled="busy"
        @click="reasoning = !reasoning"
      >
        {{ t("perm.rejectWithReason") }}
      </button>
      <button
        v-if="!request.forced"
        type="button"
        class="perm-btn"
        data-cnav
        data-perm-always
        :disabled="busy"
        @click="answer('always')"
      >
        {{ t("perm.alwaysShort") }}
      </button>
      <button
        type="button"
        class="perm-btn primary"
        data-cnav
        data-cnav-primary
        data-perm-once
        :disabled="busy"
        @click="answer('once')"
      >
        {{ t("perm.once") }}
      </button>
    </div>

    <div v-if="reasoning" class="reason" data-perm-reason>
      <input
        ref="reasonInput"
        v-model="reason"
        type="text"
        class="reason-input"
        :placeholder="t('perm.reasonPlaceholder')"
        @keydown="onReasonKey"
      />
      <button type="button" class="perm-btn" data-perm-reason-submit :disabled="busy" @click="rejectWithReason">
        {{ t("perm.submit") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.card {
  min-width: 0;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.5;
}

.icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  color: var(--text-weak);
}

.chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 1px 6px;
  color: var(--text-weak);
  background: var(--surface-hover);
  border-radius: 4px;
}

.queue-slot {
  display: flex;
  flex: none;
  align-items: center;
  margin-inline-start: auto;
}

.queue {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.cmd-wrap {
  position: relative;
  margin-top: 6px;
}

.cmd {
  max-height: 220px;
  margin: 0;
  padding: 9px 12px;
  overflow: auto;
  color: var(--text-strong);
  font-family: var(--font-mono);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface-sunken);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
}

.cmd.lossy {
  padding-inline-end: 38px;
}

.cmd-toggle {
  position: absolute;
  inset-inline-end: 8px;
  top: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 6px;
  transform: translateY(-50%);
  cursor: pointer;
}

.cmd-toggle:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.diff-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 0;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  background: transparent;
  border: 0;
  cursor: pointer;
}

.diff-toggle:hover {
  color: var(--text-strong);
}

.diff {
  max-height: 220px;
  margin-top: 6px;
  overflow: auto;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
}

.forced {
  margin-top: 6px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.perm-btn {
  padding: 5px 12px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 1.5;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  cursor: pointer;
}

.perm-btn:hover {
  background: var(--surface-hover);
}

.perm-btn.muted {
  color: var(--text-weak);
}

.perm-btn.primary {
  color: var(--surface-raised);
  background: var(--text-strong);
  border-color: var(--text-strong);
}

.perm-btn.primary:hover {
  background: var(--text-strong);
  opacity: 0.9;
}

.perm-btn:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

.perm-btn:disabled {
  cursor: default;
  opacity: 0.4;
}

.reason {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.reason-input {
  flex: 1;
  min-width: 0;
  padding: 5px 10px;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  outline: none;
}

.reason-input:focus {
  border-color: var(--interactive);
}
</style>
