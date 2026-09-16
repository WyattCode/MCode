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
import { messagesRequest } from "../src/server/provider/anthropic"
import { OpenAICompatible } from "../src/server/provider/openai"

export async function roundNineProviderChecks(check: Check, section: (name: string) => void): Promise<void> {
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
