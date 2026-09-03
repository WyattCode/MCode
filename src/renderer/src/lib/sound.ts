/**
 * The three sounds the app makes.
 *
 * Synthesised rather than shipped as files: they are three short tones, and a
 * pair of oscillators describes them more precisely than an audio asset would
 * while adding nothing to the bundle. The context is created on first use
 * because a browser will not let one start before the page has been touched.
 */
export type Cue = "done" | "permission" | "error"

let context: AudioContext | undefined

/** Each cue as a shape: a note, a fall, and how long it takes. */
const CUES: Record<Cue, { from: number; to: number; seconds: number; gain: number }> = {
  // Finished: a small rise, the way a task ticking off sounds.
  done: { from: 660, to: 880, seconds: 0.16, gain: 0.05 },
  // Asking: two even notes, so it reads as a question rather than a result.
  permission: { from: 520, to: 520, seconds: 0.22, gain: 0.06 },
  // Failed: a fall, which is what everything that goes wrong sounds like.
  error: { from: 400, to: 240, seconds: 0.26, gain: 0.06 },
}

export function play(cue: Cue): void {
  try {
    context = context ?? new AudioContext()
    if (context.state === "suspended") void context.resume()

    const shape = CUES[cue]
    const now = context.currentTime
    const oscillator = context.createOscillator()
    const amplifier = context.createGain()

    oscillator.type = "sine"
    oscillator.frequency.setValueAtTime(shape.from, now)
    if (shape.to !== shape.from) {
      oscillator.frequency.exponentialRampToValueAtTime(shape.to, now + shape.seconds)
    }

    /*
     * A tone that starts and stops abruptly clicks, which is far more
     * noticeable than the tone itself - so it fades in over a few milliseconds
     * and decays away rather than being cut.
     */
    amplifier.gain.setValueAtTime(0.0001, now)
    amplifier.gain.exponentialRampToValueAtTime(shape.gain, now + 0.012)
    amplifier.gain.exponentialRampToValueAtTime(0.0001, now + shape.seconds)

    oscillator.connect(amplifier)
    amplifier.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + shape.seconds + 0.02)
  } catch {
    // No audio device, or a context the browser refused: a missing sound is
    // never worth interrupting anything for.
  }
}
