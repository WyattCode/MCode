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

/* MiMo's offline render: 44.1 kHz stereo, 4096 frames a block, the window given back every 8 ms. */
export const ABC_SAMPLE_RATE = 44_100
export const ABC_RENDER_BLOCK = 4096
export const ABC_RENDER_YIELD_MS = 8

/** Frames to render for `seconds` (renderSeconds's answer), never more than ten minutes' worth. */
export function renderFrames(seconds: number): number {
  const cap = ABC_SAMPLE_RATE * ABC_AUDIO_LIMIT_SECONDS
  if (!Number.isFinite(seconds)) return cap
  return Math.max(0, Math.min(Math.ceil(seconds * ABC_SAMPLE_RATE), cap))
}

const MIDI_PROGRAM = /^%%MIDI program (\d+)/
const HEADER_VOICE = /^V:([\w-]+)/
const INLINE_VOICE = /\[V:([\w-]+)\]/

/* The %%MIDI program directly under a line: blank lines, plain comments and other %% directives are passed over, anything else ends the search. */
function programBelow(lines: string[], from: number, end: number): { line: number; program: number } | undefined {
  for (let index = from; index < end; index += 1) {
    const text = lines[index].trim()
    if (text === "" || (text.startsWith("%") && !text.startsWith("%%"))) continue
    const match = MIDI_PROGRAM.exec(text)
    if (match) return { line: index, program: Number.parseInt(match[1], 10) }
    if (!text.startsWith("%%")) return undefined
  }
  return undefined
}

/**
 * MiMo's instrument fix before a tune becomes MIDI. A `%%MIDI program` written
 * under a voice declared in the header, or under an inline `[V:name]` in the
 * body, does not reach that voice in abcjs's MIDI. So the header's voice lines
 * move to just after K:, each followed by its program (an inline one wins over
 * the header's), and the programs are taken out of where they were written.
 * A tune with no K:, no header voices or no programs is left as it is.
 */
export function withVoicePrograms(source: string): string {
  const lines = source.split("\n")
  const key = lines.findIndex((line) => line.trim().startsWith("K:"))
  if (key === -1) return source
  const voices: { index: number; name: string }[] = []
  for (let index = 0; index < key; index += 1) {
    const match = HEADER_VOICE.exec(lines[index])
    if (match) voices.push({ index, name: match[1] })
  }
  if (!voices.length) return source
  const programs = new Map<string, number>()
  const moved = new Set<number>()
  for (let index = key + 1; index < lines.length; index += 1) {
    const match = INLINE_VOICE.exec(lines[index])
    if (!match) continue
    const found = programBelow(lines, index + 1, lines.length)
    if (!found) continue
    programs.set(match[1], found.program)
    moved.add(found.line)
  }
  for (const voice of voices) {
    const found = programBelow(lines, voice.index + 1, key)
    if (!found) continue
    moved.add(found.line)
    if (!programs.has(voice.name)) programs.set(voice.name, found.program)
  }
  if (!programs.size) return source
  const voiceLines = new Set(voices.map((voice) => voice.index))
  const head = lines.slice(0, key + 1).filter((_, index) => index === key || (!voiceLines.has(index) && !moved.has(index)))
  const declared = voices.flatMap((voice) => {
    const program = programs.get(voice.name)
    return program === undefined ? [lines[voice.index]] : [lines[voice.index], `%%MIDI program ${program}`]
  })
  const body = lines.slice(key + 1).filter((_, offset) => !moved.has(key + 1 + offset))
  return [...head, ...declared, ...body].join("\n")
}

function readVariable(bytes: Uint8Array, at: number, end: number): [number, number] {
  let value = 0
  while (at < end) {
    const byte = bytes[at++]
    value = (value << 7) | (byte & 0x7f)
    if (!(byte & 0x80)) break
  }
  return [value, at]
}

/* Every event of one track: its kind (the status's high nibble, or the whole status for meta and sysex), channel, and where its status byte sits (-1 for running status). */
function eachTrackEvent(bytes: Uint8Array, start: number, end: number, visit: (event: { kind: number; channel: number; statusAt: number; dataAt: number }) => void) {
  let at = start
  let running = 0
  while (at < end) {
    at = readVariable(bytes, at, end)[1]
    if (at >= end) break
    let status = running
    let statusAt = -1
    if (bytes[at] & 0x80) {
      status = bytes[at]
      statusAt = at
      at += 1
      if (status < 0xf0) running = status
    }
    if (!status) break
    const kind = status < 0xf0 ? status & 0xf0 : status
    visit({ kind, channel: status & 0x0f, statusAt, dataAt: at })
    if (kind === 0x80 || kind === 0x90 || kind === 0xa0 || kind === 0xb0 || kind === 0xe0) at += 2
    else if (kind === 0xc0 || kind === 0xd0) at += 1
    else if (status === 0xff) {
      const [length, next] = readVariable(bytes, at + 1, end)
      at = next + length
    } else if (status === 0xf0 || status === 0xf7) {
      const [length, next] = readVariable(bytes, at, end)
      at = next + length
    } else break
  }
}

/**
 * MiMo's MIDI fix after abcjs writes the file: a track whose notes all sound on
 * one channel other than 0 still carries its Program Change on channel 0, so
 * the instrument lands on the wrong channel. Such a track's channel-0 program
 * changes are moved to the channel its notes use. Returns a patched copy; bytes
 * that are not a standard MIDI file come back unchanged.
 */
export function patchTrackPrograms(midi: Uint8Array): Uint8Array {
  const bytes = midi.slice()
  const tag = (at: number, word: string) => [...word].every((letter, offset) => bytes[at + offset] === letter.charCodeAt(0))
  if (bytes.length < 14 || !tag(0, "MThd")) return bytes
  const headerLength = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0
  const tracks = (bytes[10] << 8) | bytes[11]
  let at = 8 + headerLength
  for (let track = 0; track < tracks; track += 1) {
    if (at + 8 > bytes.length || !tag(at, "MTrk")) break
    const length = ((bytes[at + 4] << 24) | (bytes[at + 5] << 16) | (bytes[at + 6] << 8) | bytes[at + 7]) >>> 0
    const start = at + 8
    const end = Math.min(start + length, bytes.length)
    at = end
    const sounding = new Set<number>()
    eachTrackEvent(bytes, start, end, ({ kind, channel, dataAt }) => {
      if (kind === 0x90 && dataAt + 1 < end && bytes[dataAt + 1] > 0) sounding.add(channel)
    })
    if (sounding.size !== 1) continue
    const [channel] = sounding
    if (channel === 0) continue
    eachTrackEvent(bytes, start, end, (event) => {
      if (event.kind === 0xc0 && event.statusAt >= 0 && event.channel === 0) bytes[event.statusAt] = 0xc0 | channel
    })
  }
  return bytes
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
