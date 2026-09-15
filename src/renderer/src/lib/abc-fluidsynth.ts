import type { Synthesizer } from "js-synthesizer"
import { ABC_RENDER_BLOCK, ABC_RENDER_YIELD_MS, ABC_SAMPLE_RATE, renderFrames } from "./abc-play"

/**
 * MiMo's score voice: FluidSynth, compiled to WebAssembly, playing the bundled
 * MuseScore_General soundfont.
 *
 * The engine is libfluidsynth-2.4.6-with-libsndfile.js exactly as js-synthesizer
 * ships it (LGPL-2.1). It is not bundled: electron.vite.config.ts copies it to
 * vendor/ beside the page, electron-builder leaves that folder outside the asar,
 * and it is loaded here with a script tag of its own - so it stays one file a
 * user can replace. The soundfont's bytes come from the main process over IPC;
 * nothing is fetched and no audio leaves the window.
 *
 * Everything is loaded once, on first need: the promise is kept, and dropped
 * again on a failure so the next press tries afresh.
 */
export const FLUIDSYNTH_GLUE = "./vendor/libfluidsynth-2.4.6-with-libsndfile.js"
const GLUE_MARK = "data-mcode-fluidsynth"

let ready: Promise<Synthesizer> | undefined

/* The glue defines a global Module that js-synthesizer looks for. */
function loadGlue(): Promise<void> {
  const scope = window as unknown as { Module?: unknown }
  if (scope.Module) return Promise.resolve()
  document.querySelector(`script[${GLUE_MARK}]`)?.remove()
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.setAttribute(GLUE_MARK, "")
    script.async = false
    script.src = FLUIDSYNTH_GLUE
    script.onload = () => {
      if (scope.Module) resolve()
      else {
        script.remove()
        reject(new Error("fluidsynth glue did not define Module"))
      }
    }
    script.onerror = () => {
      script.remove()
      reject(new Error(`could not load ${FLUIDSYNTH_GLUE}`))
    }
    document.head.appendChild(script)
  })
}

export function loadFluidSynth(): Promise<Synthesizer> {
  ready ??= (async () => {
    await loadGlue()
    const library = await import("js-synthesizer")
    await library.waitForReady()
    /*
     * The WebAssembly build reports each of its stubbed file calls (fluid_stat,
     * fluid_file_test) as an error: over a thousand console lines per load. A
     * real failure still rejects below, so only a panic is left to print.
     */
    library.disableLogging(library.LogLevel.Error)
    const reply = await window.mcode.soundfont()
    if (!reply.ok) throw new Error(`soundfont unavailable (${reply.reason})`)
    const synth = new library.Synthesizer()
    synth.init(ABC_SAMPLE_RATE)
    const { bytes } = reply
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    await synth.loadSFont((whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer)
    return synth
  })().catch((error: unknown) => {
    ready = undefined
    throw error
  })
  return ready
}

/* MiMo warms the engine once a score is on screen, when the window is idle, so the first press is quick. */
export function warmFluidSynth(): void {
  const load = () => void loadFluidSynth().catch(() => undefined)
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(load, { timeout: 10_000 })
  else setTimeout(load, 0)
}

const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * The tune's MIDI rendered offline into one stereo 44.1 kHz buffer, in 4096-frame
 * blocks, giving the window back every 8 ms so a long tune does not freeze it.
 */
export async function renderWithFluidSynth(midi: Uint8Array, seconds: number, context: BaseAudioContext): Promise<AudioBuffer> {
  const synth = await loadFluidSynth()
  await synth.resetPlayer()
  synth.midiSystemReset()
  await synth.addSMFDataToPlayer(midi.slice().buffer as ArrayBuffer)
  await synth.playPlayer()
  try {
    const frames = renderFrames(seconds)
    const buffer = context.createBuffer(2, Math.max(1, frames), ABC_SAMPLE_RATE)
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    const blockLeft = new Float32Array(ABC_RENDER_BLOCK)
    const blockRight = new Float32Array(ABC_RENDER_BLOCK)
    let since = Date.now()
    for (let at = 0; at < frames; at += ABC_RENDER_BLOCK) {
      synth.render([blockLeft, blockRight])
      const count = Math.min(ABC_RENDER_BLOCK, frames - at)
      left.set(count === ABC_RENDER_BLOCK ? blockLeft : blockLeft.subarray(0, count), at)
      right.set(count === ABC_RENDER_BLOCK ? blockRight : blockRight.subarray(0, count), at)
      if (Date.now() - since >= ABC_RENDER_YIELD_MS) {
        await breathe()
        since = Date.now()
      }
    }
    return buffer
  } finally {
    synth.stopPlayer()
  }
}
