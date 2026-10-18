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
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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

/**
 * One recording written down by faster-whisper.
 *
 * The audio is handed over as a temporary file because that is what the
 * library reads; anything it does not decode (a container PyAV cannot open)
 * comes back as `voice.emptyResult`, the same code a provider's empty answer
 * has, so the window's messages need no new case.
 */
export async function transcribeLocally(audio: Buffer, mime: string, language?: string, model?: string): Promise<string> {
  const python = await localPython()
  if (!python) throw new Error("voice.localMissing")
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-asr-"))
  const file = path.join(dir, `recording${extensionFor(mime)}`)
  await fs.writeFile(file, audio)
  const size = model || localModelName()
  const lang = (language ?? "").split("-")[0]
  /*
   * Runs in the interpreter that has the package, printing one JSON object.
   * `vad_filter` drops the silence around a press-and-hold, which otherwise
   * gets hallucinated into "谢谢观看" by the smaller models.
   */
  const script = `import json,sys
from faster_whisper import WhisperModel
m = WhisperModel(${JSON.stringify(size)}, device="cpu", compute_type="int8")
segs, info = m.transcribe(${JSON.stringify(file)}, language=${lang ? JSON.stringify(lang) : "None"}, vad_filter=True, beam_size=1)
print(json.dumps({"text": "".join(s.text for s in segs).strip()}, ensure_ascii=False))`
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(python, ["-c", script], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`voice.localFailed: ${String(stderr || err.message).slice(0, 300)}`))
        else resolve(String(stdout))
      })
    })
    const line = out.trim().split(/\r?\n/).pop() ?? ""
    const parsed = JSON.parse(line) as { text?: string }
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