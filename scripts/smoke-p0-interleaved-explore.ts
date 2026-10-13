/**
 * P0 checks: interleaved reasoning field for local Qwen families, and the
 * default explore structured-result schema.
 *
 * Run: `bun scripts/smoke-p0-interleaved-explore.ts` (or esbuild + node).
 */
import { interleavedField } from "../src/server/provider/interleaved"
import { customModelOf } from "../src/server/config"
import { DEFAULT_EXPLORE_OUTPUT_SCHEMA, defaultOutputSchema } from "../src/server/tool/subagent"

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

const ref = (model: string) => ({ provider: "local", model })

check("deepseek → reasoning_content", interleavedField("openai-compatible", ref("deepseek-r1"), undefined) === "reasoning_content")
check("qwen → reasoning_content", interleavedField("openai-compatible", ref("Qwen3.8-Flash-Next"), undefined) === "reasoning_content")
check("glm → reasoning_content", interleavedField("openai-compatible", ref("glm-4.7"), undefined) === "reasoning_content")
check("kimi → reasoning_content", interleavedField("openai-compatible", ref("kimi-k2"), undefined) === "reasoning_content")
check("minimax → reasoning_content", interleavedField("openai-compatible", ref("minimax-m1"), undefined) === "reasoning_content")
check("gpt-4o → undefined", interleavedField("openai-compatible", ref("gpt-4o"), undefined) === undefined)
check("entry wins", interleavedField("openai-compatible", ref("qwen3"), { interleaved: "reasoning_details" } as any) === "reasoning_details")
check("anthropic kind → undefined", interleavedField("anthropic", ref("qwen3"), undefined) === undefined)

const required = (DEFAULT_EXPLORE_OUTPUT_SCHEMA.required as string[]) ?? []
check("explore schema required summary", required.includes("summary"))
check("explore schema required files", required.includes("files"))
check("explore schema required remaining_risks", required.includes("remaining_risks"))
check("defaultOutputSchema explore defined", defaultOutputSchema("explore") === DEFAULT_EXPLORE_OUTPUT_SCHEMA)
check("defaultOutputSchema general undefined", defaultOutputSchema("general") === undefined)

const custom = customModelOf({
  id: "qwen-local",
  name: "Local Qwen",
  thinking: { efforts: ["high"], canOff: true, default: "high" },
})
check("customModelOf thinking defaults interleaved", custom.interleaved === "reasoning_content")

const explicit = customModelOf({
  id: "qwen-local",
  name: "Local Qwen",
  interleaved: "reasoning",
  thinking: { efforts: ["high"] },
})
check("customModelOf keeps explicit interleaved", explicit.interleaved === "reasoning")

console.log(`${passed} passed / ${failed} failed`)
if (failed > 0) process.exit(1)
