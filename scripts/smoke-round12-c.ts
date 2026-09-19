/**
 * Round 12, lane C: what the user sees when something fails or there is
 * nothing to show (C12-1 - C12-10), measured against MiMo 26.914. Kept apart
 * from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundTwelveFailureChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { LANGUAGES, language, t } from "../src/renderer/src/lib/i18n"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundTwelveFailureChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 12 (C): failure and empty-state UX")

  // ---------------------------------------------------------------- C12-1
  {
    const before = language.value
    const rendered = LANGUAGES.map(({ id }) => {
      language.value = id
      return [id, t("harnessRow.retryIn", { time: "5s" })] as const
    })
    language.value = before
    const braced = rendered.filter(([, text]) => /[{}]/.test(text) || !text.includes("5s"))
    check("C12-1: the retry countdown renders its time without braces in all 18 languages", braced.length === 0, braced)
  }
}
