import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseFrontmatter } from "./frontmatter"

/**
 * Skills: folders holding a SKILL.md, found where MiMo's desktop engine looks.
 *
 * In order, each later source winning a name over an earlier one:
 *
 *   1. the skills this app ships (`resources/skills/<name>/SKILL.md`);
 *   2. the global config folder, `{skill,skills}/**\/SKILL.md` under the app's
 *      own data directory, where its AGENTS.md also lives;
 *   3. every project `.mcode` folder from the repository root down to the
 *      conversation's directory, the same pattern - nearer wins.
 *
 * A shipped skill never displaces one the user wrote, whichever order they are
 * met in, and a user skill replaces a shipped one of the same name. MiMo's
 * engine can also read `.claude`, `.agents`, `.codex` and `.opencode` folders,
 * but its desktop app switches all four off, so they are not read here.
 */

export interface SkillInfo {
  name: string
  description: string
  aliases: string[]
  /** The SKILL.md itself. */
  location: string
  /** The folder it sits in, which its relative paths are resolved against. */
  directory: string
  /** The body, frontmatter removed, up to `SKILL_BODY_MAX`. */
  content: string
  /** The body was longer than that and what is here stops short of the end. */
  truncated?: boolean
  /** Kept out of the prompt, the search and the skill tool; `/name` typed by the user still loads it. */
  disableModelInvocation: boolean
  /** Shipped with the app. */
  builtin: boolean
}

export interface SkillProblem {
  path: string
  message: string
}

export interface SkillScan {
  skills: SkillInfo[]
  problems: SkillProblem[]
}

/** Where a project keeps its own commands and skills. */
export const PROJECT_CONFIG_DIR = ".mcode"

/**
 * The most of one SKILL.md that is read, as MiMo reads one.
 *
 * A skill's body goes into the prompt whole, and nothing capped it: an
 * unusually large SKILL.md quietly spent the conversation's context budget and
 * its cost before the first question was asked. MiMo stops at the same figure
 * and marks what it handed back as cut.
 */
export const SKILL_BODY_MAX = 200_000

/** How deep a folder scan walks before giving up. */
export const MAX_DEPTH = 8

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * The folder the shipped skills are read from.
 *
 * Packaged, electron-builder copies `resources/skills` beside the asar; in a
 * development build the bundle sits in `out/main` and the checks run from
 * `src/server`, both two levels under the repository root.
 */
export function builtinSkillsRoot(): string | undefined {
  const packaged = (process as { resourcesPath?: string }).resourcesPath
  const candidates = [
    process.env.MCODE_BUILTIN_SKILLS,
    packaged ? path.join(packaged, "skills") : undefined,
    path.resolve(here, "../../resources/skills"),
    // The checks are bundled into `out/` itself, one level down.
    path.resolve(here, "../resources/skills"),
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!))
}

/** Every skill folder the last scan found, so reading inside one is not a trip outside the project. */
const knownDirectories = new Set<string>()

export function isSkillPath(target: string): boolean {
  const resolved = path.resolve(target)
  const roots = [...knownDirectories, builtinSkillsRoot()].filter((root): root is string => Boolean(root))
  return roots.some((root) => {
    const relative = path.relative(root, resolved)
    return !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export async function discoverSkills(input: { directory: string; storageDirectory?: string; builtinRoot?: string | null }): Promise<SkillScan> {
  const byName = new Map<string, SkillInfo>()
  const problems: SkillProblem[] = []

  const builtin = input.builtinRoot === null ? undefined : (input.builtinRoot ?? builtinSkillsRoot())
  if (builtin) {
    // One level only: a shipped skill's own folders hold references and scripts, never more skills.
    const entries = await fs.readdir(builtin, { withFileTypes: true }).catch(() => [])
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const file = path.join(builtin, entry.name, "SKILL.md")
      if (existsSync(file)) await add(byName, problems, file, true)
    }
  }

  const roots: string[] = []
  if (input.storageDirectory) roots.push(input.storageDirectory)
  roots.push(...(await projectConfigDirs(input.directory)))
  for (const root of roots) {
    for (const folder of ["skill", "skills"]) {
      for (const file of await scan(path.join(root, folder), MAX_DEPTH, (name) => name === "SKILL.md")) {
        await add(byName, problems, file, false)
      }
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const skill of skills) knownDirectories.add(skill.directory)
  return { skills, problems }
}

/** The skills the model may see and load itself. */
export function modelInvocable(skills: readonly SkillInfo[]): SkillInfo[] {
  return skills.filter((skill) => !skill.disableModelInvocation)
}

/* ------------------------------------------------ what a message brings in */

/** MiMo loads at most this many skills named with `/name` in one message. */
export const MAX_AUTOLOAD = 3

/**
 * The skills a message names as `/name`, in the order written, once each.
 *
 * Code is not read: a path or a command in backticks or a fenced block is not
 * the user asking for a skill. Any skill counts here, including one kept from
 * the model, because typing its name is how the user starts it.
 */
export function mentionedSkills(text: string, skills: readonly SkillInfo[]): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ")
  const names = new Set(skills.map((skill) => skill.name))
  const out: string[] = []
  for (const match of prose.matchAll(/(?:^|\s)\/([A-Za-z][A-Za-z0-9_:-]*)(?=[^A-Za-z0-9_:-]|$)/g)) {
    const name = match[1]!
    if (names.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** A skill's instructions as a message carries them, with the folder its paths start from. */
export function skillBlock(skill: SkillInfo): string {
  return [
    `<system-reminder>`,
    `<loaded_skill name="${skill.name}">`,
    skill.content.trim(),
    "",
    `This skill's folder: ${skill.directory}`,
    `</loaded_skill>`,
    `</system-reminder>`,
  ].join("\n")
}

/**
 * MiMo's document triggers: an attachment of one of these types, by mime type or
 * by name, points the model at the skill for that kind of file.
 */
export const OFFICE_TRIGGERS: { skill: string; mimes: string[]; names: RegExp }[] = [
  { skill: "pdf", mimes: ["application/pdf"], names: /\.pdf$/i },
  {
    skill: "docx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/msword",
    ],
    names: /\.(docx|dotx)$/i,
  },
  {
    skill: "xlsx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "application/vnd.ms-excel",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "text/csv",
      "text/tab-separated-values",
    ],
    names: /\.(xlsx|xlsm|xltx|csv|tsv)$/i,
  },
  {
    skill: "pptx",
    mimes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-powerpoint"],
    names: /\.pptx$/i,
  },
]

/** The hint an attached office document or PDF brings: which skills fit, and where their SKILL.md is. */
export function officeSkillHint(attachments: readonly { path: string; mime: string }[], skills: readonly SkillInfo[]): string | undefined {
  const matched = OFFICE_TRIGGERS.filter((trigger) =>
    attachments.some((file) => trigger.mimes.includes(file.mime.toLowerCase()) || trigger.names.test(file.path)),
  )
    .map((trigger) => skills.find((skill) => skill.name === trigger.skill))
    .filter((skill): skill is SkillInfo => Boolean(skill))
  if (!matched.length) return undefined
  return [
    "<system-reminder>",
    "This message attaches office documents or PDFs. These skills cover reading, producing and changing such files; read the matching SKILL.md when it fits the task, and prefer its way of working over improvising:",
    ...matched.map((skill) => `- ${skill.name}: ${skill.location}`),
    "</system-reminder>",
  ].join("\n")
}

/**
 * What a user message carries for the model beyond its words.
 *
 * An attached office document or PDF brings a hint naming the skills for it.
 * Skills named with `/name` are loaded into it, up to three; naming two or more
 * adds a note asking for a plan of how they combine before any work starts.
 * Kept on the message rather than rebuilt per request, as MiMo keeps them, so
 * the history the model reads does not change under it on a later turn.
 */
export function skillReminders(text: string, skills: readonly SkillInfo[], attachments: readonly { path: string; mime: string }[] = []): string[] {
  const hint = officeSkillHint(attachments, skills)
  const mentioned = mentionedSkills(text, skills)
  if (!mentioned.length) return hint ? [hint] : []
  const loaded = mentioned.slice(0, MAX_AUTOLOAD)
  const left = mentioned.slice(MAX_AUTOLOAD)
  const out = [...(hint ? [hint] : []), ...loaded.map((name) => skillBlock(skills.find((skill) => skill.name === name)!))]
  if (mentioned.length >= 2) {
    out.push(
      [
        "<system-reminder>",
        `The user named several skills in this message: ${mentioned.join(", ")}.`,
        `Loaded above: ${loaded.join(", ")}.${left.length ? ` Not loaded, so load each with the skill tool before relying on it: ${left.join(", ")}.` : ""}`,
        "Before doing the work, settle how they fit together:",
        "- read every one of them in full first; their descriptions alone can hide rules that change the plan;",
        "- decide whether one feeds the next, whether each handles its own part, or whether one does the work while another sets its rules;",
        "- where one feeds another, fix the format and path of what passes between them;",
        "- where two give different instructions about the same thing, say which one decides it;",
        "- then state the order of work (step, skill, what it produces) and follow it.",
        "Keep the plan as short as the combination is simple.",
        "</system-reminder>",
      ].join("\n"),
    )
  }
  return out
}

/** The history a model is sent, each user message followed by what it carries; the transcript keeps the words alone. */
export function withSkillReminders<T extends { role: string; text?: string; reminders?: string[] }>(history: T[]): T[] {
  return history.map((message) =>
    message.role === "user" && message.reminders?.length ? { ...message, text: [message.text ?? "", ...message.reminders].join("\n\n") } : message,
  )
}

async function add(byName: Map<string, SkillInfo>, problems: SkillProblem[], file: string, builtin: boolean): Promise<void> {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (raw === undefined) return
  const parsed = parseFrontmatter(raw)
  if (parsed.error) {
    problems.push({ path: file, message: `Frontmatter could not be read: ${parsed.error}` })
    return
  }
  const data = parsed.data
  const invalid = (message: string): void => {
    problems.push({ path: file, message })
  }
  if (typeof data.name !== "string" || !data.name.trim()) return invalid("Frontmatter needs a name.")
  if (typeof data.description !== "string") return invalid("Frontmatter needs a description.")
  const aliases = data.aliases
  if (aliases !== undefined && aliases !== null && !(Array.isArray(aliases) && aliases.every((alias) => typeof alias === "string"))) {
    return invalid("aliases must be a list of names.")
  }
  const disabled = data["disable-model-invocation"]
  if (disabled !== undefined && disabled !== null && typeof disabled !== "boolean") return invalid("disable-model-invocation must be true or false.")

  const name = data.name.trim()
  const directory = path.dirname(file)
  // Reported, as MiMo defines the error for it, but the skill still loads: MiMo never refuses one for it either.
  if (path.basename(directory) !== name) invalid(`The name "${name}" does not match its folder "${path.basename(directory)}".`)

  const existing = byName.get(name)
  if (existing && builtin && !existing.builtin) return
  const overlong = parsed.body.length > SKILL_BODY_MAX
  byName.set(name, {
    name,
    description: data.description.trim(),
    aliases: Array.isArray(aliases) ? (aliases as string[]).map((alias) => alias.trim()).filter(Boolean) : [],
    location: file,
    directory,
    content: overlong ? parsed.body.slice(0, SKILL_BODY_MAX) : parsed.body,
    ...(overlong ? { truncated: true } : {}),
    disableModelInvocation: disabled === true,
    builtin,
  })
}

/**
 * The `.mcode` folders between the repository root and a directory, outermost
 * first, so the one nearest the conversation is read last and wins. Outside a
 * repository the walk goes on to the top of the drive, as MiMo's does.
 */
export async function projectConfigDirs(directory: string): Promise<string[]> {
  const found: string[] = []
  let at = path.resolve(directory)
  for (;;) {
    const config = path.join(at, PROJECT_CONFIG_DIR)
    if (existsSync(config)) found.push(config)
    if (existsSync(path.join(at, ".git"))) break
    const parent = path.dirname(at)
    if (parent === at) break
    at = parent
  }
  return found.reverse()
}

/**
 * Walks a folder for the files a scan wants, in a stable order.
 *
 * Sorted because the order decides which of two skills with the same name is
 * kept. A missing folder is not an error: most projects have none of these.
 */
export async function scan(root: string, depth: number, wanted: (name: string) => boolean): Promise<string[]> {
  if (depth <= 0) return []
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await scan(full, depth - 1, wanted)))
      continue
    }
    if (entry.isFile() && wanted(entry.name)) found.push(full)
  }
  return found
}
