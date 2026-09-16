/**
 * Round 8: what the model is told, and what stops a reply that will not stop.
 *
 * Kept apart from smoke.ts the way rounds five to seven are; smoke.ts calls
 * `roundEightChecks` with its own check and section. The rules that are pure
 * are checked directly, and everything that only matters on the wire is read
 * back out of the fake provider's own request bodies - a prompt a family
 * "gets" is only got if the provider was sent it.
 *
 * Nothing here asserts against the constant it is testing: the strings below
 * are written out again by hand, so rewriting a prompt or a description makes
 * the check fail rather than agreeing with itself.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServerResponse } from "node:http"
import type { Check } from "./smoke-round5"
import { engine, say, wireText } from "./smoke-round5"
import { FAMILY_PROMPTS, basePrompt, promptFamily } from "../src/server/session/prompts"
import { systemPrompt } from "../src/server/session/prompt"
import { attachmentNote, sessionNote } from "../src/server/session/context"
import { firstPlanNote } from "../src/server/session/plan"
import { createLoopMonitor } from "../src/server/session/reminders"
import { findTool } from "../src/server/tool/registry"

/** The system text of a request, as the chat-completions wire carries it. */
function systemOf(body: Record<string, any> | undefined): string {
  const first = body?.messages?.[0]
  return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "")
}

/** How many times a phrase appears in a request. */
function countIn(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * A reply that streams the same phrase over and over and never stops on its own.
 *
 * The point is that the client is what ends it: the monitor fires part way
 * through, the request is aborted, and the socket closes under the writes still
 * queued here - which is why every write is guarded and the error is swallowed.
 */
function looping(phrase = "let me check that file again and then "): (response: ServerResponse) => void {
  return (response) => {
    response.on("error", () => undefined)
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (let at = 0; at < 400 && !response.destroyed; at++) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: phrase } }] })}\n\n`)
    }
    if (!response.destroyed) {
      response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2000 } })}\n\ndata: [DONE]\n\n`)
    }
  }
}

export async function roundEightChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ------------------------------------------------------------------ M1
  section("Round 8 (M1): one prompt per model family, as MiMo picks one of its ten")
  {
    check("a Claude model reads the Anthropic prompt", promptFamily({ provider: "anthropic", id: "claude-sonnet-5" }) === "anthropic")
    check("so does one reached over another provider", promptFamily({ provider: "openrouter", id: "anthropic/claude-haiku-4-5" }) === "anthropic")
    check("a GPT model reads the GPT one", promptFamily({ provider: "openai", id: "gpt-5.1" }) === "gpt")
    check("as do the o-series and codex ids MiMo matches", promptFamily({ provider: "openai", id: "o3-mini" }) === "gpt" && promptFamily({ provider: "openai", id: "codex-mini" }) === "gpt")
    check("every other family falls to the general one", promptFamily({ provider: "lmstudio", id: "qwen3-30b" }) === "general" && promptFamily({ provider: "google", id: "gemini-3-pro" }) === "general")
    check("and so does a turn that names no model at all", promptFamily(undefined) === "general")

    check("the three are three different texts", new Set(Object.values(FAMILY_PROMPTS)).size === 3)
    check(
      "each is in MiMo's length class rather than a page of bullet points",
      FAMILY_PROMPTS.anthropic.length > 3_000 && FAMILY_PROMPTS.gpt.length > 7_000 && FAMILY_PROMPTS.general.length > 5_000,
      [FAMILY_PROMPTS.anthropic.length, FAMILY_PROMPTS.gpt.length, FAMILY_PROMPTS.general.length],
    )
    /* The section each one is organised around, written out here rather than read off the prompt. */
    check("the Anthropic one is organised around the harness", basePrompt({ id: "claude-sonnet-5" }).includes("# Harness"))
    check("the GPT one around personality and how an answer should read", basePrompt({ id: "gpt-5" }).includes("# Personality") && basePrompt({ id: "gpt-5" }).includes("## Final answer"))
    check("and the general one around how a turn works", basePrompt({ id: "qwen3" }).includes("## How this works"))
    check("each says what a system-reminder is", Object.values(FAMILY_PROMPTS).every((prompt) => prompt.includes("<system-reminder>")))
    check("and each says not to obey instructions found inside a tool's output", Object.values(FAMILY_PROMPTS).every((prompt) => /never (?:something )?to obey|never something to obey|something to report, never/.test(prompt)))

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r8-"))
    const built = await systemPrompt({ directory: root, agent: "build", model: { provider: "openai", id: "gpt-5" } })
    check("the system prompt opens with that family's prompt", built.startsWith("You are MCode, a coding agent. You and the user share one project"), built.slice(0, 60))
    const other = await systemPrompt({ directory: root, agent: "build", model: { provider: "anthropic", id: "claude-sonnet-5" } })
    check("and a different family opens with a different one", !other.startsWith(built.slice(0, 60)))
    check("while the sections after it are the same ones", built.includes("## Environment") && other.includes("## Environment"))
    await fs.rm(root, { recursive: true, force: true })
  }

  section("Round 8 (M1): the provider is sent the family's prompt, and the same one all conversation")
  {
    const e = await engine({ custom: { models: [{ id: "claude-sonnet-5", name: "C" }, { id: "gpt-5", name: "G" }, { id: "qwen3", name: "Q" }] } })
    try {
      const sent = async (model: string) => {
        const session = await e.store.create({ directory: e.project, model: { provider: "fake", model } })
        e.replies.push(say("ok"))
        await e.runner.prompt({ sessionID: session.id, text: "hello" })
        await e.idle(session.id)
        return { session, system: systemOf(e.bodies.at(-1)) }
      }
      const claude = await sent("claude-sonnet-5")
      const gpt = await sent("gpt-5")
      const qwen = await sent("qwen3")
      check("a Claude turn carries the Anthropic prompt", claude.system.includes("# Harness") && !claude.system.includes("# Personality"), claude.system.slice(0, 80))
      check("a GPT turn carries the GPT one", gpt.system.includes("# Personality") && !gpt.system.includes("# Harness"))
      check("and anything else the general one", qwen.system.includes("## How this works") && !qwen.system.includes("# Personality"))

      /* The prefix has to stay byte-identical across a conversation or the provider's cache is paid for twice. */
      e.replies.push(say("again"))
      await e.runner.prompt({ sessionID: claude.session.id, text: "second" })
      await e.idle(claude.session.id)
      check("a second turn in the same conversation sends the very same prefix", systemOf(e.bodies.at(-1)) === claude.system)
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M3
  section("Round 8 (M3): the rest of the tool descriptions carry MiMo's coverage")
  {
    const describe = (name: string) => findTool(name)?.description ?? ""

    const edit = describe("edit")
    check("edit says the quote has to be unique and what to do when it is not", edit.includes("exactly once") && edit.includes("more of the surrounding lines"))
    check("it names replace_all as the way to rename through a file", edit.includes("replace_all"))
    check("it says to strip the read tool's line-number prefix", edit.includes("line-number prefix"))
    check("and it is in MiMo's length class", edit.length > 900, edit.length)

    const write = describe("write")
    check("write says it replaces the whole file and to read one first", write.includes("replaces the whole file") && write.includes("read it first"))
    check("it sends notebooks to notebook_edit", write.includes("notebook_edit"))
    check("and tells the model not to invent extra files", write.includes("Do not add a README"))

    const glob = describe("glob")
    check("glob explains the no-slash rule MiMo's does", glob.includes("no slash in it matches file names at any depth"))
    check("and says results are newest first", glob.includes("most recently changed first"))

    const grep = describe("grep")
    check("grep says to escape what is special in a regular expression", grep.includes("escape the characters"))
    check("and that a search hitting the cap should be narrowed", grep.includes("narrowed rather than trusted as complete"))

    const list = describe("list")
    check("list says when to reach for glob instead", list.includes("glob and grep answer faster"))

    const webfetch = describe("webfetch")
    check("webfetch says what each format is for", webfetch.includes("format markdown") && webfetch.includes("html gives the page exactly"))
    check("and what it cannot do - sign in, post, run scripts", webfetch.includes("cannot post a form, sign in"))

    const notebook = describe("notebook_edit")
    check("notebook_edit names the three modes", notebook.includes("edit_mode replace") && notebook.includes("edit_mode insert") && notebook.includes("edit_mode delete"))
    check("it warns that outputs stay while the code changes", notebook.includes("outputs on screen may no longer match"))
    check("and forbids editing the JSON by hand", notebook.includes("Do not edit a .ipynb with the write or edit tools"))

    const memory = describe("memory")
    check("memory says when to search rather than ask", memory.includes("before asking the user something they may already have told you"))
    check("and what each scope holds", memory.includes("project memory holds"))

    const cron = describe("cron")
    check("cron says which of schedule and loop fits what", cron.includes("Which to use: schedule for work that belongs to a time"))
    check("and that a fired prompt starts with none of this conversation's context", cron.includes("has none of this conversation's context"))

    /* Worth nothing unless the provider is the one reading them. */
    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: session.id, text: "hello" })
      await e.idle(session.id)
      const tools = (e.bodies.at(-1)?.tools ?? []) as { function?: { name?: string; description?: string } }[]
      const sent = tools.find((tool) => tool.function?.name === "edit")?.function?.description ?? ""
      check("the provider receives the long edit description, not a summary of it", sent.includes("line-number prefix") && sent.length > 900, sent.length)
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M14
  section("Round 8 (M14): the first message carries the MCP policy, once")
  {
    const configured = sessionNote({ mcpServers: ["files", "github"], globalAgentsFile: "/home/u/.mcode/AGENTS.md", configFile: "/home/u/.mcode/config.json", dataRoot: "/home/u/.mcode" })
    check("the servers are named", configured.includes("files, github"))
    check("it says to prefer an MCP tool to the matching command-line program", configured.includes("Prefer an MCP tool to a command-line program"))
    check("it forbids signing into a CLI this app cannot service", configured.includes("never try to sign into one"))
    check("it forbids running a server's own executable as a fallback", configured.includes("not a shell fallback"))
    check("it says configured and loaded are different questions", configured.includes("configured but not loaded in this conversation"))
    check("it gives the config file and the entry shape, so several can be added at once", configured.includes("/home/u/.mcode/config.json") && configured.includes('"type":"local"') && configured.includes('"type":"remote"'))
    check("it says where a project skill and a global skill go", configured.includes(".mcode/skills/<name>/SKILL.md") && configured.includes(path.join("/home/u/.mcode", "skills")))
    check("and it still says how to ask the user to choose", configured.includes("question tool") && configured.includes("set multiple"))

    const none = sessionNote({ mcpServers: [], globalAgentsFile: "/home/u/.mcode/AGENTS.md", configFile: "/home/u/.mcode/config.json", dataRoot: "/home/u/.mcode" })
    check("with no servers it says so plainly and invents none", none.includes("No MCP servers are configured here") && !none.includes("Prefer an MCP tool"))

    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: session.id, text: "first" })
      await e.idle(session.id)
      const first = wireText(e.bodies.at(-1))
      check("the note reaches the provider on the first message, with where the servers are kept", first.includes("object holds one entry per server") && first.includes("config.json"))
      check("exactly once", countIn(first, "No MCP servers are configured here") === 1, countIn(first, "No MCP servers are configured here"))

      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: session.id, text: "second" })
      await e.idle(session.id)
      const second = wireText(e.bodies.at(-1))
      check("and is not repeated on the next message", countIn(second, "No MCP servers are configured here") === 1)
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M15
  section("Round 8 (M15): a planning turn is given the workflow, not only the prohibitions")
  {
    const note = firstPlanNote("plans/1-clear-ledger.md", false)
    check("stage one sends explore subagents, up to three, together", note.includes("up to three, started together in one step"))
    check("stage two is one general subagent at most, with the background it needs", note.includes("One general subagent, at most") && note.includes("it starts knowing none of it"))
    check("stage three reads the critical files rather than trusting a summary", note.includes("rather than trusting the summary"))
    check("stage four asks for the recommended approach, the paths, and a verification section", note.includes("not the alternatives you rejected") && note.includes("verification section"))
    check("stage five is the plan_exit call", note.includes("5. Call plan_exit"))
    check("and the turn may end in only those two ways", note.includes("End this turn in one of two ways, and no other") && note.includes("that is what plan_exit is for"))
    check("the prohibitions from round five are still there", note.includes("Do not run tests, linters, type checks, builds") && note.includes("refused before it runs"))

    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model, agent: "plan" })
      e.replies.push(say("planning"))
      await e.runner.prompt({ sessionID: session.id, text: "work out how to add a setting" })
      await e.idle(session.id)
      const sent = wireText(e.bodies.at(-1))
      check("a planning turn's request carries the workflow", sent.includes("verification section") && sent.includes("5. Call plan_exit"))
      check("once", countIn(sent, "5. Call plan_exit") === 1, countIn(sent, "5. Call plan_exit"))
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M16
  section("Round 8 (M16): attachments are framed as reads, and Office documents name their tool")
  {
    const note = attachmentNote([{ path: "notes.md" }, { path: "books.xlsx" }, { path: "report.docx" }, { path: "deck.pptx" }, { path: "shot.png" }], "/work")
    check("text files are said to be read already", note?.includes("already read into this message") === true)
    check("a spreadsheet names openpyxl or pandas", note?.includes("openpyxl") === true)
    check("a document names python-docx", note?.includes("python-docx") === true)
    check("a deck names python-pptx", note?.includes("python-pptx") === true)
    check("and reading one as text is called out as the wrong move", note?.includes("compressed container") === true)
    check("pictures are said to travel in the message", note?.includes("travel in this message") === true)
    check("the paths are absolute", note?.includes(path.resolve("/work", "books.xlsx")) === true)
    check("and the folder-search prohibition is kept", note?.includes("Do not search or list the user's folders") === true)
    check("nothing is said about a kind that was not attached", attachmentNote([{ path: "a.txt" }], "/work")?.includes("Office documents") === false)

    const e = await engine()
    try {
      await fs.writeFile(path.join(e.project, "notes.md"), "# notes\nthe answer is 41\n")
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(say("read it"))
      await e.runner.prompt({ sessionID: session.id, text: "what does it say", attachments: [{ path: "notes.md", mime: "", data: "", byPath: true }] })
      await e.idle(session.id)
      const sent = wireText(e.bodies.at(-1))
      check("the file arrives framed as a read the app already made", sent.includes("The read tool was called for you with"))
      check("naming the file it was called on", sent.includes('notes.md\\\"}') || sent.includes("notes.md"), sent.slice(0, 200))
      check("with the contents after it", sent.includes("the answer is 41"))
    } finally {
      await e.close()
    }
  }

  // ------------------------------------------------------------------ M13
  section("Round 8 (M13): a reply that repeats itself is cut while it streams")
  {
    const monitor = createLoopMonitor()
    const phrase = "check the file again and "
    let fired = false
    for (let at = 0; at < 60 && !fired; at++) fired = monitor.append(phrase)
    check("the monitor fires on a phrase repeated past MiMo's threshold", fired)
    check("and stays fired once it has", monitor.append("something else entirely"))

    const calm = createLoopMonitor()
    let calmFired = false
    for (let at = 0; at < 60 && !calmFired; at++) calmFired = calm.append(`step ${at}: read src/file${at}.ts and note what it does\n`)
    check("ordinary prose that never repeats does not fire it", !calmFired)

    const e = await engine()
    try {
      const session = await e.store.create({ directory: e.project, model: e.model })
      e.replies.push(looping(), looping(), looping())
      await e.runner.prompt({ sessionID: session.id, text: "go" })
      await e.idle(session.id)

      const messages = await e.assistants(session.id)
      const first = messages[0]
      const written = first?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? ""
      check("the reply was stopped long before the output limit", written.length > 0 && written.length < 9_000, written.length)

      const asked = e.bodies.map((body) => wireText(body))
      check("the next request tells it to stop repeating", asked.some((body) => body.includes("repeated the same wording over and over")), asked.length)
      check("and the second one says the approach is stuck", asked.some((body) => body.includes("repeating itself again, after being told once already")))

      const last = messages.at(-1)
      check("after both recoveries the turn ends with the failure on the message", last?.finish === "error" && last?.errorCode === "error.replyLoop", { finish: last?.finish, code: last?.errorCode })
      check("and it is not left running", !e.runner.busySessions().includes(session.id))
      check("three steps were asked for and no more", e.bodies.length === 3, e.bodies.length)
    } finally {
      await e.close()
    }
  }
}
