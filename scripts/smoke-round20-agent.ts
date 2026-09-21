/**
 * Round 20, the coding agent against MiMo 26.920's engine: tool advice MiMo
 * gives and MCode lacked, the prompt's examples, the first-message note, and
 * the request on the step that has to be the last one. Each check fails on the
 * text or the request as it stood before.
 *
 * smoke.ts calls `roundTwentyAgentChecks` with its own check and section.
 */
import { sessionNote } from "../src/server/session/context"
import { agentPrompt } from "../src/server/session/prompts"
import { bashDescription } from "../src/server/tool/bash"
import { findTool } from "../src/server/tool/registry"
import type { Check } from "./smoke-round5"

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
}
