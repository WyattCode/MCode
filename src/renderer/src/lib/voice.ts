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

import { ref } from "vue"
import type { VoiceDraft, VoiceEdit, VoiceMode, VoicePrecheckFailure } from "@shared/protocol"

/**
 * Where one stretch of speech ends: this long without a voice in it.
 *
 * MiMo has no ceiling on a recording at all. It cuts on silence instead and
 * writes each piece down while the microphone stays open, so a long dictation
 * appears in the box as it is spoken. This used to record whole and stop itself
 * after a minute, which cut a long message off in the middle of a sentence.
 *
 * The two waits are MiMo's own: 1.2 s in 智能编辑, where a pause is often part of
 * an instruction, and 0.8 s in 快速输入, where the point is to see the words
 * quickly. MCode waited 1.2 s in both, so quick input was 0.4 s slower than the
 * reference at every cut.
 */
export const SILENCE_MS: Record<VoiceMode, number> = { smart: 1_200, fast: 800 }

/**
 * The longest one stretch may run, MiMo's `maxSegmentS = 60`.
 *
 * Someone who talks for five minutes without a pause long enough to cut on
 * used to get nothing written down until they pressed stop; this cuts anyway.
 */
export const MAX_SEGMENT_MS = 60_000

/*
 * Above this the microphone is hearing a voice rather than the room.
 *
 * MiMo runs a voice-activity detector over each 16 kHz frame; MCode has no such
 * model and does not add one, so the line is drawn against the room instead of
 * at a fixed height. The first third of a second after the microphone opens is
 * the room: whatever it measures, a voice is several times louder than that.
 * A single number - 0.06 - used to sit below a noisy room's own level, and then
 * no cut was ever made and the whole dictation waited for the stop button.
 */
export const FLOOR_SAMPLE_MS = 300
const FLOOR_FACTOR = 3.5
/** Held between these: a silent room must not make every breath a word, and a loud one must still be speakable over. */
export const MIN_SPEECH_LEVEL = 0.02
export const MAX_SPEECH_LEVEL = 0.25
/**
 * Speech ends a little below where it starts, so one wavering syllable does not
 * cut a sentence in two. MiMo's detector opens at 0.8 and closes at 0.7, which
 * is this ratio.
 */
const END_RATIO = 0.875

/** The level a voice has to pass, given how loud the room was found to be. */
export function speechFloor(noise: number): number {
  const measured = Number.isFinite(noise) ? Math.max(0, noise) * FLOOR_FACTOR : MIN_SPEECH_LEVEL
  return Math.max(MIN_SPEECH_LEVEL, Math.min(MAX_SPEECH_LEVEL, measured))
}

/* How often the level is read while looking for the end of a stretch. */
const WATCH_MS = 50
/* No cut is made before this much has been recorded: a container needs a moment of audio to be readable. */
const MIN_SEGMENT_MS = 700

/**
 * What the recorder is doing, for a button that has to say so: pressed and
 * waiting for the microphone, listening, or having it written down.
 */
export type VoiceState = "idle" | "starting" | "recording" | "working"

/**
 * And what is happening to one stretch inside that, which is what MiMo's
 * capsule actually says: waiting for a voice, hearing one, writing it down or
 * understanding it, and how that ended.
 *
 * MCode's capsule read 录音中 for the whole recording, so none of the work
 * going on behind it - a stretch being transcribed while the next is spoken -
 * was visible.
 */
export type VoiceStatus = "listening" | "recording" | "transcribing" | "understanding" | "transcribed" | "understood" | "noContent" | "failed"

/** The four that are an outcome rather than a state; each shows briefly and gives way to waiting again. */
const SETTLED: readonly VoiceStatus[] = ["transcribed", "understood", "noContent", "failed"]

/** How long an outcome stays on the capsule before it goes back to waiting, as MiMo holds it. */
export const STATUS_SETTLE_MS = 2_000

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
  private watch?: number
  private audio?: AudioContext
  private analyser?: AnalyserNode
  private samples?: Uint8Array<ArrayBuffer>
  private smoothed = 0
  /** The container every stretch of this session is recorded in, chosen once. */
  private mime?: string
  /** Set for as long as the microphone is open, across the cuts between stretches. */
  private active = false
  /** Whether this stretch has heard a voice at all - silence alone is not worth writing down. */
  private spoke = false
  private quietSince = 0
  /** True while a cut is being made, so the watcher does not start a second one on top of it. */
  private cutting = false
  /** How long to wait for silence before cutting, from the mode this recording was started in. */
  private silenceMs = SILENCE_MS.smart
  /** The room, measured over the first `FLOOR_SAMPLE_MS`: the readings, then the level they set. */
  private floorUntil = 0
  private floorReadings: number[] = []
  private speechLevel = MIN_SPEECH_LEVEL
  /** Whether a voice is being heard right now, so the capsule can say which. */
  private speaking = false

  /** Told each time a voice starts or stops, so the capsule can show waiting and hearing apart. */
  onActive?: (speaking: boolean) => void

  /**
   * Each stretch of speech, as soon as the silence after it ends it.
   *
   * The microphone stays open: the caller writes this one down while the next
   * is still being spoken, which is what lets a long dictation appear in the
   * box as it is said rather than all at once at the end.
   */
  onSegment?: (recording: Recording) => void

  get running(): boolean {
    return this.active
  }

  /**
   * How loud the microphone is right now, 0 to 1, smoothed between readings.
   *
   * Read once per animation frame by the capsule's waveform. Zero whenever
   * nothing is recording, or when the machine offers no audio analysis.
   */
  get level(): number {
    const rms = this.rms()
    if (rms === undefined) return 0
    this.smoothed = this.smoothed * LEVEL_SMOOTHING + Math.min(1, rms * LEVEL_GAIN) * (1 - LEVEL_SMOOTHING)
    return this.smoothed
  }

  /** The unsmoothed loudness, which is what deciding where a stretch ends has to read. */
  private rms(): number | undefined {
    const analyser = this.analyser
    const samples = this.samples
    if (!analyser || !samples || !this.active) return undefined
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) {
      const centred = (sample - 128) / 128
      sum += centred * centred
    }
    return Math.sqrt(sum / samples.length)
  }

  /**
   * Opens the microphone and starts recording.
   *
   * Throws rather than returning a flag: refusing a microphone is something the
   * reader must be told about, and the message the browser gives - a denied
   * permission, no device at all - is the useful part.
   */
  async start(mode: VoiceMode = "smart"): Promise<void> {
    if (this.running) return
    const mime = bestFormat()
    if (!mime) throw new Error("voice.noRecorder")
    /*
     * The three constraints MiMo asks for. One channel because the recording is
     * downmixed anyway; the other two because a room's own noise and the
     * machine's own speakers are exactly what makes the level meter below
     * useless, and Chromium will do both in the capture pipeline for free.
     */
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    this.stream = stream
    this.mime = mime
    this.silenceMs = SILENCE_MS[mode] ?? SILENCE_MS.smart
    this.active = true
    /*
     * Without the level meter nothing can be cut on silence: the whole
     * dictation would wait for the stop button and a minute of it would be
     * thrown away by the cap below. MiMo refuses to record when its detector
     * will not start, and so does this, rather than recording into a mode that
     * no longer works.
     */
    if (!this.listen(stream)) {
      this.release()
      this.active = false
      throw new Error("voice.vadFailed")
    }
    this.speaking = false
    this.floorUntil = Date.now() + FLOOR_SAMPLE_MS
    this.floorReadings = []
    this.speechLevel = MIN_SPEECH_LEVEL
    this.begin()
    this.watch = window.setInterval(() => this.tick(), WATCH_MS)
  }

  /** One stretch: its own recorder run, so every piece handed out is a whole, readable file. */
  private begin() {
    const stream = this.stream
    if (!stream || !this.mime) return
    this.chunks = []
    this.startedAt = Date.now()
    this.spoke = false
    this.quietSince = 0
    const recorder = new MediaRecorder(stream, { mimeType: this.mime })
    recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data)
    }
    recorder.start()
    this.recorder = recorder
  }

  /** Whether a voice is being heard at this moment, for a capsule that says which. */
  get hearing(): boolean {
    return this.speaking
  }

  /** The level a voice has to pass right now, once the room has been measured. */
  get threshold(): number {
    return this.speechLevel
  }

  private setSpeaking(speaking: boolean) {
    if (this.speaking === speaking) return
    this.speaking = speaking
    this.onActive?.(speaking)
  }

  /** Watches for the silence that ends a stretch, and cuts there. */
  private tick() {
    if (!this.active || this.cutting) return
    const rms = this.rms()
    if (rms === undefined) return
    const now = Date.now()
    /* The room first: until it has been measured nothing counts as a voice. */
    if (now < this.floorUntil) {
      this.floorReadings.push(rms)
      return
    }
    if (this.floorReadings.length) {
      this.speechLevel = speechFloor(this.floorReadings.reduce((sum, value) => sum + value, 0) / this.floorReadings.length)
      this.floorReadings = []
    }
    /* A stretch that has run on past the cap is cut wherever it is, as MiMo cuts it. */
    if (this.spoke && now - this.startedAt >= MAX_SEGMENT_MS) return void this.cut()
    if (rms >= (this.speaking ? this.speechLevel * END_RATIO : this.speechLevel)) {
      this.spoke = true
      this.quietSince = 0
      this.setSpeaking(true)
      return
    }
    this.setSpeaking(false)
    if (!this.spoke) return
    if (!this.quietSince) {
      this.quietSince = now
      return
    }
    if (now - this.quietSince < this.silenceMs || now - this.startedAt < MIN_SEGMENT_MS) return
    void this.cut()
  }

  private async cut() {
    this.cutting = true
    try {
      const spoke = this.spoke
      const recording = await this.finish()
      if (!this.active) return
      this.setSpeaking(false)
      if (recording && spoke) this.onSegment?.(recording)
      this.begin()
    } finally {
      this.cutting = false
    }
  }

  /** Closes the current run and returns what it caught; the microphone is left open. */
  private async finish(): Promise<Recording | undefined> {
    const recorder = this.recorder
    if (!recorder) return undefined
    this.recorder = undefined
    const ms = Date.now() - this.startedAt
    if (recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
        recorder.stop()
      })
    }
    const blob = new Blob(this.chunks, { type: recorder.mimeType })
    this.chunks = []
    if (!blob.size) return undefined
    return { audio: await base64Of(blob), mime: recorder.mimeType, ms }
  }

  /* The level meter, which is both the waveform and the thing that decides where a stretch ends. */
  private listen(stream: MediaStream): boolean {
    try {
      const audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      audio.createMediaStreamSource(stream).connect(analyser)
      this.audio = audio
      this.analyser = analyser
      this.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      this.smoothed = 0
      return true
    } catch {
      this.audio = undefined
      this.analyser = undefined
      this.samples = undefined
      return false
    }
  }

  /** Stops, releases the microphone, and hands back the last stretch - the earlier ones already went to `onSegment`. */
  async stop(): Promise<Recording | undefined> {
    if (!this.active) return undefined
    this.active = false
    if (this.watch) window.clearInterval(this.watch)
    this.watch = undefined
    const recording = await this.finish()
    this.release()
    return recording
  }

  /** Throws the recording away and shuts the microphone. */
  cancel(): void {
    this.active = false
    if (this.watch) window.clearInterval(this.watch)
    this.watch = undefined
    const recorder = this.recorder
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null
      recorder.stop()
    }
    this.recorder = undefined
    this.chunks = []
    this.release()
  }

  private release() {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    this.recorder = undefined
    this.mime = undefined
    this.spoke = false
    this.quietSince = 0
    this.speaking = false
    this.floorReadings = []
    this.floorUntil = 0
    void this.audio?.close().catch(() => {})
    this.audio = undefined
    this.analyser = undefined
    this.samples = undefined
    this.smoothed = 0
  }
}

/**
 * A voice failure as the composer shows it: one danger toast worded by `key`,
 * optionally with the failure's own words under it, and whether MiMo's guide
 * to the OS microphone settings follows.
 */
export interface VoiceFailure {
  key: string
  params?: Record<string, string>
  detail?: string
  guide?: boolean
}

function nameOf(err: unknown): string {
  return err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : ""
}

function messageOf(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message)
  return String(err)
}

/** A microphone that would not open, sorted as MiMo sorts getUserMedia's errors. */
export function micFailure(err: unknown): VoiceFailure {
  const name = nameOf(err)
  const message = messageOf(err)
  if (message === "voice.noRecorder") return { key: "voice.noRecorder" }
  if (message === "voice.vadFailed") return { key: "voice.vadFailed" }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return { key: "voice.micDenied", guide: true }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return { key: "voice.micNotFound" }
  // The device exists but would not start: another program holds it.
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return { key: "voice.micInUse" }
  return { key: "voice.micAccessFailed", params: { msg: message || name } }
}

/**
 * Why the microphone was not opened, from the pre-recording check.
 *
 * MiMo's five kinds each get their own line; the point of asking before the
 * microphone opens is that the reader is told now rather than after speaking a
 * sentence into an endpoint that was never going to answer.
 */
const PRECHECK_KEYS: Record<VoicePrecheckFailure, string> = {
  unauthorized: "voice.loginRequired",
  asrUnavailable: "voice.asrUnavailable",
  chatUnavailable: "voice.controlUnavailable",
  unreachable: "voice.networkUnreachable",
  failed: "voice.startFailed",
}

export function precheckFailure(reason: VoicePrecheckFailure): VoiceFailure {
  return { key: PRECHECK_KEYS[reason] ?? "voice.startFailed" }
}

/** A transcription that failed, from the code the server threw, as MiMo names it. */
export function transcribeFailure(err: unknown): VoiceFailure {
  const message = messageOf(err)
  const http = /voice\.http:(\d{3})/.exec(message)
  if (http) return { key: "voice.serviceHttp", params: { status: http[1] } }
  const named: [string, string][] = [
    ["voice.notConfigured", "voice.notConfigured"],
    ["voice.noEndpoint", "voice.noEndpoint"],
    ["voice.timeout", "voice.timeout"],
    ["voice.network", "voice.networkUnreachable"],
    ["voice.modelUnavailable", "voice.modelUnavailable"],
    ["voice.emptyResult", "voice.emptyResult"],
  ]
  for (const [code, key] of named) if (message.includes(code)) return { key }
  // MiMo's default is its plain voice failure; the words that came with it are kept underneath.
  return { key: "voice.failed", detail: message }
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

/*
 * MiMo's spoken clear in quick input: a short utterance that is nothing but one
 * of these words, punctuation and spaces aside, empties the box instead of
 * being typed into it.
 */
const CLEAR_WORDS = /^(清空|清除|清空输入|删掉重来|重写)$/

export function isClearCommand(text: string): boolean {
  const bare = text.replace(/[。.!！?？,，、\s]/g, "")
  return bare.length <= 12 && CLEAR_WORDS.test(bare)
}

/** The three results MiMo's composer names for a spoken command. */
export type VoiceCue = "sent" | "cleared" | "rewritten"

/*
 * What a smart-edit answer did to the box: nothing to say if it left the text
 * as it was, "cleared" if nothing is left, "rewritten" otherwise. A send is
 * named by whoever sends, since it outranks either.
 */
export function editCue(before: string, after: string, edited: boolean): VoiceCue | undefined {
  if (!edited || before === after) return undefined
  return after.trim() ? "rewritten" : "cleared"
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

/**
 * The one microphone, and which box has it.
 *
 * Several boxes are mounted at once - the dock's, the side panel's chat, the
 * home screen's - and each used to hold a recorder of its own, so pressing the
 * microphone in one and then in another opened two captures of the same device.
 * MiMo keeps the recording in one place with an owner beside it: pressing in
 * the box that owns it stops it, pressing in another stops that one first and
 * starts here.
 */
export const recorder = new VoiceRecorder()

/** The box holding the microphone, by the id its component was given; nothing when it is free. */
export const voiceOwner = ref<string | undefined>(undefined)

let boxes = 0

/** One id per mounted box, so ownership can be compared without the components knowing each other. */
export function nextVoiceBox(): string {
  boxes += 1
  return `composer-${boxes}`
}

/** What the microphone is doing. Only the owner draws it. */
export const voiceState = ref<VoiceState>("idle")

/**
 * What is happening to the stretch of speech in hand, which is what the capsule
 * says while `voiceState` is "recording". Nothing while the microphone is shut.
 */
export const voiceStatus = ref<VoiceStatus | undefined>(undefined)

let settle: ReturnType<typeof setTimeout> | undefined

/**
 * Sets it, and - for the four that are outcomes rather than states - puts the
 * capsule back to waiting two seconds later, as MiMo does, since the microphone
 * is still open and the next sentence can start at any moment.
 */
export function reportVoiceStatus(status: VoiceStatus | undefined): void {
  clearTimeout(settle)
  settle = undefined
  voiceStatus.value = status
  if (!status || !SETTLED.includes(status)) return
  settle = setTimeout(() => {
    if (voiceStatus.value === status) voiceStatus.value = "listening"
  }, STATUS_SETTLE_MS)
}

/** Bumped whenever a recording is abandoned, so a transcription already on its way lands nowhere. */
export const voiceRun = ref(0)

/** Drops whatever is being recorded or written down, wherever it is. */
export function dropVoice(): void {
  voiceRun.value += 1
  recorder.onSegment = undefined
  recorder.onActive = undefined
  recorder.cancel()
  voiceState.value = "idle"
  reportVoiceStatus(undefined)
  voiceOwner.value = undefined
}

