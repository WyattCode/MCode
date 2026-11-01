import { parentPort } from "node:worker_threads"
import { runFallbackJob, type FallbackJob } from "./search-fallback"

/**
 * Runs stand-in searches, one at a time, for as long as the main thread keeps it.
 *
 * The whole point of the thread is that it can be killed: a model-supplied
 * regex may backtrack for hours, and terminate() is the only thing that stops
 * it. Nothing here is shared with the main thread beyond the job description
 * and the result, both of which are plain data. A search that finishes leaves
 * the worker ready for the next one; one that does not is terminated, and
 * the worker with it. Errors cross as a message and a flag for a ToolError,
 * because a class does not survive the trip.
 */
parentPort?.on("message", (job: FallbackJob) => {
  runFallbackJob(job, new AbortController().signal).then(
    (result) => parentPort?.postMessage({ ok: true, result }),
    (error: Error) => parentPort?.postMessage({ ok: false, error: error.message }),
  )
})
