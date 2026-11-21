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

/**
 * Whether the address names a server on a network the person owns.
 *
 * A box on the LAN answering OpenAI-compatible traffic - vLLM, llama.cpp,
 * ExLlama - usually has no key at all, and asking for one there teaches the
 * habit of typing `test` into the field, which leaves a config that describes a
 * credential nobody uses. For those the trust boundary is the network: nothing
 * outside it can reach the port.
 *
 * 100.64.0.0/10 counts because that is what a tailnet hands out, and a tailnet
 * is the same owned network one hop away. A public hostname does not, even when
 * DNS happens to point it somewhere private - the address in the settings field
 * is what gets judged, because that is what the person chose.
 */
export function selfHostedEndpoint(baseURL: string): boolean {
  let host: string
  try {
    host = new URL(baseURL.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return false
  }
  if (!host) return false
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true
  // IPv6 link-local and unique-local: both are only reachable inside the network.
  if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a > 255 || b > 255) return false
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return a === 100 && b >= 64 && b <= 127
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
