<script setup lang="ts">
import { computed, ref } from "vue"
import type { PermissionRecord, ToolPart } from "@shared/protocol"
import DiffView from "./DiffView.vue"
import StepIcon from "./StepIcon.vue"
import "./steps.css"
import { t } from "../../lib/i18n"
import { bashOf, isUnifiedDiff } from "../../lib/tool-meta"
import { redactText } from "@shared/display-redact"

/**
 * A permission question after it was answered, as MiMo leaves it in the steps:
 * what was asked for, how it was decided, and the command or change it was
 * about. It follows the call it gated, and it is read back from that call's
 * part, so it is still there after a reload.
 */
const props = defineProps<{ part: ToolPart; record: PermissionRecord }>()

const VERBS: Record<string, string> = {
  bash: "perm.verb.bash",
  edit: "perm.verb.edit",
  write: "perm.verb.write",
  outside: "perm.verb.outside",
  webfetch: "perm.verb.webfetch",
}

const DECIDED: Record<string, string> = {
  "allow-once": "perm.decided.once",
  "allow-always": "perm.decided.always",
  reject: "perm.decided.reject",
  "reject-with-reason": "perm.decided.rejectWithReason",
  cancelled: "perm.decided.cancelled",
}

const verb = computed(() => (props.record.forced ? t("perm.verb.bashDelete") : t(VERBS[props.record.kind] ?? "perm.verb.fallback")))
const decided = computed(() => t(DECIDED[props.record.decided] ?? "perm.decided.fallback"))
const bash = computed(() => (props.record.kind === "bash" ? bashOf(props.part) : undefined))

/** The command as `$ command` when the call carries one, otherwise what was asked about. */
/* Secrets and personal numbers masked, as the step rows mask them (beyond MiMo). */
const full = computed(() => redactText(bash.value ? `$ ${bash.value.cmd}` : props.record.subject).slice(0, 3000))

/* One line at most, at most 120 characters of it, with the rest behind a toggle. */
const folded = computed(() => {
  const first = full.value.split("\n", 1)[0] ?? ""
  const lossy = full.value.includes("\n") || first.length > 120
  return { text: first.length > 120 ? `${first.slice(0, 120)}…` : first, lossy }
})

const detail = computed(() => (props.record.preview && isUnifiedDiff(props.record.preview) ? props.record.preview : undefined))

const showCmd = ref(false)
const showDiff = ref(false)
</script>

<template>
  <div class="hstep hs-perm" :data-permission-row="record.requestID" :data-decided="record.decided">
    <span class="hs-ic tall mut"><StepIcon name="permission" :size="15" /></span>
    <div class="hs-body">
      <div class="hs-perm-head">
        <span data-perm-request>{{ t("perm.request", { verb }) }}</span>
        <span v-if="bash?.desc" class="hs-bash-desc" dir="auto">{{ redactText(bash.desc) }}</span>
        <span class="hs-decided" data-decided-label>{{ decided }}</span>
      </div>
      <pre class="hs-perm-cmd" data-perm-row-cmd>{{ folded.lossy && !showCmd ? folded.text : full }}</pre>
      <button v-if="folded.lossy" type="button" class="hs-perm-toggle" data-perm-row-toggle="cmd" @click="showCmd = !showCmd">
        {{ (showCmd ? "▾ " : "▸ ") + (showCmd ? t("perm.hideCmd") : t("perm.viewCmd")) }}
      </button>
      <button v-if="detail" type="button" class="hs-perm-toggle" data-perm-row-toggle="diff" @click="showDiff = !showDiff">
        {{ (showDiff ? "▾ " : "▸ ") + (showDiff ? t("perm.hideDiff") : t("perm.viewDiff")) }}
      </button>
      <div v-if="detail && showDiff" class="hs-diff"><DiffView :diff="detail" /></div>
      <div v-if="record.decided === 'reject-with-reason' && record.reason" class="hs-perm-reason" data-perm-reason>
        {{ t("perm.rejectedReason", { reason: record.reason }) }}
      </div>
    </div>
  </div>
</template>
