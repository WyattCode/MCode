import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { SearchStopped } from "./ignore"
import { ToolError } from "./types"
import { runFallbackJob, type FallbackJob, type GlobJob, type GlobOutcome, type GrepJob, type GrepOutcome } from "./search-fallback"

/**
 * How long a single stand-in search may run before it is killed.
 *
 * Generous for any real search over a project - a full grep of this repository
 * is a few hundred milliseconds - and short enough that a pattern which will
 * never finish gives the model an answer it can act on instead of a frozen app.
 */
const TIMEOUT = 10_000

/**
 * The bundled worker entry, which lands beside whichever bundle is running.
 *
 * The app builds it to out/main/search-worker.js; the test bundle writes
 * out/search-worker.mjs next to its own entry. Both are found by looking beside
 * this module rather than by guessing a project layout that only exists in the
 * source tree.
 */
function workerFile(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const name of ["search-worker.js", "search-worker.mjs"]) {
    const candidate = path.join(here, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Workers kept warm between searches, and for how long: starting one means loading the bundle again. */
const IDLE_WORKERS = 2
const IDLE_MS = 30_000
const idle: { worker: Worker; timer: NodeJS.Timeout }[] = []

function forget(worker: Worker): void {
  const at = idle.findIndex((entry) => entry.worker === worker)
  if (at < 0) return
  clearTimeout(idle[at]!.timer)
  idle.splice(at, 1)
}

/** A worker that finished its search cleanly: kept for the next one, within limits. */
function keep(worker: Worker): void {
  if (idle.length >= IDLE_WORKERS) {
    void worker.terminate()
    return
  }
  const timer = setTimeout(() => {
    forget(worker)
    void worker.terminate()
  }, IDLE_MS)
  timer.unref()
  idle.push({ worker, timer })
}

function take(file: string): Worker {
  const entry = idle.pop()
  if (entry) {
    clearTimeout(entry.timer)
    return entry.worker
  }
  const worker = new Worker(file)
  // A worker waiting for work must not keep the process from exiting; a search in progress is held open by its deadline timer.
  worker.unref()
  // Between searches nobody is listening, and an unhandled worker error would take the process down.
  worker.on("error", () => forget(worker))
  worker.on("exit", () => forget(worker))
  return worker
}

/**
 * Runs a stand-in search off the main thread, with a deadline.
 *
 * The regex comes from the model, and a pattern such as `(a+)+$` backtracks
 * without end. A regex cannot be interrupted - not by an abort signal, not by a
 * timer, because both need the event loop the match is holding - so it runs
 * where it can be terminated instead. The backend shares its thread with the
 * window, so the alternative is not a slow search but an unresponsive app.
 *
 * A worker that finishes is kept for the next search; one that is stopped is
 * terminated, since it may still be inside the match.
 */
export function runFallback(job: GrepJob, signal: AbortSignal, timeoutMs?: number): Promise<GrepOutcome>
export function runFallback(job: GlobJob, signal: AbortSignal, timeoutMs?: number): Promise<GlobOutcome>
export function runFallback(job: FallbackJob, signal: AbortSignal, timeoutMs?: number): Promise<GrepOutcome | GlobOutcome>
export async function runFallback(
  job: FallbackJob,
  signal: AbortSignal,
  /** Overridden only by the tests, which cannot afford to wait out the real one. */
  timeoutMs: number = TIMEOUT,
): Promise<GrepOutcome | GlobOutcome> {
  const file = workerFile()
  /*
   * No worker bundle - an unusual packaging, or a direct import in a test.
   * Searching still has to work, so it runs here, exactly as bounded as it was
   * before the worker existed: the walk stops on abort, a runaway regex does
   * not. Said out loud, because silently falling back to the behaviour this
   * file exists to prevent is worth finding in a log.
   */
  if (!file) {
    console.warn("[search] no worker bundle beside", import.meta.url, "- searching on the main thread")
    return runFallbackJob(job, signal)
  }

  // A turn stopped before the search began must not run it: no listener below would ever hear an abort that already happened.
  if (signal.aborted) throw new SearchStopped()

  return new Promise((resolve, reject) => {
    const worker = take(file)
    let settled = false

    const finish = (act: () => void, reusable = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      worker.off("message", onMessage)
      worker.off("error", onError)
      worker.off("exit", onExit)
      if (reusable) keep(worker)
      else void worker.terminate()
      act()
    }

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ToolError(
              `The search did not finish within ${timeoutMs / 1000} seconds and was stopped. A pattern with nested quantifiers such as (a+)+ can take effectively forever - narrow it, or anchor it.`,
            ),
          ),
        ),
      timeoutMs,
    )

    const onAbort = () => finish(() => reject(new SearchStopped()))
    const onMessage = (message: { ok: boolean; result?: GrepOutcome | GlobOutcome; error?: string }) =>
      finish(() => (message.ok ? resolve(message.result!) : reject(new ToolError(message.error ?? "Search failed"))), true)
    const onError = (error: Error) => finish(() => reject(new ToolError(error.message)))
    const onExit = (code: number) => finish(() => reject(new ToolError(`The search worker stopped unexpectedly (code ${code})`)))

    signal.addEventListener("abort", onAbort, { once: true })
    worker.on("message", onMessage)
    worker.on("error", onError)
    worker.on("exit", onExit)
    worker.postMessage(job)
  })
}
