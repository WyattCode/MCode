/**
 * Speech to text, on this machine or on a provider.
 *
 * The window records and sends the bytes; what turns them into words is this
 * module. Two engines, picked by what the configuration holds:
 *
 *  - `local` - faster-whisper in the Python that ships beside this project. No
 *    key, no network, and the one that works when the providers on the network
 *    are chat-only endpoints (which is the usual local-inference setup).
 *  - `provider` - any OpenAI-compatible `/audio/transcriptions` endpoint, the
 *    same call the desktop has always made.
 *
 * Neither is assumed: `voice.precheck` answers with which one will run, so the
 * window can say "no model" before it opens the microphone.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"

/** The recording's extension, from the mime the window sent. */
function extensionFor(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes("wav")) return ".wav"
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3"
  if (m.includes("ogg") || m.includes("opus")) return ".ogg"
  if (m.includes("webm")) return ".webm"
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return ".m4a"
  return ".m4a"
}

/**
 * The Python that has faster-whisper in it.
 *
 * `MCODE_ASR_PYTHON` wins when set; otherwise the interpreter this machine
 * already has the package in. A missing interpreter or a missing package is
 * not an error here - it is how `local` is reported as unavailable.
 */
async function localPython(): Promise<string | undefined> {
  const candidates = [
    process.env.MCODE_ASR_PYTHON,
    path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python311", "python.exe"),
    path.join(os.homedir(), ".workbuddy", "binaries", "python", "envs", "default", "Scripts", "python.exe"),
    "/usr/bin/python3",
    "/usr/local/bin/python3",
  ].filter((entry): entry is string => Boolean(entry))
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/** True when this machine can transcribe locally: the interpreter and the package are both there. */
export async function localAsrAvailable(): Promise<boolean> {
  const python = await localPython()
  if (!python) return false
  return new Promise((resolve) => {
    execFile(python, ["-c", "import faster_whisper"], { timeout: 15_000 }, (err) => resolve(!err))
  })
}

/** The model `local` uses: the configured one, or base - the size this machine has cached. */
export function localModelName(configured?: { provider: string; model: string }): string {
  if (configured?.provider === "local" && configured.model) return configured.model
  return process.env.MCODE_ASR_MODEL ?? "base"
}

/*
 * The worker, kept alive between recordings.
 *
 * Spawning Python per utterance cost ten to fifteen seconds: the interpreter
 * boot, the imports, and loading the weights, for every sentence. Held open,
 * the weights load once and a recording costs only the transcribe itself.
 *
 * The protocol is one JSON object per line in, one per line out. Input is an
 * absolute path to a temp file (the audio) plus the model and language; output
 * is `{text}` or `{error}`. Nothing is shared with the main process beyond the
 * pipe, so a crash costs one recording rather than the gateway.
 */
const WORKER_SCRIPT = `
import json, sys, os
from faster_whisper import WhisperModel

model = None
loaded_name = None

def load(name):
    global model, loaded_name
    if model is None or loaded_name != name:
        model = WhisperModel(name, device="cpu", compute_type="int8")
        loaded_name = name
    return model

sys.stdout.write(json.dumps({"ready": True}) + "\\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        job = json.loads(line)
        if job.get("quit"):
            break
        engine = load(job.get("model") or "base")
        lang = job.get("language") or None
        segs, info = engine.transcribe(job["file"], language=lang, vad_filter=True, beam_size=1)
        text = "".join(s.text for s in segs).strip()
        sys.stdout.write(json.dumps({"text": text}, ensure_ascii=False) + "\\n")
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)[:300]}, ensure_ascii=False) + "\\n")
    sys.stdout.flush()
`

type Worker = {
  child: ChildProcessWithoutNullStreams
  ready: Promise<void>
  pending: ((line: string) => void) | undefined
}

let worker: Worker | undefined
/** When the last worker died before answering ready; repeated fast failures mean the interpreter is broken. */
let lastEarlyDeathAt = 0

async function ensureWorker(python: string): Promise<Worker> {
  if (worker && worker.child.exitCode === null) return worker
  // A worker that died before it was ready (broken interpreter, missing
  // package) would otherwise be respawned per call - fail fast instead.
  if (lastEarlyDeathAt && Date.now() - lastEarlyDeathAt < 10_000) throw new Error("voice.localFailed: the local speech worker failed to start")
  const child = spawn(python, ["-u", "-c", WORKER_SCRIPT], { windowsHide: true })
  let settleReady: (error?: Error) => void = () => {}
  // True once the worker answered ready. Only a death before this point is an
  // early death: a worker that crashes mid-job (or is killed at the 120s
  // transcription timeout) must be respawnable, not fail-fast.
  let readyAnswered = false
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = (error) => (error ? reject(error) : resolve())
  })
  const created: Worker = { child, ready, pending: undefined }
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const parsed = JSON.parse(line) as { ready?: boolean }
      if (parsed.ready) {
        readyAnswered = true
        settleReady()
        return
      }
    } catch {
      // Not our protocol line; ignore and keep the reader alive.
      return
    }
    const waiter = created.pending
    created.pending = undefined
    waiter?.(line)
  })
  // A worker that dies is dropped so the next call spawns a fresh one. If it
  // died before answering ready, wake whatever is waiting on `ready` and note
  // the early death, or the awaiting call hangs forever.
  child.on("exit", () => {
    if (worker === created) worker = undefined
    if (readyAnswered) return
    lastEarlyDeathAt = Date.now()
    settleReady(new Error("voice.localFailed: the local speech worker exited before it was ready"))
  })
  // Spawn failures (missing executable bit, bad interpreter) surface here, not
  // as an uncaught exception that would take the whole process down.
  child.on("error", (error) => {
    if (worker === created) worker = undefined
    if (readyAnswered) return
    lastEarlyDeathAt = Date.now()
    settleReady(new Error(`voice.localFailed: ${error.message}`))
  })
  child.stdin.on("error", () => {})
  worker = created
  return created
}

/**
 * One recording written down by the resident worker.
 *
 * A worker that fails mid-job is dropped and the call falls back to a fresh
 * spawn-and-exit run, so a crashed interpreter costs latency rather than the
 * feature. A recording nothing decodes, and silence, both land as
 * `voice.emptyResult`, the code the window already has a message for.
 *
 * Calls are serialized: the worker answers one job at a time over a single
 * reply slot, so concurrent recordings would read each other's transcript.
 */
let transcription: Promise<unknown> = Promise.resolve()

export function transcribeLocally(audio: Buffer, mime: string, language?: string, model?: string): Promise<string> {
  const run = transcription.catch(() => {}).then(() => transcribeOnce(audio, mime, language, model))
  transcription = run
  return run
}

async function transcribeOnce(audio: Buffer, mime: string, language?: string, model?: string): Promise<string> {
  const python = await localPython()
  if (!python) throw new Error("voice.localMissing")
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-asr-"))
  const file = path.join(dir, `recording${extensionFor(mime)}`)
  await fs.writeFile(file, audio)
  const size = model || localModelName()
  const lang = (language ?? "").split("-")[0] || undefined
  try {
    const active = await ensureWorker(python)
    await active.ready
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        active.pending = undefined
        // The worker is still chewing on the stale job; drop it outright so
        // its late answer can never be handed to a later recording.
        try {
          active.child.kill()
        } catch {
          // Already gone.
        }
        if (worker === active) worker = undefined
        reject(new Error("voice.timeout"))
      }, 120_000)
      active.pending = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
      active.child.stdin.write(`${JSON.stringify({ file, model: size, language: lang })}\n`)
    })
    const parsed = JSON.parse(reply) as { text?: string; error?: string }
    if (parsed.error) throw new Error(`voice.localFailed: ${parsed.error}`)
    const heard = (parsed.text ?? "").trim()
    if (!heard) throw new Error("voice.emptyResult")
    return heard
  } finally {
    void fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** True when this configuration asks for the local engine. */
export function wantsLocalAsr(configured?: { provider: string }): boolean {
  return configured?.provider === "local"
}

/** Stops the resident worker, for a clean shutdown. */
export function stopLocalAsr(): void {
  const active = worker
  worker = undefined
  if (!active) return
  try {
    active.child.stdin.write(`${JSON.stringify({ quit: true })}\n`)
    active.child.stdin.end()
  } catch {
    // Already gone.
  }
  setTimeout(() => {
    if (active.child.exitCode === null) active.child.kill()
  }, 2000).unref?.()
}