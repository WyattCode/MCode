import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { ToolError } from "./types"
import { runJob, type GlobResult, type GrepResult, type SearchJob } from "./search-core"

/**
 * How long a single search may run before it is killed.
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

/**
 * Runs a search off the main thread, with a deadline.
 *
 * The regex comes from the model, and a pattern such as `(a+)+$` backtracks
 * without end. A regex cannot be interrupted - not by an abort signal, not by a
 * timer, because both need the event loop the match is holding - so it runs
 * where it can be terminated instead. The backend shares its thread with the
 * window, so the alternative is not a slow search but an unresponsive app.
 */
export async function runSearch(
  job: SearchJob,
  signal: AbortSignal,
  /** Overridden only by the tests, which cannot afford to wait out the real one. */
  timeoutMs: number = TIMEOUT,
): Promise<GrepResult | GlobResult> {
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
    return runJob(job, signal)
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: job })
    let settled = false

    const finish = (act: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      void worker.terminate()
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

    const onAbort = () => finish(() => reject(new ToolError("Search cancelled")))
    signal.addEventListener("abort", onAbort, { once: true })

    worker.once("message", (message: { ok: boolean; result?: GrepResult | GlobResult; error?: string }) => {
      finish(() => (message.ok ? resolve(message.result!) : reject(new ToolError(message.error ?? "Search failed"))))
    })
    worker.once("error", (error: Error) => finish(() => reject(new ToolError(error.message))))
    worker.once("exit", (code) => {
      // A clean exit after a result has already been handled is the normal path.
      finish(() => reject(new ToolError(`The search worker stopped unexpectedly (code ${code})`)))
    })
  })
}
