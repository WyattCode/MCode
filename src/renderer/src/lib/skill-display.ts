import type { SkillSummary } from "@shared/protocol"

/**
 * How a skill is named and described on the plugins page and its card, by
 * MiMo's rules: a skill may carry `locales/<language>.json` with its own
 * translated name and one-line summary, and a description written only in a
 * language other than the interface's is not shown under Chinese or English.
 */

export type SkillContentState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; path: string; text: string; truncated: boolean }

/** The skill's translation for this interface language, by exact tag and then by its base. */
function localized(skill: SkillSummary, language: string): { displayName?: string; brief?: string } | undefined {
  const table = skill.localizations
  if (!table) return undefined
  if (table[language]) return table[language]
  const base = language.split("-")[0]!.toLowerCase()
  const key = Object.keys(table).find((entry) => entry.split("-")[0]!.toLowerCase() === base)
  return key ? table[key] : undefined
}

export function skillTitle(skill: SkillSummary, language: string): string {
  return localized(skill, language)?.displayName?.trim() || skill.name
}

/**
 * The name a skill chip in the box carries.
 *
 * MiMo names a chip from the skill it stands for and falls back to the command
 * only when it cannot find one, so the same skill reads the same way in the box
 * as on its card. The chip used to show the command trigger, which for a skill
 * with a translated name was a different word entirely.
 */
export function commandTitle(command: { name: string; localizations?: SkillSummary["localizations"] } | undefined, fallback: string, language: string): string {
  if (!command) return fallback
  return localized({ ...command, description: "", builtin: false, enabled: true, removable: false, location: "" }, language)?.displayName?.trim() || command.name
}

/** The one-line summary, when it says something the description does not. */
export function skillBrief(skill: SkillSummary, language: string): string {
  const brief = localized(skill, language)?.brief?.trim() ?? ""
  return brief && brief !== skill.description.trim() ? brief : ""
}

/**
 * The description, unless it is plainly in the other of the two languages
 * MiMo checks: Latin-only text under Simplified Chinese, or text with Chinese
 * characters under English. A bare path is always shown.
 */
export function skillDescription(skill: SkillSummary, language: string): string {
  const text = skill.description.trim()
  if (!text) return ""
  if (!/\s/.test(text) && /[\\/]/.test(text)) return text
  const chinese = /[㐀-鿿]/u.test(text)
  const latin = /[A-Za-z]/.test(text)
  if (language === "zh-CN" && latin && !chinese) return ""
  if (language === "en" && chinese) return ""
  return text
}

/** The hue a skill without its own mark is drawn in, fixed by its name. */
export function skillHue(name: string): number {
  let hash = 0
  for (let at = 0; at < name.length; at++) hash = (hash * 31 + name.charCodeAt(at)) >>> 0
  return hash % 360
}
