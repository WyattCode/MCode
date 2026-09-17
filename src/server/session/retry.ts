/**
 * When a failed provider request is worth sending again, and after how long.
 *
 * MiMo's engine sorts every failure into a kind and gives each kind a budget of
 * its own: a dropped connection is waited out for as long as it takes, a rate
 * limit may be waited on for minutes, a server error is tried eight times in a
 * quarter of an hour. Anything else - a refused key, a malformed request, a
 * prompt too long for the model, a model the provider does not have - fails the
 * same way every time, and waiting would only delay saying so.
 *
 * A wait the provider names itself (`retry-after-ms`, `retry-after`, or "try
 * again in 20s" in its words) is honoured, held under the kind's longest wait.
 */
import Anthropic from "@anthropic-ai/sdk"
import { isOverflowError } from "./overflow"
import { ProviderError, ProviderHttpError } from "../provider/types"

export type RetryKind = "stream" | "network" | "rate_limit" | "server" | "unknown" | "request"

export interface RetryBudget {
  /** Attempts after the first; Infinity waits for as long as it takes. */
  retries: number
  /** How long after the first failure retrying stops; Infinity for never. */
  deadline: number
  initial: number
  max: number
  jitter: boolean
}

/** MiMo's budgets, per kind. */
export const RETRY_BUDGETS: Record<RetryKind, RetryBudget> = {
  stream: { retries: 5, deadline: 10 * 60_000, initial: 2_000, max: 30_000, jitter: true },
  server: { retries: 8, deadline: 15 * 60_000, initial: 2_000, max: 30_000, jitter: true },
  rate_limit: { retries: 5, deadline: 15 * 60_000, initial: 2_000, max: 5 * 60_000, jitter: true },
  network: { retries: Infinity, deadline: Infinity, initial: 5_000, max: 60_000, jitter: false },
  /*
   * MiMo's last resort, for a failure it could not sort but the SDK marks
   * retryable: eight attempts over a quarter of an hour, the same shape as a
   * server error. Without it a status nobody recognised failed the turn at
   * once, however plainly temporary the provider said it was.
   */
  unknown: { retries: 8, deadline: 15 * 60_000, initial: 2_000, max: 30_000, jitter: true },
  /*
   * MiMo's `DEFAULT_RETRY_CONFIG.request`, chosen by the phase of a call
   * rather than by the kind of its failure: four tries inside half a minute,
   * starting at 200ms. It is for the calls that are not a turn - naming a
   * conversation, writing a commit message - which had no budget of their own
   * here and were left to whatever the adapter happened to do.
   */
  request: { retries: 4, deadline: 30_000, initial: 200, max: 30_000, jitter: true },
}

/**
 * One call that is not a turn, tried again on MiMo's request budget.
 *
 * MiMo picks this budget by the phase of the call rather than by the kind of
 * its failure (`budgetFor` takes `decision.phase === "request"` before it looks
 * at anything else), so a title or a commit message gets four quick tries
 * where the turn loop would get eight slow ones. Only failures worth repeating
 * are repeated: `retryKind` decides that, and anything terminal - a refused
 * key, a model the provider does not have - fails at once as it should.
 */
export async function withRequestRetry<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const budget = RETRY_BUDGETS.request
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      if (signal?.aborted) throw err
      const elapsed = Date.now() - started
      if (attempt >= budget.retries || elapsed >= budget.deadline || !retryKind(err)) throw err
      const wait = Math.min(budget.max, budget.initial * 2 ** attempt)
      await new Promise((resolve) => setTimeout(resolve, Math.max(FLOOR, wait)))
    }
  }
}

/** No wait is shorter than this. */
const FLOOR = 100

/** A wait named in the provider's words is taken up to this long. */
const HINT_CAP = 5 * 60_000

/** GPT's overload answer: tried at once the first time, and three times at most. */
const GPT_OVERLOAD_RETRIES = 3

const RATE_LIMITED = /too many requests|too_many_requests|rate[ _]limit(?:ed)?|rate increased too quickly/i
const NETWORK =
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout|und_err_socket/i
const STREAM = /stream_read_error|upstream_error|sse read timed? ?out|stream (?:read )?time(?:d)? ?out/i
const SERVER_CODE = /exhausted|unavailable/i

/**
 * The codes an error frame inside a 200 stream carries for "try again".
 *
 * MiMo's `parseStreamError` sorts such a frame by `error.code || error.type`
 * and marks exactly these retryable (`stream_read_error` is in its list too and
 * is read as a stream failure a few lines below, which is the kind it belongs
 * to). None of them arrives with an HTTP status - the response was a 200 and
 * the failure came down the stream - so without naming them here `retryKind`
 * fell through every branch and returned undefined, and Anthropic's
 * `overloaded_error`, which is the ordinary way that API sheds load once a
 * stream is open, failed the turn on the first try where MiMo would have tried
 * it eight times over a quarter of an hour.
 */
const SERVER_WIRE_CODES = new Set(["overloaded_error", "server_is_overloaded", "server_error"])

/**
 * The codes MiMo marks explicitly not retryable, so a later branch cannot pick
 * them up: a spent quota, a plan that does not include this model, and a prompt
 * the provider refuses to take. Each fails the same way every time.
 */
const TERMINAL_WIRE_CODES = new Set(["insufficient_quota", "usage_not_included", "invalid_prompt"])

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
  if (err instanceof ProviderHttpError) return err.status
  return undefined
}

function headerOf(err: unknown, name: string): string | undefined {
  if (err instanceof ProviderHttpError) return err.headers[name]
  if (!(err instanceof Anthropic.APIError)) return undefined
  const headers: unknown = err.headers
  if (!headers) return undefined
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === "string" ? value : undefined
}

/** The provider's own code and type for a failure, where it sent them. */
function wireOf(err: unknown): { code?: string; type?: string } {
  if (err instanceof ProviderError || err instanceof ProviderHttpError) return err.wire ?? {}
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { type?: unknown } } | undefined
    const type = body?.error?.type
    return typeof type === "string" ? { type } : {}
  }
  return {}
}

function aborted(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error && current.name === "AbortError") return true
    if ((current as { code?: unknown })?.code === "ABORT_ERR") return true
    current = (current as { cause?: unknown })?.cause
  }
  return false
}

/** What kind of failure this is, or undefined for one that will not go away by waiting. MiMo's order. */
export function retryKind(err: unknown): RetryKind | undefined {
  if (!err || typeof err !== "object") return undefined
  const text = textOf(err)
  if (aborted(err) || isOverflowError(err, text)) return undefined
  const status = statusOf(err)
  const wire = wireOf(err)
  if (status === 401 || status === 403 || status === 402 || status === 501 || status === 505) return undefined
  /*
   * A 404 is terminal only where the model really is absent. MiMo sets
   * allow404Retry for its MODEL_NOT_FOUND_RETRY_ADAPTERS - the
   * OpenAI-compatible family, Azure, Groq, Together, OpenRouter and the
   * gateways - because a gateway rotating models answers 404 in passing, and
   * those retries go on the unknown budget. Here that family is exactly the
   * adapters that raise ProviderHttpError; anything else keeps 404 final.
   */
  if (status === 404) return err instanceof ProviderHttpError ? "unknown" : undefined
  if (/usage[_ ]?limit/i.test(wire.code ?? "")) return undefined
  if (TERMINAL_WIRE_CODES.has(wire.code ?? "") || TERMINAL_WIRE_CODES.has(wire.type ?? "")) return undefined
  if (wire.code === "stream_read_error" || wire.type === "upstream_error") return "stream"
  // MiMo's retryable stream-error codes, which carry no status of their own.
  if (SERVER_WIRE_CODES.has(wire.code ?? "") || SERVER_WIRE_CODES.has(wire.type ?? "")) return "server"
  if (NETWORK.test(text)) return "network"
  if (STREAM.test(text)) return "stream"
  if (wire.type === "too_many_requests" || /rate_limit/.test(`${wire.type ?? ""} ${wire.code ?? ""}`) || wire.code === "429" || RATE_LIMITED.test(text)) {
    return "rate_limit"
  }
  if (SERVER_CODE.test(wire.code ?? "")) return "server"
  if (status === 429) return "rate_limit"
  if (status !== undefined && (status === 408 || status === 425 || status >= 500)) return "server"
  /*
   * MiMo's final branch: an API error the SDK marks retryable takes the unknown
   * budget. That flag is status 408, 409, 429 or 5xx, so 409 - which some
   * gateways answer when their concurrency limit is reached - was the one case
   * MCode failed outright where MiMo waits it out.
   */
  if (status === 409) return "unknown"
  return undefined
}

/** Whether this failure is the kind that goes away by itself. */
export function isRetryable(err: unknown): boolean {
  return retryKind(err) !== undefined
}

/** A wait the provider asked for: its headers first, then its words. */
export function retryHint(err: unknown): number | undefined {
  const afterMs = headerOf(err, "retry-after-ms")
  if (afterMs) {
    const parsed = Number.parseFloat(afterMs)
    if (Number.isFinite(parsed)) return Math.ceil(parsed)
  }
  const after = headerOf(err, "retry-after")
  if (after) {
    const seconds = Number.parseFloat(after)
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000)
    const until = Date.parse(after) - Date.now()
    if (Number.isFinite(until) && until > 0) return Math.ceil(until)
  }
  const said = /(?:try again|retry(?:ing)?)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b/i.exec(textOf(err))
  if (!said) return undefined
  const amount = Number.parseFloat(said[1]!)
  const unit = said[2]!.toLowerCase()
  const scale = unit.startsWith("ms") || unit.startsWith("milli") ? 1 : unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60_000 : 3_600_000
  return Math.min(HINT_CAP, Math.ceil(amount * scale))
}

export interface RetryDecision {
  kind: RetryKind
  wait: number
  /** The attempts this kind allows, 0 when it waits for as long as it takes. */
  max: number
}

/**
 * Whether to send attempt `attempt + 1`, and after how long.
 *
 * @param attempt the attempt that just failed, from 1.
 * @param elapsed how long ago the first failure of this request was.
 */
export function retryDecision(
  err: unknown,
  attempt: number,
  elapsed: number,
  random = Math.random(),
  phase: "request" | "stream" = "stream",
): RetryDecision | undefined {
  const kind = retryKind(err)
  if (!kind) return undefined
  /*
   * MiMo retries in two phases, and picks the budget by the phase before it
   * looks at the kind (`budgetFor(..., phase === "request")`). A request that
   * has not produced a single event has failed before the model said anything,
   * so it is tried again quickly - 200ms, doubling - rather than on the two
   * seconds a stream failure waits. How many attempts it gets, and for how
   * long, still belong to the kind of failure it was: a dropped connection is
   * still waited out for as long as it takes.
   */
  const curve = phase === "request" ? RETRY_BUDGETS.request : RETRY_BUDGETS[kind]
  const budget = { ...RETRY_BUDGETS[kind], initial: curve.initial, max: Math.min(RETRY_BUDGETS[kind].max, curve.max) }
  /*
   * MiMo's `isGptServerOverloadedError` reads the parsed body rather than the
   * words: type "service_unavailable_error" together with code
   * "server_is_overloaded". Matching the whole sentence meant an unrelated
   * failure that merely mentioned one of those strings got the immediate first
   * retry and a ceiling of three, in place of the full server budget of eight.
   */
  const wire = wireOf(err)
  const overload = wire.type === "service_unavailable_error" && wire.code === "server_is_overloaded"
  const retries = overload ? Math.min(budget.retries, GPT_OVERLOAD_RETRIES) : budget.retries
  if (attempt > retries) return undefined

  let wait: number
  const hint = retryHint(err)
  if (overload && attempt === 1) wait = 0
  else if (hint !== undefined) wait = Math.min(budget.max, Math.max(FLOOR, hint))
  else {
    const base = Math.min(budget.max, budget.initial * Math.pow(2, attempt - 1))
    const spread = budget.jitter ? 1 + (random * 2 - 1) * 0.1 : 1
    wait = Math.round(Math.min(budget.max, Math.max(FLOOR, base * spread)))
  }
  if (elapsed >= budget.deadline || wait >= budget.deadline - elapsed) return undefined
  return { kind, wait, max: Number.isFinite(retries) ? retries : 0 }
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
