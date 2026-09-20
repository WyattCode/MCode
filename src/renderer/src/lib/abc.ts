import type { NoteTimingEvent, TuneObject } from "abcjs"
import { sanitizeAbcSvg } from "./diagram"
import {
  ABC_SAMPLE_RATE,
  patchTrackPrograms,
  playbackController,
  renderSeconds,
  scoreNotes,
  scoreProblem,
  tuneSeconds,
  withVoicePrograms,
  type ScoreNote,
} from "./abc-play"
import { renderWithFluidSynth } from "./abc-fluidsynth"

/*
 * What MiMo's ABC block needs from the window: abcjs loaded once on first use,
 * a score drawn and sanitised before it is put in the page, and the tune
 * played through Web Audio.
 *
 * Playing is MiMo's: the tune becomes MIDI (instruments fixed up before and
 * after), FluidSynth renders it offline with the bundled MuseScore_General
 * soundfont into one buffer (lib/abc-fluidsynth), and abcjs's TimingCallbacks
 * light the notes. When the engine or the soundfont cannot be had, the notes
 * of abcjs's own audio sequence are voiced instead by a small oscillator synth,
 * so a score still plays. Nothing is fetched either way.
 */

type Abcjs = typeof import("abcjs")
let loading: Promise<Abcjs> | undefined

export function loadAbcjs(): Promise<Abcjs> {
  loading ??= import("abcjs").then((module) => (module as { default?: Abcjs }).default ?? module)
  return loading
}

export interface RenderedScore {
  tune: TuneObject
  /** abcjs's own elements to their sanitised copies on the page, and back: the timing events name abcjs's. */
  copies: Map<Element, Element>
  originals: Map<Element, Element>
}

/**
 * Draws the tune off screen (abcjs measures its text, so it must be laid out),
 * refuses what MiMo refuses, and puts the sanitised markup into `target`.
 */
export async function renderScore(target: HTMLElement, source: string): Promise<RenderedScore> {
  const abcjs = await loadAbcjs()
  const scratch = document.createElement("div")
  scratch.setAttribute("aria-hidden", "true")
  Object.assign(scratch.style, {
    position: "fixed",
    top: "0",
    left: "-100000px",
    width: `${Math.max(320, target.clientWidth || 740)}px`,
    visibility: "hidden",
    pointerEvents: "none",
  })
  document.body.appendChild(scratch)
  try {
    const tune = abcjs.renderAbc(scratch, source, { responsive: "resize", add_classes: true, paddingleft: 0, paddingright: 0 })[0]
    const problem = scoreProblem(tune, source)
    if (problem) throw new Error(`abc: ${problem}`)
    const clean = sanitizeAbcSvg(scratch.innerHTML)
    if (!/<svg[\s>]/i.test(clean)) throw new Error("abc: no score survived sanitising")
    target.innerHTML = clean
    /*
     * abcjs's "resize" mode lays the score out for a container of its own - the
     * score is `position: absolute` at its top left, and the container carries
     * the height as a padding ratio. Only the score itself survives sanitising,
     * so that positioning had nothing to hold it: the staff was drawn over
     * whatever the nearest positioned ancestor was, which in the conversation
     * is the message list and in the files tab is the view, where it landed on
     * top of the document's first heading. Put back in the flow it sizes itself
     * from its viewBox, under the `max-width: 100%; height: auto` the block's
     * stylesheet gives it.
     */
    const drawn = target.querySelector("svg")
    if (drawn) {
      drawn.style.position = "static"
      drawn.style.top = ""
      drawn.style.left = ""
    }
    const from = [...scratch.querySelectorAll("[class]")]
    const to = [...target.querySelectorAll("[class]")]
    const copies = new Map<Element, Element>()
    const originals = new Map<Element, Element>()
    // Sanitising keeps abcjs's elements in order; if it ever did not, the score still shows, only unlit.
    if (from.length === to.length) {
      from.forEach((element, index) => {
        copies.set(element, to[index])
        originals.set(to[index], element)
      })
    }
    return { tune, copies, originals }
  } finally {
    scratch.remove()
  }
}

/** What voiced the tune: FluidSynth with the soundfont, or the oscillator synth it falls back to. */
export type ScoreEngine = "fluidsynth" | "basic"

export interface ScoreAudio {
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  /** A share of the tune, 0 to 1. */
  seek: (share: number) => void
  durationMs: number
  timings: NoteTimingEvent[]
  engine: ScoreEngine
}

let context: AudioContext | undefined

/* One note: a triangle with a quiet octave above, a quick attack, a settle, and a short release. */
function voice(offline: OfflineAudioContext, out: AudioNode, note: ScoreNote) {
  const peak = 0.22 * note.gain
  if (!(peak > 0)) return
  const end = note.time + note.length
  const envelope = offline.createGain()
  envelope.gain.setValueAtTime(0, note.time)
  envelope.gain.linearRampToValueAtTime(peak, note.time + 0.008)
  envelope.gain.exponentialRampToValueAtTime(peak * 0.55, note.time + Math.min(0.25, note.length))
  envelope.gain.setTargetAtTime(0, end, 0.04)
  envelope.connect(out)
  const tone = offline.createOscillator()
  tone.type = "triangle"
  tone.frequency.value = note.frequency
  const overtone = offline.createOscillator()
  overtone.type = "sine"
  overtone.frequency.value = note.frequency * 2
  const overtoneLevel = offline.createGain()
  overtoneLevel.gain.value = 0.25
  tone.connect(envelope)
  overtone.connect(overtoneLevel).connect(envelope)
  const stopAt = end + 0.3
  tone.start(note.time)
  overtone.start(note.time)
  tone.stop(stopAt)
  overtone.stop(stopAt)
}

function elementsOf(event: NoteTimingEvent | null): Element[] {
  const groups = event?.elements
  if (!Array.isArray(groups)) return []
  return groups.flatMap((group) => (Array.isArray(group) ? group.filter((element): element is HTMLElement => element instanceof Element) : []))
}

/* MiMo's path: MIDI without abcjs's chord and bass accompaniment, rendered by FluidSynth. */
async function soundfontBuffer(abcjs: Abcjs, source: string, length: number, live: AudioContext): Promise<AudioBuffer> {
  const midi: unknown = abcjs.synth.getMidiFile(withVoicePrograms(source), { midiOutputType: "binary", chordvol: 0, bassvol: 0 })
  const file: unknown = Array.isArray(midi) ? midi[0] : midi
  const bytes = file instanceof Uint8Array ? file : file instanceof ArrayBuffer ? new Uint8Array(file) : undefined
  if (!bytes?.byteLength) throw new Error("abc produced no midi")
  return renderWithFluidSynth(patchTrackPrograms(bytes), length, live)
}

/* The fallback: abcjs's note sequence through the oscillator voice above. */
async function basicBuffer(sequence: { tempo?: unknown; tracks?: unknown }, length: number): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext !== "function") throw new Error("audio not supported")
  const notes = scoreNotes(sequence, length)
  if (!notes.length) throw new Error("abc produced no notes to play")
  const offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(length * ABC_SAMPLE_RATE)), ABC_SAMPLE_RATE)
  const master = offline.createDynamicsCompressor()
  master.connect(offline.destination)
  for (const note of notes) voice(offline, master, note)
  return offline.startRendering()
}

/** The tune rendered to a buffer and a player over it; `watch` hears which notes sound and how far along it is. */
export async function prepareScoreAudio(
  tune: TuneObject,
  source: string,
  onEnded: () => void,
  watch: { onEvent: (elements: Element[]) => void; onProgress: (share: number) => void },
): Promise<ScoreAudio> {
  const abcjs = await loadAbcjs()
  const Context = window.AudioContext
  if (!Context) throw new Error("audio not supported")
  context ??= new Context()
  const live = context
  const sequence = tune.setUpAudio({})
  const seconds = tuneSeconds(sequence)
  const length = renderSeconds(seconds)
  let engine: ScoreEngine = "fluidsynth"
  let buffer: AudioBuffer
  try {
    buffer = await soundfontBuffer(abcjs, source, length, live)
  } catch (error) {
    // Not a failure to play: the tune is voiced by the built-in synth instead.
    console.info("abc: soundfont playback unavailable, using the built-in synth", error)
    engine = "basic"
    buffer = await basicBuffer(sequence, length)
  }
  const duration = seconds ?? buffer.duration

  const controller = playbackController(
    {
      duration,
      now: () => live.currentTime,
      createSource: (offset, onEnd) => {
        const source = live.createBufferSource()
        source.buffer = buffer
        source.connect(live.destination)
        source.onended = () => onEnd()
        source.start(0, Math.min(offset, buffer.duration))
        return {
          stop: () => {
            try {
              source.stop()
            } catch {
              // Already stopped.
            }
          },
          detach: () => {
            source.onended = null
          },
        }
      },
    },
    onEnded,
  )
  const timer = new abcjs.TimingCallbacks(tune, {
    eventCallback: (event) => {
      watch.onEvent(elementsOf(event))
      return undefined
    },
    beatCallback: (beat, total) => watch.onProgress(total > 0 ? beat / total : 0),
  })
  return {
    start: async () => {
      if (live.state === "suspended") await live.resume()
      controller.start()
      timer.start()
    },
    pause: () => {
      controller.pause()
      timer.pause()
    },
    resume: () => {
      controller.resume()
      timer.start()
    },
    stop: () => {
      controller.stop()
      timer.stop()
    },
    seek: (share) => {
      const at = Math.min(1, Math.max(0, share))
      controller.seekTo(at * duration)
      timer.setProgress(at, "percent")
    },
    durationMs: duration * 1000,
    timings: timer.noteTimings ?? [],
    engine,
  }
}
