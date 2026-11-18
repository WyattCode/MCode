/**
 * How a custom provider's address and model ids are tidied before they are
 * used, as MiMo tidies them when it saves one.
 *
 * The form asks for the address up to `/v1`, but people paste the full
 * `/chat/completions` URL anyway; the adapter appends that path itself, so
 * left alone the request would go to `.../chat/completions/chat/completions`
 * and fail as "model unavailable". A model id never contains whitespace, so a
 * space that came along with a paste is dropped rather than sent upstream.
 */

/** The address without surrounding blanks, trailing slashes or a trailing `/chat/completions` or `/completions`. */
export function normalizeBaseURL(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/completions$/i, "")
    .replace(/\/+$/, "")
}

/** The model id with every whitespace character removed. */
export function normalizeModelId(raw: string): string {
  return raw.replace(/\s+/g, "")
}

export type ProviderProtocol = "chat-completions" | "messages" | "responses"

export function normalizeProviderProtocol(raw = ""): ProviderProtocol {
  const value = raw.trim().toLowerCase()
  if (value.includes("openai-compatible")) return "chat-completions"
  if (value === "messages" || value.includes("anthropic")) return "messages"
  if (value === "responses" || value.endsWith("/openai")) return "responses"
  return "chat-completions"
}

export function validEndpoint(text: string): boolean {
  const value = text.trim()
  if (!/^https?:\/\//i.test(value)) return false
  try {
    return Boolean(new URL(value).hostname)
  } catch {
    return false
  }
}

export function limitOf(text: string): { ok: boolean; value?: number } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? { ok: true, value } : { ok: false }
}

export function modelLimitProblem(context: string, output: string): "integer" | "pair" | undefined {
  const a = limitOf(context)
  const b = limitOf(output)
  if (!a.ok || !b.ok) return "integer"
  if ((a.value === undefined) !== (b.value === undefined)) return "pair"
}

export const PROVIDER_PRESETS = {
  deepseek: { label: "DeepSeek", protocol: "chat-completions", baseURL: "https://api.deepseek.com" },
  "moonshotai-cn": { label: "Kimi", protocol: "chat-completions", baseURL: "https://api.moonshot.cn/v1" },
  zhipuai: { label: "Zhipu GLM", protocol: "chat-completions", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
  "alibaba-cn": { label: "Qwen", protocol: "chat-completions", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  "minimax-cn": { label: "MiniMax", protocol: "messages", baseURL: "https://api.minimaxi.com/anthropic/v1" },
  openai: { label: "OpenAI", protocol: "responses", baseURL: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", protocol: "messages", baseURL: "https://api.anthropic.com/v1" },
  openrouter: { label: "OpenRouter", protocol: "chat-completions", baseURL: "https://openrouter.ai/api/v1" },
  google: { label: "Google", protocol: "chat-completions", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  custom: { label: "自定义 / Custom", protocol: "chat-completions", baseURL: "" },
} as const satisfies Record<string, { label: string; protocol: ProviderProtocol; baseURL: string }>

export type ProviderPreset = Exclude<keyof typeof PROVIDER_PRESETS, "custom">
