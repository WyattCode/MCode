/**
 * The provider tab row must never hide a provider.
 *
 * From the cloud commit f953d2f (an earlier session's fix, pulled in rather
 * than written here): the row scrolled sideways with no visible bar, so with
 * five providers the last one sat off the right edge and looked impossible to
 * open or edit. It now wraps. Two checks hold that; a third holds the other
 * half of the commit - two providers sharing a display name ("Qwen" on two
 * servers) are told apart by host, and only then.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const cases: { name: string; run: () => void }[] = []

function register(name: string, run: () => void): void {
  cases.push({ name, run })
}

function page(): string {
  return readFileSync(join(process.cwd(), "src/renderer/src/components/ModelsPage.vue"), "utf8")
}

/** The `.tabs` rule, up to its closing brace. */
function tabsRule(src: string): string {
  const start = src.indexOf(".tabs {")
  assert.ok(start >= 0, "no .tabs rule to read")
  const end = src.indexOf("}", start)
  return src.slice(start, end)
}

register("the tab row wraps instead of scrolling sideways", () => {
  const rule = tabsRule(page())
  assert.match(rule, /flex-wrap:\s*wrap/, "tabs that only wrap can push a provider off-screen")
  assert.doesNotMatch(rule, /overflow-x:\s*(auto|scroll|hidden)/, "a sideways scroll with no bar hides the last provider")
})

register("a repeated tab name carries the host, and a unique one does not", () => {
  const src = page()
  const start = src.indexOf("const tabLabels")
  assert.ok(start >= 0, "tabLabels is gone")
  const block = src.slice(start, src.indexOf("})", start))
  assert.match(block, /count\.get\(name\)[^)]*\)\s*>\s*1/, "the host must be appended only when a name repeats")
  assert.match(block, /new URL\(provider\.baseURL\)\.host/, "the host is what tells two same-named providers apart")
  assert.match(block, /`\$\{name\} · \$\{host\}`|`\$\{name\} . \$\{host\}`/, "the label joins name and host with a separator")
})

register("the tab shows the disambiguated label", () => {
  const src = page()
  assert.match(src, /tabLabels\.get\(provider\.id\)/, "the tab still prints the plain label")
  assert.match(src, /:title="tabLabels\.get\(provider\.id\)"/, "the full label should be readable when the tab is narrow")
})

export async function modelsTabsChecks(check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  for (const { name, run } of cases) {
    try {
      run()
      check(name, true)
    } catch (err) {
      check(name, false, err instanceof Error ? err.message : String(err))
    }
  }
}

/* Standalone entry, for `node_modules/.bin/jiti scripts/smoke-models-tabs.ts`.
 * The basename is compared exactly because the battery builds this file as
 * `rounds-smoke-models-tabs.mjs`; an endsWith match would run the cases twice. */
const entry = process.argv[1]?.split("/").pop()
if (entry === "smoke-models-tabs.ts" || entry === "smoke-models-tabs.mjs") {
  for (const { name, run } of cases) {
    try {
      run()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}: ${(error as Error).message}`)
      process.exitCode = 1
    }
  }
}
