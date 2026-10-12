<script setup lang="ts">
import { onMounted, ref } from "vue"
import type { McpTrustPrompt } from "@shared/protocol"
import { t } from "../lib/i18n"
import { useEscapeLayer } from "../lib/escape-layer"

/**
 * Asked the first time a folder's own MCP config would start a server.
 *
 * Trust is the dangerous answer, so it is not focused and Enter does not
 * choose it. Escape is the refusal, which is remembered like the button.
 */
const props = defineProps<{ prompt: McpTrustPrompt }>()
const emit = defineEmits<{ answer: [decision: "allow" | "deny"] }>()

const denyButton = ref<HTMLButtonElement>()

useEscapeLayer(() => emit("answer", "deny"))

onMounted(() => {
  denyButton.value?.focus()
})
</script>

<template>
  <div class="scrim">
    <div v-modal class="dialog" data-mcp-trust role="alertdialog" aria-labelledby="mcp-trust-title" aria-describedby="mcp-trust-body">
      <h2 id="mcp-trust-title">{{ t("mcp.trust.title") }}</h2>
      <p id="mcp-trust-body" class="body">{{ t("mcp.trust.body") }}</p>
      <p class="dir" data-mcp-trust-dir>{{ props.prompt.directory }}</p>
      <ul class="servers">
        <li v-for="server in props.prompt.servers" :key="server.name">
          <span class="name">{{ server.name }}</span>
          <span v-if="server.detail" class="detail">{{ server.detail }}</span>
        </li>
      </ul>
      <footer>
        <button ref="denyButton" class="ghost" type="button" data-mcp-trust-deny @click="emit('answer', 'deny')">{{ t("mcp.trust.deny") }}</button>
        <button class="confirm" type="button" data-mcp-trust-allow @click="emit('answer', 'allow')">{{ t("mcp.trust.allow") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: #00000080;
}

.dialog {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(460px, 88vw);
  max-height: min(80vh, 640px);
  padding: 22px 24px;
  background: var(--surface-page);
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-pop);
}

h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(17px * var(--ui-font-scale, 1));
  font-weight: 400;
}

.body {
  margin: 8px 0 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: 1.6;
}

.dir {
  margin: 12px 0 0;
  color: var(--text-strong);
  font-size: calc(12px * var(--ui-font-scale, 1));
  word-break: break-all;
}

.servers {
  margin: 8px 0 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.servers li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  border-top: 1px solid var(--border-weaker);
}

.name {
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.detail {
  color: var(--text-base);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: calc(12px * var(--ui-font-scale, 1));
  word-break: break-all;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

.ghost,
.confirm {
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  cursor: pointer;
}

.ghost {
  color: var(--text-base);
  background: var(--surface-page);
  border-color: var(--border-weak);
}

.ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.confirm {
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-color: var(--button-primary);
}
</style>
