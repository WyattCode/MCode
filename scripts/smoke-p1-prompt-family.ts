/**
 * Per-model coding prompt variants: family selection, env override, and lean prompt shape.
 * Run: esbuild + node, or bun with aliases.
 */
import { agentPrompt, promptFamily } from "../src/server/session/prompts"

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

const originalPromptFamily = process.env.MCODE_PROMPT_FAMILY
const originalLean = process.env.MCODE_LEAN

function restoreEnv() {
  if (originalPromptFamily === undefined) delete process.env.MCODE_PROMPT_FAMILY
  else process.env.MCODE_PROMPT_FAMILY = originalPromptFamily
  if (originalLean === undefined) delete process.env.MCODE_LEAN
  else process.env.MCODE_LEAN = originalLean
}

try {
  delete process.env.MCODE_PROMPT_FAMILY
  delete process.env.MCODE_LEAN

  check("qwen is reasoning", promptFamily("Qwen3.8-Flash-Next") === "reasoning")
  check("glm is reasoning", promptFamily("glm-4.6") === "reasoning")
  check("deepseek is reasoning", promptFamily("deepseek-v3.2") === "reasoning")
  check("gpt is default", promptFamily("gpt-5") === "default")
  check("claude is default", promptFamily("claude-sonnet-4.5") === "default")
  check("undefined is default", promptFamily(undefined) === "default")

  process.env.MCODE_PROMPT_FAMILY = "reasoning"
  check("env override to reasoning", promptFamily("gpt-5") === "reasoning")
  process.env.MCODE_PROMPT_FAMILY = "default"
  check("env override to default", promptFamily("qwen") === "default")
  delete process.env.MCODE_PROMPT_FAMILY

  const reasoning = agentPrompt("build", { local: true, modelID: "Qwen3.8-Flash-Next" })
  check("reasoning has Pace", reasoning.includes("**Pace**"))
  check("reasoning has Reproduce first", reasoning.includes("Reproduce first"))
  check("reasoning has Result:", reasoning.includes("Result:"))
  check("reasoning has Left / risks:", reasoning.includes("Left / risks:"))

  const reasoningProtocolStart = reasoning.indexOf("## Coding protocol")
  check("reasoning protocol exists", reasoningProtocolStart >= 0)
  const reasoningProtocol = reasoning.slice(reasoningProtocolStart)
  check("reasoning protocol under 2800 chars", reasoningProtocol.length < 2800, reasoningProtocol.length)
  check("reasoning has no-simulate rule", reasoningProtocol.includes("Don't simulate code in your head"))
  check("reasoning has node -e", reasoningProtocol.includes("node -e"))

  const defaultLean = agentPrompt("build", { local: true, modelID: "gpt-5" })
  check("default lean has coding protocol", defaultLean.includes("## Coding protocol"))
  check("default lean has no Pace", !defaultLean.includes("**Pace**"))
  check("default lean has no no-simulate rule", !defaultLean.includes("Don't simulate code in your head"))
  check("default lean has no node -e", !defaultLean.includes("node -e"))

  const full = agentPrompt("build", { local: false, modelID: "qwen" })
  check("full desktop has no coding protocol", !full.includes("## Coding protocol"))
  check("full desktop has no Pace", !full.includes("**Pace**"))
} finally {
  restoreEnv()
}

console.log(`${passed} passed / ${failed} failed`)
if (failed) process.exit(1)
