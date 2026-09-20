/**
 * Round 17 (lane M): voice, sound and the media surfaces.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundSeventeenMediaChecks` with its own check and section. Nothing here
 * reaches the network or the reader's own files: the transcription and chat
 * endpoints are a fake server on 127.0.0.1, and every profile is a temporary
 * folder of its own.
 *
 * Sounds are checked by the shape of the figure they would synthesise - which
 * notes, when, how loud, how long - rather than by listening; the renderer's
 * `lib/sound.ts` is the one place that decides those.
 */
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Storage } from "../src/server/storage"
import { SessionStore } from "../src/server/session/store"
import { handle, voiceFileName, VOICE_PRECHECK_TIMEOUT_MS } from "../src/server/handlers"
import type { Runtime } from "../src/server/index"
import type { Request } from "../src/shared/protocol"
import { CONFIRM_VOICES, spineTone } from "../src/renderer/src/lib/sound"
import {
  MAX_SEGMENT_MS,
  MAX_SPEECH_LEVEL,
  MIN_SPEECH_LEVEL,
  SILENCE_MS,
  STATUS_SETTLE_MS,
  micFailure,
  precheckFailure,
  speechFloor,
} from "../src/renderer/src/lib/voice"
import { hushSpeech } from "../src/renderer/src/lib/voice"
import { followSpoken } from "../src/renderer/src/lib/speak-part"
import { nextTick, ref } from "vue"
import type { Message } from "../src/shared/protocol"
import { SpeakTool } from "../src/server/tool/speak"
import { PresentFilesTool } from "../src/server/tool/present"
import { WIDGET_FENCE } from "../src/shared/widget"
import { annotationsBlock } from "../src/shared/annotations"

/** One finished turn whose only part is a completed speak call, as the stream would hold it. */
function spokenTurn(callID: string, text: string): Message {
  return {
    id: `msg-${callID}`,
    sessionID: "probe",
    role: "assistant",
    time: { created: Date.now() },
    parts: [
      {
        type: "tool",
        callID,
        name: "speak",
        status: "completed",
        input: { text },
        metadata: { text },
        time: { created: Date.now(), completed: Date.now() },
      },
    ],
  } as unknown as Message
}

/** One fake OpenAI-compatible service: what it was asked, and what it answers. */
interface Fake {
  port: number
  /** Each request's path, so "which endpoint got the rewrite" is answerable. */
  seen: { path: string; model?: string; file?: string }[]
  /** Model ids the /models listing names; an empty list answers 404 instead. */
  models: string[]
  /** What /audio/transcriptions heard. */
  heard: string
  /** What /chat/completions replies with, or a status to fail with. */
  chat: string | number
  close(): Promise<void>
}

async function fakeVoiceService(options: { models?: string[]; heard?: string; chat?: string | number } = {}): Promise<Fake> {
  const state: Fake = {
    port: 0,
    seen: [],
    models: options.models ?? ["asr-1", "chat-1"],
    heard: options.heard ?? "hello there",
    chat: options.chat ?? "tidy line",
    close: async () => undefined,
  }
  const server = http.createServer((request, response) => {
    const url = request.url ?? ""
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (url.endsWith("/models")) {
        state.seen.push({ path: url })
        if (!state.models.length) {
          response.writeHead(404)
          response.end("{}")
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: state.models.map((id) => ({ id })) }))
        return
      }
      if (url.endsWith("/audio/transcriptions")) {
        // Multipart: the model is a field and the recording is a part with a file name.
        const model = /name="model"\r?\n\r?\n([^\r\n]+)/.exec(raw)?.[1]
        const file = /filename="([^"]+)"/.exec(raw)?.[1]
        state.seen.push({ path: url, model, file })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ text: state.heard }))
        return
      }
      if (url.endsWith("/chat/completions")) {
        const body = raw ? (JSON.parse(raw) as { model?: string }) : {}
        state.seen.push({ path: url, model: body.model })
        if (typeof state.chat === "number") {
          response.writeHead(state.chat)
          response.end("{}")
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ choices: [{ message: { content: state.chat } }] }))
        return
      }
      response.writeHead(404)
      response.end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  state.port = (server.address() as { port: number }).port
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return state
}

/** A backend with just the pieces the voice handlers read, on a throwaway profile. */
async function voiceRuntime(root: string, name: string, port: number, voiceModel = "asr-1") {
  const dir = path.join(root, name)
  const project = path.join(dir, "project")
  await fs.mkdir(project, { recursive: true })
  const storage = new Storage(path.join(dir, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(dir, "credentials.json"))
  await config.load()
  await config.set({
    customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "asr-1", name: "ASR" }, { id: "chat-1", name: "Chat" }] }],
    directory: project,
    model: { provider: "fake", model: "chat-1" },
    voiceModel: { provider: "fake", model: voiceModel },
  })
  await config.setApiKey("fake", "k")
  const sessions = new SessionStore(storage, bus)
  const runtime = { storage, bus, config, sessions } as unknown as Runtime
  return { runtime, config, sessions, project }
}

/** Two seconds of silence in a WebM container is not needed: the fake reads the part, not the bytes. */
const AUDIO = Buffer.from("not really audio").toString("base64")

const ask = (runtime: Runtime, request: Request) => handle(runtime, request)

export async function roundSeventeenMediaChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round17m-"))

  // ---------------------------------------------------------------- R17-M1
  section("Round 17 (M1): 智能编辑 rewrites with the conversation's model, and says so when it cannot")
  {
    const service = await fakeVoiceService({ heard: "把左边改成右边", chat: JSON.stringify({ before: "右边", after: "" }) })
    try {
      const { runtime, sessions, project } = await voiceRuntime(root, "m1", service.port)
      const session = await sessions.create({ directory: project, model: { provider: "fake", model: "chat-1" } })
      const answer = (await ask(runtime, {
        type: "voice.transcribe",
        audio: AUDIO,
        mime: "audio/webm;codecs=opus",
        mode: "smart",
        draft: { text: "左边", selectionStart: 2, selectionEnd: 2 },
        sessionID: session.id,
      })) as { text: string; edit?: unknown; editFailed?: string }

      const transcribed = service.seen.find((entry) => entry.path.endsWith("/audio/transcriptions"))
      const rewritten = service.seen.find((entry) => entry.path.endsWith("/chat/completions"))
      check("the recording still goes to the voice model", transcribed?.model === "asr-1", transcribed)
      check("but the rewrite goes to the conversation's model, not the voice one", rewritten?.model === "chat-1", rewritten)
      check("and it came back as an edit", Boolean(answer.edit) && !answer.editFailed, answer)
      // The bug this replaces: an ASR model with no /chat/completions silently became 快速输入.
      check("the multipart file name follows the container that was recorded", transcribed?.file === "speech.webm", transcribed)
    } finally {
      await service.close()
    }

    check("an Ogg recording is named .ogg, not .webm", voiceFileName("audio/ogg;codecs=opus") === "speech.ogg")
    check("an MP4 one is named .mp4", voiceFileName("audio/mp4") === "speech.mp4")
    check("an unknown container still gets a name", voiceFileName("audio/weird") === "speech.webm")

    /* The refusal path: the chat endpoint turns the rewrite down. */
    const refusing = await fakeVoiceService({ heard: "just words", chat: 404 })
    try {
      const { runtime, sessions, project } = await voiceRuntime(root, "m1b", refusing.port)
      const session = await sessions.create({ directory: project, model: { provider: "fake", model: "chat-1" } })
      const answer = (await ask(runtime, {
        type: "voice.transcribe",
        audio: AUDIO,
        mime: "audio/webm",
        mode: "smart",
        draft: { text: "", selectionStart: 0, selectionEnd: 0 },
        sessionID: session.id,
      })) as { text: string; editFailed?: string }
      check("a refused rewrite still types the words in", answer.text === "just words", answer)
      check("and names the failure instead of passing itself off as 快速输入", answer.editFailed === "refused", answer)
    } finally {
      await refusing.close()
    }

    /* An answer that is not an edit at all. */
    const babbling = await fakeVoiceService({ heard: "just words", chat: "I'm afraid I can't do that" })
    try {
      const { runtime, sessions, project } = await voiceRuntime(root, "m1c", babbling.port)
      const session = await sessions.create({ directory: project, model: { provider: "fake", model: "chat-1" } })
      const answer = (await ask(runtime, {
        type: "voice.transcribe",
        audio: AUDIO,
        mime: "audio/webm",
        mode: "smart",
        draft: { text: "", selectionStart: 0, selectionEnd: 0 },
        sessionID: session.id,
      })) as { editFailed?: string }
      check("an answer that is not an edit is reported as unreadable", answer.editFailed === "unreadable", answer)
    } finally {
      await babbling.close()
    }
  }

  // ---------------------------------------------------------------- R17-M2
  section("Round 17 (M2): a waiting confirmation has a sound of its own")
  {
    /*
     * The figure, not the sound: each note is an oscillator with a pitch, a
     * start, a length and a gain, and what MiMo's pair is measured to be is
     * E5 then A5 0.16 s later, the second longer and a little louder.
     */
    const fundamentals = CONFIRM_VOICES.filter((_, index) => index % 2 === 0)
    check("it is two struck notes, each with its own partial", CONFIRM_VOICES.length === 4, CONFIRM_VOICES.length)
    check("the first is E5", Math.abs(fundamentals[0].from - 659.25) < 0.01, fundamentals[0])
    check("the second is A5", Math.abs(fundamentals[1].from - 880) < 0.01, fundamentals[1])
    check("and lands 0.16s after it, as MiMo's does", Math.abs(fundamentals[1].at - 0.16) < 1e-9 && fundamentals[0].at === 0, fundamentals.map((voice) => voice.at))
    check("the second rings longer: 1.1s then 1.4s", fundamentals[0].seconds === 1.1 && fundamentals[1].seconds === 1.4, fundamentals.map((voice) => voice.seconds))
    check("and a little louder, in MiMo's 0.85 : 1 ratio", Math.abs(fundamentals[0].gain / fundamentals[1].gain - 0.85) < 1e-9, fundamentals.map((voice) => voice.gain))
    check("every note is audible - a gain of zero would be the silence this replaces", fundamentals.every((voice) => voice.gain > 0))
    check("and none of it outlasts two seconds", CONFIRM_VOICES.every((voice) => voice.at + voice.seconds <= 2))
  }

  // ---------------------------------------------------------------- R17-M9
  section("Round 17 (M9): the conversation navigator's scale spans what MiMo's does")
  {
    const count = 40
    const first = spineTone(0, count)
    const last = spineTone(count - 1, count)
    check("the lowest tick is C3, an octave under the scale table", Math.abs(first.from - 130.815) < 0.01, first.from)
    check("the highest is G6", Math.abs(last.from - 1568) < 0.01, last.from)
    const octaves = Math.log2(last.from / first.from)
    check("which is about three and a half octaves, not two", octaves > 3.4 && octaves < 3.7, octaves)
    check("hovering is 0.13 and 0.42s", first.gain === 0.13 && first.seconds === 0.42, first)
    const pressed = spineTone(0, count, true)
    check("pressing is 0.3 and 0.9s", pressed.gain === 0.3 && pressed.seconds === 0.9, pressed)
    check("the note is the same either way; only how it is struck changes", pressed.from === first.from && pressed.type === "triangle")
    check("a lone turn takes the bottom note rather than dividing by zero", Number.isFinite(spineTone(0, 1).from) && spineTone(0, 1).from === first.from)
    /* It has to climb: a scale that repeats one note would pass every check above but say nothing. */
    const run = Array.from({ length: count }, (_, at) => spineTone(at, count).from)
    check("and every tick is at least as high as the one before it", run.every((value, at) => at === 0 || value >= run[at - 1]), run)
    check("with more distinct pitches than the five the table holds", new Set(run).size > 5, new Set(run).size)
  }

  // ---------------------------------------------------------------- R17-M4
  section("Round 17 (M4): the microphone is not opened when the service is not going to answer")
  {
    const service = await fakeVoiceService()
    try {
      const { runtime, sessions, project } = await voiceRuntime(root, "m4", service.port)
      const session = await sessions.create({ directory: project, model: { provider: "fake", model: "chat-1" } })
      const ready = (await ask(runtime, { type: "voice.precheck", mode: "smart", sessionID: session.id })) as { ok: boolean }
      check("a service that lists the chosen model is fine", ready.ok === true, ready)

      /* The model the setting names is not one the provider offers. */
      service.models = ["something-else"]
      const missing = (await ask(runtime, { type: "voice.precheck", mode: "smart", sessionID: session.id })) as { ok: boolean; reason?: string }
      check("a model the provider does not list is named before recording", missing.ok === false && missing.reason === "asrUnavailable", missing)

      /* A listing that is not offered at all says nothing either way, and recording goes ahead. */
      service.models = []
      const silent = (await ask(runtime, { type: "voice.precheck", mode: "smart", sessionID: session.id })) as { ok: boolean }
      check("a provider with no model listing is not refused on a guess", silent.ok === true, silent)
    } finally {
      await service.close()
    }

    /* Offline: nothing is listening on that port at all. */
    {
      const dead = await fakeVoiceService()
      const port = dead.port
      await dead.close()
      const { runtime } = await voiceRuntime(root, "m4b", port)
      const started = Date.now()
      const gone = (await ask(runtime, { type: "voice.precheck", mode: "fast" })) as { ok: boolean; reason?: string }
      check("an endpoint that is not there is 'unreachable', not a dozen toasts later", gone.ok === false && gone.reason === "unreachable", gone)
      check("and the answer comes back inside the probe's own budget", Date.now() - started < VOICE_PRECHECK_TIMEOUT_MS + 3_000, Date.now() - started)
    }

    /* 智能编辑 with nothing to rewrite with. */
    {
      const service2 = await fakeVoiceService()
      try {
        const { runtime, config } = await voiceRuntime(root, "m4c", service2.port)
        await config.set({ model: { provider: "nothing-here", model: "gone" } })
        const answer = (await ask(runtime, { type: "voice.precheck", mode: "smart" })) as { ok: boolean; reason?: string }
        check("智能编辑 with no conversation model is refused as chatUnavailable", answer.ok === false && answer.reason === "chatUnavailable", answer)
        const quick = (await ask(runtime, { type: "voice.precheck", mode: "fast" })) as { ok: boolean }
        check("while 快速输入, which needs no rewrite, still goes ahead", quick.ok === true, quick)
      } finally {
        await service2.close()
      }
    }

    check("each of the five kinds has a line of its own", new Set((["unauthorized", "asrUnavailable", "chatUnavailable", "unreachable", "failed"] as const).map((reason) => precheckFailure(reason).key)).size === 5)
    check("and none of them falls through to the plain voice failure", (["unauthorized", "asrUnavailable", "chatUnavailable", "unreachable"] as const).every((reason) => precheckFailure(reason).key !== "voice.failed"))
  }

  // ---------------------------------------------------------------- R17-M5
  section("Round 17 (M5): where one stretch of speech ends")
  {
    check("快速输入 cuts at 0.8s, as MiMo does", SILENCE_MS.fast === 800, SILENCE_MS)
    check("智能编辑 waits 1.2s, where a pause is often part of the instruction", SILENCE_MS.smart === 1_200, SILENCE_MS)
    check("no stretch runs past a minute, whatever the speaker does", MAX_SEGMENT_MS === 60_000, MAX_SEGMENT_MS)

    /*
     * The line is drawn against the room rather than at a fixed height: 0.06
     * sat below a noisy room's own level, and then no cut was ever made.
     */
    check("a silent room is still held to a floor, so breathing is not speech", speechFloor(0) === MIN_SPEECH_LEVEL, speechFloor(0))
    check("a quiet room lowers the line under the old fixed 0.06", speechFloor(0.004) < 0.06, speechFloor(0.004))
    check("a noisy room raises it above its own level", speechFloor(0.05) > 0.05, speechFloor(0.05))
    check("and a room louder than any voice is held to a ceiling", speechFloor(5) === MAX_SPEECH_LEVEL, speechFloor(5))
    check("the line always rises with the room", [0, 0.01, 0.03, 0.06].every((noise, at, all) => at === 0 || speechFloor(noise) >= speechFloor(all[at - 1])))
    check("nothing unmeasurable gets past it", speechFloor(Number.NaN) === MIN_SPEECH_LEVEL && speechFloor(-1) === MIN_SPEECH_LEVEL)

    check("a level meter that will not start is a named failure, not a silent recording", micFailure(new Error("voice.vadFailed")).key === "voice.vadFailed")
  }

  // ---------------------------------------------------------------- R17-M3
  section("Round 17 (M3): the capsule says what is happening to the stretch in hand")
  {
    /* Nine words, each with a line in every table - the capsule used to have three. */
    const words = ["starting", "listening", "recording", "transcribing", "understanding", "transcribed", "understood", "noContent", "failed"]
    const table = await fs.readFile(new URL("../src/renderer/src/lib/i18n.ts", import.meta.url), "utf8")
    const tables = table.match(/^const [A-Za-z0-9]+: Table = \{/gm)?.length ?? 0
    check("there are eighteen language tables to fill", tables === 18, tables)
    for (const word of words) {
      const found = table.match(new RegExp(`^  "voice\\.${word}": `, "gm"))?.length ?? 0
      check(`voice.${word} is in every one of them`, found === tables, { word, found })
    }
    check("an outcome gives way to waiting again after two seconds, as MiMo holds it", STATUS_SETTLE_MS === 2_000, STATUS_SETTLE_MS)
  }

  // ---------------------------------------------------------------- R17-M6
  section("Round 17 (M6): what the two tool descriptions claim")
  {
    const said = SpeakTool.description
    check("speak no longer states the user asked for narration as a fact", !/^.*The user has asked to be kept up to date/m.test(said), said.slice(0, 160))
    check("it makes the call conditional on their having asked in the conversation", /only when the user has asked/i.test(said), said.slice(0, 200))
    check("and says the setting is permission rather than a request", /permission to speak, not a request/i.test(said))

    const presents = PresentFilesTool.description
    check("present_files names the fence a demonstration belongs in", presents.includes(WIDGET_FENCE), presents)
    check("and says not to write it to a file or hand it over", /Do not write it to a file, and do not hand it over/i.test(presents))
    check("while still allowing a page that is genuinely the deliverable", /page, a site or an app as the thing they are given/i.test(presents))
  }

  // ---------------------------------------------------------------- R17-M8
  section("Round 17 (M8): a line being read aloud can be cut off")
  {
    /*
     * The OS speech engine reads to the end of the sentence unless it is told
     * not to, and the only `cancel` in the app was the one at the start of the
     * next line - so 停止, leaving the conversation and switching the feature
     * off all left the machine talking. Driven here over a stub of the engine.
     */
    const engine = { spoken: [] as string[], cancels: 0 }
    const held = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      speechSynthesis: {
        cancel: () => engine.cancels++,
        speak: (utterance: { text: string }) => engine.spoken.push(utterance.text),
      },
    }
    ;(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = class {
      lang = ""
      constructor(public text: string) {}
    }
    try {
      const session = ref<string | undefined>("one")
      const on = ref(true)
      const messages = ref<Message[]>([])
      followSpoken({ enabled: () => on.value, session: () => session.value, messages: () => messages.value })
      messages.value = [spokenTurn("call-1", "starting now")]
      await nextTick()
      check("a completed speak call is read aloud", engine.spoken.includes("starting now"), engine.spoken)

      const beforeSwitch = engine.cancels
      session.value = "two"
      await nextTick()
      check("leaving the conversation cuts the line off", engine.cancels > beforeSwitch, { beforeSwitch, now: engine.cancels })

      const beforeOff = engine.cancels
      on.value = false
      await nextTick()
      check("and so does switching voice feedback off", engine.cancels > beforeOff, { beforeOff, now: engine.cancels })

      const quiet = engine.spoken.length
      messages.value = [spokenTurn("call-2", "still going")]
      await nextTick()
      check("with the feature off nothing new is said", engine.spoken.length === quiet, engine.spoken)

      /* 停止: the store's abort hushes before it even reaches the socket. */
      const beforeStop = engine.cancels
      hushSpeech()
      check("hushSpeech, which 停止 calls, reaches the engine", engine.cancels > beforeStop)
    } finally {
      if (held === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = held
      delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
    }
  }

  // ---------------------------------------------------------------- R17-M7
  section("Round 17 (M7): a boxed part of a picture is something the model is told about")
  {
    const note = {
      id: "ann-1",
      kind: "image" as const,
      path: "/pictures/plot.png",
      name: "plot.png",
      region: { fx: 0.25, fy: 0.1, fw: 0.5, fh: 0.4 },
      text: "the axis here is wrong",
    }
    const block = annotationsBlock([note])
    check("the file is named", block.includes("/pictures/plot.png"), block)
    check("with the boxed part of it as percentages of the picture", /25%, 10%\) to \(75%, 50%\)/.test(block), block)
    check("and the note under it", block.includes("the axis here is wrong"), block)
    /* Without the kind in the union this would have fallen through to "a passage of an earlier reply". */
    check("it is not mistaken for a passage of a reply", !block.includes("earlier assistant reply"), block)

    const whole = annotationsBlock([{ ...note, region: undefined }])
    check("a picture pointed at with no box still names the file", whole.includes("/pictures/plot.png") && !whole.includes("region"), whole)

    const preview = await fs.readFile(new URL("../src/renderer/src/components/ImagePreview.vue", import.meta.url), "utf8")
    check("the preview has a mode that boxes rather than pans", preview.includes('data-preview-tool="annotate"'), preview.length)
    check("and draws the box inside the transform, so it follows the zoom and the turn", preview.includes('data-image-box'))
  }
}
