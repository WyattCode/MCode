/**
 * Speaking to the app, and the app speaking back.
 *
 * The microphone is opened only when a reader presses the button, it is closed
 * the moment the recording stops, and nothing here ever starts on its own. A
 * recording is held in memory for exactly as long as it takes to send it for
 * transcription - it is never written to disk and never kept afterwards.
 *
 * Chromium's own speech recognition is not available in this app: the engine
 * behind `webkitSpeechRecognition` is a Google service that ships with Chrome
 * and not with Electron, so a page that asks for it gets an object that never
 * returns a result. The recording is therefore made here and written down by
 * whichever model the reader has pointed the feature at.
 */

import type { VoiceDraft, VoiceEdit } from "@shared/protocol"

/** The longest single recording. A minute of speech is already a long message. */
const MAX_MS = 60_000

/**
 * What the recorder is doing, for a button that has to say so: pressed and
 * waiting for the microphone, listening, or having it written down.
 */
export type VoiceState = "idle" | "starting" | "recording" | "working"

export interface Recording {
  /** The audio, base64, ready for the protocol - which is JSON and takes no bytes. */
  audio: string
  mime: string
  /** How long it ran, so a recording of nothing can be told from a short one. */
  ms: number
}

/**
 * The formats Chromium will actually produce, best first.
 *
 * Opus in WebM is what every OpenAI-compatible transcription endpoint accepts;
 * the others are here so a build without that encoder still records rather
 * than failing at the first line.
 */
const FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]

function bestFormat(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined
  return FORMATS.find((type) => MediaRecorder.isTypeSupported(type))
}

/* Speech sits well under full scale; this lifts a normal voice to most of the waveform's height. */
const LEVEL_GAIN = 4
/* How much of the previous reading a new one keeps, so the bars move rather than flicker. */
const LEVEL_SMOOTHING = 0.6

export class VoiceRecorder {
  private recorder?: MediaRecorder
  private stream?: MediaStream
  private chunks: Blob[] = []
  private startedAt = 0
  private timer?: number
  private audio?: AudioContext
  private analyser?: AnalyserNode
  private samples?: Uint8Array<ArrayBuffer>
  private smoothed = 0

  get running(): boolean {
    return this.recorder?.state === "recording"
  }

  /**
   * How loud the microphone is right now, 0 to 1, smoothed between readings.
   *
   * Read once per animation frame by the capsule's waveform. Zero whenever
   * nothing is recording, or when the machine offers no audio analysis.
   */
  get level(): number {
    const analyser = this.analyser
    const samples = this.samples
    if (!analyser || !samples || !this.running) return 0
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) {
      const centred = (sample - 128) / 128
      sum += centred * centred
    }
    const rms = Math.sqrt(sum / samples.length)
    this.smoothed = this.smoothed * LEVEL_SMOOTHING + Math.min(1, rms * LEVEL_GAIN) * (1 - LEVEL_SMOOTHING)
    return this.smoothed
  }

  /**
   * Opens the microphone and starts recording.
   *
   * Throws rather than returning a flag: refusing a microphone is something the
   * reader must be told about, and the message the browser gives - a denied
   * permission, no device at all - is the useful part.
   */
  async start(): Promise<void> {
    if (this.running) return
    const mime = bestFormat()
    if (!mime) throw new Error("voice.noRecorder")
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.stream = stream
    this.chunks = []
    this.startedAt = Date.now()
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data)
    }
    recorder.start()
    this.recorder = recorder
    this.listen(stream)
    /* A recording nobody stopped stops itself, rather than holding the
       microphone open for as long as the window is left alone. */
    this.timer = window.setTimeout(() => void this.stop().catch(() => {}), MAX_MS)
  }

  /* The level meter; a machine without Web Audio still records, with a flat waveform. */
  private listen(stream: MediaStream) {
    try {
      const audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      audio.createMediaStreamSource(stream).connect(analyser)
      this.audio = audio
      this.analyser = analyser
      this.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      this.smoothed = 0
    } catch {
      this.audio = undefined
      this.analyser = undefined
      this.samples = undefined
    }
  }

  /** Stops, releases the microphone, and hands back what was heard. */
  async stop(): Promise<Recording | undefined> {
    const recorder = this.recorder
    if (!recorder) return undefined
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = undefined
    const ms = Date.now() - this.startedAt

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    if (recorder.state !== "inactive") recorder.stop()
    await finished
    this.release()

    const blob = new Blob(this.chunks, { type: recorder.mimeType })
    this.chunks = []
    if (!blob.size) return undefined
    return { audio: await base64Of(blob), mime: recorder.mimeType, ms }
  }

  /** Throws the recording away and shuts the microphone. */
  cancel(): void {
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = undefined
    const recorder = this.recorder
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null
      recorder.stop()
    }
    this.chunks = []
    this.release()
  }

  private release() {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    this.recorder = undefined
    void this.audio?.close().catch(() => {})
    this.audio = undefined
    this.analyser = undefined
    this.samples = undefined
    this.smoothed = 0
  }
}

async function base64Of(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  /* In blocks: one apply() over a megabyte of audio overflows the call stack. */
  const BLOCK = 0x8000
  for (let at = 0; at < buffer.length; at += BLOCK) {
    binary += String.fromCharCode(...buffer.subarray(at, at + BLOCK))
  }
  return btoa(binary)
}

/**
 * The word that sends, and what is left when it is taken off.
 *
 * Spoken punctuation lands after it often enough that a trailing full stop has
 * to be allowed for; a "send" in the middle of a sentence is a word, not an
 * instruction, so only the end of the recording counts.
 */
const SEND_WORDS = [/[发發]送[。．.!！]?$/, /\bsend[.!]?$/i, /\b送信[。.]?$/]

export function splitSendWord(text: string): { text: string; send: boolean } {
  const trimmed = text.trim()
  for (const pattern of SEND_WORDS) {
    if (pattern.test(trimmed)) return { text: trimmed.replace(pattern, "").trim(), send: true }
  }
  return { text: trimmed, send: false }
}

/** Latin letters and digits want a space between words; CJK text and punctuation do not. */
const WORDISH_END = /[A-Za-z0-9,.;:!?)\]'"]$/
const WORDISH_START = /^[A-Za-z0-9(["']/

/**
 * What one recording does to the composer.
 *
 * 智能编辑 answers with the whole new text and the caret or selection when the
 * server understood the utterance as an edit; anything else - quick input, an
 * older server, or an answer that failed validation - is typed in where the
 * caret is, replacing the selection. This is the one hook the composer calls,
 * so the rules live here where smoke can hold them.
 */
export function applyVoiceResult(
  draft: VoiceDraft,
  result: { text: string; heard: string; edit?: VoiceEdit },
): VoiceDraft & { send: boolean } {
  const length = draft.text.length
  const clampTo = (value: number, max: number) => Math.max(0, Math.min(Number.isFinite(value) ? Math.floor(value) : max, max))

  if (result.edit) {
    const said = splitSendWord(result.heard)
    let text = result.edit.text
    let start = clampTo(result.edit.selectionStart, text.length)
    let end = clampTo(result.edit.selectionEnd, text.length)
    // A trailing send word the model left in the text is still an instruction, not content.
    const trailing = splitSendWord(text)
    if (said.send && trailing.send) {
      text = trailing.text
      start = Math.min(start, text.length)
      end = Math.min(end, text.length)
    }
    return { text, selectionStart: Math.min(start, end), selectionEnd: Math.max(start, end), send: said.send || trailing.send }
  }

  const { text: spoken, send } = splitSendWord(result.text)
  const start = clampTo(Math.min(draft.selectionStart, draft.selectionEnd), length)
  const end = clampTo(Math.max(draft.selectionStart, draft.selectionEnd), length)
  if (!spoken) return { text: draft.text, selectionStart: start, selectionEnd: end, send }
  const before = draft.text.slice(0, start)
  const after = draft.text.slice(end)
  const lead = before && !/\s$/.test(before) && WORDISH_END.test(before) && WORDISH_START.test(spoken) ? " " : ""
  const trail = after && !/^\s/.test(after) && WORDISH_START.test(after) && WORDISH_END.test(spoken) ? " " : ""
  const inserted = lead + spoken + trail
  const caret = before.length + lead.length + spoken.length
  return { text: before + inserted + after, selectionStart: caret, selectionEnd: caret, send }
}

/**
 * Reads a line aloud, if the machine has a voice for it.
 *
 * The OS speech engine, not a model: it is already installed, it costs nothing
 * and it starts speaking immediately, which is the whole point of a progress
 * line. Anything already being spoken is cut off - two overlapping progress
 * lines are worse than the newer one alone.
 */
export function speak(text: string, language: string): boolean {
  const line = text.trim()
  if (!line || typeof window.speechSynthesis === "undefined") return false
  try {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(line.slice(0, 240))
    utterance.lang = language
    window.speechSynthesis.speak(utterance)
    return true
  } catch {
    return false
  }
}

/** Stops whatever is being read aloud. */
export function hush(): void {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* A window with no speech engine has nothing to stop. */
  }
}
