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

/** The longest single recording. A minute of speech is already a long message. */
const MAX_MS = 60_000

/** What the recorder is doing, for a button that has to say so. */
export type VoiceState = "idle" | "recording" | "working"

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

export class VoiceRecorder {
  private recorder?: MediaRecorder
  private stream?: MediaStream
  private chunks: Blob[] = []
  private startedAt = 0
  private timer?: number

  get running(): boolean {
    return this.recorder?.state === "recording"
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
    /* A recording nobody stopped stops itself, rather than holding the
       microphone open for as long as the window is left alone. */
    this.timer = window.setTimeout(() => void this.stop().catch(() => {}), MAX_MS)
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
