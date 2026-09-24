/**
 * Round 20, the coding agent against MiMo 26.920's engine: tool advice MiMo
 * gives and MCode lacked, the prompt's examples, the first-message note, and
 * the request on the step that has to be the last one. Each check fails on the
 * text or the request as it stood before.
 *
 * smoke.ts calls `roundTwentyAgentChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import { messagesRequest } from "../src/server/provider/anthropic"
import { sessionNote } from "../src/server/session/context"
import { agentPrompt } from "../src/server/session/prompts"
import { bashDescription } from "../src/server/tool/bash"
import { findTool } from "../src/server/tool/registry"
import { calls, engine, say, wireText, type Check } from "./smoke-round5"

const describe = (name: string) => findTool(name)?.description ?? ""

export async function roundTwentyAgentChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 20 (V4-1): read points at grep and glob, and keeps its byte cap for the notice")
  {
    const read = describe("read")
    check("V4-1: a large file or one with long lines is searched with grep", /large file/.test(read) && /lines run very long/.test(read) && read.includes("grep"), read)
    check("V4-1: an uncertain path is found with glob first", /not sure of a path/.test(read) && read.includes("glob first"), read)
    check("V4-1: the 50 KB cap is not stated up front", !read.includes("50 KB"), read)
    check("V4-1: it still says a read that stops early says where to go on", read.includes("says where to continue from"), read)
  }

  section("Round 20 (V4-2): write builds a large file in parts")
  {
    const write = describe("write")
    check("V4-2: a large file is written as a first portion, then edit calls", write.includes("Build a large file in parts") && write.includes("then add the rest with edit"), write)
    check("V4-2: and why - one huge call can pass the output limit and leave the file cut off", write.includes("output limit") && write.includes("cut off"), write)
  }

  section("Round 20 (V4-3): grep sends counting to ripgrep through bash")
  {
    const grep = describe("grep")
    check("V4-3: counting matches is done with rg through bash, not grep", grep.includes("to count them") && grep.includes("run ripgrep through bash") && grep.includes("rg --count"), grep)
    check("V4-3: and it names where the bundled rg is when none is on the PATH", grep.includes("MCODE_RIPGREP_PATH"), grep)
  }

  section("Round 20 (V4-4): bash checks a parent folder first and leaves output uncut")
  {
    const bash = bashDescription()
    check("V4-4: the parent folder is checked before something is created in it", bash.includes("make sure the folder it goes into exists") && bash.includes("before `mkdir"), bash)
    check("V4-4: output is not cut with head or tail, since the whole of it is saved", bash.includes("do not cut the output down yourself") && bash.includes("`head`") && bash.includes("`tail`"), bash)
  }

  section("Round 20 (V4-5): the task list's example steps are Chinese, as the model-facing layer is")
  {
    const prompt = agentPrompt("build")
    const task = /## Task management[\s\S]*?\n1\. ([^\n]*)/.exec(prompt)?.[1] ?? ""
    const examples = [...task.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "")
    check("V4-5: the first rule gives example step names", examples.length >= 2, task)
    check("V4-5: every one of them is written in Chinese", examples.length > 0 && examples.every((example) => /\p{Script=Han}/u.test(example) && !/[A-Za-z]{3,}/.test(example)), examples)
    check("V4-5: the English examples are gone", !prompt.includes("Outline the deck") && !prompt.includes("Check the finished slides"))
  }

  section("Round 20 (V4-6): with no MCP server the first note adds nothing about servers")
  {
    const none = sessionNote({ mcpServers: [], configFile: "/home/u/.mcode/config.json" })
    check("V4-6: no line announcing that there are none", !/No MCP servers/i.test(none), none)
    check("V4-6: the note is its heading and the config-file block alone", none.split("\n").length === 2 && none.includes("mcpServers") && none.includes("/home/u/.mcode/config.json"), none)
    const some = sessionNote({ mcpServers: ["files"], configFile: "/home/u/.mcode/config.json" })
    check("V4-6: with a server configured it is still named", some.includes("MCP servers configured here: files"), some)
  }

  section("Round 20 (V4-7): the no-colon narration example is Chinese")
  {
    const prompt = agentPrompt("build")
    const rule = prompt.split("\n").find((line) => line.includes("with a colon just before a tool call")) ?? ""
    const examples = [...rule.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "")
    check("V4-7: the rule shows the right way and the wrong way", examples.length === 2, rule)
    check("V4-7: both in Chinese, one closing on a full stop and one on a colon", /\p{Script=Han}/u.test(examples[0] ?? "") && (examples[0] ?? "").endsWith("。") && (examples[1] ?? "").endsWith("："), examples)
    check("V4-7: the English example is gone", !prompt.includes("I'll check the config"))
  }

  section("Round 20 (V4-8): the last step keeps the tools defined and lets none be called, as MiMo's does")
  {
    const e = await engine()
    try {
      await e.config.set({ maxSteps: 1 })
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(calls([{ name: "read", input: { file_path: "README.md" } }]), say("stopped here"))
      await e.runner.prompt({ sessionID: session.id, text: "keep going" })
      await e.idle(session.id)
      const last = e.bodies.at(-1)
      const tools = (last?.tools ?? []) as unknown[]
      check("V4-8: the step and then the last one were asked for", e.bodies.length === 2, e.bodies.length)
      check("V4-8: the last request's history holds the tool call and its result", wireText(last).includes('"tool_calls"') && wireText(last).includes('"role":"tool"'), wireText(last).slice(0, 400))
      check("V4-8: so its tools are still defined", tools.length > 0, tools.length)
      check("V4-8: with the tool choice none", last?.tool_choice === "none", last?.tool_choice)
      check("V4-8: and the instruction to answer in words", wireText(last).includes("MAXIMUM STEPS REACHED"))
      const earlier = e.bodies[0]
      check("V4-8: an ordinary step still leaves the choice to the model", earlier?.tool_choice === "auto", earlier?.tool_choice)
      const reply = (await e.assistants(session.id)).at(-1)
      check("V4-8: the turn ends on the model's words", !reply?.error && reply?.finish === "end_turn", reply?.error ?? reply?.finish)
    } finally {
      await e.close()
      await fs.rm(e.dir, { recursive: true, force: true }).catch(() => undefined)
    }

    // The Messages request: Anthropic refuses tool blocks in a request that defines no tools.
    const base = {
      apiKey: "",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      system: "s",
      history: [],
      tools: [findTool("read")!],
      effort: "",
      signal: new AbortController().signal,
    }
    const closing = messagesRequest({ ...base, toolChoice: "none" }) as { tools?: unknown[]; tool_choice?: { type?: string } }
    check("V4-8 (Anthropic): the last step's request defines the tools", (closing.tools?.length ?? 0) === 1, closing.tools?.length)
    check("V4-8 (Anthropic): and chooses none of them", closing.tool_choice?.type === "none", closing.tool_choice)
    const ordinary = messagesRequest(base) as { tool_choice?: unknown }
    check("V4-8 (Anthropic): an ordinary step sends no choice, so the model picks", ordinary.tool_choice === undefined, ordinary.tool_choice)
  }
}
