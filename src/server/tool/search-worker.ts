import { parentPort, workerData } from "node:worker_threads"
import { runFallbackJob, type FallbackJob } from "./search-fallback"

/**
 * Runs one stand-in search and exits.
 *
 * The whole point of the thread is that it can be killed: a model-supplied
 * regex may backtrack for hours, and terminate() is the only thing that stops
 * it. Nothing here is shared with the main thread beyond the job description
 * and the result, both of which are plain data.
 */
runFallbackJob(workerData as FallbackJob, new AbortController().signal).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error: Error) => parentPort?.postMessage({ ok: false, error: error.message }),
)