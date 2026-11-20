/**
 * Smart routing's sub-controls must be dead while its switch is off.
 *
 * Found walking the shipped 1.2.2 build screen by screen: with 启用 Smart 路由
 * off, the two tier dropdowns and the confidence slider still looked live and
 * took input, so the pane reads as "smart is off, yet I can set what smart
 * does". The disabled fieldset below is the guarantee. Remove the fieldset and
 * checks 1 and 2 go red; move the switch inside it and check 3 goes red, which
 * is the trap to avoid - a disabled switch could never turn smart routing on.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const cases: { name: string; run: () => void }[] = []

function register(name: string, run: () => void): void {
  cases.push({ name, run })
}

function settings(): string {
  return readFileSync(join(process.cwd(), "src/renderer/src/components/SettingsDialog.vue"), "utf8")
}

const GATE = /<fieldset[^>]*:disabled="app\.config\?\.smart !== true"/

register("the smart pane gates its sub-controls with a disabled fieldset", () => {
  assert.match(
    settings(),
    GATE,
    "the tier dropdowns and the threshold must sit in a fieldset Vue disables with the smart switch",
  )
})

register("the gate covers the tier dropdowns and the confidence slider", () => {
  const src = settings()
  const open = src.search(GATE)
  const close = open < 0 ? -1 : src.indexOf("</fieldset>", open)
  assert.ok(open >= 0 && close > open, "no gate to read")
  const body = src.slice(open, close)
  assert.match(body, /v-for="tier in smartTiers"/, "the tier rows are outside the gate")
  assert.match(body, /id="smart-threshold"/, "the confidence slider is outside the gate")
})

register("the switch itself stays outside the gate", () => {
  const src = settings()
  const open = src.search(GATE)
  const at = src.indexOf(`aria-label="t('set.smartEnable')"`)
  assert.ok(open >= 0 && at >= 0 && at < open, "a switch inside a disabled fieldset can never be pressed")
})

export async function smartGateChecks(check: (label: string, ok: boolean, detail?: unknown) => void): Promise<void> {
  for (const { name, run } of cases) {
    try {
      run()
      check(name, true)
    } catch (err) {
      check(name, false, err instanceof Error ? err.message : String(err))
    }
  }
}

/* Run directly with `node scripts/smoke-smart-gate.ts` as well as through the
 * battery. The basename is compared exactly because the battery builds this
 * file as `rounds-smoke-smart-gate.mjs`, and an endsWith match would run the
 * cases a second time inside the battery. */
const entry = process.argv[1]?.split("/").pop()
if (entry === "smoke-smart-gate.ts" || entry === "smoke-smart-gate.mjs") {
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
