<script setup lang="ts">
import { computed } from "vue"
import type { TextPart } from "@shared/protocol"
import { cleanLiveReply, cleanReply } from "@shared/reply-clean"
import { useApp } from "../../stores/app"
import MarkdownBody from "./MarkdownBody.vue"

/**
 * One text part of a reply: the shared markdown body, given the reply's text.
 *
 * Everything the body draws - the blocks, the colours, the media, the tables,
 * the path menu - is in MarkdownBody, which the files tab hangs on a .md file
 * as MiMo hangs its one markdown component on both. What is this part's own is
 * the text: which message it belongs to, whether that message is still being
 * written, and the cleaning each of those two cases wants.
 */
const props = defineProps<{ part: TextPart }>()
const app = useApp()

/* The streaming message this part is in, while it streams. */
const owner = computed(() => [app.streaming, app.sideStreaming].find((message) => message?.parts.some((part) => part.id === props.part.id)))

/*
 * Live while the message it belongs to is still streaming: MiMo keeps diagrams
 * as code, the last line plain and footnotes back until the reply has ended.
 *
 * Text arrives here as the store holds it. There is no per-character pacing -
 * each delta of MiMo's goes straight onto the run's text as it lands, and the
 * only thing its stylesheet animates is the block. MCode used to meter the text
 * out a few characters a frame, which left the screen up to 9,230 characters
 * behind a fast answer and still typing 309-413ms after the turn had ended.
 */
const live = computed(() => Boolean(owner.value))

// MiMo takes leaked tool-call and thinking markup out first, and holds back a tag still arriving.
const text = computed(() => (live.value ? cleanLiveReply(props.part.text) : cleanReply(props.part.text)))
</script>

<template>
  <MarkdownBody :text="text" :live="live" :data-text-part="part.id" data-annotate="answer" />
</template>
