import Anthropic from "@anthropic-ai/sdk"
import { ProviderError, ProviderHttpError } from "../provider/types"
import { isOverflowError } from "./overflow"

/**
 * MiMo's short failure sentences, as keys the window phrases.
 *
 * MiMo passes every provider failure through one classifier and shows only its
 * short sentence on the card, keeping the raw text aside. The kinds here are
 * MiMo's - an unreachable or dropped connection, a rate limit, a refused key,
 * a conversation too long for the model, a model the provider does not have -
 * plus a server error that outlasted the retries, for which MiMo has a
 * sentence too. A failure the provider already coded keeps its code; anything
 * else keeps the provider's own words.
 */

const UNREACHABLE = /getaddrinfo|enotfound|eai_again|cannot connect to (?:the )?api/i
const DROPPED = ["terminated", "fetch failed", "econnreset", "und_err", "socket hang up", "network", "etimedout", "econnrefused"]
const RATE_LIMITED = /too\s+many\s+requests?|rate[\s_-]?limit/i
const BAD_KEY =
  /\b(?:invalid|incorrect|missing|expired|wrong)\b[\w\s-]{0,12}\bapi[\s_-]*key|\bapi[\s_-]*key\b[\w\s-]{0,12}\b(?:invalid|missing|incorrect|expired|not valid)\b|authentication failed|unauthori[sz]ed/i
const NO_MODEL = /model[\s_-]*not[\s_-]*found|does not recognise this model|no such model|unknown model/i
/** A status the adapters write into their own sentences: "returned 503", "request failed (429)". */
const STATUS_IN_TEXT = /\b(?:returned|request failed)\s*\(?(\d{3})\)?/i

/** Everything an error says about itself, its causes included: a dropped socket hides in `cause`. */
export function failureDetail(err: unknown): string {
  const pieces: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 4; depth++) {
    if (!(current instanceof Error)) {
      pieces.push(String(current))
      break
    }
    pieces.push(current.message)
    const code = (current as { code?: unknown }).code
    if (typeof code === "string") pieces.push(code)
    current = (current as { cause?: unknown }).cause
  }
  return pieces.join(" ").trim()
}

function statusOf(err: unknown, text: string): number | undefined {
  if (err instanceof Anthropic.APIError && typeof err.status === "number") return err.status
  if (err instanceof ProviderHttpError) return err.status
  const found = STATUS_IN_TEXT.exec(text)
  return found ? Number(found[1]) : undefined
}

export function failureCode(err: unknown): { code: string; params?: Record<string, string> } | undefined {
  if (err instanceof ProviderError && err.code) return { code: err.code, params: err.params }
  const text = failureDetail(err)
  if (!text) return undefined
  const status = statusOf(err, text)
  if (status === 429) return { code: "error.rateLimited" }
  if (status === 401 || status === 403) return { code: "error.authInvalid" }
  if (status === 404) return { code: "error.modelUnavailable" }
  if (UNREACHABLE.test(text)) return { code: "error.network" }
  const lower = text.toLowerCase()
  if (DROPPED.some((word) => lower.includes(word))) return { code: "error.network" }
  if (RATE_LIMITED.test(text)) return { code: "error.rateLimited" }
  if (BAD_KEY.test(text)) return { code: "error.authInvalid" }
  if (isOverflowError(err, text)) return { code: "error.contextExceeded" }
  if (NO_MODEL.test(text)) return { code: "error.modelUnavailable" }
  if (status !== undefined && status >= 500) return { code: "error.serverError" }
  return undefined
}
