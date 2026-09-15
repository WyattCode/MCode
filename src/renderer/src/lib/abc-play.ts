/**
 * MiMo's ABC score block, the parts that need no window: which fences and
 * files are scores, whether a parse is music or prose, how long a tune plays,
 * where a press on the progress bar lands, and the play/pause/seek clock over
 * one rendered buffer. The checks run these in node.
 */

/** MiMo's cap on an ABC source; a longer fence stays code. */
export const ABC_SOURCE_LIMIT = 200_000
/* MiMo renders at most ten minutes, and three seconds past the last note so it rings out. */
export const ABC_AUDIO_LIMIT_SECONDS = 600
export const ABC_AUDIO_TAIL_SECONDS = 3

export function isAbcFile(path: string | undefined): boolean {
  return /\.abc(?:[?#].*)?$/i.test(path ?? "")
}

interface VoiceItem {
  el_type?: string
  rest?: unknown
}

/** Sounding notes in a parsed tune: rests and everything that is not a note are left out. */
export function countNotes(tune: unknown): number {
  let count = 0
  const lines = (tune as { lines?: { staff?: { voices?: VoiceItem[][] }[] }[] } | undefined)?.lines ?? []
  for (const line of lines) for (const staff of line.staff ?? []) for (const voice of staff.voices ?? []) for (const item of voice ?? []) if (item?.el_type === "note" && !item.rest) count += 1
  return count
}

/** MiMo's three refusals: nothing parsed, no notes, or warnings on text with no X: header (prose that happened to parse). */
export function scoreProblem(tune: unknown, source: string): "no-music" | "no-notes" | "prose" | undefined {
  const parsed = tune as { lines?: unknown[]; warnings?: unknown[] } | undefined
  if (!parsed || !Array.isArray(parsed.lines) || !parsed.lines.length) return "no-music"
  if (countNotes(parsed) === 0) return "no-notes"
  if ((parsed.warnings?.length ?? 0) > 0 && !/^\s*X\s*:/m.test(source)) return "prose"
  return undefined
}

/** A tune's playing time in seconds from abcjs's audio setup (whole notes at a quarter-note tempo). */
export function tuneSeconds(audio: { tempo?: unknown; totalDuration?: unknown } | undefined): number | undefined {
  const tempo = audio?.tempo
  const total = audio?.totalDuration
  if (typeof tempo !== "number" || typeof total !== "number" || !(tempo > 0) || !(total > 0)) return undefined
  return (total * 4 * 60) / tempo
}

/** How much to render: the tune and its tail, never past MiMo's ten minutes. */
export function renderSeconds(seconds: number | undefined): number {
  return seconds === undefined ? ABC_AUDIO_LIMIT_SECONDS : Math.min(ABC_AUDIO_LIMIT_SECONDS, seconds + ABC_AUDIO_TAIL_SECONDS)
}

/** Where on the progress bar a pointer is, as a share of the tune. */
export function progressAt(x: number, left: number, width: number): number | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return undefined
  return Math.min(1, Math.max(0, (x - left) / width))
}

export interface ScoreNote {
  time: number
  length: number
  frequency: number
  gain: number
}

interface TrackNote {
  cmd?: string
  pitch?: unknown
  start?: unknown
  duration?: unknown
  gap?: unknown
  volume?: unknown
  instrument?: unknown
}

/**
 * abcjs's own note sequence for the tune, in seconds and hertz. Percussion
 * (abcjs's instrument 128) has no pitch to sound and is left out.
 */
export function scoreNotes(audio: { tempo?: unknown; tracks?: unknown } | undefined, until: number): ScoreNote[] {
  const tempo = typeof audio?.tempo === "number" && audio.tempo > 0 ? audio.tempo : undefined
  if (!tempo || !Array.isArray(audio?.tracks)) return []
  const scale = 240 / tempo
  const notes: ScoreNote[] = []
  for (const track of audio.tracks as unknown[]) {
    if (!Array.isArray(track)) continue
    for (const item of track as TrackNote[]) {
      if (item?.cmd !== "note" || typeof item.pitch !== "number" || typeof item.start !== "number" || typeof item.duration !== "number") continue
      if (typeof item.instrument === "number" && item.instrument >= 128) continue
      const time = item.start * scale
      if (!(time >= 0) || time >= until) continue
      const gap = typeof item.gap === "number" && item.gap > 0 ? item.gap : 0
      const volume = typeof item.volume === "number" ? item.volume : 80
      notes.push({
        time,
        length: Math.max(0.03, (item.duration - gap) * scale),
        frequency: 440 * 2 ** ((item.pitch - 69) / 12),
        gain: Math.max(0, Math.min(1, volume / 127)),
      })
    }
  }
  return notes
}

export interface PlayClock {
  duration: number
  now: () => number
  createSource: (offset: number, onEnd: () => void) => { stop: () => void; detach: () => void }
}

/** MiMo's player over one buffer: a source per stretch of playing, the place kept across a pause, a seek that restarts the source. */
export function playbackController(clock: PlayClock, onEnded: () => void) {
  let source: ReturnType<PlayClock["createSource"]> | undefined
  let startedAt = 0
  let offset = 0
  const clamp = (value: number) => Math.max(0, Math.min(value, clock.duration))
  const begin = (at: number) => {
    offset = clamp(at)
    startedAt = clock.now()
    source = clock.createSource(offset, () => {
      source = undefined
      offset = 0
      onEnded()
    })
  }
  const halt = (keepPlace: boolean) => {
    if (!source) return
    if (keepPlace) offset = clamp(offset + (clock.now() - startedAt))
    source.detach()
    source.stop()
    source = undefined
  }
  return {
    start: () => begin(0),
    pause: () => halt(true),
    resume: () => begin(offset),
    stop: () => {
      halt(false)
      offset = 0
    },
    seekTo: (at: number) => {
      if (source) {
        halt(false)
        begin(at)
      } else offset = clamp(at)
    },
    isRunning: () => source !== undefined,
    position: () => (source ? clamp(offset + (clock.now() - startedAt)) : offset),
  }
}

/* One score sounds at a time, as in MiMo: starting another stops the one before. */
let sounding: (() => void) | undefined

export function claimScoreAudio(stop: () => void): void {
  if (sounding && sounding !== stop) sounding()
  sounding = stop
}

export function releaseScoreAudio(stop: () => void): void {
  if (sounding === stop) sounding = undefined
}
