/**
 * Round 79: what a lean turn is told has to match what a lean turn is handed.
 *
 * A turn whose endpoint sits on this machine or the LAN runs lean: `toolsForTurn` drops the tools in
 * `LEAN_LEAVES_OUT` — the session-chat family, the two desktop settings, `pdf_locate`, `history` —
 * because most of the tools a coding turn offers those models are never called. Two ways that went
 * wrong, both pinned here:
 *
 *   1. Lean was decided by whether the provider was built in, so a built-in Ollama (which always
 *      answers locally) never got the trimmed turn, and a vendor provider added by hand lost its
 *      desktop tools just for being hand-added. The rule now is the endpoint the provider resolves
 *      to, read off `definition(id).baseURL`: an entry added by hand and pointed at a LAN port is
 *      lean, one pointed at a public host is not, and the id itself never carries the decision.
 *   2. Text a lean model does read — a tool's own description, a skill shipped with the app — named a
 *      tool its request never carried, and told it to call that tool. A tool that is not in the
 *      request is not "unreliable": the model answers in prose or calls a name that does not exist,
 *      and the retry costs a step. The check works out what lean withdrew from the tool table itself,
 *      so renaming a tool or trimming a new one cannot leave the prose pointing at nothing.
 *   3. The skill whose tools lean withdraws is withdrawn with them — but only the system prefix knew
 *      that, so a lean turn could still pull the same body through `/skill-name` or the `skill` tool.
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "../src/server/config"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { isLocalEndpoint } from "../src/server/provider/sampling"
import { LEAN_LEAVES_OUT, TOOLS, findTool, toolsForTurn } from "../src/server/tool/registry"
import { discoverSkills } from "../src/server/skill"
import type { CustomProvider } from "../src/shared/protocol"

const ROOT = process.cwd()
const scratch: string[] = []
const failures: string[] = []
const check = (cond: boolean, what: string): void => {
  if (!cond) failures.push(what)
}

/** A temp home, so discovery sees the shipped skills and nothing a developer keeps in ~/.mcode. */
async function tempHome(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcode-r79-"))
  scratch.push(dir)
  return dir
}

/** A config loaded through the real store, so `definition` answers from real provider entries. */
async function loaded(stored: Record<string, unknown>): Promise<Config> {
  const dir = await tempHome()
  const store = new Storage(dir)
  await store.write("config", stored)
  const config = new Config(store, new Bus(), path.join(dir, "credentials.json"))
  await config.load()
  return config
}

const local = (config: Config, id: string): boolean => isLocalEndpoint(id, config.definition(id)?.baseURL)

/** A hand-added provider: the shape the settings form writes, at a caller-chosen base URL. */
const added = (id: string, baseURL: string): CustomProvider => ({ id, name: id, baseURL })

async function endpointDecidesTheTurn(): Promise<void> {
  const config = await loaded({
    customProviders: [added("lan-lab", "http://192.168.10.233:8888/v1"), added("far-lab", "https://api.deepseek.com/v1")],
  })
  check(!!config.definition("lan-lab"), "a provider added by hand has to reach the provider table for the rest of this round to mean anything")

  // The built-ins that answer on this machine, and the ones that do not.
  for (const id of ["ollama", "vllm", "lmstudio"]) check(local(config, id), `built-in ${id} answers on this machine and must be read as a local endpoint`)
  for (const id of ["anthropic", "openai"]) check(!local(config, id), `built-in ${id} answers from elsewhere and must not be read as a local endpoint`)

  // An entry added by hand is judged by where it answers, which is the point of the change: the lab
  // box on the LAN gets the trimmed turn, and a vendor added by hand keeps its full one.
  check(local(config, "lan-lab"), "a provider added by hand and pointed at a LAN address is a local endpoint")
  check(!local(config, "far-lab"), "a provider added by hand and pointed at a public host is not a local endpoint")

  // And the name decides nothing on its own: the same id at a public address is not local.
  check(!isLocalEndpoint("ollama", "https://ollama.com"), "a provider id named ollama at a public address is still not a local endpoint")
}

/**
 * The tools a turn is handed, with everything the user can switch on switched on. `local` is the
 * switch that moves the table (`registry.ts` reads the lean mode off it, not off a separate lean
 * flag), and it is the same answer the runner now takes from `isLocalEndpoint`.
 */
function turnTools(local: boolean): Set<string> {
  return new Set(
    toolsForTurn("build", { voiceFeedback: false, shell: "/bin/bash", sessionChat: true, webSearch: true, local }).map(
      (tool) => tool.name,
    ),
  )
}

/** What local-withdraws, worked out from the tool table rather than repeated from its list. */
function leanWithdraws(): string[] {
  const full = turnTools(false)
  check(full.size > 0, "a turn has to be handed a tool table for this round to mean anything")
  const lean = turnTools(true)
  return [...full].filter((name) => !lean.has(name))
}

/**
 * The sentence that lets a withheld name stand says one of two things, in whichever language the
 * text is written: the tool may not be in this turn's list ("本轮工具清单没有它们时跳过这一步",
 * "if it is not among your tools"), or the same result is reachable without it ("where your tools
 * include it, or from the message JSON"). Naming the tool list is what keeps either from being an
 * accident of wording.
 */
const NAMES_THE_TOOL_LIST = /工具|tools?\b/i
const SAYS_IT_MAY_BE_MISSING = /没有|不含|缺|不可用|跳过|not\b|no such|missing|unavailable|absent|lack|withheld|exclude|drop|omit/i
const OFFERS_ANOTHER_WAY = /\bor\b[^.;:]{0,80}\b(from|read|JSON|file|panel|view)\b|否则|或者|改用/i

/** Blocks of prose: a qualifier belongs to the paragraph that names the tool, not to any nearby line. */
const paragraphs = (text: string): string[] => text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).filter((block) => block.trim().length > 0)

function namesWithheldTool(text: string, withheld: Set<string>): { name: string; block: string }[] {
  const found: { name: string; block: string }[] = []
  for (const block of paragraphs(text)) {
    for (const match of block.matchAll(/`([a-z][a-z0-9_]+)`/g)) {
      if (withheld.has(match[1])) found.push({ name: match[1], block })
    }
  }
  return found
}

/** Every file of text a lean turn can be shown: the skills discovery still offers it, and their guides. */
async function leanSkillTexts(lean: boolean): Promise<{ skill: string; file: string; text: string }[]> {
  const home = await tempHome()
  const skills = await discoverSkills({
    directory: home,
    builtinRoot: path.join(ROOT, "resources", "skills"),
    home,
    storageDirectory: home,
    lean,
  })
  const texts: { skill: string; file: string; text: string }[] = []
  for (const entry of skills.skills) {
    texts.push({ skill: entry.name, file: path.relative(ROOT, entry.location), text: entry.content })
    const guides = path.join(entry.directory, "references")
    if (!fs.existsSync(guides)) continue
    for (const name of fs.readdirSync(guides).filter((file) => file.endsWith(".md"))) {
      const full = path.join(guides, name)
      texts.push({ skill: entry.name, file: path.relative(ROOT, full), text: fs.readFileSync(full, "utf8") })
    }
  }
  return texts
}

async function textMatchesTheTable(): Promise<void> {
  const withdrawn = leanWithdraws()
  check(withdrawn.length > 0, "the lean turn has to take tools away for this round to mean anything")
  check(
    withdrawn.every((name) => LEAN_LEAVES_OUT.has(name)),
    `lean took away ${withdrawn.filter((name) => !LEAN_LEAVES_OUT.has(name)).join(", ")}, which is not in the set its own list names`,
  )

  // The skill whose tools lean takes is taken with them: both discovery passes see the same shelf.
  const fullSkills = new Set((await leanSkillTexts(false)).map((entry) => entry.skill))
  const leanSkills = new Set((await leanSkillTexts(true)).map((entry) => entry.skill))
  check(fullSkills.size > 0, "the shipped skills have to be found for this round to mean anything")
  check(
    [...fullSkills].some((name) => !leanSkills.has(name)),
    "a lean turn keeps a skill whose tools it was not given; the skill has to be withdrawn with them",
  )

  // Each turn is read against its own table: a description belongs to the turn that offers its tool,
  // and a skill body belongs to the turn whose discovery still hands it over. The same sentence can
  // be a lie for a local turn and honest for a full one.
  for (const local of [true, false]) {
    const table = turnTools(local)
    const withheld = new Set(withdrawn.filter((name) => !table.has(name)))
    const texts: { file: string; text: string }[] = []
    for (const tool of TOOLS) {
      if (!table.has(tool.name) || !tool.description) continue
      texts.push({ file: `the ${tool.name} tool's own description`, text: tool.description })
    }
    for (const entry of await leanSkillTexts(local)) texts.push({ file: `${entry.skill} skill (${entry.file})`, text: entry.text })

    for (const { file, text } of texts) {
      for (const { name, block } of namesWithheldTool(text, withheld)) {
        check(
          NAMES_THE_TOOL_LIST.test(block) && (SAYS_IT_MAY_BE_MISSING.test(block) || OFFERS_ANOTHER_WAY.test(block)),
          `${file} sends the ${local ? "local-endpoint" : "full"} turn to \`${name}\`, which it is not given, without saying it may be absent or how to get the same result without it: ${block.trim().replace(/\s+/g, " ").slice(0, 160)}`,
        )
      }
    }
  }

  // The names the rule reads are real tools, or a typo would pass it quietly.
  for (const name of withdrawn) check(!!findTool(name), `${name} is taken away by lean but is not a tool the app has`)
  check(TOOLS.length > 0, "the tool table has to be there for this round to mean anything")
}

async function main(): Promise<void> {
  try {
    await endpointDecidesTheTurn()
    await textMatchesTheTable()
  } finally {
    for (const dir of scratch) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // A scratch dir the OS already took is not a failed check.
      }
    }
  }
  for (const failure of failures) console.log("FAIL:", failure)
  console.log(`\nround79: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`)
  if (failures.length > 0) process.exitCode = 1
}

void main()
