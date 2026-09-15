/**
 * The sounds the app makes.
 *
 * Synthesised rather than shipped as files: they are three short tones, and a
 * few oscillators describe them more precisely than an audio asset would
 * while adding nothing to the bundle. The context is created on first use
 * because a browser will not let one start before the page has been touched.
 */
import type { ChimeName } from "@shared/chime"

export type Cue = "permission" | "error"

let context: AudioContext | undefined

/** Each cue as a shape: a note, a fall, and how long it takes. */
const CUES: Record<Cue, { from: number; to: number; seconds: number; gain: number }> = {
  // Asking: two even notes, so it reads as a question rather than a result.
  permission: { from: 520, to: 520, seconds: 0.22, gain: 0.06 },
  // Failed: a fall, which is what everything that goes wrong sounds like.
  error: { from: 400, to: 240, seconds: 0.26, gain: 0.06 },
}

/** One oscillator: a pitch (gliding to `to` if given), when it starts, how long it rings. */
interface Voice {
  from: number
  to?: number
  at: number
  seconds: number
  gain: number
  type?: OscillatorType
}

/*
 * The long-task chimes, MiMo's eight names drawn with MCode's own voices. Each
 * is a handful of oscillators rather than a recording, and each is kept under
 * two seconds so it announces the end without becoming a tune someone has to
 * wait out.
 */

/* A struck note: its fundamental, and one quieter partial at `ratio` that dies sooner. */
function struck(from: number, at: number, seconds: number, gain: number, ratio: number, type: OscillatorType = "sine"): Voice[] {
  return [
    { from, at, seconds, gain, type },
    { from: from * ratio, at, seconds: seconds * 0.45, gain: gain * 0.3 },
  ]
}

const CHIME_VOICES: Record<ChimeName, Voice[]> = {
  // 琥珀: a warm electric-piano third, the upper note laid on the lower.
  rhodes: [...struck(659, 0, 0.9, 0.05, 2), ...struck(831, 0.12, 1.0, 0.04, 2)],
  // 空山: a low steel-drum fifth with an octave shimmer, left to ring.
  handpan: [...struck(294, 0, 1.5, 0.06, 2.01), ...struck(440, 0.22, 1.4, 0.045, 2.01)],
  // 铃语: three bright bars climbing, each with a high fourth-harmonic ring.
  vibes: [...struck(1047, 0, 0.5, 0.04, 4), ...struck(1319, 0.11, 0.5, 0.04, 4), ...struck(1568, 0.22, 0.9, 0.045, 4)],
  // 晨曦: a soft major arpeggio opening upward, the top note held longest.
  bloom: [
    { from: 523, at: 0, seconds: 0.6, gain: 0.04 },
    { from: 659, at: 0.09, seconds: 0.6, gain: 0.04 },
    { from: 784, at: 0.18, seconds: 0.7, gain: 0.04 },
    { from: 1047, at: 0.27, seconds: 1.1, gain: 0.045 },
  ],
  // 流萤: a quick plucked run up a pentatonic scale.
  harp: [
    { from: 587, at: 0, seconds: 0.35, gain: 0.04, type: "triangle" },
    { from: 659, at: 0.06, seconds: 0.35, gain: 0.04, type: "triangle" },
    { from: 784, at: 0.12, seconds: 0.35, gain: 0.04, type: "triangle" },
    { from: 880, at: 0.18, seconds: 0.4, gain: 0.04, type: "triangle" },
    { from: 1175, at: 0.24, seconds: 0.8, gain: 0.045, type: "triangle" },
  ],
  // 山泉: two thumb-piano plinks, their bell-like partial out of tune on purpose.
  kalimba: [...struck(1175, 0, 0.45, 0.05, 5.4), ...struck(1568, 0.16, 0.7, 0.05, 5.4)],
  // 静水: one singing bowl, its uneven overtone beating slowly as it fades.
  bowl: [
    { from: 392, at: 0, seconds: 1.8, gain: 0.06 },
    { from: 1058, at: 0, seconds: 1.4, gain: 0.014 },
    { from: 1062, at: 0.02, seconds: 1.4, gain: 0.012 },
  ],
  // 远山: two plucked strings a fourth apart, the second bending down as it settles.
  koto: [
    { from: 440, at: 0, seconds: 0.8, gain: 0.05, type: "triangle" },
    { from: 880, at: 0, seconds: 0.3, gain: 0.012 },
    { from: 600, to: 587, at: 0.2, seconds: 1.1, gain: 0.05, type: "triangle" },
    { from: 1174, at: 0.2, seconds: 0.35, gain: 0.012 },
  ],
}

function audio(): AudioContext {
  context = context ?? new AudioContext()
  if (context.state === "suspended") void context.resume()
  return context
}

/*
 * A tone that starts and stops abruptly clicks, which is far more noticeable
 * than the tone itself - so each voice fades in over a few milliseconds and
 * decays away rather than being cut.
 */
function sound(ctx: AudioContext, voice: Voice): void {
  const start = ctx.currentTime + voice.at
  const oscillator = ctx.createOscillator()
  const amplifier = ctx.createGain()

  oscillator.type = voice.type ?? "sine"
  oscillator.frequency.setValueAtTime(voice.from, start)
  if (voice.to !== undefined && voice.to !== voice.from) {
    oscillator.frequency.exponentialRampToValueAtTime(voice.to, start + voice.seconds)
  }

  amplifier.gain.setValueAtTime(0.0001, start)
  amplifier.gain.exponentialRampToValueAtTime(voice.gain, start + 0.012)
  amplifier.gain.exponentialRampToValueAtTime(0.0001, start + voice.seconds)

  oscillator.connect(amplifier)
  amplifier.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + voice.seconds + 0.02)
}

export function play(cue: Cue): void {
  try {
    const shape = CUES[cue]
    sound(audio(), { from: shape.from, to: shape.to, at: 0, seconds: shape.seconds, gain: shape.gain })
  } catch {
    // No audio device, or a context the browser refused: a missing sound is
    // never worth interrupting anything for.
  }
}

export function chime(name: ChimeName): void {
  try {
    const ctx = audio()
    for (const voice of CHIME_VOICES[name]) sound(ctx, voice)
  } catch {
    // As above: silence is the right failure.
  }
}

/*
 * The conversation navigator's scale: the major pentatonic, climbing two octaves
 * from the first turn to the last, so where the pointer is can be heard. Passing
 * over a tick is a light touch; pressing one rings fuller.
 */
const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0]

export function spineNote(index: number, count: number, strong = false): void {
  try {
    const step = count > 1 ? Math.round((index / (count - 1)) * PENTATONIC.length * 2) : 0
    const from = PENTATONIC[step % PENTATONIC.length] * 2 ** Math.floor(step / PENTATONIC.length)
    sound(audio(), { from, at: 0, seconds: strong ? 0.7 : 0.32, gain: strong ? 0.12 : 0.05, type: "triangle" })
  } catch {
    // As above: silence is the right failure.
  }
}
