/**
 * Check of the fanout and verify_page tools.
 *
 * fanout runs against a stand-in for the runner's control, so what is checked
 * is the tool: its arguments, the files it writes, how it reports a failure
 * and an answer the output limit cut. verify_page runs against a real headless
 * browser when the machine has one (and says so when it does not), on pages
 * built to be wrong in one way each - including one that is fine for three
 * seconds and then throws, which only shows because the animation is run forward.
 *
 * Run: npm run fanoutcheck
 */
import "./fenced-home"
import "./safe-listen"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FanoutTool } from "../src/server/tool/fanout"
import { VerifyPageTool } from "../src/server/tool/verify-page"
import { TOOLS, reachOf } from "../src/server/tool/registry"
import { ToolError, type FanoutControl, type FanoutOutcome, type ToolContext } from "../src/server/tool/types"
import { findBrowser } from "../src/server/appdrive/browser"
import { checkPage } from "../src/server/appdrive/page-check"
import { SessionRunner } from "../src/server/session/runner"
import { cooldownLeft, noteRateLimit } from "../src/server/session/retry"

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function context(directory: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: `smoke-fanout-${Date.now()}`,
    messageID: "smoke-message",
    callID: "smoke-call",
    directory,
    permissions: { ask: async () => undefined },
    questions: {},
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
    ...extra,
  } as unknown as ToolContext
}

async function refused(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error instanceof ToolError ? error.message : `not a ToolError: ${String(error)}`
  }
}

/** A control that answers each request with its own prompt upper-cased, and fails or cuts the ones named so. */
function fakeControl(seen: { system?: string; effort?: string; maxTokens?: number; concurrency?: number; names: string[] }): FanoutControl {
  return {
    async generate(items, options, hooks) {
      seen.system = options.system
      seen.effort = options.effort
      seen.maxTokens = options.maxTokens
      seen.concurrency = options.concurrency
      seen.names = items.map((item) => item.name)
      const results: FanoutOutcome[] = items.map((item, index) => {
        if (item.name.startsWith("fail")) return { name: item.name, ok: false, text: "", seconds: 1, error: "provider said no" }
        return {
          name: item.name,
          ok: true,
          text: item.prompt.toUpperCase(),
          seconds: 2 + index,
          stop: item.name.startsWith("cut") ? "max_tokens" : "end_turn",
          usage: { input: 10, output: 20, reasoning: 0 },
        }
      })
      results.forEach((outcome, index) => hooks?.done?.(outcome, index + 1, results.length))
      return results
    },
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-fanout-smoke-"))

  console.log("registration")
  const names = TOOLS.map((tool) => tool.name)
  check("fanout and verify_page are registered", names.includes("fanout") && names.includes("verify_page"))
  check("they sit after every older tool, so the cached prefix stays as it was", names.indexOf("fanout") > names.indexOf("lsp") && names.indexOf("verify_page") > names.indexOf("fanout"))
  check("fanout records the files it writes, and verify_page changes none", reachOf("fanout") === "reports" && reachOf("verify_page") === "reads")
  check("fanout is asked about as an edit, and verify_page, which runs a page's scripts, as a command", FanoutTool.permission === "edit" && VerifyPageTool.permission === "bash")
  const han = /[一-鿿]/
  for (const tool of [FanoutTool, VerifyPageTool]) {
    const text = `${tool.description}${JSON.stringify(tool.parameters)}`
    check(`${tool.name} describes itself in English`, !han.test(text))
    check(`${tool.name} names no other tool with a capital`, !/\b(Read|Write|Edit|Glob|Grep|Bash|Task|WebFetch|Question) tool\b/.test(text))
  }

  console.log("fanout: arguments")
  const seen = { names: [] as string[] }
  const withControl = context(root, { fanout: fakeControl(seen) })
  check("without a control it says a subagent cannot fan out", (await refused(() => FanoutTool.execute({ requests: [{ name: "a", prompt: "x" }], output_dir: "out" }, context(root))))?.includes("not available") === true)
  check("no requests is refused", (await refused(() => FanoutTool.execute({ requests: [], output_dir: "out" }, withControl))) !== undefined)
  check("a missing output_dir is refused", (await refused(() => FanoutTool.execute({ requests: [{ name: "a", prompt: "x" }] }, withControl)))?.includes("output_dir") === true)
  check("a name with a slash is refused", (await refused(() => FanoutTool.execute({ requests: [{ name: "a/b", prompt: "x" }], output_dir: "out" }, withControl)))?.includes("name") === true)
  check("two requests with one name are refused", (await refused(() => FanoutTool.execute({ requests: [{ name: "a", prompt: "x" }, { name: "a", prompt: "y" }], output_dir: "out" }, withControl)))?.includes("unique") === true)
  check("an empty prompt is refused", (await refused(() => FanoutTool.execute({ requests: [{ name: "a", prompt: "  " }], output_dir: "out" }, withControl)))?.includes("empty prompt") === true)
  check("an unknown effort is refused", (await refused(() => FanoutTool.execute({ requests: [{ name: "a", prompt: "x" }], output_dir: "out", effort: "turbo" }, withControl)))?.includes("effort") === true)
  const many = Array.from({ length: 17 }, (_, index) => ({ name: `p${index}`, prompt: "x" }))
  check("more than sixteen requests are refused", (await refused(() => FanoutTool.execute({ requests: many, output_dir: "out" }, withControl)))?.includes("At most") === true)
  check("a refused call wrote nothing", await fs.stat(path.join(root, "out")).then(() => false, () => true))

  console.log("fanout: a run")
  const progress: string[] = []
  const ran = await FanoutTool.execute(
    {
      requests: [
        { name: "bg", prompt: "draw the sky" },
        { name: "fail_one", prompt: "x" },
        { name: "cut_one", prompt: "long" },
      ],
      output_dir: "parts/run1",
      system: "shared contract",
      effort: "off",
      max_tokens: 4000,
      concurrency: 3,
      // The stand-in's "fail" requests always fail; without this they would be run a second time, which is checked below.
      retries: 0,
    },
    context(root, { fanout: fakeControl(seen), progress: (text) => progress.push(text) }),
  )
  check("the control got the shared system text, the effort, the limits and the names", seen.system === "shared contract" && seen.effort === "off" && seen.maxTokens === 4000 && seen.concurrency === 3 && seen.names.join(",") === "bg,fail_one,cut_one", JSON.stringify(seen))
  check("each answer is saved as <name>.txt, exactly as written", (await fs.readFile(path.join(root, "parts/run1/bg.txt"), "utf8").catch(() => "")) === "DRAW THE SKY")
  check("a failed request writes no file", await fs.stat(path.join(root, "parts/run1/fail_one.txt")).then(() => false, () => true))
  check("the result says which one failed and why", ran.output.includes("fail_one: FAILED") && ran.output.includes("provider said no"), ran.output)
  check("the result lists the file, the time and the tokens of one that worked", /bg: ok in 2s, 20 output tokens, stop=end_turn -> parts[\\/]run1[\\/]bg\.txt/.test(ran.output), ran.output)
  check("an answer cut at the output limit is called out", ran.output.includes("stop=max_tokens") && ran.output.includes("incomplete"), ran.output)
  check("the card title counts what was written", ran.title === "2/3 written", ran.title)
  check("progress was reported as requests finished", progress[0] === "0/3 done" && progress.at(-1)?.startsWith("3/3 done") === true, progress)

  console.log("fanout: retries")
  {
    const calls: string[][] = []
    // Fails "flaky" once, answers "wrong" without the required text once, then both answer properly.
    const tries = new Map<string, number>()
    const control: FanoutControl = {
      async generate(items) {
        calls.push(items.map((item) => item.name))
        return items.map((item) => {
          const count = (tries.get(item.name) ?? 0) + 1
          tries.set(item.name, count)
          if (item.name === "flaky" && count === 1) return { name: item.name, ok: false, text: "", seconds: 1, error: "reset by peer" }
          if (item.name === "wrong" && count === 1) return { name: item.name, ok: true, text: "<tool_call>nope</tool_call>", seconds: 1, stop: "end_turn" }
          if (item.name === "never") return { name: item.name, ok: true, text: "still no fence", seconds: 1, stop: "end_turn" }
          return { name: item.name, ok: true, text: "```js\nok\n```", seconds: 1, stop: "end_turn" }
        })
      },
    }
    const out = await FanoutTool.execute(
      { requests: [{ name: "fine", prompt: "x" }, { name: "flaky", prompt: "x" }, { name: "wrong", prompt: "x" }, { name: "never", prompt: "x" }], output_dir: "parts/retry", must_contain: "```js" },
      context(root, { fanout: control }),
    )
    check("a failed request and one lacking the required text are rerun together, the good one is not", calls.length === 2 && calls[1]!.join(",") === "flaky,wrong,never", JSON.stringify(calls))
    check("both come back right and say it took two attempts", /flaky: ok .*\(took 2 attempts\)/.test(out.output) && /wrong: ok .*\(took 2 attempts\)/.test(out.output), out.output)
    check("one that never has the text is a failure that says why", out.output.includes("never: FAILED") && out.output.includes("does not contain"), out.output)
    check("and writes no file", await fs.stat(path.join(root, "parts/retry/never.txt")).then(() => false, () => true))
    const off = await FanoutTool.execute({ requests: [{ name: "flaky", prompt: "x" }], output_dir: "parts/retry0", retries: 0 }, context(root, { fanout: { generate: async (items) => items.map((item) => ({ name: item.name, ok: false, text: "", seconds: 1, error: "down" })) } }))
    check("retries: 0 turns it off", off.output.includes("flaky: FAILED") && !off.output.includes("attempts"), off.output)
  }

  console.log("fanout: what the write tool is held to")
  {
    const sessionID = "smoke-fanout-guards"
    const asked: { kind?: string; subject?: string; preview?: string }[] = []
    let generated = 0
    const counting: FanoutControl = {
      async generate(items) {
        generated++
        return items.map((item) => ({ name: item.name, ok: true, text: `answer of ${item.name}`, seconds: 1, stop: "end_turn" }))
      },
    }
    const guarded = (extra: Partial<ToolContext> = {}) =>
      context(root, { sessionID, fanout: counting, permissions: { ask: async (request: { kind?: string; subject?: string; preview?: string }) => void asked.push(request) } as never, ...extra })
    await fs.mkdir(path.join(root, "guard"), { recursive: true })
    await fs.writeFile(path.join(root, "guard", "mine.txt"), "the user's own text", "utf8")
    const unread = await refused(() => FanoutTool.execute({ requests: [{ name: "mine", prompt: "x" }], output_dir: "guard" }, guarded()))
    check("a file that exists and was not read is refused", unread !== undefined, unread)
    check("and is left as it was, with no request made", (await fs.readFile(path.join(root, "guard", "mine.txt"), "utf8")) === "the user's own text" && generated === 0)
    const declined = await refused(() =>
      FanoutTool.execute({ requests: [{ name: "new1", prompt: "x" }], output_dir: "guard" }, guarded({ permissions: { ask: async () => { throw new ToolError("declined") } } as never })),
    )
    check("answering no stops it before any request is made", declined === "declined" && generated === 0, declined)
    await FanoutTool.execute({ requests: [{ name: "new1", prompt: "x" }, { name: "new2", prompt: "y" }], output_dir: "guard" }, guarded())
    check("the user is asked once, as an edit, and shown the files", asked.length === 1 && asked[0]!.kind === "edit" && asked[0]!.subject === "guard" && asked[0]!.preview!.includes("new1.txt") && asked[0]!.preview!.includes("new2.txt"), asked)
    const again = await FanoutTool.execute({ requests: [{ name: "new1", prompt: "x" }], output_dir: "guard" }, guarded())
    check("its own answer counts as read, so a rerun of a part may replace it", again.output.includes("new1: ok"), again.output)
    await fs.writeFile(path.join(root, "guard", "new1.txt"), "edited by hand since", "utf8")
    const stale = await refused(() => FanoutTool.execute({ requests: [{ name: "new1", prompt: "x" }], output_dir: "guard" }, guarded()))
    check("a file changed since is refused", stale !== undefined && (await fs.readFile(path.join(root, "guard", "new1.txt"), "utf8")) === "edited by hand since", stale)
    const racing: FanoutControl = {
      async generate(items) {
        await fs.writeFile(path.join(root, "guard", `${items[0]!.name}.txt`), "appeared meanwhile", "utf8")
        return items.map((item) => ({ name: item.name, ok: true, text: "answer", seconds: 1, stop: "end_turn" }))
      },
    }
    const raced = await FanoutTool.execute({ requests: [{ name: "race", prompt: "x" }], output_dir: "guard" }, guarded({ fanout: racing }))
    check("a file that changes during generation is kept, and the result says so", raced.output.includes("NOT WRITTEN") && (await fs.readFile(path.join(root, "guard", "race.txt"), "utf8")) === "appeared meanwhile", raced.output)
    const ask = (requests: unknown[]) => refused(() => FanoutTool.execute({ requests, output_dir: "guard" }, guarded()))
    check("names differing only in case are refused", (await ask([{ name: "Bike", prompt: "x" }, { name: "bike", prompt: "y" }]))?.includes("ignoring case") === true)
    check("a name Windows reserves is refused", (await ask([{ name: "con", prompt: "x" }]))?.includes("reserves") === true && (await ask([{ name: "COM1.a", prompt: "x" }]))?.includes("reserves") === true)
    check("a name that only starts like one is fine", (await ask([{ name: "console", prompt: "x" }])) === undefined)
    const blank = await FanoutTool.execute({ requests: [{ name: "blank", prompt: "x" }], output_dir: "guard", retries: 0 }, guarded({ fanout: { generate: async (items) => items.map((item) => ({ name: item.name, ok: true, text: "  \n", seconds: 1, stop: "end_turn" })) } }))
    check("an empty answer is a failure, and writes no file", blank.output.includes("blank: FAILED") && blank.output.includes("empty") && (await fs.stat(path.join(root, "guard", "blank.txt")).then(() => false, () => true)), blank.output)
    let cutCalls = 0
    const cutOff = await FanoutTool.execute(
      { requests: [{ name: "cutoff", prompt: "x" }], output_dir: "guard", must_contain: "```js" },
      guarded({ fanout: { generate: async (items) => { cutCalls++; return items.map((item) => ({ name: item.name, ok: true, text: "half a part", seconds: 1, stop: "max_tokens" })) } } }),
    )
    check("an answer cut at the limit is not retried, and is told to raise it", cutCalls === 1 && cutOff.output.includes("raise max_tokens"), cutOff.output)
    const stopped = new AbortController()
    stopped.abort()
    let stoppedCalls = 0
    await FanoutTool.execute(
      { requests: [{ name: "stopped", prompt: "x" }], output_dir: "guard" },
      guarded({ signal: stopped.signal, fanout: { generate: async (items) => { stoppedCalls++; return items.map((item) => ({ name: item.name, ok: false, text: "", seconds: 0, error: "cancelled" })) } } }),
    )
    check("nothing is retried once the turn has been stopped", stoppedCalls === 1, stoppedCalls)
    const noted = await FanoutTool.execute({ requests: [{ name: "n1", prompt: "x" }, { name: "n2", prompt: "x" }], output_dir: "guard" }, guarded({ fanout: { generate: async (items) => items.map((item) => ({ name: item.name, ok: true, text: "a", seconds: 1, stop: "end_turn", note: "thinking stayed on" })) } }))
    check("a note from the runner reaches the model, once", noted.output.split("thinking stayed on").length === 2, noted.output)
  }

  console.log("fanout: a file that cannot be written")
  {
    const made: boolean[] = []
    const blocked = await FanoutTool.execute(
      { requests: [{ name: "w1", prompt: "x" }, { name: "w2", prompt: "x" }, { name: "w3", prompt: "x" }], output_dir: "writes" },
      context(root, {
        fanout: {
          generate: async (items) => {
            made.push(await fs.stat(path.join(root, "writes")).then((stat) => stat.isDirectory(), () => false))
            await fs.mkdir(path.join(root, "writes", "w2.txt"))
            return items.map((item) => ({ name: item.name, ok: true, text: "answer", seconds: 1, stop: "end_turn" }))
          },
        },
      }),
    )
    check("the folder exists before any request is made", made[0] === true)
    check("one file that cannot be written fails alone, and says so", /w2: NOT WRITTEN/.test(blocked.output) && blocked.title === "2/3 written", blocked.output)
    check("and the others are still saved", (await fs.readFile(path.join(root, "writes", "w1.txt"), "utf8")) === "answer" && (await fs.readFile(path.join(root, "writes", "w3.txt"), "utf8")) === "answer")
  }

  console.log("fanout: the runner's requests")
  {
    let limitedURL = ""
    const bodies: Record<string, any>[] = []
    const server = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        bodies.push(JSON.parse(raw))
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const runnerWith = (setup: { handEntered: boolean; variants: string[]; preferred?: string; maxOutput?: number; contextWindow?: number; provider?: string }) => {
      const model = { provider: setup.provider ?? "p", model: "some-model" }
      const runner = Object.create(SessionRunner.prototype) as any
      runner.store = { require: async () => ({ id: "s", model, effort: undefined }) }
      runner.config = {
        definition: () => ({ id: "p", kind: "openai-compatible", baseURL, headers: undefined, handEntered: setup.handEntered }),
        usable: () => true,
        apiKey: () => "k",
        get: () => ({}),
        variants: () => setup.variants,
        menu: () => ({ levels: setup.variants, preferred: setup.preferred }),
        modelEntry: () => ({ maxOutput: setup.maxOutput, contextWindow: setup.contextWindow ?? 0 }),
      }
      runner.auth = { accessToken: async () => undefined }
      runner.noteBackground = () => {}
      return runner
    }
    const run = async (setup: Parameters<typeof runnerWith>[0], options: Record<string, unknown>) => {
      bodies.length = 0
      const outcomes = await runnerWith(setup).fanoutControl({ sessionID: "s", signal: new AbortController().signal }).generate([{ name: "a", prompt: "write it" }], options)
      return { body: bodies[0]!, outcome: outcomes[0]! }
    }
    const local = { handEntered: true, variants: ["none", "low"], maxOutput: 16_384 }
    const plain = await run(local, {})
    check("no system text still sends one, since a provider may refuse an empty one", typeof plain.body.messages[0].content === "string" && plain.body.messages[0].role === "system" && plain.body.messages[0].content.length > 0, plain.body.messages[0])
    check("no max_tokens takes the model's own ceiling", plain.body.max_tokens === 16_384, plain.body.max_tokens)
    check("asking for more than the ceiling gets the ceiling", (await run(local, { maxTokens: 50_000 })).body.max_tokens === 16_384)
    check("asking for less is honoured", (await run(local, { maxTokens: 900 })).body.max_tokens === 900)
    check("the output is fitted to a small context window", (await run({ ...local, contextWindow: 20_000 }, { system: "x".repeat(30_000) })).body.max_tokens < 16_384)
    const offLocal = await run(local, { effort: "off" })
    check("off on a local server uses its chat template switch, and needs no note", offLocal.body.chat_template_kwargs?.enable_thinking === false && offLocal.outcome.note === undefined, offLocal.body)
    const offLevel = await run({ handEntered: false, variants: ["none", "low"] }, { effort: "off" })
    check("off on a provider with a none level asks for it", offLevel.body.reasoning_effort === "none" && offLevel.outcome.note === undefined, offLevel.body)
    const offNone = await run({ handEntered: false, variants: ["low", "high"] }, { effort: "off" })
    check("off on a provider with neither sends no level and says so", offNone.body.reasoning_effort === undefined && /could not be switched off/.test(offNone.outcome.note ?? ""), offNone.outcome)
    check("no effort follows the conversation's rule: the model's preferred level", (await run({ handEntered: false, variants: ["low", "medium", "xhigh"], preferred: "xhigh" }, {})).body.reasoning_effort === "xhigh")
    const clamped = await run({ handEntered: true, variants: ["none", "low", "medium", "xhigh"] }, { effort: "high" })
    check("a level the model does not offer is clamped as a turn's is, and says so", clamped.body.reasoning_effort === "medium" && /no "high" thinking level/.test(clamped.outcome.note ?? ""), clamped.outcome)
    const offered1 = await run({ handEntered: false, variants: ["low"], provider: "xai" }, {})
    check("a provider's own switches go as a turn's do", offered1.body.store === false && offered1.body.prompt_cache_key === "s", offered1.body)
    const offZhipu = await run({ handEntered: false, variants: [], provider: "zhipu" }, { effort: "off" })
    check("and turning thinking off still has the last word", offZhipu.body.thinking?.type === "disabled", offZhipu.body)
    const cool = "cooling-provider"
    noteRateLimit(cool, Date.now() + 1500)
    const waitedFrom = Date.now()
    await run({ handEntered: true, variants: [], provider: cool }, {})
    check("a request waits out a provider's cooldown", Date.now() - waitedFrom >= 1000, Date.now() - waitedFrom)
    noteRateLimit(cool, Date.now() + 60_000)
    const leaving = new AbortController()
    const leftBehind = runnerWith({ handEntered: true, variants: [], provider: cool }).fanoutControl({ sessionID: "s", signal: leaving.signal }).generate([{ name: "a", prompt: "x" }], {})
    setTimeout(() => leaving.abort(), 50)
    check("and Stop ends that wait", (await leftBehind)[0].error === "cancelled")
    server.close()
    const limiting = createServer((request, response) => {
      request.resume()
      request.on("end", () => {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "1" })
        response.end(JSON.stringify({ error: { message: "slow down" } }))
      })
    })
    await new Promise<void>((resolve) => limiting.listen(0, "127.0.0.1", () => resolve()))
    limitedURL = `http://127.0.0.1:${(limiting.address() as { port: number }).port}/v1`
    const limitedRunner = runnerWith({ handEntered: true, variants: [], provider: "limited-provider" })
    const limitedDefinition = limitedRunner.config.definition
    limitedRunner.config.definition = () => ({ ...limitedDefinition(), baseURL: limitedURL })
    const limited = await limitedRunner.fanoutControl({ sessionID: "s", signal: new AbortController().signal }).generate([{ name: "a", prompt: "x" }], {})
    check("a 429 sets the cooldown the next request waits for", limited[0].ok === false && cooldownLeft("limited-provider") > 0, limited[0])
    limiting.close()
    const offering = Object.create(SessionRunner.prototype) as any
    offering.tools = () => TOOLS
    offering.config = { get: () => ({ customProviders: [] }) }
    const offered = (parentID?: string) => offering.offeredTools({ agent: "build", directory: root, model: { provider: "p", model: "m" }, ...(parentID ? { parentID } : {}) }).map((tool: { name: string }) => tool.name)
    check("a conversation is offered fanout, and a subagent, which could not run it, is not", offered().includes("fanout") && !offered("parent").includes("fanout"))
  }

  console.log("fanout: a system prompt kept in a file")
  await fs.writeFile(path.join(root, "contract.md"), "THE CONTRACT", "utf8")
  const withFile = { names: [] as string[] } as { system?: string; effort?: string; maxTokens?: number; concurrency?: number; names: string[] }
  await FanoutTool.execute({ requests: [{ name: "a", prompt: "x" }], output_dir: "parts/run2", system_file: "contract.md" }, context(root, { fanout: fakeControl(withFile) }))
  check("system_file is read and sent as the shared system text", withFile.system === "THE CONTRACT", withFile.system)
  await FanoutTool.execute({ requests: [{ name: "a", prompt: "x" }], output_dir: "parts/run3", system_file: "contract.md", system: "and more" }, context(root, { fanout: fakeControl(withFile) }))
  check("system after system_file follows it", withFile.system === "THE CONTRACT\n\nand more", withFile.system)
  check("a system_file that is not there is refused", (await refused(() => FanoutTool.execute({ requests: [{ name: "a", prompt: "x" }], output_dir: "parts/run4", system_file: "nope.md" }, context(root, { fanout: fakeControl(withFile) }))))?.includes("system_file") === true)

  console.log("verify_page")
  const browser = findBrowser()
  if (!browser) {
    passed++
    console.log("  ok   (skipped: no Chrome or Edge on this machine)")
  } else {
    const page = (name: string, body: string, script: string) => fs.writeFile(path.join(root, name), `<!DOCTYPE html><html><body>${body}<script>${script}</script></body></html>`, "utf8")
    const loop = (inner: string) => `var t0 = 0; function frame(now) { var s = { t: now / 1000 }; try { ${inner} } catch (e) { console.error(e); } requestAnimationFrame(frame); } requestAnimationFrame(frame);`
    const svg = '<svg id="stage" width="200" height="100" viewBox="0 0 200 100"><g id="L_a"><circle id="c" cx="50" cy="50" r="10"/></g><g id="L_empty"></g></svg>'
    await page("good.html", svg, `window.update_demo = function (s) { document.getElementById('c').setAttribute('cx', 50 + 10 * Math.sin(s.t)); }; ${loop("window.update_demo(s);")}`)
    await page("nan.html", svg, loop("document.getElementById('c').setAttribute('transform', 'translate(' + (s.t * undefined) + ',0)');"))
    await page("path.html", svg, loop("var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', '10,10 20,20'); document.getElementById('L_a').appendChild(p);"))
    await page("late.html", svg, loop("if (s.t > 3) throw new Error('boom after three seconds');"))

    const verify = (file: string, input: Record<string, unknown> = {}) => VerifyPageTool.execute({ file_path: file, ...input }, context(root))
    const good = await verify("good.html", { layers: { L_a: "a" }, require_functions: ["update_demo"] })
    check("a sound page reports no problems", good.output.includes("No problems found.") && good.title === "no problems", good.output)
    const missing = await verify("good.html", { require_functions: ["update_missing"] })
    check("a function the page must define but does not is reported", missing.output.includes("window.update_missing"), missing.output)
    const empty = await verify("good.html", { layers: { L_a: "a", L_empty: "b" } })
    check("an empty layer is reported against its part", empty.output.includes("b:") && empty.output.includes("Layer L_empty is empty"), empty.output)
    const nan = await verify("nan.html")
    check("a NaN written into an attribute is reported", nan.output.includes("NaN") || nan.output.includes("undefined"), nan.output)
    const bad = await verify("path.html")
    check("a path that does not start with a moveto is reported", bad.output.includes("moveto"), bad.output)
    const late = await verify("late.html")
    check("an error that only happens after three seconds of animation is found", late.output.includes("boom after three seconds"), late.output)
    await page("flood.html", svg, loop("document.getElementById('c').setAttribute('transform', 'translate(' + (s.t * undefined) + ',' + s.t + ')');"))
    const flood = await verify("flood.html")
    check("the same fault on every frame is one line with a count, not hundreds", flood.output.split("\n").filter((line) => line.startsWith("- ")).length <= 3 && /x\d+ with other numbers/.test(flood.output), flood.output)
    // The skill's own checks.js, driven by "expect" data the way assemble.py embeds it.
    const skillChecks = path.join(process.cwd(), "resources", "skills", "parallel-build", "scripts", "checks.js")
    await fs.copyFile(skillChecks, path.join(root, "checks.js"))
    const expecting = (expect: unknown[], script: string) =>
      fs.writeFile(
        path.join(root, "expect.html"),
        `<!DOCTYPE html><html><body><svg id="stage" width="400" height="200" viewBox="0 0 400 200"><g id="L_scroll"><rect id="t" x="0" y="150" width="30" height="20"/></g><g id="L_still"><rect x="10" y="10" width="20" height="20"/></g><g id="L_body"><ellipse id="e" cx="200" cy="100" rx="40" ry="30"/></g></svg><script>window.__expect = ${JSON.stringify(expect)};</script><script>${script}</script></body></html>`,
        "utf8",
      )
    const animate = "var last = 0; function frame(now) { var t = now / 1000; document.getElementById('t').setAttribute('x', (t * 100) % 110); " + "BODY" + " requestAnimationFrame(frame); } requestAnimationFrame(frame);"
    await expecting(
      [
        { kind: "moves", part: "bg", layer: "L_scroll" },
        { kind: "moves", part: "bg", layer: "L_still" },
        { kind: "stable", part: "body", layer: "L_body", move: 12, scale: 0.15 },
        { kind: "covers", part: "body", point: [200, 100], layers: "#L_body" },
        { kind: "covers", part: "body", point: [10, 190], layers: "#L_body", text: "nothing covers the corner" },
        { kind: "shape_near", part: "body", selector: "#L_body *", size: [55, 90], center: [200, 100], tol: 5 },
        { kind: "small", part: "body", layers: ["L_body"], max: [50, 50], text: "the body is bigger than 50" },
      ],
      animate.replace("BODY", ""),
    )
    const data = await verify("expect.html", { checks_file: "checks.js" })
    check("a layer that scrolls in a period shorter than the sampling step still counts as moving", !data.output.includes("L_scroll"), data.output)
    check("a layer whose content never changes is reported as not moving", data.output.includes("Layer L_still did not change"), data.output)
    check("a body that stays put is stable, covers its centre, and is the size said", !data.output.includes("L_body moves") && !data.output.includes("topmost thing at (200,100)") && !data.output.includes("is about 55"), data.output)
    check("a point nothing covers uses the text from parts.json", data.output.includes("nothing covers the corner"), data.output)
    check("a layer bigger than the stated maximum is reported with the text given", data.output.includes("the body is bigger than 50"), data.output)
    await expecting([{ kind: "stable", part: "body", layer: "L_body", move: 12, scale: 0.15 }], animate.replace("BODY", "document.getElementById('e').setAttribute('cx', 200 + t * 30);"))
    const drifting = await verify("expect.html", { checks_file: "checks.js" })
    check("a body that drifts across the stage is reported as wandering", drifting.output.includes("Layer L_body moves"), drifting.output)
    await expecting(
      [
        { kind: "shape_near", part: "body", selector: "#L_body *", size: [80, 90], center: [200, 100], tol: 5, text: "a hair under the lower bound" },
        { kind: "shape_near", part: "body", selector: "#L_body *", size: [100, 140], center: [200, 100], tol: 5, text: "really too small" },
      ],
      "document.getElementById('e').setAttribute('rx', '39.9999'); document.getElementById('e').setAttribute('ry', '39.9999');",
    )
    const bounds = await verify("expect.html", { checks_file: "checks.js" })
    check("a size a hair under the lower bound is not a problem", !bounds.output.includes("a hair under the lower bound"), bounds.output)
    check("a size well outside the bounds still is", bounds.output.includes("really too small"), bounds.output)
    await expecting(
      [
        { kind: "touches", part: "body", a: "#e", b: "#near", gap: 12, text: "stays close" },
        { kind: "touches", part: "body", a: "#e", b: "#t", gap: 12, text: "never close" },
        { kind: "touches", part: "body", a: "#e", b: "#drift", gap: 12, text: "drifts away later" },
        { kind: "touches", part: "body", a: "#e", b: "#nobody", gap: 12 },
      ],
      "var svgNS = 'http://www.w3.org/2000/svg', body = document.getElementById('L_body');" +
        "['near', 'drift'].forEach(function (id) { var r = document.createElementNS(svgNS, 'rect'); r.id = id; r.setAttribute('x', '245'); r.setAttribute('y', '100'); r.setAttribute('width', '10'); r.setAttribute('height', '10'); body.appendChild(r); });" +
        "function frame(now) { document.getElementById('drift').setAttribute('x', 245 + Math.max(0, now / 1000 - 4) * 40); requestAnimationFrame(frame); } requestAnimationFrame(frame);",
    )
    const meeting = await verify("expect.html", { checks_file: "checks.js" })
    check("two elements that stay against each other pass", !meeting.output.includes("stays close"), meeting.output)
    check("two elements far apart are reported", meeting.output.includes("never close"), meeting.output)
    check("two that part only later in the animation are reported", meeting.output.includes("drifts away later"), meeting.output)
    check("a selector that finds nothing is reported, not passed", meeting.output.includes("Nothing matches #nobody"), meeting.output)
    await expecting(
      [
        { kind: "shape_near", part: "body", selector: "#e", size: [75, 85], center: [200, 100], tol: 3, text: "the spinning shape was measured wrong" },
        { kind: "shape_near", part: "body", selector: "#e", size: [75, 85], center: [300, 100], tol: 3, text: "the shape is not over there" },
      ],
      "var e = document.getElementById('e'); e.setAttribute('rx', '40'); e.setAttribute('ry', '40'); e.setAttribute('transform', 'rotate(45 200 100)');",
    )
    const spinning = await verify("expect.html", { checks_file: "checks.js" })
    check("a rotated shape is measured by its own size, not its inflated on-screen box", !spinning.output.includes("the spinning shape was measured wrong"), spinning.output)
    check("and its centre is still checked", spinning.output.includes("the shape is not over there"), spinning.output)
    await page("minified.html", svg.replace('<g id="L_empty"></g>', '<path id="BaNaNa" data-note="NaN" d="M1 1A1 1 0 011 5a2 2 0 1 1 3 3z"/>'), "")
    const minified = await verify("minified.html")
    check("arc flags run together and an id spelling NaN are not problems", minified.output.includes("No problems found."), minified.output)
    await page("arc.html", svg.replace('<g id="L_empty"></g>', '<path d="M1 1A1 1 0 2 1 1 5"/>'), "")
    check("an arc flag that is neither 0 nor 1 is", (await verify("arc.html")).output.includes("arc flag"))
    await page("reject.html", svg, "Promise.reject(new Error('async init failed'));")
    check("an unhandled promise rejection is reported", (await verify("reject.html")).output.includes("async init failed"))
    await page("underscore.html", svg, "window.update_bike_back = function () { throw new Error('boom'); }; " + loop("window.update_bike_back(s);").replace("console.error(e)", "console.error('update_bike_back', e)"))
    const blamed = await verify("underscore.html", { layers: { L_a: "bike_back" } })
    check("a part whose name has an underscore is blamed by its whole name", /^bike_back:$/m.test(blamed.output), blamed.output)
    await page("late-reject.html", svg, loop("if (s.t > 1) Promise.reject(new Error('rejected while animating'));"))
    check("a promise rejected while the animation runs is reported", (await verify("late-reject.html")).output.includes("rejected while animating"))
    await page("late-timer.html", svg, loop("if (s.t > 1) setTimeout(function () { throw new Error('timer while animating'); }, 0);"))
    check("a timer that fails while the animation runs is reported", (await verify("late-timer.html")).output.includes("timer while animating"))
    await page("date-clock.html", svg, "var t0 = Date.now(); function frame() { requestAnimationFrame(frame); var t = (Date.now() - t0) / 1000; document.getElementById('c').setAttribute('cx', t > 2 ? NaN : t); } requestAnimationFrame(frame);")
    check("animation timed by Date.now is run forward", (await verify("date-clock.html")).output.includes("NaN"))
    await page("new-date.html", svg, "var t0 = new Date(); function frame() { requestAnimationFrame(frame); if (new Date() - t0 > 2000 && new Date(0).getTime() === 0 && new Date() instanceof Date) throw new Error('two seconds by new Date'); } requestAnimationFrame(frame);")
    check("and by new Date, which still works as a Date", (await verify("new-date.html")).output.includes("two seconds by new Date"))
    await page("interval.html", svg, "var n = 0; setInterval(function (by) { n += by; document.getElementById('c').setAttribute('cx', n > 60 ? NaN : n); }, 33, 1);")
    check("animation on setInterval is run forward", (await verify("interval.html")).output.includes("NaN"))
    await page("zero-timer.html", svg, "function tick() { setTimeout(tick, 0); } tick();")
    check("a timer that re-arms itself at zero does not hang the check", (await verify("zero-timer.html")).output.includes("No problems found."))
    await page("cleared.html", svg, "var a = setTimeout(function () { throw new Error('cleared timeout ran'); }, 100); clearTimeout(a); var b = setInterval(function () { throw new Error('cleared interval ran'); }, 100); clearInterval(b);")
    check("a cleared timer does not run", (await verify("cleared.html")).output.includes("No problems found."))
    await page("cancelled.html", svg, "var id = requestAnimationFrame(function () { throw new Error('ran after cancel'); }); cancelAnimationFrame(id);")
    check("a cancelled frame does not run", (await verify("cancelled.html")).output.includes("No problems found."))
    await expecting([{ kind: "moves", part: "bg", layer: "L_scroll" }], "function frame(now) { document.getElementById('L_scroll').setAttribute('transform', 'translate(' + now / 100 + ',0)'); requestAnimationFrame(frame); } requestAnimationFrame(frame);")
    check("a layer moved by its own transform counts as moving", (await verify("expect.html", { checks_file: "checks.js" })).output.includes("No problems found."))
    await expecting([{ kind: "moves", part: "a", layer: "L_typo1" }, { kind: "stable", part: "b", layer: "L_typo2" }, { kind: "small", part: "c", layers: ["L_typo3"], max: [1, 1] }], "")
    const typos = (await verify("expect.html", { checks_file: "checks.js" })).output
    check("a layer in expect that the page does not have is reported, for every kind", ["L_typo1", "L_typo2", "L_typo3"].every((id) => typos.includes(`names layer ${id}`)), typos)
    const asked: { kind?: string; subject?: string }[] = []
    await VerifyPageTool.execute({ file_path: "good.html" }, context(root, { permissions: { ask: async (request: { kind?: string; subject?: string }) => void asked.push(request) } as never }))
    check("running a page is asked about first, as a command", asked.length === 1 && asked[0]!.kind === "bash" && asked[0]!.subject === "good.html", asked)
    check("and answering no runs nothing", (await refused(() => VerifyPageTool.execute({ file_path: "good.html" }, context(root, { permissions: { ask: async () => { throw new ToolError("declined") } } as never })))) === "declined")
    const gone = new AbortController()
    gone.abort()
    check("a check that is already stopped does not start a browser", (await refused(() => VerifyPageTool.execute({ file_path: "good.html" }, context(root, { signal: gone.signal }))))?.includes("cancelled") === true)
    // A script that never returns: the load event would take the whole 15-second limit to give up on.
    await page("hang.html", svg, "for (;;) {}")
    const stopping = new AbortController()
    const startedAt = Date.now()
    const longRun = refused(() => VerifyPageTool.execute({ file_path: "hang.html" }, context(root, { signal: stopping.signal })))
    setTimeout(() => stopping.abort(), 1500)
    const stoppedWith = await longRun
    check("Stop ends a running check promptly, and says it was stopped", Date.now() - startedAt < 8000 && stoppedWith?.includes("could not be checked") === true, { ms: Date.now() - startedAt, stoppedWith })
    const noFile = await checkPage({ file: path.join(root, "not-there.html") }).then(() => "resolved", (error: Error) => error.message)
    check("a page that cannot load is an error, not a clean report", noFile.includes("did not load"), noFile)
    const profiles = async () => (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("mcode-app-browser-")).length
    const before = await profiles()
    await verify("good.html")
    check("a check leaves no browser profile behind", (await profiles()) === before, { before, after: await profiles() })
    const short = await verify("late.html", { seconds: 1 })
    check("and is not found when the animation is only run for one second", short.output.includes("No problems found."), short.output)
    check("a file that is not there is refused", (await refused(() => verify("nope.html")))?.includes("not a file") === true || (await refused(() => verify("nope.html"))) !== undefined)
  }

  console.log("assemble.py")
  const python = [process.env.MCODE_PYTHON, path.join(process.cwd(), "resources", "runtimes", "win32-x64", "python", "python.exe"), "python3", "python"].find((file) => {
    if (!file) return false
    try {
      return execFileSync(file, ["--version"], { encoding: "utf8", stdio: "pipe" }).startsWith("Python 3")
    } catch {
      return false
    }
  })
  if (!python) {
    passed++
    console.log("  ok   (skipped: no Python 3 on this machine)")
  } else {
    const script = path.join(process.cwd(), "resources", "skills", "parallel-build", "scripts", "assemble.py")
    const runIn = (work: string) => execFileSync(python, [script, "--work", work], { encoding: "utf8" })
    const fence = (head: string, body: string) => "```" + head + "\n" + body + "\n```\n"
    const js = fence("js", "window.update_a = function () {};")
    const assemble = async (name: string, answer: string, config: Record<string, unknown> = {}) => {
      const work = path.join(root, name)
      await fs.mkdir(path.join(work, "parts"), { recursive: true })
      await fs.writeFile(path.join(work, "parts.json"), JSON.stringify({ canvas: [100, 100], parts: { a: ["L_a", "L_b"] }, order: ["L_a", "L_b"], ...config }), "utf8")
      await fs.writeFile(path.join(work, "parts", "a.txt"), answer, "utf8")
      const log = runIn(work)
      return { log, page: await fs.readFile(path.join(work, "page.html"), "utf8") }
    }
    const placeholder = await assemble("names1", fence("svg LAYER_NAME", '<circle id="one"/>') + fence("svg LAYER_NAME", '<circle id="two"/>') + js)
    check("placeholder names fill the layers in order", placeholder.page.includes('<g id="L_a"><circle id="one"/>') && placeholder.page.includes('<g id="L_b"><circle id="two"/>'), placeholder.log)
    check("and it says so, with no warning left to chase", placeholder.log.includes("NOTE a:") && !placeholder.log.includes("WARN"), placeholder.log)
    const mixed = await assemble("names2", fence("svg LAYER_NAME", '<circle id="one"/>') + fence("svg L_a", '<circle id="two"/>') + js)
    check("a placeholder never takes a layer another fence names", mixed.page.includes('<g id="L_a"><circle id="two"/>') && mixed.page.includes('<g id="L_b"><circle id="one"/>'), mixed.log)
    const extra = await assemble("names3", fence("svg L_a", '<circle id="one"/>') + fence("svg L_b", '<circle id="two"/>') + fence("svg LAYER_NAME", '<circle id="three"/>') + js)
    check("a block with no layer left is reported and dropped", extra.log.includes("WARN a:") && !extra.page.includes('id="three"'), extra.log)
    const lineName = await assemble("names5", "```svg\nL_b\n<circle id=\"one\"/>\n```\n```css\n```\n" + fence("svg", '<g id="L_a"><circle id="two"/></g>') + js)
    check("a name on the next line, an empty css block and a wrapped layer are all understood", lineName.page.includes('<g id="L_b"><circle id="one"/>') && lineName.page.includes('<g id="L_a"><circle id="two"/></g>'), lineName.page)
    check("the page carries the part's script and the copied checks", lineName.page.includes("/* block a */") && (await fs.stat(path.join(root, "names5", "checks.js"))).isFile())
    const left = await assemble("names6", fence("svg L_a", "<circle/>") + fence("svg L_b", "<circle/>") + js, { order: ["L_a", "L_ghost"] })
    check("a layer left out of order is warned about, and so is one nobody owns", left.log.includes("layer L_b is not in") && left.log.includes("names L_ghost"), left.log)
    const dashed = await assemble("names7", fence("svg L_a", "<circle/>") + fence("js", "window.update_a = function () {};"), { parts: { "a-b": ["L_a"] }, order: ["L_a"] }).catch((error: Error) => ({ log: error.message, page: "" }))
    check("a part name that cannot name a function is warned about", dashed.log.includes("cannot be part of a function name"), dashed.log)
    const odd = await assemble("na[me]s 8", fence("svg L_a", "<text>@@CSS@@</text>") + fence("svg L_b", "<circle/>") + fence("js", "window.update_a = function () { /* </script> */ };"), { title: "A <b> & c", expect: [{ kind: "small", text: "</script>" }] })
    check("a folder with brackets and spaces works", odd.log.includes("wrote "), odd.log)
    check("the title is escaped, and text from an answer is not taken for the skeleton's", odd.page.includes("<title>A &lt;b&gt; &amp; c</title>") && odd.page.includes("<text>@@CSS@@</text>"), odd.page.slice(0, 300))
    check("expect cannot end its script, and a part's </script> is warned about", odd.page.includes("<\\/script>") && odd.log.includes("contains </script>"), odd.log)
    {
      const work = path.join(root, "names4")
      await fs.mkdir(path.join(work, "parts"), { recursive: true })
      const run = async (expect: unknown[]) => {
        await fs.writeFile(path.join(work, "parts.json"), JSON.stringify({ canvas: [100, 100], parts: { a: ["L_a"], b: ["L_b"] }, order: ["L_a", "L_b"], expect }), "utf8")
        for (const name of ["a", "b"]) await fs.writeFile(path.join(work, "parts", `${name}.txt`), fence(`svg L_${name}`, "<circle/>") + fence("js", `window.update_${name} = function () {};`), "utf8")
        return runIn(work)
      }
      check("two parts with no touches entry draw a warning", (await run([])).includes("no 'touches' entry"))
      check("one touches entry clears it", !(await run([{ kind: "touches", part: "a", a: "#x", b: "#y" }])).includes("no 'touches' entry"))
    }
    const noConfig = path.join(root, "names9")
    await fs.mkdir(noConfig, { recursive: true })
    check("a missing parts.json is an error", (() => { try { runIn(noConfig); return false } catch { return true } })())
  }

  await fs.rm(root, { recursive: true, force: true })
  console.log("")
  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
