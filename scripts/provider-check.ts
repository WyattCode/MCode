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
// First of all, so nothing here can read the person's own home directory.
import "./fenced-home"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { COMMAND_SOURCES, EFFORTS, type AssistantMessage, type Attachment, type Effort, type UserMessage } from "@shared/protocol"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { modelVariants } from "../src/server/provider/variants"
import { reasoningRequest as anthropicReasoning } from "../src/server/provider/anthropic"
import { reasoningRequest as codexReasoning } from "../src/server/provider/chatgpt"
import { adapterFor } from "../src/server/provider/adapter"
import { AnthropicAdapter, toProviderMessages } from "../src/server/provider/anthropic"
import { ChatGPTSubscription, OpenAIResponses } from "../src/server/provider/chatgpt"
import { OpenAICompatible } from "../src/server/provider/openai"
import { requestHistory } from "../src/server/provider/history"

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
  section("Provider breadth characterization")
  {
    note("all four kinds select their adapter", adapterFor("anthropic") === AnthropicAdapter && adapterFor("chatgpt") === ChatGPTSubscription && adapterFor("openai-responses") === OpenAIResponses && adapterFor("openai-compatible") === OpenAICompatible)
    const user: UserMessage = { id: "u", sessionID: "s", role: "user", text: "", attachments: [], time: { created: 1 } }
    const assistant = { id: "a", sessionID: "s", role: "assistant", model: { provider: "anthropic", model: "claude" }, parts: [{ type: "reasoning", text: "thought", signature: "proof" }, { type: "text", text: "answer" }], time: { created: 1 } } as AssistantMessage
    note("empty user becomes Continue", (requestHistory([user])[0] as UserMessage).text === "Continue.")
    note("assistant ending gets Continue", (requestHistory([assistant]).at(-1) as UserMessage).text === "Continue.")
    const wire = JSON.stringify(toProviderMessages([user, assistant], undefined, assistant.model))
    note("Anthropic replays signed thinking", wire.includes('"signature":"proof"') && wire.includes('"thinking":"thought"'))
    note("Anthropic drops foreign signatures", !JSON.stringify(toProviderMessages([user, assistant], undefined, { provider: "anthropic", model: "other" })).includes("proof"))
    const pending = { ...assistant, parts: [{ type: "tool", callID: "call", name: "read", input: {}, status: "running" }] } as AssistantMessage
    const tools = JSON.stringify(toProviderMessages([user, pending], undefined, assistant.model))
    note("unfinished tools get paired interrupted results", tools.includes('"tool_use"') && tools.includes('"tool_result"') && tools.includes("[Tool execution was interrupted]"))
    note("history shaping leaves stored tools untouched", pending.parts[0]?.type === "tool" && pending.parts[0].status === "running")
  }

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

    section("A fetched model list does not override what a person typed into a custom provider")
    {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-provider-thinking-"))
      const own = new Config(new Storage(home), new Bus(), path.join(home, "credentials.json"))
      await own.load()
      await own.set({
        customProviders: [
          {
            id: "lan",
            name: "LAN",
            baseURL: "https://example.test/v1",
            models: [
              { id: "thinker", name: "Thinker", limit: { context: 1048576, output: 32000 }, thinking: { efforts: ["low", "high"], canOff: true, default: "high" } },
              { id: "plain", name: "Plain" },
            ],
          },
        ],
      })
      const levels = () => own.providers().find((row) => row.id === "lan")?.models.find((row) => row.id === "thinker")
      note("before a refresh the menu is the model's own", levels()?.variants.join() === "none,low,high", levels()?.variants)

      // What 刷新模型列表 stores: the server's ids, with nothing but the id known.
      await own.setDiscovered(
        "lan",
        ["thinker", "plain"].map((id) => ({ id, name: id, contextWindow: 0, input: 0, output: 0 })),
      )
      note("after a refresh the menu is still there", levels()?.variants.join() === "none,low,high", levels()?.variants)
      note("and so is its default", levels()?.defaultEffort === "high", levels()?.defaultEffort)
      note(
        "the turn is clamped against that menu as well, so a level is still sent",
        own.menu({ provider: "lan", model: "thinker" }).levels.join() === "none,low,high",
        own.menu({ provider: "lan", model: "thinker" }),
      )
      note("a model that named no thinking still has no menu", own.menu({ provider: "lan", model: "plain" }).levels.length === 0)
      note("the limit typed in is not replaced by the 0 of a bare id", levels()?.contextWindow === 1048576, levels()?.contextWindow)

      // A model typed in after the list was last fetched is still the person's model.
      await own.set({
        customProviders: [
          {
            id: "lan",
            name: "LAN",
            baseURL: "https://example.test/v1",
            models: [
              { id: "thinker", name: "Thinker", thinking: { efforts: ["low", "high"], canOff: true, default: "high" } },
              { id: "added-later", name: "Added later", thinking: { efforts: ["low", "high"] } },
            ],
          },
        ],
      })
      const ids = () => own.providers().find((row) => row.id === "lan")?.models.map((row) => row.id).join()
      note("a model typed in after a refresh is offered", ids()?.split(",").includes("added-later") === true, ids())
      note("and the ones the server listed still are", ids()?.split(",").includes("thinker") === true, ids())
      note("a model taken out of the form is no longer offered, whatever the stale list says", ids()?.split(",").includes("plain") === false, ids())
      note(
        "with its own levels",
        own.providers().find((row) => row.id === "lan")?.models.find((row) => row.id === "added-later")?.variants.join() === "low,high",
      )
      await fs.rm(home, { recursive: true, force: true })
    }

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

      // The user's own removal forgets the record: nothing is left to turn up in the config page.
      await config.set({ customProviders: config.get().customProviders.filter((row) => row.id !== "probe") }, ["probe"])
      note("a removal the user asked for leaves no record", !config.get().customProviders.some((row) => row.id === "probe"), config.get().customProviders)
      note("and no disabled id", !config.get().disabledProviders.includes("probe"), config.get().disabledProviders)
      note("the remove handler passes the id to forget", /customProviders\.filter\(\(entry\) => entry\.id !== request\.provider\) \}, \[request\.provider\]\)/.test(handlers))

      // A record an older build left disabled is dropped at the next start, and a disabled built-in is not touched.
      await config.set({ customProviders: [entry] })
      await config.set({ customProviders: [] })
      await config.set({ disabledProviders: [...config.get().disabledProviders, "anthropic"] })
      note("an older removal still left a disabled record", config.get().customProviders.some((row) => row.id === "probe"))
      const restarted = new Config(new Storage(root), new Bus(), path.join(root, "credentials.json"))
      await restarted.load()
      note("a start drops the leftover record", !restarted.get().customProviders.some((row) => row.id === "probe"), restarted.get().customProviders)
      note("and keeps a disconnected built-in disabled", restarted.get().disabledProviders.join() === "anthropic", restarted.get().disabledProviders)
    }
  }

  section("Anthropic: adaptive thinking, a token budget, or nothing")
  {
    const five = ["low", "medium", "high", "xhigh", "max"]

    const modern = anthropicReasoning("claude-opus-5", "xhigh", five, MAX_TOKENS)
    note(
      "a modern Claude gets adaptive thinking and the level in output_config",
      modern.thinking?.type === "adaptive" && modern.output_config?.effort === "xhigh",
      modern,
    )
    /*
     * S11-10. Every caller used to pass showReasoning: false and this asked
     * for `omitted`, so the server sent no thinking at all - and a step that
     * thought and said nothing then looked exactly like a step that produced
     * nothing. The reference asks for the summary on every such request; the
     * interface still draws none of it.
     */
    note(
      "the thinking is always asked for, summarized",
      anthropicReasoning("claude-opus-5", "high", five, MAX_TOKENS).thinking?.display === "summarized" &&
        anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], MAX_TOKENS).thinking?.display === "summarized",
    )

    const four6 = anthropicReasoning("claude-sonnet-4-6", "max", ["low", "medium", "high", "max"], MAX_TOKENS)
    note("4.6 is adaptive too", four6.thinking?.type === "adaptive" && four6.output_config?.effort === "max", four6)

    /*
     * The budget branch. `Math.min(16e3, Math.floor(output / 2 - 1))` for high
     * and `Math.min(31999, output - 1)` for max, against the 64k this app
     * sends - the reference's own arithmetic at @22216297.
     */
    const budgetHigh = anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], MAX_TOKENS)
    const budgetMax = anthropicReasoning("claude-haiku-4-5", "max", ["high", "max"], MAX_TOKENS)
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
      Object.keys(anthropicReasoning("claude-opus-4-6", "xhigh", ["low", "medium", "high", "max"], MAX_TOKENS))
        .length === 0,
    )
    note(
      "a model with no effort control gets no thinking either",
      Object.keys(anthropicReasoning("some-chat-model", "high", [], MAX_TOKENS)).length === 0,
    )
    note(
      "a caller that says nothing about the model still sends the level",
      anthropicReasoning("claude-opus-5", "high", undefined, MAX_TOKENS).output_config?.effort === "high",
    )
  }

  section("History media the target model cannot read")
  {
    const user = (attachments: Attachment[]): UserMessage => ({
      id: "u1",
      sessionID: "s1",
      role: "user",
      text: "look",
      attachments,
      time: { created: 0 },
    })
    const image: Attachment = { path: "/pictures/photo.png", mime: "image/png", data: "cGl4ZWw=", byPath: true }
    const pdf: Attachment = { path: "/papers/paper.pdf", mime: "application/pdf", data: "JVBERi0=", byPath: true }

    const textOnly = requestHistory([user([image, pdf])], { text: true })
    const replaced = (textOnly[0] as UserMessage).attachments
    note("an image the model cannot read is not sent", replaced[0]?.data === "" && replaced[0]?.byPath === false, replaced[0])
    note("and it reads as one line saying why", /cannot read image input/.test(replaced[0]?.note ?? ""), replaced[0]?.note)
    note("a PDF is replaced the same way", /cannot read PDF input/.test(replaced[1]?.note ?? ""), replaced[1]?.note)

    const vision = requestHistory([user([image])], { text: true, image: true })
    note("a model that reads the picture keeps it", (vision[0] as UserMessage).attachments[0]?.data === image.data, (vision[0] as UserMessage).attachments[0])

    const tool: AssistantMessage = {
      id: "a1",
      sessionID: "s1",
      role: "assistant",
      model: { provider: "anthropic", model: "claude-opus-5" },
      agent: "build",
      parts: [
        { type: "tool", id: "t1", callID: "c1", name: "read", status: "completed", input: {}, attachments: [pdf], time: { created: 0 } },
      ],
      time: { created: 0 },
    }
    const toolOnly = requestHistory([tool], { text: true })
    const part = (toolOnly[0] as AssistantMessage).parts[0]
    note("a tool result's PDF is replaced too", part.type === "tool" && /cannot read PDF input/.test(part.attachments?.[0]?.note ?? ""), part)
  }

  section("Codex: a reasoning block, or nothing")
  {
    const five = ["none", "low", "medium", "high", "xhigh"]
    note(
      "an accepted level is sent",
      codexReasoning("high", five).reasoning?.effort === "high",
      codexReasoning("high", five),
    )
    note("none is a level, not an absence", codexReasoning("none", five).reasoning?.effort === "none")
    // S11-10: the reference asks for `auto` on every such request, whatever the interface draws.
    note("the summary is always asked for", codexReasoning("high", five).reasoning?.summary === "auto")
    note(
      "a level the model does not accept withholds the whole block",
      codexReasoning("max", five).reasoning === undefined,
      codexReasoning("max", five),
    )
    note("a model with no effort control gets no reasoning block", codexReasoning("high", []).reasoning === undefined)
    note("a caller that says nothing still sends it", codexReasoning("high", undefined).reasoning?.effort === "high")
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
