/**
 * Smoke test for P0-3: lean coding prompt on by default for local models.
 *
 * Run with: npx tsx scripts/smoke-p0-lean-prompt.ts
 * Or bundled: esbuild scripts/smoke-p0-lean-prompt.ts --bundle --platform=node --alias:@shared=./src/shared | node
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { memorySection, systemPromptFrom, type InstructionValues } from "../src/server/session/prompt"
import { agentPrompt } from "../src/server/session/prompts"
import { discoverSkills } from "../src/server/skill"
import { LEAN_LEAVES_OUT, toolsForTurn, withheldByLean } from "../src/server/tool/registry"

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

/*
 * 8-11: what the trim must also take away, not just stop printing. Before this,
 * a lean turn's shorter list was the whole of the withholding: the memory
 * section and the pdf skill name two of these ten, the session-chat skill
 * teaches six more, and a name the model has read is a name it calls - which
 * ran, because dispatch only knew about the lab's switch.
 */
void (async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lean-prompt-"))
  try {
    withEnv("MCODE_LEAN", undefined, () => {
      const local = toolNames("build", { voiceFeedback: true, local: true })
      const cloud = toolNames("build", { voiceFeedback: true })
      // 8a. The ten are gone from a local turn's request, and back on a cloud one.
      for (const name of LEAN_LEAVES_OUT) {
        if (cloud.includes(name)) ok(`cloud turn offers ${name}`, !local.includes(name))
      }
      // 8b. Dispatch, the same predicate runner.ts consults: refused on a local turn, whatever the turn was offered.
      for (const name of LEAN_LEAVES_OUT) ok(`a local turn refuses ${name}`, withheldByLean(name, true))
      ok("a cloud turn refuses none of the ten", ![...LEAN_LEAVES_OUT].some((name) => withheldByLean(name, false)))
      ok("a local turn still runs read", !withheldByLean("read", true))

      // 9. The memory section stops naming the history tool a lean turn does not have.
      const files = { project: "/p/PROJECT.md", global: "/g/GLOBAL.md", notes: "/n/NOTES.md" }
      ok("memory section names the history tool when the turn has it", memorySection(files).includes("history tool"))
      ok("memory section names no history tool when the turn has none", !memorySection(files, false).includes("history"))
      ok("read-only memory section names none either", !memorySection({ ...files, readOnly: true }, false).includes("history"))

      // 10. And the assembled prompt, given a lean turn's names, really does leave it out.
      const values = {} as InstructionValues
      ok("a lean turn's system prompt does not name the history tool", !systemPromptFrom("build", values, files, { local: true, toolNames: local }).includes("history tool"))
      ok("a cloud turn's system prompt does", systemPromptFrom("build", values, files, { toolNames: cloud }).includes("history tool"))
    })

    // 11. A skill whose tools a lean turn was not given is not offered either.
    const skills = (await discoverSkills({ directory: tmp, storageDirectory: tmp, builtinRoot: path.resolve("resources/skills"), home: tmp, lean: true })).skills
    const full = (await discoverSkills({ directory: tmp, storageDirectory: tmp, builtinRoot: path.resolve("resources/skills"), home: tmp })).skills
    ok("a cloud turn is offered the session-chat skill", full.some((skill) => skill.name === "session-chat"))
    ok("a lean turn is not offered the session-chat skill", !skills.some((skill) => skill.name === "session-chat"))
    ok("a lean turn keeps the pdf skill, which still has read and bash", skills.some((skill) => skill.name === "pdf"))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  // MCODE_LEAN=0 goes back to the full list on a local model, tools and gate alike.
  withEnv("MCODE_LEAN", "0", () => {
    ok("MCODE_LEAN=0 + local turn refuses none of the ten", ![...LEAN_LEAVES_OUT].some((name) => withheldByLean(name, true)))
    ok("MCODE_LEAN=0 + local turn offers history", toolNames("build", { voiceFeedback: true, local: true }).includes("history"))
  })

  console.log("")
  if (failures > 0) {
    console.log(`${failures} failure(s)`)
    process.exit(1)
  }
  console.log("All checks passed.")
})()
