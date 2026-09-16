import type { Attachment, McpServerConfig, Message } from "@shared/protocol"
import type { Config } from "./config"
import type { AuthManager } from "./auth/manager"
import type { Permissions } from "./permission"
import { McpRequestError, type McpSampler } from "./mcp"
import { AnthropicAdapter } from "./provider/anthropic"
import { OpenAICompatible } from "./provider/openai"
import { ChatGPTSubscription } from "./provider/chatgpt"
import type { ProviderAdapter } from "./provider/types"

/**
 * An MCP server asking this app's model to write something for it
 * (`sampling/createMessage`), decided the way MiMo's engine decides it.
 *
 * Each server has a policy in its config - deny, ask or allow, ask when unset.
 * Asking needs a conversation to ask in, which is the one whose tool call last
 * reached that server; with none, the request is refused rather than left
 * waiting. "Always" is remembered per server. The answer comes from the app's
 * model, with no tools and no reasoning setting.
 */

/** MiMo's code for a request refused by a setting or by the user. */
export const SAMPLING_REFUSED = -1
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const CANCELLED = -32001

export type SamplingPolicy = "deny" | "ask" | "allow"

export function samplingPolicy(entry: McpServerConfig | undefined): SamplingPolicy {
  const set = entry?.sampling
  return set === "deny" || set === "allow" || set === "ask" ? set : "ask"
}

export interface SamplingRequest {
  system: string
  history: Message[]
  maxTokens: number
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The request's messages as a history the providers take, or why they cannot be. */
export function samplingRequest(server: string, params: Record<string, unknown>): SamplingRequest | McpRequestError {
  const invalid = (message: string) => new McpRequestError(INVALID_PARAMS, message)
  // Tools are not offered in the handshake, so a request that brings them is malformed for this client.
  if (params.tools !== undefined || params.toolChoice !== undefined) return invalid("Sampling with tools is not offered by this client")
  if (!Array.isArray(params.messages) || params.messages.length === 0) return invalid("messages has to hold at least one message")
  const maxTokens = params.maxTokens
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) return invalid("maxTokens has to be a positive whole number")
  if (params.systemPrompt !== undefined && typeof params.systemPrompt !== "string") return invalid("systemPrompt has to be text")

  const history: Message[] = []
  for (const [index, raw] of params.messages.entries()) {
    if (!record(raw) || (raw.role !== "user" && raw.role !== "assistant")) return invalid(`message ${index + 1} has no user or assistant role`)
    const texts: string[] = []
    const attachments: Attachment[] = []
    for (const item of Array.isArray(raw.content) ? raw.content : [raw.content]) {
      if (!record(item)) return invalid(`message ${index + 1} has content that is not an object`)
      if (item.type === "text" && typeof item.text === "string") texts.push(item.text)
      else if (item.type === "image" && raw.role === "user" && typeof item.data === "string" && typeof item.mimeType === "string" && item.mimeType.startsWith("image/")) {
        attachments.push({ path: `${server}-sample-${index + 1}`, mime: item.mimeType, data: item.data })
      } else return invalid(`message ${index + 1} carries content this client cannot send to a model`)
    }
    const id = `mcp-sampling:${server}:${index}`
    const time = { created: Date.now() }
    history.push(
      raw.role === "user"
        ? { id, sessionID: id, role: "user", text: texts.join("\n"), attachments, time }
        : {
            id,
            sessionID: id,
            role: "assistant",
            model: { provider: "", model: "" },
            agent: "build",
            parts: [{ type: "text", id: `${id}:text`, text: texts.join("\n") }],
            time,
          },
    )
  }
  return { system: typeof params.systemPrompt === "string" ? params.systemPrompt : "", history, maxTokens }
}

export function createSampler(deps: { config: Config; auth: AuthManager; permissions: Permissions }): McpSampler {
  return async ({ server, params, sessionID, signal }) => {
    const policy = samplingPolicy(deps.config.get().mcpServers?.[server])
    if (policy === "deny") throw new McpRequestError(SAMPLING_REFUSED, `Sampling is turned off for the MCP server "${server}"`)
    const request = samplingRequest(server, params)
    if (request instanceof McpRequestError) throw request

    const model = deps.config.get().model
    const definition = deps.config.definition(model.provider)
    if (!definition || !deps.config.usable(model.provider)) {
      throw new McpRequestError(INVALID_PARAMS, "No configured model can answer this sampling request")
    }

    if (policy === "ask") {
      if (!sessionID) {
        throw new McpRequestError(SAMPLING_REFUSED, `Sampling for the MCP server "${server}" needs approval, and there is no conversation to ask in`)
      }
      try {
        await deps.permissions.ask({
          sessionID,
          messageID: "",
          callID: `mcp-sampling:${server}:${Date.now()}`,
          kind: "mcp",
          title: "mcp_sampling",
          subject: server,
          scope: `mcp-sampling:${server}`,
        })
      } catch {
        throw new McpRequestError(SAMPLING_REFUSED, `The user declined sampling for the MCP server "${server}"`)
      }
    }

    const adapter: ProviderAdapter =
      definition.kind === "anthropic" ? AnthropicAdapter : definition.kind === "chatgpt" ? ChatGPTSubscription : OpenAICompatible
    const apiKey = deps.config.apiKey(definition.id) ?? ""
    const tokens = definition.kind === "chatgpt" ? await deps.auth.accessToken(definition.id).catch(() => undefined) : undefined
    let text = ""
    let stop: string
    try {
      const outcome = await adapter.stream(
        {
          apiKey: tokens?.access ?? apiKey,
          model,
          system: request.system,
          history: request.history,
          tools: [],
          effort: "",
          // An empty list is how an adapter is told to send no reasoning setting at all.
          variants: [],
          showReasoning: false,
          signal,
          baseURL: definition.baseURL,
          headers: definition.headers,
          accountId: tokens?.accountId,
          maxOutput: request.maxTokens,
        },
        (event) => {
          if (event.type === "text.delta") text += event.text
        },
      )
      stop = outcome.stop
    } catch {
      if (signal.aborted) throw new McpRequestError(CANCELLED, "Sampling was cancelled")
      throw new McpRequestError(INTERNAL_ERROR, "Sampling failed")
    }
    return {
      role: "assistant",
      content: { type: "text", text },
      model: `${model.provider}/${model.model}`,
      stopReason: stop === "max_tokens" ? "maxTokens" : "endTurn",
    }
  }
}
