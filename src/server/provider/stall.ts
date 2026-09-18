/**
 * How long a provider may go quiet, as MiMo's engine allows: 480 seconds
 * between chunks of a stream, and for OpenAI's Responses API 300 seconds before
 * the response headers arrive. Past that the request is cut off with a stream
 * timeout, which the retry logic treats as worth trying again.
 *
 * Kept in an object so a check can shorten them.
 */
export const STALL = { headerMs: 300_000, chunkMs: 480_000 }

export interface StallGuard {
  /** The signal to hand the request: the turn's own, plus the stall. */
  signal: AbortSignal
  /** Something arrived; the quiet spell starts again. */
  alive(): void
  /** The error to throw for a failure: the stall's own when it was the stall. */
  failure(err: unknown): unknown
  dispose(): void
}

/**
 * The stream guards in flight, so a machine that has just woken can cut them
 * (N11-16).
 *
 * A stream that was open when the laptop slept is dead on the other side but
 * looks perfectly alive from here: nothing arrives, and nothing will, so the
 * turn sits behind the eight-minute quiet bound with the spinner turning and
 * the power hold keeping the machine awake. Cutting them on resume makes it a
 * stream timeout, which the retry ladder already knows how to handle.
 */
const live = new Set<(why: string) => void>()

/** How many streams are in flight, for the checks. */
export function liveStreams(): number {
  return live.size
}

/** Ends every stream in flight with a stall-shaped failure. Returns how many there were. */
export function cutLiveStreams(why: string): number {
  const trips = [...live]
  for (const trip of trips) trip(why)
  return trips.length
}

export function stallGuard(outer: AbortSignal, waitForHeaders: boolean): StallGuard {
  const controller = new AbortController()
  let failure: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, what: string) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      failure = new Error(`${what} for ${Math.round(ms / 1000)}s: stream timeout`)
      controller.abort(failure)
    }, ms)
    timer.unref?.()
  }
  const onAbort = () => {
    clearTimeout(timer)
    controller.abort(outer.reason)
  }
  /* Worded like the guard's own timeouts, so retry.ts sorts it as a stream failure. */
  const trip = (why: string) => {
    if (outer.aborted || failure) return
    clearTimeout(timer)
    failure = new Error(`${why}: stream timeout`)
    controller.abort(failure)
  }
  live.add(trip)
  if (outer.aborted) controller.abort(outer.reason)
  else outer.addEventListener("abort", onAbort, { once: true })
  if (waitForHeaders) arm(STALL.headerMs, "The provider sent no response")
  else arm(STALL.chunkMs, "The provider sent nothing")
  return {
    signal: controller.signal,
    alive: () => {
      if (!outer.aborted && !failure) arm(STALL.chunkMs, "The provider stopped sending")
    },
    failure: (err) => failure ?? err,
    dispose: () => {
      clearTimeout(timer)
      live.delete(trip)
      outer.removeEventListener("abort", onAbort)
    },
  }
}

/** A stream read through the guard: each item keeps it alive, a stall ends it with the stall's error. */
export async function* guarded<T>(source: AsyncIterable<T>, guard: StallGuard): AsyncGenerator<T> {
  try {
    for await (const item of source) {
      guard.alive()
      yield item
    }
  } catch (err) {
    throw guard.failure(err)
  } finally {
    guard.dispose()
  }
}
