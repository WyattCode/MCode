import type { Attachment } from "@shared/protocol"

/**
 * MiMo's audio checks before a send.
 *
 * Each attached .wav, .mp3, .m4a, .ogg, .flac or .aac is read first: a file
 * that cannot be read as audio, or one longer than ten minutes, stops the send
 * with a notice and the draft kept. A read that fails for any other reason, or
 * takes more than three seconds, lets the file through, as MiMo's does.
 */
export const AUDIO_EXTENSIONS: readonly string[] = [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac"]
export const AUDIO_MAX_MS = 10 * 60_000
export const AUDIO_PROBE_MS = 3000

export type AudioProbe = { ok: true; durationMs: number } | { ok: false; unsupported: boolean }

export function isAudioFile(path: string): boolean {
  const name = path.toLowerCase()
  return AUDIO_EXTENSIONS.some((extension) => name.endsWith(extension))
}

/** What a probe means for the send; no answer at all is not a reason to stop. */
export function audioVerdict(probe: AudioProbe | undefined, maxMs = AUDIO_MAX_MS): "ok" | "unsupported" | "tooLong" {
  if (!probe) return "ok"
  if (!probe.ok) return probe.unsupported ? "unsupported" : "ok"
  return probe.durationMs > maxMs ? "tooLong" : "ok"
}

/** The limit as the notice words it, in whole minutes. */
export function limitMinutes(maxMs = AUDIO_MAX_MS): number {
  return Math.round(maxMs / 60_000)
}

async function bytesOf(file: Attachment): Promise<Uint8Array | undefined> {
  if (file.data) {
    const binary = atob(file.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  const read = await window.mcode.readFileBytes(file.path).catch(() => undefined)
  if (!read || !read.ok || read.unchanged) return undefined
  return bytesOf({ ...file, data: read.base64 })
}

/** Reads the file's length the way the window would play it; the element answers from the header alone. */
export async function probeAudio(file: Attachment): Promise<AudioProbe | undefined> {
  const bytes = await bytesOf(file).catch(() => undefined)
  if (!bytes) return undefined
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mime || "audio/*" }))
  const player = new Audio()
  try {
    return await new Promise<AudioProbe | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), AUDIO_PROBE_MS)
      player.preload = "metadata"
      player.onloadedmetadata = () => {
        clearTimeout(timer)
        resolve(Number.isFinite(player.duration) ? { ok: true, durationMs: player.duration * 1000 } : undefined)
      }
      player.onerror = () => {
        clearTimeout(timer)
        resolve({ ok: false, unsupported: true })
      }
      player.src = url
    })
  } finally {
    player.removeAttribute("src")
    URL.revokeObjectURL(url)
  }
}
