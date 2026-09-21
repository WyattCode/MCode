/**
 * Round 18, lane M: the settings MiMo 26.920 added or redid - the skill folders
 * of other tools (R18-M1), launch at login (R18-M2), the lab page (R18-M3),
 * the `/responses` protocol (R18-M4) and the redone models page (R18-M5).
 *
 * Everything here runs in plain node: folders are temporary, the home folder
 * is a folder of the check's own, and the login item is a stub that records
 * what it was asked. The drawn pages are in the lane's Electron probe.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { SESSION_CHAT_SKILL, discoverSkills, externalSkillDirs } from "../src/server/skill"
import { sanitizeConfig } from "../src/server/config-sanitize"
import type { AppConfig } from "../src/shared/protocol"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

async function skill(root: string, name: string, description = `the ${name} skill`): Promise<void> {
  await fs.mkdir(path.join(root, name), { recursive: true })
  await fs.writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`, "utf8")
}

export async function roundEighteenSettingsChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ---------------------------------------------------------------- R18-M1
  section("Round 18 (M1): the skill folders of other tools, `.agents` read by default")
  {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r18m1-"))
    try {
      const home = path.join(base, "home")
      const repo = path.join(base, "repo")
      const nested = path.join(repo, "packages", "app")
      const storage = path.join(base, "storage")
      await fs.mkdir(path.join(repo, ".git"), { recursive: true })
      await fs.mkdir(nested, { recursive: true })
      await skill(path.join(home, ".agents", "skills"), "global-agents")
      await skill(path.join(home, ".agents", "skills"), "shared", "from the global agents folder")
      await skill(path.join(home, ".claude", "skills"), "global-claude")
      await skill(path.join(home, ".codex", "skills"), "global-codex")
      await skill(path.join(home, ".opencode", "skills"), "global-opencode")
      await skill(path.join(repo, ".agents", "skills"), "project-agents")
      await skill(path.join(repo, ".agents", "skills"), "shared", "from the repository root")
      await skill(path.join(nested, ".agents", "skills"), "shared", "from the nearer folder")
      await skill(path.join(repo, ".claude", "skills"), "project-claude")
      await skill(path.join(storage, "skills"), "own", "from the app's own folder")
      await skill(path.join(repo, ".agents", "skills"), "own", "from the project agents folder")
      // Only `skills`, as MiMo reads these folders; a `skill` folder there is not one.
      await skill(path.join(home, ".agents", "skill"), "singular")

      const names = async (settings?: Pick<AppConfig, "skillPaths" | "sessionChat">) => {
        const scan = await discoverSkills({ directory: nested, storageDirectory: storage, builtinRoot: null, home, settings })
        return scan.skills
      }
      const plain = await names()
      const has = (list: { name: string }[], name: string) => list.some((entry) => entry.name === name)
      check("R18-M1: by default the global ~/.agents/skills is read", has(plain, "global-agents"), plain.map((entry) => entry.name))
      check("R18-M1: and the project's .agents/skills", has(plain, "project-agents"))
      check("R18-M1: the three brand folders stay unread by default", !has(plain, "global-claude") && !has(plain, "global-codex") && !has(plain, "global-opencode") && !has(plain, "project-claude"))
      check("R18-M1: only a `skills` folder counts there", !has(plain, "singular"))
      check("R18-M1: the nearer project folder wins a shared name", plain.find((entry) => entry.name === "shared")?.description === "from the nearer folder")
      check("R18-M1: the app's own global folder is read after them and wins", plain.find((entry) => entry.name === "own")?.description === "from the app's own folder")
      check("R18-M1: a skill from these folders is the user's, not a shipped one", plain.every((entry) => !entry.builtin))

      const claude = await names({ skillPaths: { claude: true } })
      check("R18-M1: switching Claude on reads ~/.claude/skills", has(claude, "global-claude") && has(claude, "project-claude"))
      check("R18-M1: and leaves .agents as it was", has(claude, "global-agents"))
      const none = await names({ skillPaths: { agents: false } })
      check("R18-M1: switching .agents off stops reading it", !has(none, "global-agents") && !has(none, "project-agents"))
      const all = await names({ skillPaths: { claude: true, codex: true, opencode: true } })
      check("R18-M1: all four read when all are on", ["global-agents", "global-claude", "global-codex", "global-opencode"].every((name) => has(all, name)))
      check("R18-M1: the folders in MiMo's order", externalSkillDirs({ claude: true, codex: true, opencode: true }).join(" ") === ".claude .codex .opencode .agents")
      check("R18-M1: and only .agents when nothing was chosen", externalSkillDirs(undefined).join(" ") === ".agents")

      const doc = { skillPaths: { agents: false, claude: "yes", other: true } } as unknown as AppConfig
      sanitizeConfig(doc, {} as AppConfig)
      check("R18-M1: a stored choice that is not a boolean, or not one of the four, is dropped", JSON.stringify(doc.skillPaths) === JSON.stringify({ agents: false }), doc.skillPaths)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
    const source = await read("src/server/skill.ts")
    check("R18-M1: skill.ts no longer says MiMo switches the four folders off", !/switches all four off/.test(source))
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    check("R18-M1: the config page lists the four folders with a switch each", /data-skill-path-switch/.test(settings) && /\["agents", "claude", "codex", "opencode"\]/.test(settings))
    check("R18-M1: and the config file row can copy its path", /data-config-copy-path/.test(settings) && /navigator\.clipboard\.writeText\(target\)/.test(settings))
  }

  // Session chat's skill, which the lab switch takes away (R18-M3 checks the tools).
  {
    const builtin = path.join(process.cwd(), "resources", "skills")
    const on = await discoverSkills({ directory: os.tmpdir(), builtinRoot: builtin, home: path.join(os.tmpdir(), "mcode-r18-no-home") })
    const off = await discoverSkills({ directory: os.tmpdir(), builtinRoot: builtin, home: path.join(os.tmpdir(), "mcode-r18-no-home"), settings: { sessionChat: false } })
    check("R18-M3: session chat's skill ships", on.skills.some((entry) => entry.name === SESSION_CHAT_SKILL))
    check("R18-M3: and is gone while session chat is off", !off.skills.some((entry) => entry.name === SESSION_CHAT_SKILL))
  }
}
