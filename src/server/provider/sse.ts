/**
 * One server-sent-events reader, for every adapter that reads a stream itself.
 *
 * Both hand-written adapters used to carry their own three-line reader that
 * yielded the payload of each `data:` line as it went past. That is not what
 * the format says, and each of the differences cost something real:
 *
 *   - an event is dispatched on a **blank line**, not on a `data:` line, and an
 *     event may carry several `data:` lines which are joined with newlines.
 *     Yielding each line on its own split one event into two fragments of JSON,
 *     both of which failed to parse and were swallowed by the caller's `catch`.
 *   - a line beginning with `:` is a comment. OpenRouter sends one every few
 *     seconds while a long request is queued, and Anthropic sends `ping`
 *     events, and neither used to count as the provider being alive - so a
 *     model that thought for more than the 480-second stall window was cut off
 *     and retried even though bytes were arriving the whole time. `onRead`
 *     fires on every read, before any parsing, which is where MiMo hangs its
 *     own chunk timeout (`wrapSSE` re-arms on each `reader.read()`).
 *   - `field:value` and `field: value` are the same field; only one leading
 *     space belongs to the separator.
 *   - lines end with LF, CR or CRLF, not LF alone.
 *   - the decoder needs a final flush, and whatever is left in the buffer when
 *     the connection closes is still an event. A provider whose last line has
 *     no trailing newline used to lose it entirely - and that last frame is
 *     usually the one carrying `finish_reason` or `usage`, so the turn then
 *     looked like a stream that had closed without a reply.
 *
 * The last point is the one place this is more forgiving than the format: a
 * strict reader discards an unterminated trailing line, and this one parses it
 * and dispatches what has accumulated. Nothing is lost by doing so - the
 * connection is over, so there is no next line for it to have been part of.
 */

export interface SseOptions {
  /** Ends the read early, without waiting for the body to reject. */
  signal?: AbortSignal
  /**
   * Bytes arrived. Called once per read, whatever they turned out to be:
   * comments, keep-alives and partial lines are all the provider being alive.
   */
  onRead?: () => void
}

/** One dispatched event: the `event:` field where the provider sent one, and the joined `data:` lines. */
export interface SseEvent {
  event?: string
  data: string
}

/** Splits on CR, LF or CRLF, keeping whatever follows the last break for the next chunk. */
function splitLines(chunk: string): { lines: string[]; rest: string } {
  const lines: string[] = []
  let at = 0
  while (at < chunk.length) {
    const cr = chunk.indexOf("\r", at)
    const lf = chunk.indexOf("\n", at)
    let end: number
    if (cr !== -1 && lf !== -1) end = Math.min(cr, lf)
    // A CR at the very end may yet be the first half of a CRLF, so it waits for the next chunk.
    else if (cr !== -1) end = cr === chunk.length - 1 ? -1 : cr
    else end = lf
    if (end === -1) return { lines, rest: chunk.slice(at) }
    lines.push(chunk.slice(at, end))
    at = end + 1
    if (chunk[end] === "\r" && chunk[at] === "\n") at += 1
  }
  return { lines, rest: "" }
}

/**
 * The events of a stream, in order.
 *
 * `onComment` is deliberately absent: a comment's only use here is that it
 * proves the connection is alive, and `onRead` already says that for every byte
 * that arrives, comment or not.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>, options: SseOptions = {}): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  /*
   * `ignoreBOM` is false by default, so this already takes a byte-order mark
   * off the front of the stream - MiMo's parser strips one itself because it is
   * handed strings rather than bytes. Doing it again here was checked and found
   * to be dead code.
   */
  const decoder = new TextDecoder()
  let rest = ""
  let name = ""
  let data = ""
  let done = false

  /** The event a blank line dispatches, or nothing when no `data:` line has arrived. */
  const dispatch = (): SseEvent | undefined => {
    if (!data.length) {
      name = ""
      return undefined
    }
    // Every data line contributed a trailing newline; the last one is not part of the payload.
    const event: SseEvent = { ...(name ? { event: name } : {}), data: data.endsWith("\n") ? data.slice(0, -1) : data }
    name = ""
    data = ""
    return event
  }

  const parse = (line: string): SseEvent | undefined => {
    if (line === "") return dispatch()
    if (line.startsWith(":")) return undefined
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    // One space after the colon belongs to the separator; a second one is data.
    const value = colon === -1 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1))
    if (field === "event") name = value
    else if (field === "data") data += `${value}\n`
    // `id` and `retry` are for reconnecting to an event source, which is not what a turn does.
    return undefined
  }

  try {
    while (!done) {
      if (options.signal?.aborted) return
      const read = await reader.read()
      // Before anything is parsed: the provider is alive whatever these bytes say.
      options.onRead?.()
      done = read.done
      // The final `decode()` with no argument flushes whatever the last chunk left half-decoded.
      const chunk = done ? decoder.decode() : decoder.decode(read.value, { stream: true })
      const split = splitLines(rest + chunk)
      rest = split.rest
      for (const line of split.lines) {
        const event = parse(line)
        if (event) yield event
      }
    }

    /*
     * The connection is closed. An unterminated last line is still the last
     * thing the provider said, and an event that never met its blank line is
     * still an event.
     */
    if (rest) {
      const event = parse(rest)
      if (event) yield event
    }
    const last = dispatch()
    if (last) yield last
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** The `data` payloads alone, which is all either wire format puts anything in. */
export async function* readData(body: ReadableStream<Uint8Array>, options: SseOptions = {}): AsyncGenerator<string> {
  for await (const event of readEvents(body, options)) yield event.data
}
