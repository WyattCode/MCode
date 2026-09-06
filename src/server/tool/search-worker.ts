import { parentPort, workerData } from "node:worker_threads"
import { runJob, type SearchJob } from "./search-core"

/**
 * Runs one search and exits.
 *
 * The whole point of the thread is that it can be killed: a model-supplied
 * regex may backtrack for hours, and terminate() is the only thing that stops
 * it. Nothing here is shared with the main thread beyond the job description
 * and the result, both of which are plain data.
 */
runJob(workerData as SearchJob).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error: Error) => parentPort?.postMessage({ ok: false, error: error.message }),
)
