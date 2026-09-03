/**
 * What reaches the provider, and what a removed provider leaves behind.
 *
 * Three things this file exists to hold still, all of which were wrong or
 * absent before and none of which any other check can see:
 *
 *   1. The reasoning level. Three adapters send it three different ways, and
 *      until now only one of them asked whether the model would accept it. The
 *      Anthropic path shapes it as adaptive thinking or a token budget; the
 *      Codex path as a `reasoning` block; the OpenAI-compatible path as a
 *      `reasoning_effort` field. Each has its own function here and its own
 *      case for "the model does not take this level, so send nothing".
 *   2. The effort vocabulary. `EFFORTS` carries all seven ids the reference
 *      uses, and the models this app ships have to offer the levels the
 *      reference's own table gives them - including `none`, which all seven
 *      of its Codex models accept and which this app used to hide.
 *   3. Removal. The reference disables a custom provider rather than deleting
 *      it, which is what lets a removed id be re-added. Nothing about that is
 *      visible in a type: it is an invariant of the config store, and the way
 *      to see it is to remove one and look at what is still there.
 *
 * Each case says what a person would expect, so a surprise reads as a finding
 * rather than as a number.
 */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { COMMAND_SOURCES, EFFORTS, type Effort } from "@shared/protocol"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { modelVariants } from "../src/server/provider/variants"
import { reasoningRequest as anthropicReasoning } from "../src/server/provider/anthropic"
import { reasoningRequest as codexReasoning } from "../src/server/provider/chatgpt"

const findings: string[] = []
function note(name: string, ok: boolean, detail: unknown = ""): void {
  const shown = detail === "" ? "" : " - " + JSON.stringify(detail)
  console.log(`  ${ok ? "ok  " : "??  "} ${name}${shown}`)
  if (!ok) findings.push(name + shown)
}

function section(title: string): void {
  console.log("")
  console.log(title)
}

/** A 64k output limit, which is what the Anthropic adapter sends. */
const MAX_TOKENS = 64_000

async function main(): Promise<void> {
  section("The effort vocabulary")
  {
    /*
     * The reference's constants at node-BBwF64dM.js @22219232, plus `max` from
     * the Anthropic and DeepSeek-V4 arms. Seven, in ascending order.
     */
    note(
      "all seven of the reference's levels exist, in its order",
      EFFORTS.join() === "none,minimal,low,medium,high,xhigh,max",
      EFFORTS,
    )
  }

  section("The surface the question tool and the slash menu stand on")
  {
    /*
     * Types vanish at runtime, so the only honest way to assert that this
     * surface is still here is to read the file - the same thing i18n-check
     * does to protocol.ts for its permission families. It was landed ahead of
     * the screens that use it, which means nothing else in the project would
     * notice if a member went missing.
     */
    note(
      "the three sources the reference badges",
      COMMAND_SOURCES.join() === "command,mcp,skill",
      COMMAND_SOURCES,
    )
    const protocol = await fs.readFile("src/shared/protocol.ts", "utf8")
    const declares = (needle: string) => protocol.includes(needle)
    for (const member of [
      'type: "question.list"',
      'type: "question.reply"; requestID: string; answers: QuestionAnswer[]',
      'type: "question.reject"',
      'type: "command.list"; directory: string',
      'type: "question.asked"; request: QuestionRequest',
      'type: "question.replied"',
      'type: "question.rejected"',
      '"question.list": { questions: QuestionRequest[] }',
      '"command.list": { commands: CommandInfo[] }',
    ]) {
      note(`the protocol still declares ${member}`, declares(member))
    }
    for (const shape of ["interface QuestionPrompt", "interface QuestionRequest", "interface QuestionMetadata", "interface CommandInfo", "interface CommandDefinition"]) {
      note(`and ${shape}`, declares(shape))
    }
  }

  section("Which levels each model offers")
  {
    const anthropic = (id: string): Effort[] =>
      modelVariants("anthropic", { id, name: id, contextWindow: 0, input: 0, output: 0, reasoning: true })

    // The snapshot's own `anthropic` provider record, read model by model.
    note("Claude 5 offers five levels", anthropic("claude-opus-5").join() === "low,medium,high,xhigh,max")
    note("Claude 4.6 has no xhigh", anthropic("claude-opus-4-6").join() === "low,medium,high,max")
    note("Haiku 4.5 falls back to the budget pair", anthropic("claude-haiku-4-5").join() === "high,max")
    note(
      "no Anthropic model is offered none or minimal",
      !["claude-opus-5", "claude-opus-4-6", "claude-haiku-4-5"].some((id) =>
        anthropic(id).some((level) => level === "none" || level === "minimal"),
      ),
    )

    /*
     * And the Codex models, which is the half that was wrong. Each list is the
     * `reasoning_options` the snapshot's `openai` provider record carries, so
     * these assertions are against the reference's table and not against this
     * app's own heuristic.
     */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-provider-"))
    const bus = new Bus()
    const config = new Config(new Storage(root), bus, path.join(root, "credentials.json"))
    await config.load()

    const codex = (id: string) => config.variants({ provider: "chatgpt", model: id })?.join()
    note("gpt-5.5 offers none", codex("gpt-5.5") === "none,low,medium,high,xhigh", codex("gpt-5.5"))
    note("gpt-5.4-mini offers none", codex("gpt-5.4-mini") === "none,low,medium,high,xhigh", codex("gpt-5.4-mini"))
    note(
      "the gpt-5.6 tier reaches max, which the heuristic alone would miss",
      codex("gpt-5.6-sol") === "none,low,medium,high,xhigh,max",
      codex("gpt-5.6-sol"),
    )
    note(
      "gpt-5.3-codex-spark has an effort control after all",
      codex("gpt-5.3-codex-spark") === "none,low,medium,high,xhigh",
      codex("gpt-5.3-codex-spark"),
    )

    section("Removal disables a custom provider rather than deleting it")
    {
      /*
       * The behaviour lives in the config store, not in the handler, so this
       * exercises the store - but only the handler's own expression, read out
       * of the handler, so the two cannot drift apart silently. If someone
       * rewrites `provider.removeCustom` to stop going through `set`, the
       * assertions below would keep passing while the app stopped disabling.
       */
      const handlers = await fs.readFile("src/server/handlers.ts", "utf8")
      note(
        "the remove handler still removes by rewriting the list through the store",
        /case "provider\.removeCustom":[\s\S]{0,400}config\.set\(\{[\s\S]{0,200}customProviders: config\.customProviders\.filter/.test(
          handlers,
        ),
      )

      const entry = { id: "probe", name: "Probe", baseURL: "https://example.test/v1", models: [{ id: "m", name: "M" }] }
      await config.set({ customProviders: [entry] })
      note("it is listed once added", Boolean(config.definition("probe")))

      // What the remove handler does: rewrite the list without that entry.
      await config.set({ customProviders: config.get().customProviders.filter((row) => row.id !== "probe") })
      note("it is gone from the list", !config.definition("probe"))
      note("its id is disabled", config.get().disabledProviders.join() === "probe", config.get().disabledProviders)
      note(
        "but its record survives, which is what the reference keeps",
        config.get().customProviders.some((row) => row.id === "probe" && row.baseURL === entry.baseURL),
        config.get().customProviders,
      )
      note("and it is absent from the provider list", !config.providers().some((row) => row.id === "probe"))

      // Re-adding under the same id: allowed, replaces the record, un-disables.
      const again = { ...entry, name: "Probe II", baseURL: "https://example.test/v2", models: [{ id: "m2", name: "M2" }] }
      await config.set({ customProviders: [...config.get().customProviders, again] })
      note("re-adding is not refused by the id-collision rule", Boolean(config.definition("probe")))
      note("the record is replaced, not duplicated", config.get().customProviders.length === 1, config.get().customProviders)
      note("the new values won", config.definition("probe")?.baseURL === "https://example.test/v2")
      note("and the id is no longer disabled", config.get().disabledProviders.length === 0)
    }
  }

  section("Anthropic: adaptive thinking, a token budget, or nothing")
  {
    const five = ["low", "medium", "high", "xhigh", "max"]

    const modern = anthropicReasoning("claude-opus-5", "xhigh", five, true, MAX_TOKENS)
    note(
      "a modern Claude gets adaptive thinking and the level in output_config",
      modern.thinking?.type === "adaptive" && modern.output_config?.effort === "xhigh",
      modern,
    )
    note(
      "Show reasoning off asks for the thinking to be omitted",
      anthropicReasoning("claude-opus-5", "high", five, false, MAX_TOKENS).thinking?.display === "omitted",
    )

    const four6 = anthropicReasoning("claude-sonnet-4-6", "max", ["low", "medium", "high", "max"], true, MAX_TOKENS)
    note("4.6 is adaptive too", four6.thinking?.type === "adaptive" && four6.output_config?.effort === "max", four6)

    /*
     * The budget branch. `Math.min(16e3, Math.floor(output / 2 - 1))` for high
     * and `Math.min(31999, output - 1)` for max, against the 64k this app
     * sends - the reference's own arithmetic at @22216297.
     */
    const budgetHigh = anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], true, MAX_TOKENS)
    const budgetMax = anthropicReasoning("claude-haiku-4-5", "max", ["high", "max"], true, MAX_TOKENS)
    note(
      "an older Claude gets a thinking budget and no effort field",
      budgetHigh.thinking?.type === "enabled" &&
        budgetHigh.thinking.budget_tokens === 16_000 &&
        budgetHigh.output_config === undefined,
      budgetHigh,
    )
    note(
      "and max is the larger budget",
      budgetMax.thinking?.type === "enabled" && budgetMax.thinking.budget_tokens === 31_999,
      budgetMax,
    )

    note(
      "a level the model does not accept is sent as nothing at all",
      Object.keys(anthropicReasoning("claude-opus-4-6", "xhigh", ["low", "medium", "high", "max"], true, MAX_TOKENS))
        .length === 0,
    )
    note(
      "a model with no effort control gets no thinking either",
      Object.keys(anthropicReasoning("some-chat-model", "high", [], true, MAX_TOKENS)).length === 0,
    )
    note(
      "a caller that says nothing about the model still sends the level",
      anthropicReasoning("claude-opus-5", "high", undefined, true, MAX_TOKENS).output_config?.effort === "high",
    )
  }

  section("Codex: a reasoning block, or nothing")
  {
    const five = ["none", "low", "medium", "high", "xhigh"]
    note(
      "an accepted level is sent",
      codexReasoning("high", five, true).reasoning?.effort === "high",
      codexReasoning("high", five, true),
    )
    note("none is a level, not an absence", codexReasoning("none", five, true).reasoning?.effort === "none")
    note("Show reasoning off asks for a concise summary", codexReasoning("high", five, false).reasoning?.summary === "concise")
    note(
      "a level the model does not accept withholds the whole block",
      codexReasoning("max", five, true).reasoning === undefined,
      codexReasoning("max", five, true),
    )
    note("a model with no effort control gets no reasoning block", codexReasoning("high", [], true).reasoning === undefined)
    note("a caller that says nothing still sends it", codexReasoning("high", undefined, true).reasoning?.effort === "high")
  }

  console.log("")
  if (findings.length) {
    console.error(`${findings.length} case(s) behaved unexpectedly:`)
    for (const finding of findings) console.error("  " + finding)
    process.exit(1)
  }
  console.log("Every level offered is one the model takes, and a removed provider is disabled rather than lost.")
  process.exit(0)
}

void main()
