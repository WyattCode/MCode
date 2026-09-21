/**
 * Provider registry.
 *
 * Two kinds of provider exist. "anthropic" speaks the Messages API and carries
 * a curated model list, because those ids and their pricing are known. Everyone
 * else speaks the OpenAI-compatible shape, and their models are *discovered* at
 * runtime from GET /v1/models rather than hardcoded here - a baked-in list for
 * a third-party gateway would be wrong the week it shipped.
 */

import type { Effort, ModelModalities } from "@shared/protocol"

export type ProviderKind = "anthropic" | "openai-compatible" | "chatgpt" | "openai-responses"

/**
 * How a provider can be connected. Subscriptions authorise over OAuth; the
 * headless variant exists for machines with no browser, where the user carries
 * the redirect URL back by hand.
 */
export type AuthMethodKind = "api-key" | "oauth-browser" | "oauth-headless" | "local"

export interface ModelEntry {
  id: string
  name: string
  contextWindow: number
  /** USD per million tokens. Zero means unknown, and the cost readout hides it. */
  input: number
  output: number
  /** USD per million cached tokens read and written; absent prices count as nothing, as MiMo's do. */
  cacheRead?: number
  cacheWrite?: number
  /**
   * The dearer prices past 200k of context, where the catalog states them
   * (`cost.context_over_200k`, which MiMo carries as `experimentalOver200K`).
   * A Claude model's rates double over that line, so a long conversation's cost
   * was reported systematically low without it.
   */
  over200K?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /** MiMo's `cachePromptTTL`: a model that asks for the hour-long prompt cache. */
  cacheTTL?: "5m" | "1h"
  /** MiMo's `interleaved.field`: where an OpenAI-compatible model reads its earlier reasoning back from. */
  interleaved?: string
  /**
   * What the model can do, in the reference's own vocabulary.
   *
   * Every one of these is optional and absent means "not known", which the
   * wire boundary reads as false - the reference's own default, since each of
   * its capability reads ends in `?? false`. That matters most for `reasoning`,
   * because a model not known to reason is offered no effort control at all.
   */
  reasoning?: boolean
  attachment?: boolean
  toolCall?: boolean
  temperature?: boolean
  /** Largest single reply, in tokens. Absent means unknown. */
  maxOutput?: number
  /**
   * Input modalities, named as the reference names them. Absent means only the
   * text one is known, which is true of every chat model.
   */
  inputs?: Partial<ModelModalities>
  /**
   * The effort levels this model states outright, mirroring the reference's
   * `reasoning_options` entry of `{type: "effort", values: [...]}`.
   *
   * Absent means "nothing stated", and the reference's own per-family rules
   * work it out instead. An empty array is not the same thing: it is the
   * reference's `options.length === 0 -> return {}`, a model that reasons and
   * takes no effort parameter, so it gets no effort control at all. No model
   * this app ships is in that state - the one that was, gpt-5.3-codex-spark,
   * turned out to have been read off the wrong gateway's copy of the snapshot.
   */
  efforts?: Effort[]
}

export interface ProviderDefinition {
  id: string
  name: string
  kind: ProviderKind
  /** One line shown under the name in the connect list. */
  description: string
  baseURL?: string
  /** Ordered before the rest and marked in the UI. */
  recommended?: boolean
  /** Explicit position in the picker; lower sorts first, ties fall back to name. */
  order?: number
  /**
   * Providers that offer more than one way in - a metered API and a
   * subscription, say - share a group id and are shown as one card with a mode
   * selector, instead of competing for space as separate entries.
   */
  group?: string
  groupName?: string
  /** Label for this entry inside its group. */
  modeLabel?: string
  /**
   * Extra headers sent with every call to this provider.
   *
   * Only a custom provider has any: the reference collects them as free
   * key/value pairs precisely because the endpoints that need them - Azure's
   * `api-key`, a gateway's routing header - cannot be served by a fixed set.
   * They are spread FIRST at the call site, so a header named `authorization`
   * loses to the bearer token this app already builds, which is the reference's
   * own merge order (`{...providerHeaders(options.headers), ...input.headers}`).
   */
  headers?: Record<string, string>
  /** Models are known up front rather than fetched. */
  models?: ModelEntry[]
  /**
   * True when the model list is the user's own typing rather than anything a
   * /models endpoint returned. Discovery is skipped entirely for these, which
   * is what the reference does for a custom provider.
   */
  handEntered?: boolean
  /** Where to get a key, shown as a hint in the connect dialog. */
  keyURL?: string
  /** Ways in offered for this entry; an API key is assumed when omitted. */
  authMethods?: AuthMethodKind[]
}

/**
 * Documented MiMo ids, used only until discovery returns the live list - so a
 * blocked or slow /models call still leaves the provider selectable.
 */
const MIMO_MODELS: ModelEntry[] = [
  /*
   * Capabilities from the reference's own bundled models.dev snapshot, taken
   * as the value the majority of its copies of each entry agree on (the
   * snapshot carries one copy per gateway that resells the model, and the
   * copies disagree at the edges). MiMo-Pro is text-only where plain MiMo also
   * takes image, audio and video, which is the reference's record, not a guess.
   */
  {
    id: "mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    contextWindow: 0,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: false,
    toolCall: true,
    temperature: true,
    maxOutput: 131_072,
    inputs: { text: true },
  },
  {
    id: "mimo-v2.5",
    name: "MiMo-V2.5",
    contextWindow: 0,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: true,
    maxOutput: 131_072,
    inputs: { text: true, image: true, audio: true, video: true },
  },
]

/**
 * Fallback only - the live list is fetched after sign-in.
 *
 * The served set is not stable: models arrive and are retired between releases,
 * so anything written here is wrong within weeks. It exists so the picker is
 * not empty before the first discovery, or if that call fails. Costs stay zero
 * because a subscription is not billed per token, and the readout hides zeroes.
 */
const CODEX_MODELS: ModelEntry[] = [
  /*
   * Same source as the MiMo block above. The context windows are left at what
   * this app already had, because they describe the subscription's serving
   * limits rather than the model's and the live list overwrites them after
   * sign-in anyway - only the capability fields are adopted here.
   *
   * Each `efforts` list below is the `reasoning_options` entry the snapshot's
   * `openai` provider record carries for that id - the record these models are
   * actually served from - read out with a brace-matched extractor rather than
   * by grepping the whole file. That distinction matters: this app's catalog
   * previously gave gpt-5.3-codex-spark `efforts: []`, taken from some other
   * gateway's copy, and the openai record says
   * `[{type:"effort", values:["none","low","medium","high","xhigh"]}]`. Spark
   * showed no effort control at all as a result, and it should show five
   * levels like the rest.
   *
   * They are stated rather than left to the per-family heuristic because that
   * is the reference's own precedence: `reasoningVariants(model, base) ??
   * variants(base)` (node-BBwF64dM.js @34262883) reads the table first and
   * falls back to the rules only where the table is silent. The two disagree
   * for the gpt-5.6 tier, where the table adds `max` and the rules do not.
   */
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    contextWindow: 272_000,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    contextWindow: 272_000,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    contextWindow: 272_000,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 272_000,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
    efforts: ["none", "low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 272_000,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: true,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
    efforts: ["none", "low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    contextWindow: 272_000,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: true,
    maxOutput: 128_000,
    inputs: { text: true, image: true },
    efforts: ["none", "low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3-Codex-Spark",
    contextWindow: 128_000,
    input: 0,
    output: 0,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 16_384,
    inputs: { text: true },
    efforts: ["none", "low", "medium", "high", "xhigh"],
  },
]

/*
 * Capability fields from the reference's bundled models.dev snapshot, per
 * model, taken as the value the majority of its copies agree on. Reasoning,
 * attachment and tool calling are true across the whole Claude family; the two
 * that actually vary are `temperature` - false on the 4.7-and-later tier,
 * true on 4.6 and Haiku - and the output limit, where Sonnet 4.6 and Haiku 4.5
 * stop at 64k while the rest reach 128k.
 *
 * Per-token costs are left exactly as this app already had them: they feed
 * usage accounting, and rewriting billing figures is not what this change is.
 */
const ANTHROPIC_MODELS: ModelEntry[] = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    contextWindow: 1_000_000,
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    contextWindow: 1_000_000,
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    contextWindow: 1_000_000,
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: false,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    contextWindow: 1_000_000,
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: true,
    maxOutput: 128_000,
    inputs: { text: true, image: true, pdf: true },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    contextWindow: 1_000_000,
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: true,
    maxOutput: 64_000,
    inputs: { text: true, image: true, pdf: true },
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    reasoning: true,
    attachment: true,
    toolCall: true,
    temperature: true,
    maxOutput: 64_000,
    inputs: { text: true, image: true, pdf: true },
  },
]

export const BUILT_IN: ProviderDefinition[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    description: "provider.desc.anthropic",
    recommended: true,
    order: 0,
    models: ANTHROPIC_MODELS,
    keyURL: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai-compatible",
    description: "provider.desc.openai",
    recommended: true,
    order: 1,
    group: "openai",
    groupName: "OpenAI",
    modeLabel: "mode.api",
    baseURL: "https://api.openai.com/v1",
    keyURL: "https://platform.openai.com/api-keys",
    authMethods: ["api-key"],
  },
  {
    /**
     * A ChatGPT subscription is not the metered API with a different key: it
     * authorises over OAuth and talks to the Codex backend, which speaks the
     * Responses shape and only serves the models below. Hence its own entry.
     */
    id: "chatgpt",
    name: "ChatGPT Pro/Plus",
    kind: "chatgpt",
    description: "provider.desc.chatgpt",
    recommended: true,
    order: 1,
    group: "openai",
    groupName: "OpenAI",
    modeLabel: "mode.subscription",
    models: CODEX_MODELS,
    baseURL: "https://chatgpt.com/backend-api/codex",
    authMethods: ["oauth-browser", "oauth-headless"],
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo API",
    kind: "openai-compatible",
    description: "provider.desc.xiaomi",
    recommended: true,
    order: 2,
    group: "xiaomi",
    groupName: "Xiaomi MiMo",
    modeLabel: "mode.api",
    models: MIMO_MODELS,
    baseURL: "https://api.xiaomimimo.com/v1",
    keyURL: "https://mimo.mi.com/",
  },
  {
    /**
     * Token Plan is a separate subscription endpoint, not a mode of the
     * pay-as-you-go API - different host, different key - so it is its own
     * provider rather than a toggle.
     */
    id: "xiaomi-plan",
    name: "MiMo Token Plan",
    kind: "openai-compatible",
    description: "provider.desc.xiaomiPlan",
    order: 3,
    group: "xiaomi",
    groupName: "Xiaomi MiMo",
    modeLabel: "mode.plan",
    models: MIMO_MODELS,
    baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
    keyURL: "https://mimo.mi.com/",
  },
  {
    id: "google",
    order: 4,
    name: "Google Gemini",
    kind: "openai-compatible",
    description: "provider.desc.google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyURL: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    order: 5,
    name: "OpenRouter",
    kind: "openai-compatible",
    description: "provider.desc.openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    keyURL: "https://openrouter.ai/keys",
  },
  {
    id: "deepseek",
    order: 6,
    name: "DeepSeek",
    kind: "openai-compatible",
    description: "provider.desc.deepseek",
    baseURL: "https://api.deepseek.com/v1",
    keyURL: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "moonshot",
    order: 7,
    name: "Kimi / Moonshot",
    kind: "openai-compatible",
    description: "provider.desc.moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    keyURL: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "zhipu",
    order: 8,
    name: "Zhipu GLM",
    kind: "openai-compatible",
    description: "provider.desc.zhipu",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    keyURL: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "dashscope",
    order: 9,
    name: "Qwen",
    kind: "openai-compatible",
    description: "provider.desc.dashscope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyURL: "https://bailian.console.aliyun.com/",
  },
  {
    id: "xai",
    order: 26,
    name: "xAI",
    kind: "openai-compatible",
    description: "provider.desc.xai",
    baseURL: "https://api.x.ai/v1",
    keyURL: "https://console.x.ai/",
  },
  {
    id: "groq",
    order: 27,
    name: "Groq",
    kind: "openai-compatible",
    description: "provider.desc.groq",
    baseURL: "https://api.groq.com/openai/v1",
    keyURL: "https://console.groq.com/keys",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    kind: "openai-compatible",
    description: "provider.desc.siliconflow",
    order: 10,
    baseURL: "https://api.siliconflow.cn/v1",
    keyURL: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "volcengine",
    name: "Volcengine Ark",
    kind: "openai-compatible",
    description: "provider.desc.volcengine",
    order: 11,
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    keyURL: "https://console.volcengine.com/ark",
  },
  {
    id: "minimax",
    name: "MiniMax",
    kind: "openai-compatible",
    description: "provider.desc.minimax",
    order: 12,
    baseURL: "https://api.minimaxi.com/v1",
    keyURL: "https://platform.minimaxi.com/user-center/basic-information",
  },
  {
    id: "stepfun",
    name: "StepFun",
    kind: "openai-compatible",
    description: "provider.desc.stepfun",
    order: 13,
    baseURL: "https://api.stepfun.com/v1",
    keyURL: "https://platform.stepfun.com/",
  },
  {
    id: "hunyuan",
    name: "Tencent Hunyuan",
    kind: "openai-compatible",
    description: "provider.desc.hunyuan",
    order: 14,
    baseURL: "https://api.hunyuan.cloud.tencent.com/v1",
    keyURL: "https://console.cloud.tencent.com/hunyuan/api-key",
  },
  {
    id: "qianfan",
    name: "Baidu Qianfan",
    kind: "openai-compatible",
    description: "provider.desc.qianfan",
    order: 15,
    baseURL: "https://qianfan.baidubce.com/v2",
    keyURL: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    kind: "openai-compatible",
    description: "provider.desc.mistral",
    order: 20,
    baseURL: "https://api.mistral.ai/v1",
    keyURL: "https://console.mistral.ai/api-keys",
  },
  {
    id: "together",
    name: "Together AI",
    kind: "openai-compatible",
    description: "provider.desc.together",
    order: 21,
    baseURL: "https://api.together.xyz/v1",
    keyURL: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "openai-compatible",
    description: "provider.desc.fireworks",
    order: 22,
    baseURL: "https://api.fireworks.ai/inference/v1",
    keyURL: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai-compatible",
    description: "provider.desc.cerebras",
    order: 23,
    baseURL: "https://api.cerebras.ai/v1",
    keyURL: "https://cloud.cerebras.ai/",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "openai-compatible",
    description: "provider.desc.perplexity",
    order: 24,
    baseURL: "https://api.perplexity.ai",
    keyURL: "https://www.perplexity.ai/settings/api",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "openai-compatible",
    description: "provider.desc.nvidia",
    order: 25,
    baseURL: "https://integrate.api.nvidia.com/v1",
    keyURL: "https://build.nvidia.com/",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai-compatible",
    description: "provider.desc.lmstudio",
    order: 40,
    baseURL: "http://127.0.0.1:1234/v1",
    authMethods: ["local"],
  },
  {
    id: "vllm",
    name: "vLLM",
    kind: "openai-compatible",
    description: "provider.desc.vllm",
    order: 41,
    baseURL: "http://127.0.0.1:8000/v1",
    authMethods: ["local"],
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai-compatible",
    description: "provider.desc.ollama",
    order: 42,
    baseURL: "http://127.0.0.1:11434/v1",
    authMethods: ["local"],
  },
]

/**
 * Which models.dev provider describes each built-in's models - matched by the
 * endpoint each one serves, the mainland one where models.dev lists two. A
 * provider missing here (and every custom provider) has no models.dev record,
 * as a provider id models.dev does not know has none in MiMo.
 */
export const MODELS_DEV_IDS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  chatgpt: "openai",
  xiaomi: "xiaomi",
  "xiaomi-plan": "xiaomi-token-plan-cn",
  google: "google",
  openrouter: "openrouter",
  deepseek: "deepseek",
  moonshot: "moonshotai-cn",
  zhipu: "zhipuai",
  dashscope: "alibaba-cn",
  xai: "xai",
  groq: "groq",
  siliconflow: "siliconflow-cn",
  volcengine: "volcengine",
  minimax: "minimax-cn",
  stepfun: "stepfun",
  mistral: "mistral",
  together: "togetherai",
  fireworks: "fireworks-ai",
  cerebras: "cerebras",
  perplexity: "perplexity",
  nvidia: "nvidia",
  lmstudio: "lmstudio",
}

export function definition(id: string): ProviderDefinition | undefined {
  return BUILT_IN.find((entry) => entry.id === id)
}
