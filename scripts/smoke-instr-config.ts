import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { agentsState, deleteAgents, globalAgentsPath, setAgentsEnabled } from "../src/server/global-agents"
import { instructionValues, systemPrompt, systemPromptFrom, type InstructionValues } from "../src/server/session/prompt"
import { SessionRunner } from "../src/server/session/runner"
import { discoverSkills } from "../src/server/skill"

export async function instructionConfigChecks(check: Check): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-instr-"))
  try {
    const directory = path.join(root, "repo")
    const storage = path.join(root, "profile")
    const home = path.join(root, "home")
    await fs.mkdir(path.join(directory, ".git"), { recursive: true })
    await fs.mkdir(storage)
    const file = globalAgentsPath(storage)
    const marker = "global instruction fixture"
    const context = { directory, home, agent: "build", globalAgentsFile: file }
    const prompt = () => systemPrompt(context)
    let instructions: { initial: InstructionValues; current: InstructionValues } | undefined
    const runner = Object.assign(Object.create(SessionRunner.prototype) as SessionRunner, {
      globalAgents: file,
      store: {
        get: async () => ({ instructions }),
        messages: async () => [],
        update: async (_id: string, next: { instructions: typeof instructions }) => { instructions = next.instructions },
      },
    })
    const continuedPrompt = async () => systemPromptFrom(context.agent, await runner["syncInstructions"]("fixture", await instructionValues(context)))

    check("global instructions start unconfigured", (await agentsState(file)) === "none")
    await fs.writeFile(file, marker)
    check("global instructions are loaded", (await agentsState(file)) === "loaded" && (await prompt()).includes(marker))
    check("an existing conversation starts with global instructions", (await continuedPrompt()).includes(marker))
    await setAgentsEnabled(file, false)
    check("closed global instructions are excluded by the engine", (await agentsState(file)) === "disabled" && !(await prompt()).includes(marker))
    check("closing global instructions clears them from an existing conversation's system prompt", !(await continuedPrompt()).includes(marker))
    await setAgentsEnabled(file, true)
    check("re-enabling restores the original instructions", (await prompt()).includes(marker))
    check("re-enabling restores global instructions to an existing conversation", (await continuedPrompt()).includes(marker))
    for (const enabled of [true, false]) {
      await fs.writeFile(file, marker)
      await setAgentsEnabled(file, enabled)
      await deleteAgents(file)
      check(`deleting the ${enabled ? "loaded" : "closed"} file clears it`, (await agentsState(file)) === "none" && !(await prompt()).includes(marker))
      check("deleted global instructions are excluded from the existing conversation's system prompt", !(await continuedPrompt()).includes(marker))
    }

    for (const [folder, name, description] of [
      [".agents", "shared", "Agents takes precedence"],
      [".opencode", "shared", "Legacy OpenCode"],
      [".config/opencode", "shared", "OpenCode duplicate"],
      [".config/opencode", "modern", "OpenCode config root"],
    ]) {
      const target = path.join(home, folder, "skills", name)
      await fs.mkdir(target, { recursive: true })
      await fs.writeFile(path.join(target, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`)
    }
    const scan = (opencode: boolean) => discoverSkills({ directory, home, builtinRoot: null, settings: { skillPaths: { opencode } } })
    check("OpenCode compatibility is opt-in", !(await scan(false)).skills.some(({ name }) => name === "modern"))
    const { skills } = await scan(true)
    check("enabled OpenCode scans its config root and deduplicates across roots",
      skills.map(({ name, description }) => [name, description]).join("|") === "modern,OpenCode config root|shared,Agents takes precedence",
      skills.map(({ name, description }) => [name, description]))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  const settings = await fs.readFile("src/renderer/src/components/SettingsDialog.vue", "utf8")
  const copy = await fs.readFile("src/renderer/src/lib/i18n.ts", "utf8")
  check("the Delete button opens a confirmation and only confirmation calls the delete handler",
    /data-agents-delete @click="confirmingAgentsDelete = true"/.test(settings) &&
    /<ConfirmDialog\s+v-if="confirmingAgentsDelete"[\s\S]+?:body="t\('set.agents.deleteBody'\)"[\s\S]+?@confirm="removeAgents"\s+@close="confirmingAgentsDelete = false"/.test(settings) &&
    settings.match(/type: "agents.delete"/g)?.length === 1 &&
    /async function removeAgents\(\) \{\s+if \(!confirmingAgentsDelete.value/.test(settings))
  check("confirmation uses the required Simplified Chinese copy",
    copy.includes('"set.agents.deleteBody": "将删除全局指令文件 AGENTS.md，引擎将不再注入全局指令。此操作不可撤销。"'))
}
