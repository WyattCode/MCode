import type { NoteTimingEvent, TuneObject } from "abcjs"
import { sanitizeAbcSvg } from "./diagram"
import { playbackController, renderSeconds, scoreNotes, scoreProblem, tuneSeconds, type ScoreNote } from "./abc-play"

/*
 * What MiMo's ABC block needs from the window: abcjs loaded once on first use,
 * a score drawn and sanitised before it is put in the page, and the tune
 * played through Web Audio.
 *
 * Playing differs from MiMo underneath. MiMo renders the tune's MIDI through
 * FluidSynth and a bundled General MIDI soundfont; abcjs's own synth fetches
 * its instrument samples from a web host, which this window's content policy
 * refuses and which no remote host is added for. So the notes of abcjs's own
 * audio sequence are voiced here by a small oscillator synth, rendered offline
 * into one buffer, with abcjs's TimingCallbacks lighting the notes as MiMo's
 * does. Nothing is fetched.
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

export interface ScoreAudio {
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
  /** A share of the tune, 0 to 1. */
  seek: (share: number) => void
  durationMs: number
  timings: NoteTimingEvent[]
}

const SAMPLE_RATE = 44_100
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

/** The tune rendered to a buffer and a player over it; `watch` hears which notes sound and how far along it is. */
export async function prepareScoreAudio(
  tune: TuneObject,
  onEnded: () => void,
  watch: { onEvent: (elements: Element[]) => void; onProgress: (share: number) => void },
): Promise<ScoreAudio> {
  const abcjs = await loadAbcjs()
  const Context = window.AudioContext
  if (!Context || typeof OfflineAudioContext !== "function") throw new Error("audio not supported")
  context ??= new Context()
  const live = context
  const sequence = tune.setUpAudio({})
  const seconds = tuneSeconds(sequence)
  const length = renderSeconds(seconds)
  const notes = scoreNotes(sequence, length)
  if (!notes.length) throw new Error("abc produced no notes to play")
  const offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(length * SAMPLE_RATE)), SAMPLE_RATE)
  const master = offline.createDynamicsCompressor()
  master.connect(offline.destination)
  for (const note of notes) voice(offline, master, note)
  const buffer = await offline.startRendering()
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
  }
}
