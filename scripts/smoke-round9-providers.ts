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
import { customModelOf } from "../src/server/config"
import { startBackend } from "../src/server/index"
import { handle } from "../src/server/handlers"
import type { Request } from "../src/shared/protocol"

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

    } finally {
      await backend.close()
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
