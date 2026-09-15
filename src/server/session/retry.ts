/**
 * When a failed provider request is worth sending again, and after how long.
 *
 * The schedule is OpenCode's session retry, which MiMo's engine inherits: two
 * seconds doubling each attempt with up to a quarter more at random, never more
 * than thirty seconds unless the provider named a wait of its own, and five
 * attempts at most. What counts as passing weather is its list too: rate limits,
 * overload, 5xx, and the ways a connection drops. Anything else - a refused key,
 * a malformed request, a prompt too long for the model - fails the same way
 * every time, and waiting would only delay saying so.
 */
import Anthropic from "@anthropic-ai/sdk"
import { isContextOverflow } from "./overflow"

export const RETRY_INITIAL_DELAY = 2_000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000
export const RETRY_MAX_DELAY = 2_147_483_647
export const RETRY_MAX_RETRIES = 5

const RETRYABLE = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

/** Everything an error says about itself, its causes included: a dropped socket hides in `cause`. */
function textOf(err: unknown): string {
  const pieces: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      pieces.push(current.message)
      const code = (current as { code?: unknown }).code
      if (typeof code === "string") pieces.push(code)
      current = (current as { cause?: unknown }).cause
    } else {
      pieces.push(String(current))
      break
    }
  }
  return pieces.join(" ")
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof Anthropic.APIError && typeof err.status === "number") return err.status
  return undefined
}

function headerOf(err: unknown, name: string): string | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined
  const headers: unknown = err.headers
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === "string" ? value : undefined
}

function exponential(attempt: number, random: number): number {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

/** Whether this failure is the kind that goes away by itself. */
export function isRetryable(err: unknown): boolean {
  const text = textOf(err)
  if (isContextOverflow(text)) return false
  const status = statusOf(err)
  if (status !== undefined && (status >= 500 || status === 429 || status === 408 || status === 409)) return true
  if (status !== undefined && status >= 400) return RETRYABLE.slice(1).some((pattern) => pattern.test(text))
  return RETRYABLE.some((pattern) => pattern.test(text))
}

/**
 * How long to wait before attempt `attempt + 1`, or undefined to give up.
 *
 * @param attempt the attempt that just failed, from 1.
 */
export function retryDelay(err: unknown, attempt: number, random = Math.random()): number | undefined {
  if (attempt > RETRY_MAX_RETRIES || !isRetryable(err)) return undefined
  const cap = (ms: number) => Math.min(ms, RETRY_MAX_DELAY)
  const afterMs = headerOf(err, "retry-after-ms")
  if (afterMs) {
    const parsed = Number.parseFloat(afterMs)
    if (!Number.isNaN(parsed)) return cap(parsed)
  }
  const after = headerOf(err, "retry-after")
  if (after) {
    const seconds = Number.parseFloat(after)
    if (!Number.isNaN(seconds)) return cap(Math.ceil(seconds * 1000))
    const until = Date.parse(after) - Date.now()
    if (!Number.isNaN(until) && until > 0) return cap(Math.ceil(until))
  }
  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

/** A wait that Stop cuts short. Resolves false when it was cut. */
export function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop)
      resolve(true)
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener("abort", stop, { once: true })
  })
}
