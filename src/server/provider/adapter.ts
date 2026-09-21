import type { ProviderKind } from "./catalog"
import type { ProviderAdapter } from "./types"
import { AnthropicAdapter } from "./anthropic"
import { ChatGPTSubscription, OpenAIResponses } from "./chatgpt"
import { OpenAICompatible } from "./openai"

/**
 * The wire a provider is reached over, by its kind: the Messages API, the
 * ChatGPT subscription, the Responses API, or chat completions. One place, so
 * a new kind cannot be missed by one of the callers that pick an adapter.
 */
export function adapterFor(kind: ProviderKind): ProviderAdapter {
  switch (kind) {
    case "anthropic":
      return AnthropicAdapter
    case "chatgpt":
      return ChatGPTSubscription
    case "openai-responses":
      return OpenAIResponses
    // Chat completions is also the answer for a kind nothing names, as the ternaries this replaced fell through to it.
    default:
      return OpenAICompatible
  }
}
