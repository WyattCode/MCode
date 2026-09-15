import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { modelInvocable, type SkillInfo } from "../skill"
import type { ToolContext, ToolDefinition, ToolResult } from "./types"
import { ToolError } from "./types"

/**
 * skills: the model's two ways into the skills a conversation can reach, as
 * MiMo's engine offers them - `skill` loads one by name, `skill_search` finds
 * one by what the work is and loads it outright when the match is certain.
 * Neither asks first: MiMo's default rule allows every skill.
 */

/** How many of a skill's own files are listed beside its instructions. */
export const SKILL_FILE_SAMPLE = 10

/** MiMo's search figures: results kept, the score that loads without asking, and BM25's constants. */
export const SEARCH = {
  maxResults: 3,
  autoLoad: 0.85,
  exact: 1,
  k1: 1.5,
  lengthWeight: 0.75,
  smoothing: 0.5,
  scoreWeight: 0.55,
  coverageWeight: 0.35,
  precision: 4,
  stemMin: 3,
} as const

async function available(context: ToolContext): Promise<SkillInfo[]> {
  return modelInvocable(context.skills ? await context.skills() : [])
}

/** A few of the files beside SKILL.md, so the model knows what it can open or run. */
async function sampleFiles(directory: string, limit = SKILL_FILE_SAMPLE): Promise<string[]> {
  const out: string[] = []
  const walk = async (folder: string, depth: number) => {
    if (out.length >= limit || depth > 6) return
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name !== "SKILL.md") out.push(full)
    }
  }
  await walk(directory, 0)
  return out
}

/** What loading a skill hands back: its instructions, where it lives, and some of its files. */
export async function renderSkill(skill: SkillInfo): Promise<string> {
  const files = await sampleFiles(skill.directory)
  return [
    `<loaded_skill name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Skill folder: ${pathToFileURL(skill.directory).href}`,
    "Paths this skill mentions, such as scripts/ or references/, start from that folder.",
    `Some of its files${files.length >= SKILL_FILE_SAMPLE ? " (the first few only)" : ""}:`,
    "<files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</files>",
    "</loaded_skill>",
  ].join("\n")
}

export const SkillTool: ToolDefinition = {
  name: "skill",
  description: [
    "Load a skill: the instructions and files for one kind of work, listed under Skills in the system prompt.",
    "Load one as soon as the task matches its description, before starting the work, and follow what it says. The name must be one the system prompt lists.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name, exactly as the system prompt lists it" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(input, context): Promise<ToolResult> {
    const name = typeof input.name === "string" ? input.name.trim().replace(/^\//, "") : ""
    const all = context.skills ? await context.skills() : []
    const skill = all.find((entry) => entry.name === name)
    if (!skill) {
      const names = modelInvocable(all).map((entry) => entry.name)
      throw new ToolError(`There is no skill named "${name}". Skills that can be loaded: ${names.length ? names.join(", ") : "none"}.`)
    }
    if (skill.disableModelInvocation) {
      throw new ToolError(
        `"${skill.name}" can only be started by the user, by typing /${skill.name} in a message. Do not call this tool for it again; if it is what the user wants, tell them to type /${skill.name}.`,
      )
    }
    return {
      output: await renderSkill(skill),
      title: skill.name,
      metadata: { name: skill.name, directory: skill.directory, builtin: skill.builtin },
    }
  },
}

/* ------------------------------------------------------------------ search */

interface SearchResult {
  skill_id: string
  name: string
  score: number
  reason: string
}

const STOP_WORDS = new Set(["a", "action", "an", "and", "audience", "for", "from", "input", "of", "output", "the", "to", "with"])

const normal = (value: string) => value.toLocaleLowerCase().trim()

/** Whether a query names a skill outright: the whole name as a word, or anywhere for a name in Chinese characters. */
function names(query: string, value: string): boolean {
  const wanted = normal(value)
  const said = normal(query)
  if (!wanted) return false
  if (said === wanted) return true
  if (/\p{Script=Han}/u.test(wanted)) return said.includes(wanted)
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(said)
}

/** Words for scoring: stop words out, a plural `s` off, and Chinese read as overlapping pairs of characters. */
export function searchTokens(value: string): string[] {
  return normal(value)
    .replace(/(\p{Script=Han}+)/gu, " $1 ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !STOP_WORDS.has(token))
    .flatMap((token) => {
      if (!/^\p{Script=Han}+$/u.test(token)) {
        return token.length > SEARCH.stemMin && token.endsWith("s") && !token.endsWith("ss") ? [token.slice(0, -1)] : [token]
      }
      const chars = [...token]
      if (chars.length === 1) return chars
      return chars.slice(0, -1).map((char, index) => char + chars[index + 1])
    })
}

/**
 * The best matches for a query: skills it names first, at full score, then the
 * rest by BM25 over name, aliases and description, scaled against the best and
 * mixed with how many of the query's words each one covers.
 */
export function searchSkills(query: string, skills: readonly SkillInfo[]): SearchResult[] {
  const exact = skills
    .filter((skill) => [skill.name, ...skill.aliases].some((value) => names(query, value)))
    .map((skill) => ({ skill_id: skill.name, name: skill.name, score: SEARCH.exact, reason: `The query names ${skill.name} directly.` }))

  const wanted = [...new Set(searchTokens(query))]
  const documents = skills.map((skill) => searchTokens([skill.name, ...skill.aliases, skill.description].join(" ")))
  const average = documents.reduce((sum, words) => sum + words.length, 0) / documents.length || 1
  const scores = documents.map((words) =>
    wanted.reduce((score, token) => {
      const frequency = words.filter((word) => word === token).length
      if (!frequency) return score
      const holding = documents.filter((other) => other.includes(token)).length
      const idf = Math.log(1 + (documents.length - holding + SEARCH.smoothing) / (holding + SEARCH.smoothing))
      const saturation = (frequency * (SEARCH.k1 + 1)) / (frequency + SEARCH.k1 * (1 - SEARCH.lengthWeight + SEARCH.lengthWeight * (words.length / average)))
      return score + idf * saturation
    }, 0),
  )
  const best = Math.max(...scores, 0)
  const ranked = skills
    .map((skill, index) => ({
      skill,
      score: scores[index]!,
      coverage: wanted.filter((token) => documents[index]!.includes(token)).length / (wanted.length || 1),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((entry) => {
      const described = searchTokens(entry.skill.description)
      return {
        skill_id: entry.skill.name,
        name: entry.skill.name,
        score: Number(((entry.score / best) * SEARCH.scoreWeight + entry.coverage * SEARCH.coverageWeight).toFixed(SEARCH.precision)),
        reason: `Its description shares these words with the query: ${wanted.filter((token) => described.includes(token)).join(", ") || "(its name or aliases)"}.`,
      }
    })

  const named = new Set(exact.map((result) => result.skill_id))
  return [...exact, ...ranked.filter((result) => !named.has(result.skill_id))].slice(0, SEARCH.maxResults)
}

export const SkillSearchTool: ToolDefinition = {
  name: "skill_search",
  description: [
    "Find a skill for the work at hand when no skill in the system prompt obviously fits, or to check whether one does.",
    "Describe the work in the query: what is to be done, to what, what should come out, and for whom - leaving out whatever the user did not say.",
    "A match the query names outright, or one that scores very high, is loaded straight away; otherwise the closest few come back for you to judge, and you load one with the skill tool.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The work, rewritten as a search: the action, its input, the output wanted and the audience, where known" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, context): Promise<ToolResult> {
    const query = typeof input.query === "string" ? input.query : ""
    const skills = await available(context)
    const results = searchSkills(query, skills)
    if (!results.length) {
      return {
        output: JSON.stringify({ status: "no_match", results: [], loaded_skill_id: null }, null, 2),
        title: query,
        metadata: { status: "no_match" },
      }
    }
    const top = results[0]!
    const loaded = top.score >= SEARCH.autoLoad ? skills.find((skill) => skill.name === top.skill_id) : undefined
    const payload = JSON.stringify({ status: "matched", results, loaded_skill_id: loaded?.name ?? null }, null, 2)
    return {
      output: loaded ? `${payload}\n\n${await renderSkill(loaded)}` : payload,
      title: query,
      metadata: { status: "matched", results: results.length, ...(loaded ? { loaded: loaded.name } : {}) },
    }
  },
}
