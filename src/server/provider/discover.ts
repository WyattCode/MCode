import { normalizeProviderProtocol, validEndpoint } from "@shared/custom-endpoint"
import type { ModelCandidate } from "@shared/protocol"
import type { ModelEntry, ProviderDefinition } from "./catalog"
import { nameFromId } from "./model-name"

/**
 * Discovers the model list for an OpenAI-compatible provider.
 *
 * Hardcoding a catalog for a third-party gateway goes stale immediately, so the
 * list comes from the provider itself. Pricing is not part of that response, so
 * discovered models report zero cost and the UI omits the figure rather than
 * showing a made-up one.
 */

const TIMEOUT = 15_000

/**
 * One row of /v1/models.
 *
 * The capability fields are the ones the reference reads off an OpenRouter-
 * shaped response (node-BBwF64dM.js @20784116): `supported_features`,
 * `input_modalities`, `supported_sampling_parameters`, `max_output_length`.
 * Most providers send none of them, and the reference's answer to that is not
 * to guess - every read there ends in `?? template?.capabilities.*`, falling
 * back to what the catalog already knows and then to false.
 */
interface ModelRow {
  id?: string
  context_length?: number
  context_window?: number
  /**
   * vLLM's and SGLang's name for the same number, and the only one they send.
   * A local server that reported 262,144 here was read as having no window at
   * all, so nothing could be compacted before it refused a request.
   */
  max_model_len?: number
  max_output_length?: number
  supported_features?: string[]
  supported_parameters?: string[]
  supported_sampling_parameters?: string[]
  input_modalities?: string[]
}

interface ModelsResponse {
  data?: ModelRow[]
}

/**
 * LM Studio's own model list, which carries the context length its
 * OpenAI-compatible one leaves out.
 *
 * `/v1/models` there reports nothing but an id, so every local model arrived
 * with a window of zero - and anything that divides by the window, such as the
 * context gauge on a session, had nothing to divide by. The native endpoint
 * sits alongside it on the same host and answers the same question properly.
 */
interface NativeModelsResponse {
  data?: { id?: string; loaded_context_length?: number; max_context_length?: number }[]
}

/**
 * Context lengths by model id, or an empty map if this is not LM Studio.
 *
 * `loaded_context_length` is preferred over `max_context_length`: the loaded
 * figure is what the model will actually accept right now, and the maximum is
 * often several times larger than what was loaded.
 */
async function nativeWindows(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  // Same origin, different API root: .../v1 becomes .../api/v0.
  const native = root.replace(/\/v1$/, "/api/v0")
  if (native === root) return out

  const response = await fetch(`${native}/models`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch(() => undefined)
  if (!response?.ok) return out

  const body = (await response.json().catch(() => ({}))) as NativeModelsResponse
  for (const row of body.data ?? []) {
    const window = row.loaded_context_length ?? row.max_context_length
    if (row.id && window) out.set(row.id, window)
  }
  return out
}

/**
 * Whether an id names something you can hold a conversation with.
 *
 * A provider's model list is everything it serves, not everything it can chat
 * with: embedding, reranking, speech and image models come back alongside the
 * ones that do. Offering them in a model picker is offering a session that
 * fails on the first message.
 */
export function conversational(id: string): boolean {
  const lower = id.toLowerCase()
  const NOT_CHAT = [
    "embed",
    "embedding",
    "rerank",
    "reranker",
    "whisper",
    "-tts",
    "tts-",
    "text-to-speech",
    "speech-to-text",
    "-stt",
    "-asr",
    "voiceclone",
    "voicedesign",
    "moderation",
    "dall-e",
    "stable-diffusion",
    "-vae",
    "-ocr",
  ]
  return !NOT_CHAT.some((mark) => lower.includes(mark))
}

/**
 * What one row of /v1/models says about a model, over what the catalog knows.
 *
 * Follows the reference field for field, including the part that looks like an
 * omission: when a provider says nothing about reasoning the answer is false,
 * not "probably yes". A model wrongly marked as reasoning gets an effort
 * control whose settings the provider silently drops, which is precisely the
 * defect the per-model list exists to remove.
 */
function capabilities(row: ModelRow | undefined, template: ModelEntry | undefined): Partial<ModelEntry> {
  const features = row?.supported_features ?? row?.supported_parameters
  const sampling = row?.supported_sampling_parameters ?? row?.supported_parameters
  const modalities = row?.input_modalities
  const inputs = modalities
    ? {
        text: modalities.includes("text"),
        image: modalities.includes("image"),
        audio: modalities.includes("audio"),
        video: modalities.includes("video"),
        pdf: modalities.includes("pdf") || modalities.includes("file"),
      }
    : template?.inputs
  return {
    reasoning: features?.includes("reasoning") ?? template?.reasoning ?? false,
    toolCall: features?.includes("tools") ?? features?.includes("tool_choice") ?? template?.toolCall ?? false,
    temperature: sampling?.includes("temperature") ?? template?.temperature ?? false,
    // The reference derives this the same way: anything beyond text is an
    // attachment the model will take.
    attachment: modalities
      ? modalities.some((entry) => entry !== "text")
      : (template?.attachment ?? false),
    maxOutput: row?.max_output_length ?? template?.maxOutput ?? 0,
    inputs,
    efforts: template?.efforts,
  }
}

export async function discoverModels(
  provider: ProviderDefinition,
  apiKey: string,
  baseURL?: string,
): Promise<ModelEntry[]> {
  const root = (baseURL ?? provider.baseURL ?? "").replace(/\/+$/, "")
  if (!root) throw new Error(`${provider.name} has no base URL configured`)

  const response = await fetch(`${root}/models`, {
    headers: {
      // Provider headers go on first so a custom provider cannot displace the
      // bearer token or the Accept this call depends on - the reference's own
      // merge order at offset 22312491. A header-authenticated provider has no
      // key here, and writing `Bearer ` over its own authorization header
      // breaks it (see the same guard in openai.ts).
      ...provider.headers,
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((err: Error) => {
    throw new Error(`Could not reach ${provider.name}: ${err.message}`)
  })

  if (!response.ok) {
    const detail = response.status === 401 ? "the key was rejected" : `HTTP ${response.status}`
    throw new Error(`${provider.name} did not return a model list - ${detail}`)
  }

  const body = (await response.json().catch(() => ({}))) as ModelsResponse
  const rows = Array.isArray(body.data) ? body.data : []

  // Best-effort: a provider that has no such endpoint simply yields nothing.
  const native = await nativeWindows(root)

  const models = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter(conversational)
    .map<ModelEntry>((id) => {
      const row = rows.find((entry) => entry.id === id)
      const template = provider.models?.find((entry) => entry.id === id)
      return {
        id,
        // Cased here too, so a list is presentable even before the merge sees it.
        name: nameFromId(id),
        // Providers disagree on the field name, and many omit it entirely.
        contextWindow:
          row?.context_length ?? row?.context_window ?? row?.max_model_len ?? native.get(id) ?? 0,
        input: 0,
        output: 0,
        ...capabilities(row, template),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  if (models.length === 0) {
    const served = rows.length
    throw new Error(
      served
        ? `${provider.name} serves ${served} model(s), but none of them are chat models`
        : `${provider.name} returned an empty model list`,
    )
  }
  return models
}

/** MiMo 26.920's 测试连接: ten seconds for `/models` to answer. */
export const PROBE_TIMEOUT = 10_000

function positiveLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** The model candidates returned by the endpoint, or the probe failure. */
export type ProbeResult = { ok: true; models: (string | ModelCandidate)[] } | { ok: false; reason: "http"; status: number } | { ok: false; reason: "json" | "timeout" } | { ok: false; reason: "network"; message: string }

/**
 * MiMo 26.920's 测试连接: `GET <base>/models` with the key, and the ids it
 * lists - strings, or rows carrying `id` or `model`, in an array or wrapped under `data` or `models`.
 * Every id is kept, chat model or not: this is a check that the address and key
 * work, and the list offers candidates with whatever metadata the endpoint provides.
 *
 * An Anthropic gateway takes its key as `x-api-key` with a version header, so
 * the other protocols use bearer authentication.
 */
export async function probeModels(input: {
  baseURL: string
  apiKey: string
  headers?: Record<string, string>
  protocol?: string
  fetcher?: typeof fetch
  timeout?: number
}): Promise<ProbeResult> {
  if (!validEndpoint(input.baseURL)) return { ok: false, reason: "network", message: "Invalid HTTP(S) URL" }
  const url = new URL(input.baseURL.trim())
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`
  const key = input.apiKey.trim()
  const messages = normalizeProviderProtocol(input.protocol) === "messages"
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
  headers.accept = "application/json"
  if (messages) {
    if (key) {
      delete headers.authorization
      headers["x-api-key"] = key
    }
    headers["anthropic-version"] = "2023-06-01"
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }
  const signal = AbortSignal.timeout(input.timeout ?? PROBE_TIMEOUT)
  let response: Response
  try {
    response = await (input.fetcher ?? fetch)(url.href, { method: "GET", headers, signal, redirect: "manual" })
  } catch (err) {
    if (signal.aborted || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) return { ok: false, reason: "timeout" }
    return { ok: false, reason: "network", message: "Network request failed" }
  }
  if (!response.ok) return { ok: false, reason: "http", status: response.status }
  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    if (signal.aborted) return { ok: false, reason: "timeout" }
    return err instanceof SyntaxError ? { ok: false, reason: "json" } : { ok: false, reason: "network", message: "Could not read response" }
  }
  const record = body && typeof body === "object" ? (body as { data?: unknown; models?: unknown }) : {}
  const rows: unknown[] = Array.isArray(body) ? body : Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : []
  const models = new Map<string, string | ModelCandidate>()
  for (const row of rows) {
    if (typeof row === "string") {
      if (row && !models.has(row)) models.set(row, row)
      continue
    }
    if (!row || typeof row !== "object") continue
    const fields = row as Record<string, unknown>
    const id = fields.id ?? fields.model
    if (typeof id !== "string" || !id) continue
    const name = [fields.name, fields.display_name].find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    const contextWindow = [fields.contextWindow, fields.context_length, fields.context_window, fields.max_model_len].find(positiveLimit)
    const maxOutput = [fields.maxOutput, fields.max_output_length].find(positiveLimit)
    const explicit = fields.inputs && typeof fields.inputs === "object" ? fields.inputs as Record<string, unknown> : undefined
    const inputs: NonNullable<ModelCandidate["inputs"]> = {}
    for (const modality of ["image", "audio", "video", "pdf"] as const) {
      const supported = explicit?.[modality]
      if (typeof supported === "boolean") inputs[modality] = supported
      else if (Array.isArray(fields.input_modalities)) inputs[modality] = fields.input_modalities.includes(modality)
    }
    const metadata = {
      ...(name ? { name: name.trim() } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      ...(Object.keys(inputs).length ? { inputs } : {}),
    }
    const previous = models.get(id)
    if (Object.keys(metadata).length) {
      models.set(id, { id, ...(typeof previous === "object" ? previous : {}), ...metadata })
    } else if (!previous) {
      models.set(id, id)
    }
  }
  return { ok: true, models: [...models.values()] }
}

/**
 * Discovers what a ChatGPT subscription is allowed to run.
 *
 * The Codex backend answers with its own shape - `models[]` carrying `slug`
 * rather than an OpenAI-style `data[]` of `id` - so it cannot reuse the call
 * above. Worth doing rather than shipping a list: the served set moves (models
 * appear and are retired between releases), and a stale catalog shows people
 * models they cannot pick and hides the ones they pay for.
 */
interface CodexModelsResponse {
  models?: { slug?: string; display_name?: string; context_window?: number }[]
}

export async function discoverSubscriptionModels(
  baseURL: string,
  accessToken: string,
  accountId?: string,
): Promise<ModelEntry[]> {
  const root = baseURL.replace(/\/+$/, "")
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  }
  if (accountId) headers["chatgpt-account-id"] = accountId

  const response = await fetch(`${root}/models`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!response.ok) throw new Error(`models:${response.status}`)

  const body = (await response.json().catch(() => ({}))) as CodexModelsResponse
  return (body.models ?? [])
    .filter((model): model is { slug: string; display_name?: string; context_window?: number } =>
      Boolean(model.slug),
    )
    // A subscription is not billed per token, so cost stays zero throughout.
    .map((model) => ({
      id: model.slug,
      name: model.display_name ?? nameFromId(model.slug),
      contextWindow: model.context_window ?? 0,
      input: 0,
      output: 0,
    }))
}
