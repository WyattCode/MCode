import type { Message, ModelModalities, ModelRef, Usage } from "@shared/protocol"
import type { ToolDefinition } from "../tool/types"

/**
 * Provider-agnostic turn interface.
 *
 * Anthropic and the OpenAI-compatible providers disagree on almost everything
 * at the wire level - block indices vs. choice deltas, tool_use vs. tool_calls,
 * thinking vs. reasoning_content. Normalizing to one event stream here keeps
 * that divergence out of the agent loop, which only cares that text arrived and
 * that some tools were requested.
 */
export type TurnEvent =
  | { type: "text.start"; index: number }
  | { type: "text.delta"; index: number; text: string }
  | { type: "reasoning.start"; index: number }
  | { type: "reasoning.delta"; index: number; text: string }
  | { type: "block.end"; index: number }
  /**
   * What lets this thinking be sent back to the model that wrote it, once the
   * block is complete: Anthropic's signature, or the Responses API's
   * `encrypted_content` and the id of the item it came in.
   */
  | { type: "reasoning.signature"; index: number; signature: string; itemID?: string }
  /** A tool the model wants to run, announced as soon as its name is known. */
  | { type: "tool"; callID: string; name: string }

export interface ToolCall {
  callID: string
  name: string
  input: Record<string, unknown>
  /** Why the arguments could not be read, when they arrived as text that is not a JSON object. */
  inputError?: string
}

export interface TurnOutcome {
  stop: "end_turn" | "tool_use" | "max_tokens" | "refusal"
  toolCalls: ToolCall[]
  usage: Usage
  /** The provider's own finish reason, as it said it: MiMo tells a tool-call finish with no call apart from a plain one. */
  finishReason?: string
}

/** The whole system text of a request: the cached prefix, then what belongs to this conversation alone. */
export function systemText(request: Pick<TurnRequest, "system" | "systemTail">): string {
  return request.systemTail ? `${request.system}\n\n${request.systemTail}` : request.system
}

export interface TurnRequest {
  apiKey: string
  model: ModelRef
  /** The system prompt as frozen for the conversation: the prefix a provider caches. */
  system: string
  /** memory: system text for this conversation alone, sent after the prefix and never marked for caching. */
  systemTail?: string
  history: Message[]
  tools: ToolDefinition[]
  effort: string
  signal: AbortSignal
  /** Base URL for OpenAI-compatible providers. */
  baseURL?: string
  /**
   * Extra headers this provider needs, from a custom provider's header list.
   *
   * Spread underneath the ones the adapter sets itself, so a header called
   * `authorization` cannot displace the bearer token - the reference's own
   * merge order.
   */
  headers?: Record<string, string>
  /**
   * The efforts this model accepts, or absent when nothing has worked it out.
   *
   * Carried so an adapter can tell "the user chose high" from "high means
   * nothing to this model": the second is the case where sending the field is
   * worse than omitting it.
   */
  variants?: readonly string[]
  /** Workspace the subscription login belongs to; required by the Codex backend. */
  accountId?: string
  /**
   * Output tokens to ask for, by MiMo's rule (`maxOutputTokens` in
   * session/overflow.ts). Unset means the adapter's default of 32k.
   */
  maxOutput?: number
  /** The model's own output ceiling when the catalog knows it; an Anthropic request is held under it. */
  outputLimit?: number
  /** MiMo's sampling for this model family (see sampling.ts); absent fields are not sent. */
  sampling?: { temperature?: number; topP?: number; topK?: number }
  /** Body fields a provider needs beside the usual ones (see `providerExtras`). */
  extra?: Record<string, unknown>
  /** The conversation this request belongs to: MiMo's prompt cache key and session-affinity header. */
  sessionID?: string
  /** How long a cache mark should last, when the model asks for the hour-long one. */
  cacheTTL?: "5m" | "1h"
  /** What the model reads besides text; an attachment of a kind it lacks is sent as a note instead (MiMo's unsupported parts). */
  inputs?: Partial<ModelModalities>
  /**
   * MiMo's interleaved reasoning: the assistant-message field an
   * OpenAI-compatible model reads its earlier reasoning back from. Set, the
   * reasoning is kept as it streams and sent back in that field.
   */
  interleaved?: string
  /**
   * How many times the SDK may quietly resend a failed request itself. The turn
   * loop passes 0 because it retries in the open, with a row saying so; other
   * callers leave it unset and keep the SDK's own.
   */
  retries?: number
}

/**
 * A failure the interface can phrase itself.
 *
 * Providers answer in English, and only they know the specifics - the token
 * counts, the limit. Carrying a key and its parameters instead of a finished
 * sentence lets the interface say it in the language it is running in.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly params?: Record<string, string>,
    /** The provider's own error code and type, which decide whether it is worth retrying. */
    readonly wire?: { code?: string; type?: string },
  ) {
    super(message)
    this.name = "ProviderError"
  }
}

/**
 * A request the provider answered with an HTTP failure, with the status and
 * headers kept: a rate limit's `retry-after` is how long MiMo waits.
 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly wire?: { code?: string; type?: string },
  ) {
    super(message)
    this.name = "ProviderHttpError"
  }
}

/** A response's headers, lower-cased, for a `ProviderHttpError`. */
export function headersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

/** The code and type an error body carries, when it is the usual `{error: {code, type}}` JSON. */
/**
 * A body that is a web page rather than an answer.
 *
 * A gateway, a captive portal or a corporate proxy replies with HTML, and
 * joining 300 characters of it onto a sentence put `<!DOCTYPE html><html>
 * <head><title>407 Proxy Authentication Required` on the failure card as
 * though it were what the provider had said. MiMo tests the body for the same
 * two openings and never concatenates one.
 */
export function isHtmlBody(body: string): boolean {
  return /^\s*(?:<!doctype|<html)/i.test(body)
}

export function wireOfBody(body: string): { code?: string; type?: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } }
    const code = parsed?.error?.code
    const type = parsed?.error?.type
    const wire = {
      ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}),
      ...(typeof type === "string" ? { type } : {}),
    }
    return Object.keys(wire).length ? wire : undefined
  } catch {
    return undefined
  }
}

export type Emit = (event: TurnEvent) => void

export interface ProviderAdapter {
  stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome>
}
