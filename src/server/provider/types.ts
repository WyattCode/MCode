import type { Message, ModelRef, Usage } from "@shared/protocol"
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

export interface TurnRequest {
  apiKey: string
  model: ModelRef
  system: string
  history: Message[]
  tools: ToolDefinition[]
  effort: string
  showReasoning: boolean
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
