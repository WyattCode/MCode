<script setup lang="ts">
import { onMounted, ref, watch } from "vue"
import type { Attachment } from "@shared/protocol"
import { openImagePreview } from "../../lib/image-preview"
import { stepImages } from "../../lib/tool-meta"
import "./steps.css"

/**
 * MiMo's pictures under an opened step: what a call handed back - a picture
 * `read` was pointed at, an image an MCP server returned - as a wrapping row
 * of thumbnails, each opening the image preview from where it sits.
 *
 * Bytes carried on the result are shown as they are; a picture attached by
 * its path is served from the disk by the main process, as a reply's local
 * pictures are.
 */
const props = defineProps<{ attachments?: Attachment[] }>()

interface Shot {
  key: string
  url: string
  name: string
  path?: string
}

const shots = ref<Shot[]>([])

/* A served address per file, kept across rows so a list redrawn does not ask again. */
const served = new Map<string, string>()

async function load() {
  const out: Shot[] = []
  for (const [index, item] of stepImages(props.attachments).entries()) {
    const name = item.path.split(/[\\/]/).pop() || item.path
    if (!item.byPath) {
      out.push({ key: `${index}`, url: `data:${item.mime};base64,${item.data}`, name })
      continue
    }
    let url = served.get(item.path)
    if (!url) {
      const answer = await window.mcode.officeServe(item.path).catch(() => null)
      if (!answer?.ok) continue
      url = answer.url
      served.set(item.path, url)
    }
    out.push({ key: `${index}`, url, name, path: item.path })
  }
  shots.value = out
}

onMounted(load)
watch(() => props.attachments, load)

function show(shot: Shot, event: MouseEvent) {
  openImagePreview(shot.url, {
    name: shot.name,
    path: shot.path,
    group: shots.value.map((each) => each.url),
    rect: (event.currentTarget as HTMLElement).getBoundingClientRect(),
  })
}
</script>

<template>
  <div v-if="shots.length" class="hs-shots" data-step-shots>
    <button v-for="shot in shots" :key="shot.key" type="button" class="hs-shot" :aria-label="shot.name" :title="shot.name" @click="show(shot, $event)">
      <img :src="shot.url" :alt="shot.name" draggable="false" />
    </button>
  </div>
</template>
