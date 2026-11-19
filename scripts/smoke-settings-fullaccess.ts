import fs from "node:fs"
import type { Check } from "./smoke-round5"

export async function settingsFullAccess(check: Check, section: (name: string) => void): Promise<void> {
  section("Settings full access")
  const settings = fs.readFileSync("src/renderer/src/components/SettingsDialog.vue", "utf8")
  const i18n = fs.readFileSync("src/renderer/src/lib/i18n.ts", "utf8")
  const toggle = settings.match(/async function toggleFullAccess\(\) \{([\s\S]*?)^\}/m)?.[1] ?? ""
  const enable = settings.match(/async function enableFullAccess\(\) \{([\s\S]*?)^\}/m)?.[1] ?? ""
  const modal = settings.match(/<Teleport to="body">\s*<div v-if="confirmingFullAccess"([\s\S]*?)<\/Teleport>/)?.[1] ?? ""

  check("turning on full access only opens confirmation", /if \(!config\.allowFullAccess\) \{\s*confirmingFullAccess\.value = true\s*return\s*\}/.test(toggle))
  check("confirmation enables full access in one patch and announces it", /await app\.patchConfig\(\{\s*allowFullAccess: true,\s*\.\.\.accessPatch\([^,]+, "full"\),?\s*\}\)\s*app\.announceAccess\("full"\)/.test(enable))
  check("turning off uses the restoration patch and announces a drop", /const \{ patch, dropped \} = fullAccessOff\(config\)[\s\S]*?await app\.patchConfig\(patch\)\s*if \(dropped\) app\.announceAccess\("ask"\)/.test(toggle))
  check("confirmation uses the existing copy and dismiss actions", [
    'class="vs-scrim"',
    '@mousedown.self="confirmingFullAccess = false"',
    't("composer.access.confirmTitle")',
    't("composer.access.confirmBody")',
    't("composer.access.confirmOk")',
    't("common.cancel")',
    '@click="confirmingFullAccess = false"',
    '@click="enableFullAccess"',
  ].every((snippet) => modal.includes(snippet)))

  const languageCount = 18
  const tables = [...i18n.matchAll(/^const \w+: Table = \{\n([\s\S]*?)^\}/gm)]
  check("every language table has one full-access description", tables.length === languageCount &&
    tables.every(([, table]) => [...table.matchAll(/^  "set\.allowFullAccessSub":/gm)].length === 1))
  check("the old Chinese unlock-only wording is gone", [...i18n.matchAll(/才能在对话框中选择/g)].length === 0)
  check("the full-access description key appears 18 times", [...i18n.matchAll(/"set\.allowFullAccessSub":/g)].length === languageCount)
  check("the full-access title key appears 18 times", [...i18n.matchAll(/"set\.allowFullAccess":/g)].length === languageCount)
}
