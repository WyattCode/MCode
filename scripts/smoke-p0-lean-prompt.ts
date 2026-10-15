/**
 * Smoke test for P0-3: lean coding prompt on by default for local models.
 *
 * Run with: npx tsx scripts/smoke-p0-lean-prompt.ts
 * Or bundled: esbuild scripts/smoke-p0-lean-prompt.ts --bundle --platform=node --alias:@shared=./src/shared | node
 */

import { agentPrompt } from "../src/server/session/prompts"
import { toolsForTurn } from "../src/server/tool/registry"

let failures = 0

function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}`)
    failures++
  }
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    fn()
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

function toolNames(...args: Parameters<typeof toolsForTurn>): string[] {
  return toolsForTurn(...args).map((tool) => tool.name)
}

console.log("P0-3 lean coding prompt smoke test\n")

withEnv("MCODE_LEAN", undefined, () => {
  // 1. Default (no options, no env): full prompt, no coding protocol, has slide-deck section.
  const full = agentPrompt("build")
  ok("default prompt has no '## Coding protocol'", !full.includes("## Coding protocol"))
  ok("default prompt contains '### Slide decks'", full.includes("### Slide decks"))

  // 2. local:true: lean prompt with coding protocol, no slide decks, at least 25% shorter.
  const lean = agentPrompt("build", { local: true })
  ok("local prompt contains '## Coding protocol'", lean.includes("## Coding protocol"))
  ok("local prompt has Result: template", lean.includes("Result:"))
  ok("local prompt has Files: template", lean.includes("Files:"))
  ok("local prompt has Verified: template", lean.includes("Verified:"))
  ok("local prompt has Left / risks: template", lean.includes("Left / risks:"))
  ok("local prompt lacks '### Slide decks'", !lean.includes("### Slide decks"))
  const reduction = 1 - lean.length / full.length
  ok(`local prompt is at least 25% shorter (actual: ${(reduction * 100).toFixed(1)}%)`, reduction >= 0.25)

  // 3. MCODE_LEAN=0 with local:true -> full prompt.
  withEnv("MCODE_LEAN", "0", () => {
    const forced = agentPrompt("build", { local: true })
    ok("MCODE_LEAN=0 + local:true -> full prompt (no coding protocol)", !forced.includes("## Coding protocol"))
    ok("MCODE_LEAN=0 + local:true -> has slide decks", forced.includes("### Slide decks"))
  })

  // 4. MCODE_LEAN=1 without local -> lean.
  withEnv("MCODE_LEAN", "1", () => {
    const forced = agentPrompt("build")
    ok("MCODE_LEAN=1 without local -> lean (has coding protocol)", forced.includes("## Coding protocol"))
    ok("MCODE_LEAN=1 without local -> lacks slide decks", !forced.includes("### Slide decks"))
  })

  // 5. dream/distill unaffected by local option.
  const dreamFull = agentPrompt("dream")
  const dreamLocal = agentPrompt("dream", { local: true })
  ok("dream prompt unchanged by local option", dreamFull === dreamLocal)
  ok("dream prompt starts with '# Dream'", dreamFull.startsWith("# Dream"))

  const distillFull = agentPrompt("distill")
  const distillLocal = agentPrompt("distill", { local: true })
  ok("distill prompt unchanged by local option", distillFull === distillLocal)
  ok("distill prompt starts with '# Distill'", distillFull.startsWith("# Distill"))

  // 6. toolsForTurn: the `lean` option no longer trims tools by itself.
  const leanTools = toolNames("build", { voiceFeedback: true, lean: true })
  const fullTools = toolNames("build", { voiceFeedback: true, lean: false })
  ok("lean:true keeps pdf_locate when MCODE_LEAN is unset", leanTools.includes("pdf_locate"))
  ok("lean:false keeps pdf_locate", fullTools.includes("pdf_locate"))
  ok("lean:true keeps history when MCODE_LEAN is unset", leanTools.includes("history"))

  // 7. The "unused" sentence mentions your own change.
  ok("CORE unused sentence mentions 'your change'", full.includes("When your change makes something unused"))
  ok("CORE unused sentence mentions 'already unused'", full.includes("already unused alone unless asked"))
})

withEnv("MCODE_LEAN", "0", () => {
  const tools = toolNames("build", { voiceFeedback: true, lean: true })
  ok("MCODE_LEAN=0 + lean:true keeps pdf_locate", tools.includes("pdf_locate"))
})

withEnv("MCODE_LEAN", "1", () => {
  const tools = toolNames("build", { voiceFeedback: true, lean: true })
  ok("MCODE_LEAN=1 removes pdf_locate", !tools.includes("pdf_locate"))
  ok("MCODE_LEAN=1 removes history", !tools.includes("history"))
})

console.log("")
if (failures > 0) {
  console.log(`${failures} failure(s)`)
  process.exit(1)
} else {
  console.log("All checks passed.")
}
