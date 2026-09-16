/**
 * Round 9, providers and models: what differs per model family on the wire,
 * and how endpoints, model ids, fallbacks and the model catalog behave.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundNineProviderChecks` with its own check and section. Every model reads
 * the same agent prompt (smoke-round8's M1 checks); what still differs per
 * family is the request shaping checked first here.
 */
import type { Check } from "./smoke-round5"
import { engine, say } from "./smoke-round5"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { messagesRequest } from "../src/server/provider/anthropic"
import { OpenAICompatible } from "../src/server/provider/openai"
import { menuEfforts } from "../src/shared/effort-menu"
import { normalizeBaseURL } from "../src/shared/custom-endpoint"
import { fallbackModel } from "../src/shared/model-fallback"
import { customModelOf } from "../src/server/config"
import { startBackend } from "../src/server/index"
import { handle } from "../src/server/handlers"
import type { Request } from "../src/shared/protocol"
import { connectableProviders, providerLabel, quickAddGroups } from "../src/renderer/src/lib/connect"
import { language } from "../src/renderer/src/lib/i18n"
import { readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { imageInputOf, overlayCatalog, trimCatalog, type Catalog } from "../src/shared/models-dev"
import { CATALOG_FRESH_MS, CATALOG_REFRESH_MS, CATALOG_SOURCE, CATALOG_TIMEOUT_MS, ModelCatalog, shippedCatalog } from "../src/server/provider/models-dev"

/** A catalog with one provider and the given models, in models.dev's own shape. */
function catalogOf(pid: string, models: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return { [pid]: { id: pid, name: pid, models: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { id, ...model }])) } }
}

/** A local models.dev: answers /api.json with whatever `answer` holds, and counts the requests. */
async function fakeModelsDev() {
  const state = { hits: 0, status: 200, body: catalogOf("deepseek", { "deepseek-chat": { name: "Served", limit: { context: 1234, output: 56 } } }) as unknown }
  const server = createServer((request, response) => {
    state.hits += 1
    if (request.url !== "/api.json") return void response.writeHead(404).end()
    response.writeHead(state.status, { "content-type": "application/json" })
    response.end(typeof state.body === "string" ? state.body : JSON.stringify(state.body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { state, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** How a handler call failed: its code and the values its sentence fills in. */
async function refusal(run: () => Promise<unknown>): Promise<{ code?: string; params?: Record<string, unknown> }> {
  try {
    await run()
    return {}
  } catch (err) {
    return { code: (err as { code?: string }).code, params: (err as { params?: Record<string, unknown> }).params }
  }
}

export async function roundNineProviderChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 9 (P9-1): the effort submenu appears only where MiMo's desktop shows it")
  {
    /* Written out by hand from MiMo's rule, id and display name together. */
    const table: [string, string, string][] = [
      ["claude-opus-4-7", "", "low,medium,high,xhigh,max"],
      ["claude-opus-4.8", "", "low,medium,high,xhigh,max"],
      ["claude-sonnet-5", "", "low,medium,high,xhigh,max"],
      ["claude-fable-5", "", "low,medium,high,xhigh,max"],
      ["claude-opus-4-6", "", "low,medium,high,max"],
      ["claude-sonnet-4.6", "", "low,medium,high,max"],
      ["claude-mythos-preview", "", "low,medium,high,max"],
      ["claude-sonnet-4-5", "", "low,medium,high"],
      ["claude-haiku-4-5", "", "low,medium,high"],
      ["claude-3-7-sonnet", "", "low,medium,high"],
      ["claude-3-5-sonnet", "", ""],
      ["gpt-5", "", "low,medium,high"],
      ["gpt-5.1-codex", "", "low,medium,high"],
      ["gpt-5.2", "", "low,medium,high,xhigh"],
      ["gpt-5.6-sol", "", "low,medium,high,xhigh,max"],
      ["gpt-5-chat-latest", "", ""],
      ["gpt-5-pro", "", ""],
      ["gpt-4o", "", ""],
      ["gpt-oss-120b", "", ""],
      ["codex-mini", "", ""],
      ["mimo-v2.5-pro", "MiMo-V2.5-Pro", ""],
      ["deepseek-reasoner", "", ""],
      ["gemini-3-pro", "", ""],
      ["kimi-k2.5", "", ""],
      ["glm-4.6", "", ""],
      ["my-gateway-model", "Claude Opus 4-7 via gateway", ""],
      ["my-gateway-model", "claude-opus-4-7", "low,medium,high,xhigh,max"],
      ["relay", "GPT_5 relay", ""],
      ["relay", "GPT-5 Codex relay", "low,medium,high"],
    ]
    const wrong = table.filter(([id, name, want]) => menuEfforts(id, name).join() !== want)
    check(`all ${table.length} ids offer MiMo's levels`, wrong.length === 0, wrong.map(([id, name]) => `${id}|${name} -> ${menuEfforts(id, name).join()}`))
    check("none or minimal is never offered", table.every(([id, name]) => !menuEfforts(id, name).some((level) => level === "none" || level === "minimal")))

    const e = await engine({ custom: { models: [{ id: "claude-opus-4-7", name: "C" }, { id: "mimo-v2.5-pro", name: "MiMo" }, { id: "gpt-5.6-sol", name: "G" }] } })
    try {
      const listed = e.config.providers().find((entry) => entry.id === "fake")?.models ?? []
      const levels = (id: string) => listed.find((model) => model.id === id)?.variants.join()
      check("the window is sent the menu's levels, even for a hand-entered model", levels("claude-opus-4-7") === "low,medium,high,xhigh,max" && levels("gpt-5.6-sol") === "low,medium,high,xhigh,max", listed.map((model) => model.variants))
      check("and none for a MiMo model", levels("mimo-v2.5-pro") === "", levels("mimo-v2.5-pro"))
      const xiaomiMenu = e.config.providers().find((entry) => entry.id === "xiaomi")?.models.map((model) => model.variants.length)
      check("the built-in MiMo models offer no submenu either", Boolean(xiaomiMenu?.length) && xiaomiMenu!.every((count) => count === 0), xiaomiMenu)

      /* A built-in MiMo model reasons, but the menu offers nothing, so no level goes out. */
      await e.config.set({ providerEndpoints: { xiaomi: `http://127.0.0.1:${e.port}/v1`, openai: `http://127.0.0.1:${e.port}/v1` }, effort: "high" })
      await e.config.setApiKey("xiaomi", "k")
      const mimo = await e.store.create({ directory: e.project, model: { provider: "xiaomi", model: "mimo-v2.5-pro" } })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: mimo.id, text: "hello" })
      await e.idle(mimo.id)
      check("a MiMo model is sent no reasoning level", e.bodies.at(-1)?.model === "mimo-v2.5-pro" && !("reasoning_effort" in (e.bodies.at(-1) ?? {})), e.bodies.at(-1)?.reasoning_effort)
      const saved = (await e.assistants(mimo.id)).at(-1)
      check("and its reply records no level", saved?.effort === undefined, saved?.effort)

      /* A GPT-5 model does get one, clamped to its menu. */
      await e.config.setApiKey("openai", "k")
      await e.config.setDiscovered("openai", [{ id: "gpt-5", name: "GPT-5", contextWindow: 400_000, input: 0, output: 0, reasoning: true }])
      const gpt = await e.store.create({ directory: e.project, model: { provider: "openai", model: "gpt-5" } })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: gpt.id, text: "hello" })
      await e.idle(gpt.id)
      check("a GPT-5 model is sent the chosen level", e.bodies.at(-1)?.reasoning_effort === "high", e.bodies.at(-1)?.reasoning_effort)
      await e.config.set({ effort: "max" })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: gpt.id, text: "again" })
      await e.idle(gpt.id)
      check("and a level its menu lacks falls to medium", e.bodies.at(-1)?.reasoning_effort === "medium", e.bodies.at(-1)?.reasoning_effort)
    } finally {
      await e.close()
    }
  }

  section("Round 9 (P9-2): a custom provider's address and model ids are tidied as MiMo tidies them")
  {
    const cases: [string, string][] = [
      ["https://x.example/v1", "https://x.example/v1"],
      ["  https://x.example/v1/  ", "https://x.example/v1"],
      ["https://x.example/v1/chat/completions", "https://x.example/v1"],
      ["https://x.example/v1/Chat/Completions/", "https://x.example/v1"],
      ["https://x.example/v1/completions", "https://x.example/v1"],
      ["https://x.example/openai//", "https://x.example/openai"],
    ]
    const off = cases.filter(([raw, want]) => normalizeBaseURL(raw) !== want)
    check("the address loses trailing slashes and a pasted completions path", off.length === 0, off.map(([raw]) => `${raw} -> ${normalizeBaseURL(raw)}`))
    check("a model id loses every blank, inside ones too", customModelOf({ id: " qwen3 coder\t30b ", name: " Q " }).id === "qwen3coder30b" && customModelOf({ id: "a", name: " Q " }).name === "Q")

    /* An address stored before the rule still reaches the right path. */
    const e = await engine({})
    try {
      const stored = e.config.get().customProviders[0]!
      await e.config.set({ customProviders: [{ ...stored, baseURL: `${stored.baseURL}/chat/completions/` }] })
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: session.id, text: "hello" })
      await e.idle(session.id)
      check("a stored full completions URL is requested once, not twice", e.paths.at(-1) === "/v1/chat/completions", e.paths.at(-1))
      check("and the stored text itself is left as it was", e.config.get().customProviders[0]!.baseURL.endsWith("/chat/completions/"))
    } finally {
      await e.close()
    }

    const data = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r9p-"))
    const backend = await startBackend(data)
    try {
      await handle(backend.runtime, {
        type: "provider.addCustom",
        id: "gw",
        name: "Gateway",
        baseURL: " https://gw.example/v1/chat/completions ",
        apiKey: "k",
        models: [{ id: "gpt 5", name: "G" }],
      } as unknown as Request)
      const saved = backend.runtime.config.get().customProviders.find((entry) => entry.id === "gw")
      check("adding one saves the tidied address and id", saved?.baseURL === "https://gw.example/v1" && saved?.models?.[0]?.id === "gpt5", saved)
      await handle(backend.runtime, {
        type: "provider.updateCustom",
        id: "gw",
        name: "Gateway",
        baseURL: "https://gw.example/v2/completions/",
        apiKey: "",
        models: [{ id: " gpt-5 ", name: "G" }],
      } as unknown as Request)
      const edited = backend.runtime.config.get().customProviders.find((entry) => entry.id === "gw")
      check("and so does editing it", edited?.baseURL === "https://gw.example/v2" && edited?.models?.[0]?.id === "gpt-5", edited)

      /* P9-9: the refusals are named, so the window says them in its own language. */
      const request = (body: Record<string, unknown>) => () => handle(backend.runtime, body as unknown as Request)
      const bad = await refusal(request({ type: "provider.addCustom", id: "Bad Id", name: "x", baseURL: "https://a.example/v1", apiKey: "", models: [{ id: "m", name: "m" }] }))
      check("(P9-9) a bad provider id is refused by code", bad.code === "provider.custom.error.providerID.format", bad)
      const taken = await refusal(request({ type: "provider.addCustom", id: "gw", name: "x", baseURL: "https://a.example/v1", apiKey: "", models: [{ id: "m", name: "m" }] }))
      check("(P9-9) so is a taken one", taken.code === "provider.custom.error.providerID.exists", taken)
      const empty = await refusal(request({ type: "provider.addCustom", id: "gw2", name: "x", baseURL: "https://a.example/v1", apiKey: "", models: [] }))
      check("(P9-9) and a provider with no model", empty.code === "provider.needsModel", empty)
      const limit = await refusal(request({ type: "provider.addCustom", id: "gw3", name: "x", baseURL: "https://a.example/v1", apiKey: "", models: [{ id: "m", name: "m", limit: { context: -1 } }] }))
      check("(P9-9) and a bad limit", limit.code === "provider.custom.limitInvalid", limit)
      const typed = await refusal(request({ type: "provider.discover", provider: "gw" }))
      check("(P9-9) refreshing hand-entered models names the provider", typed.code === "provider.nothingToDiscover" && typed.params?.name === "Gateway", typed)
      const missing = await refusal(request({ type: "provider.updateCustom", id: "nope", name: "x", baseURL: "https://a.example/v1", apiKey: "", models: [{ id: "m", name: "m" }] }))
      check("(P9-9) editing a provider that is gone", missing.code === "provider.notFound", missing)
      const before = process.env.DEEPSEEK_API_KEY
      process.env.DEEPSEEK_API_KEY = "from-the-shell"
      try {
        const env = await refusal(request({ type: "provider.auth", provider: "deepseek", apiKey: "" }))
        check("(P9-9) disconnecting a provider the shell connects names the variable", env.code === "provider.envConnected" && env.params?.variable === "DEEPSEEK_API_KEY", env)
      } finally {
        if (before === undefined) delete process.env.DEEPSEEK_API_KEY
        else process.env.DEEPSEEK_API_KEY = before
      }
    } finally {
      await backend.close()
      await fs.rm(data, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  section("Round 9 (P9-3, P9-4): a conversation whose model has gone moves to one that is there")
  {
    const pick = (refs: string[], prefer?: string) => {
      const found = fallbackModel(refs.map((ref) => ({ provider: ref.split("/")[0]!, model: ref.slice(ref.indexOf("/") + 1) })), prefer)
      return found ? `${found.provider}/${found.model}` : ""
    }
    check("(P9-4) a MiMo Pro model is preferred", pick(["a/qwen3", "xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro"]) === "xiaomi/mimo-v2.5-pro")
    check("(P9-4) otherwise the first model there is", pick(["a/qwen3", "b/mimo-v2.5"]) === "a/qwen3")
    check("(P9-4) the words must be whole: promo or mimosa do not count", pick(["a/x", "b/mimosa-promo"]) === "a/x")
    check("(P9-4) a provider just connected comes first", pick(["xiaomi/mimo-v2.5-pro", "fresh/qwen3"], "fresh") === "fresh/qwen3")
    check("(P9-4) and its own MiMo Pro before its others", pick(["fresh/qwen3", "fresh/mimo-v2-pro"], "fresh") === "fresh/mimo-v2-pro")
    check("(P9-4) nothing to pick is nothing", pick([]) === "")

    const e = await engine({ custom: { models: [{ id: "m", name: "M" }, { id: "gone", name: "Gone" }] } })
    try {
      await e.config.set({ model: { provider: "fake", model: "m" } })
      const dropped = await e.store.create({ directory: e.project, model: { provider: "fake", model: "gone" } })
      const removed = await e.store.create({ directory: e.project, model: { provider: "old-gateway", model: "x" } })
      const stored = e.config.get().customProviders[0]!
      await e.config.set({ customProviders: [{ ...stored, models: [{ id: "m", name: "M" }] }] })
      for (const session of [dropped, removed]) {
        e.replies.push(say("ok"))
        await e.runner.prompt({ sessionID: session.id, text: "hello" })
        await e.idle(session.id)
        check(`(P9-3) a conversation on ${session.model.provider}/${session.model.model} runs on the app's model`, e.bodies.at(-1)?.model === "m", e.bodies.at(-1)?.model)
        const after = await e.store.get(session.id)
        check("(P9-3) and keeps it from then on", after?.model.provider === "fake" && after.model.model === "m", after?.model)
      }
      await e.config.set({ customProviders: [{ ...stored, models: [{ id: "m", name: "M" }, { id: "other", name: "O" }] }] })
      const own = await e.store.create({ directory: e.project, model: { provider: "fake", model: "other" } })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: own.id, text: "hello" })
      await e.idle(own.id)
      check("(P9-3) a conversation whose model is still there keeps it", e.bodies.at(-1)?.model === "other" && (await e.store.get(own.id))?.model.model === "other")
    } finally {
      await e.close()
    }
  }

  section("Round 9 (P9-5): quick add offers MiMo's seven vendors, named as MiMo names them")
  {
    const e = await engine({})
    try {
      const providers = e.config.providers()
      const chips = quickAddGroups(providers)
      check(
        "seven chips, in MiMo's order, each opening one provider",
        chips.map((chip) => chip.id).join() === "xiaomi,xiaomi-plan,deepseek,moonshot,zhipu,dashscope,minimax" && chips.every((chip) => chip.entries.length === 1),
        chips.map((chip) => chip.id),
      )
      const before = language.value
      try {
        language.value = "en"
        check("named as MiMo names them", quickAddGroups(providers).map((chip) => chip.name).join("|") === "Xiaomi MiMo API|MiMo Token Plan|DeepSeek|Kimi / Moonshot|Zhipu GLM|Qwen|MiniMax", chips.map((chip) => chip.name))
        language.value = "zh-CN"
        check("with GLM and Qwen in Chinese where MiMo translates them", quickAddGroups(providers).map((chip) => chip.name).slice(4, 6).join("|") === "智谱 GLM|千问")
        language.value = "zh-TW"
        check("in both Chinese tables", providerLabel({ id: "zhipu", name: "Zhipu GLM" }) === "智譜 GLM" && providerLabel({ id: "dashscope", name: "Qwen" }) === "千問")
        language.value = "de"
        check("and in their own names elsewhere", providerLabel({ id: "dashscope", name: "Qwen" }) === "Qwen" && providerLabel({ id: "openai", name: "OpenAI" }) === "OpenAI")
      } finally {
        language.value = before
      }
      const offered = connectableProviders(providers).map((entry) => entry.id)
      check("the connect dialog offers the same seven and the ChatGPT sign-in, nothing else", offered.sort().join() === "chatgpt,dashscope,deepseek,minimax,moonshot,xiaomi,xiaomi-plan,zhipu", offered)
      check("MiniMax is reached at its current domain", providers.find((entry) => entry.id === "minimax")?.baseURL === "https://api.minimaxi.com/v1")
      const settings = readFileSync("src/renderer/src/components/SettingsDialog.vue", "utf8")
      const connect = readFileSync("src/renderer/src/components/ConnectDialog.vue", "utf8")
      check("the settings page draws its chips from that list", /const presetGroups = computed\(\(\) => quickAddGroups\(app\.providers\)\)/.test(settings))
      check("and the connect dialog lists only what it offers", /groupProviders\(connectableProviders\(app\.providers\)\)/.test(connect))
      /* A provider connected before still shows as added, and a moved address the user set stays theirs. */
      await e.config.set({ providerEndpoints: { minimax: "https://my-proxy.example/v1" } })
      await e.config.setApiKey("groq", "k")
      const after = e.config.providers()
      check("an override of the MiniMax address is kept", after.find((entry) => entry.id === "minimax")?.baseURL === "https://my-proxy.example/v1")
      check("a connected provider off the list is still connected", after.find((entry) => entry.id === "groq")?.configured === true)
    } finally {
      await e.close()
    }
  }

  section("Round 9 (P9-10): the models.dev catalog - shipped, cached, refreshed hourly, never in the way")
  {
    check("MiMo's address, timing and timeout", CATALOG_SOURCE === "https://models.dev" && CATALOG_FRESH_MS === 300_000 && CATALOG_REFRESH_MS === 3_600_000 && CATALOG_TIMEOUT_MS === 10_000)
    const shipped = trimCatalog(await shippedCatalog())
    const shippedModels = Object.values(shipped).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0)
    check("a copy ships with the app, with thousands of models", shippedModels > 3_000, shippedModels)
    check("it covers the vendors quick add offers", ["xiaomi", "deepseek", "moonshotai-cn", "zhipuai", "alibaba-cn", "minimax-cn"].every((id) => Object.keys(shipped[id]?.models ?? {}).length > 0))
    const size = statSync("resources/models-snapshot.json").size
    check("and it holds only the fields MCode reads (under 4 MB)", size < 4_000_000 && !readFileSync("resources/models-snapshot.json", "utf8").includes('"knowledge"'), size)

    let refused = ""
    try {
      trimCatalog({ a: { id: "b", models: {} } })
    } catch (error) {
      refused = String(error)
    }
    check("a catalog whose keys and ids disagree is refused", refused.includes("identity"))
    let empty = ""
    try {
      trimCatalog({ a: { id: "a", models: {} } })
    } catch (error) {
      empty = String(error)
    }
    check("and so is one without a single model", empty.includes("no models"))
    const laid = overlayCatalog(
      trimCatalog(catalogOf("p", { kept: { name: "Old", limit: { context: 10, output: 5 } }, dropped: { name: "Gone" } })),
      trimCatalog(catalogOf("p", { kept: { limit: { context: 20 } }, fresh: { name: "New" } })),
    )
    check(
      "a download decides what exists, and the shipped copy fills in what it leaves out",
      JSON.stringify(Object.keys(laid.p!.models)) === '["fresh","kept"]' && laid.p!.models.kept!.name === "Old" && laid.p!.models.kept!.limit?.context === 20 && laid.p!.models.kept!.limit?.output === 5,
      laid,
    )

    const fake = await fakeModelsDev()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r9-catalog-"))
    const cacheFile = path.join(dir, "cache", "models.json")
    const errors: unknown[] = []
    let disabled = false
    const make = () =>
      new ModelCatalog({
        cacheFile,
        shipped: async () => catalogOf("deepseek", { "deepseek-chat": { name: "Shipped", limit: { context: 1, output: 1 }, cost: { input: 0.5 } } }),
        source: fake.url,
        disabled: () => disabled,
        onError: (error) => errors.push(error),
      })
    try {
      const catalog = make()
      await catalog.load()
      check("with nothing downloaded yet, the shipped copy stands alone", catalog.get().deepseek?.models["deepseek-chat"]?.name === "Shipped")
      let heard = 0
      catalog.subscribe(() => (heard += 1))
      await catalog.refresh()
      const served = catalog.get().deepseek?.models["deepseek-chat"]
      check("a refresh downloads, and the download wins where it speaks", fake.state.hits === 1 && served?.name === "Served" && served.limit?.context === 1234, served)
      check("while the shipped copy fills in the rest", served?.cost?.input === 0.5, served?.cost)
      check("listeners hear that it changed", heard === 1, heard)
      check("the download is kept on disk", Boolean(trimCatalog(JSON.parse(readFileSync(cacheFile, "utf8"))).deepseek))
      await catalog.refresh()
      check("a cache under five minutes old is used rather than fetched again", fake.state.hits === 1, fake.state.hits)
      await catalog.refresh(true)
      check("unless the refresh is forced", fake.state.hits === 2, fake.state.hits)
      check("and an unchanged catalog tells nobody", heard === 1, heard)

      const reopened = make()
      await reopened.load()
      check("the next launch starts from the download, offline", reopened.get().deepseek?.models["deepseek-chat"]?.name === "Served")

      fake.state.status = 500
      const before = JSON.stringify(catalog.get())
      await catalog.refresh(true)
      check("a failed download is logged and changes nothing", errors.length === 1 && JSON.stringify(catalog.get()) === before, errors.map(String))
      fake.state.status = 200
      fake.state.body = { deepseek: { id: "other", models: {} } }
      await catalog.refresh(true)
      check("a malformed one neither replaces the cache nor the catalog", errors.length === 2 && JSON.stringify(catalog.get()) === before && readFileSync(cacheFile, "utf8").includes("Served"))
      fake.state.body = "{ not json"
      await catalog.refresh(true)
      check("nor does one that is not JSON", errors.length === 3 && JSON.stringify(catalog.get()) === before)

      await fs.writeFile(cacheFile, "garbage")
      const damaged = make()
      await damaged.load()
      check("a damaged cache falls back to the shipped copy", damaged.get().deepseek?.models["deepseek-chat"]?.name === "Shipped")

      disabled = true
      const hits = fake.state.hits
      await damaged.refresh()
      damaged.startRefresh()
      check("with the network switched off nothing is fetched", fake.state.hits === hits, fake.state.hits - hits)
      damaged.stop()
      disabled = false
      const scheduled = make()
      await scheduled.load()
      scheduled.startRefresh()
      const started = Date.now()
      while (fake.state.hits === hits && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 20))
      scheduled.stop()
      check("starting the schedule refreshes straight away", fake.state.hits === hits + 1, fake.state.hits - hits)
    } finally {
      await fake.close()
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }

    /* The catalog reaches what a provider offers. */
    const e = await engine({ custom: { models: [{ id: "deepseek-chat", name: "Mine" }] } })
    try {
      const catalog: Catalog = trimCatalog({
        ...catalogOf("deepseek", {
          "deepseek-chat": { name: "DeepSeek Chat (dev)", limit: { context: 131_072, output: 8_192 }, cost: { input: 0.27, output: 1.1 }, modalities: { input: ["text"] }, reasoning: false },
          "deepseek-new": { name: "DeepSeek New", limit: { context: 200_000, output: 16_000 }, modalities: { input: ["text", "image"] }, reasoning: true },
        }),
        ...catalogOf("openai", { "gpt-4o": { name: "GPT-4o", modalities: { input: ["text", "image"] } } }),
        ...catalogOf("xiaomi", { "mimo-v2.5-pro": { name: "Someone else's name", limit: { context: 1_048_576, output: 32_768 } } }),
      })
      await e.config.setDiscovered("deepseek", [
        { id: "deepseek-chat", name: "deepseek-chat", contextWindow: 0, input: 0, output: 0 },
        { id: "deepseek-new", name: "deepseek-new", contextWindow: 0, input: 0, output: 0 },
      ])
      const before = e.config.models("deepseek").find((entry) => entry.id === "deepseek-new")
      e.config.useModelCatalog(catalog)
      const chat = e.config.models("deepseek").find((entry) => entry.id === "deepseek-chat")
      const fresh = e.config.models("deepseek").find((entry) => entry.id === "deepseek-new")
      check("a discovered model gets its window, output limit and prices", chat?.contextWindow === 131_072 && chat.maxOutput === 8_192 && chat.input === 0.27 && chat.output === 1.1, chat)
      const pro = e.config.models("xiaomi").find((entry) => entry.id === "mimo-v2.5-pro")
      check("the app's own name for a model its table lists is kept", pro?.name === "MiMo-V2.5-Pro" && pro.contextWindow === 1_048_576, pro)
      check("a discovered model the table does not name takes models.dev's name", chat?.name === "DeepSeek Chat (dev)", chat?.name)
      check("a model the app has no name for takes models.dev's", fresh?.name === "DeepSeek New" && before?.name !== "DeepSeek New", fresh?.name)
      check("and its capabilities", fresh?.inputs?.image === true && fresh.reasoning === true && fresh.contextWindow === 200_000)
      const typed = e.config.models("fake").find((entry) => entry.id === "deepseek-chat")
      check("a custom provider's model is left as typed", typed?.name === "Mine" && typed.contextWindow === 0)

      /* P9-8: saving a custom model guesses its image input from the catalog. */
      check("(P9-8) an id every entry says takes images is an image model", imageInputOf(catalog, "GPT-4o") === true && imageInputOf(catalog, "openai/gpt-4o") === true)
      check("(P9-8) a text-only one is not, an unknown one is not known", imageInputOf(catalog, "deepseek-chat") === false && imageInputOf(catalog, "nobody-knows") === undefined)
      const split = trimCatalog({ ...catalogOf("a", { twin: { modalities: { input: ["text", "image"] } } }), ...catalogOf("b", { twin: { modalities: { input: ["text"] } } }) })
      check("(P9-8) entries that disagree decide nothing", imageInputOf(split, "twin") === undefined)
    } finally {
      await e.close()
    }

    const data = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r9p-cat-"))
    const served = await fakeModelsDev()
    served.state.body = catalogOf("openai", { "gpt-4o": { name: "GPT-4o", modalities: { input: ["text", "image"] } } })
    const saved = { disabled: process.env.MCODE_DISABLE_MODELS_FETCH, url: process.env.MCODE_MODELS_URL }
    delete process.env.MCODE_DISABLE_MODELS_FETCH
    process.env.MCODE_MODELS_URL = served.url
    const backend = await startBackend(data)
    try {
      const started = Date.now()
      while (served.state.hits === 0 && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 25))
      check("the app refreshes the catalog as it starts", served.state.hits === 1, served.state.hits)
      const cached = path.join(data, "cache", "models.json")
      const written = Date.now()
      while (!(await fs.stat(cached).catch(() => undefined)) && Date.now() - written < 5_000) await new Promise((resolve) => setTimeout(resolve, 25))
      check("into the data folder's cache", Boolean(await fs.stat(cached).catch(() => undefined)))
      await handle(backend.runtime, { type: "provider.addCustom", id: "vision", name: "V", baseURL: "https://v.example/v1", apiKey: "k", models: [{ id: "gpt-4o", name: "G" }, { id: "local-llm", name: "L" }, { id: "GPT-4O", name: "G2", attachment: false }] } as unknown as Request)
      const models = backend.runtime.config.get().customProviders.find((entry) => entry.id === "vision")?.models ?? []
      check("(P9-8) a saved gpt-4o is marked as taking images", models[0]?.attachment === true, models[0])
      check("(P9-8) an unknown model keeps the default", models[1]?.attachment === undefined, models[1])
      check("(P9-8) and an explicit choice is never overridden", models[2]?.attachment === false, models[2])
    } finally {
      await backend.close()
      await served.close()
      if (saved.disabled === undefined) delete process.env.MCODE_DISABLE_MODELS_FETCH
      else process.env.MCODE_DISABLE_MODELS_FETCH = saved.disabled
      if (saved.url === undefined) delete process.env.MCODE_MODELS_URL
      else process.env.MCODE_MODELS_URL = saved.url
      await fs.rm(data, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  section("Round 9: the family request shaping - tool schemas and Kimi's thinking")
  {
    /* An MCP-style schema with every shape the two families refuse. */
    const awkward = {
      type: "object",
      properties: {
        level: { type: "integer", enum: [1, 2, 3] },
        tags: { type: "array" },
        names: { type: "array", items: { description: "a name" } },
        note: { type: "string", properties: { stray: { type: "string" } }, required: ["stray"] },
        target: { type: "string", anyOf: [{ format: "uri" }, { type: "null" }] },
      },
      required: ["level", "missing"],
    }
    const tool = { name: "probe", description: "d", parameters: awkward, execute: async () => ({ output: "" }) }
    const base = { apiKey: "k", system: "s", history: [], tools: [tool], showReasoning: false, signal: new AbortController().signal }

    const gemini = messagesRequest({ ...base, effort: "high", model: { provider: "vertex-proxy", model: "gemini-2.5-pro" } }).tools?.[0] as any
    const shaped = gemini?.input_schema
    check("a Gemini model gets enum values as strings, on a string type", JSON.stringify(shaped?.properties?.level) === '{"type":"string","enum":["1","2","3"]}', shaped?.properties?.level)
    check("an array with no items gets one", JSON.stringify(shaped?.properties?.tags?.items) === '{"type":"string"}', shaped?.properties?.tags)
    check("an items schema that describes nothing becomes a string", shaped?.properties?.names?.items?.type === "string")
    check("a non-object schema loses its properties and required", !("properties" in (shaped?.properties?.note ?? {})) && !("required" in (shaped?.properties?.note ?? {})))
    check("and required names only declared properties", JSON.stringify(shaped?.required) === '["level"]', shaped?.required)
    check("Google's own provider counts whatever the id", (messagesRequest({ ...base, effort: "high", model: { provider: "google", model: "learnlm-2" } }).tools?.[0] as any)?.input_schema?.properties?.level?.type === "string")
    check("the tool keeps its own schema for validation", awkward.properties.level.enum[0] === 1 && awkward.required.length === 2)

    const claude = (messagesRequest({ ...base, effort: "high", model: { provider: "anthropic", model: "claude-sonnet-5" } }).tools?.[0] as any)?.input_schema
    check("a Claude model is sent the schema untouched", JSON.stringify(claude) === JSON.stringify(awkward))
    check("and so is an id that only says Gemini in capitals", JSON.stringify((messagesRequest({ ...base, effort: "high", model: { provider: "x", model: "Gemini-Pro" } }).tools?.[0] as any)?.input_schema) === JSON.stringify(awkward))

    const e = await engine()
    try {
      const sent = async (provider: string, model: string) => {
        e.replies.push(say("ok"))
        await OpenAICompatible.stream({ ...base, effort: "", model: { provider, model }, baseURL: `http://127.0.0.1:${e.port}/v1` }, () => undefined)
        return e.bodies.at(-1)?.tools?.[0]?.function?.parameters
      }
      const kimi = await sent("fake", "kimi-k2-instruct")
      check(
        "a Kimi model on the chat wire gets the type pushed into each anyOf branch that lacks one",
        JSON.stringify(kimi?.properties?.target) === '{"anyOf":[{"type":"string","format":"uri"},{"type":"null"}]}',
        kimi?.properties?.target,
      )
      check("and no Gemini reshaping", JSON.stringify(kimi?.properties?.level) === '{"type":"integer","enum":[1,2,3]}')
      const moonshot = await sent("moonshot", "moonshot-v1-8k")
      check("a Moonshot provider counts whatever the id", !("type" in (moonshot?.properties?.target ?? { type: 1 })))
      const qwen = await sent("fake", "qwen3")
      check("any other family is sent the schema untouched", JSON.stringify(qwen) === JSON.stringify(awkward))
    } finally {
      await e.close()
    }

    const thinking = (model: string) =>
      messagesRequest({ ...base, tools: [], effort: "high", variants: [], outputLimit: 32_000, model: { provider: "kimi-anthropic", model } }).thinking
    check("Kimi K2.5 over the Anthropic protocol thinks with the high budget", JSON.stringify(thinking("kimi-k2.5")) === '{"type":"enabled","budget_tokens":15999}', thinking("kimi-k2.5"))
    check("so does its k2p5 spelling", thinking("accounts/fireworks/models/kimi-k2p5")?.type === "enabled")
    check("but an older Kimi, or another family with no effort control, sends no thinking", thinking("kimi-k2-instruct") === undefined && thinking("glm-4.6") === undefined)
  }
}
