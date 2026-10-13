import type { ModelRef } from "@shared/protocol"
import type { ModelEntry } from "./catalog"

/**
 * Model families whose reasoning arrives on the OpenAI-compatible wire under
 * `reasoning_content`, the field MiMo reads back for interleaved thinking.
 *
 * These are the chat-completions servers that put the chain of thought beside
 * the answer rather than inside it: DeepSeek's R1 line, Qwen's thinking models,
 * GLM, Kimi and MiniMax all stream `reasoning_content`. A local Qwen served
 * through one of the common shims behaves the same way, which is why the id is
 * matched rather than the provider.
 */
const REASONING_FIELD_FAMILIES = ["deepseek", "qwen", "glm", "kimi", "minimax"]

/**
 * MiMo's interleaved field: what the model's entry states, else
 * `reasoning_content` for a reasoning family reached over the OpenAI-compatible
 * wire. Only that wire carries the field, so any other kind gets nothing.
 */
export function interleavedField(kind: string, model: ModelRef, entry: ModelEntry | undefined): string | undefined {
  if (kind !== "openai-compatible") return undefined
  if (entry?.interleaved) return entry.interleaved
  const id = model.model.toLowerCase()
  return REASONING_FIELD_FAMILIES.some((family) => id.includes(family)) ? "reasoning_content" : undefined
}
