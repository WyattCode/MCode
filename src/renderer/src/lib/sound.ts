/**
 * The sounds the app makes.
 *
 * Synthesised rather than shipped as files: they are short figures, and a
 * few oscillators describe them more precisely than an audio asset would
 * while adding nothing to the bundle. The context is created on first use
 * because a browser will not let one start before the page has been touched.
 */
import type { ChimeName } from "@shared/chime"

let context: AudioContext | undefined

/** One oscillator: a pitch (gliding to `to` if given), when it starts, how long it rings. */
export interface Voice {
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
function sound(ctx: AudioContext, voice: Voice, out: AudioNode = ctx.destination): void {
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
  amplifier.connect(out)
  oscillator.start(start)
  oscillator.stop(start + voice.seconds + 0.02)
}

/*
 * The chimes share one small room: a reverb whose impulse is MCode's own noise
 * dying away, so each figure rings out a little instead of stopping dry. Built
 * once per context.
 */
let room: { context: AudioContext; input: GainNode } | undefined

function chimeRoom(ctx: AudioContext): AudioNode {
  if (room?.context === ctx) return room.input
  const input = ctx.createGain()
  const dry = ctx.createGain()
  const wet = ctx.createGain()
  const convolver = ctx.createConvolver()
  dry.gain.value = 0.85
  wet.gain.value = 0.3
  convolver.buffer = impulse(ctx, 1.6)
  input.connect(dry)
  dry.connect(ctx.destination)
  input.connect(convolver)
  convolver.connect(wet)
  wet.connect(ctx.destination)
  room = { context: ctx, input }
  return input
}

/* A stereo tail of noise fading exponentially over `seconds`, each side drawn apart, which gives the room its width. */
function impulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds))
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < length; index++) data[index] = (Math.random() * 2 - 1) * Math.exp((-5 * index) / length)
  }
  return buffer
}

export function chime(name: ChimeName): void {
  try {
    const ctx = audio()
    const out = chimeRoom(ctx)
    for (const voice of CHIME_VOICES[name]) sound(ctx, voice, out)
  } catch {
    // No audio device, or a context the browser refused: silence is the right failure.
  }
}

/*
 * The two notes a waiting confirmation makes.
 *
 * Measured from MiMo's own figure, which is a pair rather than one of its eight
 * chimes: E5 (659.25 Hz) at once and A5 (880 Hz) 0.16 s later, the second a
 * touch louder and ringing longer - relative gains 0.85 then 1, lengths 1.1 s
 * then 1.4 s - drawn in the 铃语 voice, a bright bar with a high fourth-harmonic
 * ring. Those relative gains are taken against MCode's own 铃语 level, so the
 * cue sits with the rest of this file rather than over it.
 *
 * Unlike the long-task chime it has no elapsed-time threshold: MiMo's does not
 * either, because a question that arrives in the first ten seconds is waiting
 * just as much as one that arrives after a minute.
 */
const CONFIRM_LEVEL = 0.045

export const CONFIRM_VOICES: readonly Voice[] = [
  ...struck(659.25, 0, 1.1, CONFIRM_LEVEL * 0.85, 4),
  ...struck(880, 0.16, 1.4, CONFIRM_LEVEL, 4),
]

/**
 * Plays it, and says whether it was heard.
 *
 * The caller marks the OS notification silent only on a true: MiMo marks its
 * own notification silent because this sound has just played, and MCode copied
 * the silence without ever having the sound - which turned the chime setting
 * into a switch that muted every confirmation instead of announcing it.
 */
export function confirmChime(): boolean {
  try {
    const ctx = audio()
    const out = chimeRoom(ctx)
    for (const voice of CONFIRM_VOICES) sound(ctx, voice, out)
    return true
  } catch {
    return false
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
