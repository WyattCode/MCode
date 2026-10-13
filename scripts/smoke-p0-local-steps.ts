/**
 * Local/custom models get a default step cap; lean final-answer template markers.
 * Run: esbuild + node, or bun with aliases.
 */
import { DEFAULT_LOCAL_MAX_STEPS, maxStepsPrompt, stepLimitFor } from "../src/server/session/steps"
import { agentPrompt } from "../src/server/session/prompts"

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

check("cloud unlimited", stepLimitFor(undefined, false) === undefined)
check("local default 32", stepLimitFor(undefined, true) === DEFAULT_LOCAL_MAX_STEPS)
check("user override wins", stepLimitFor(10, true) === 10)
check("non-positive treated as unset", stepLimitFor(0, true) === DEFAULT_LOCAL_MAX_STEPS)
check("negative treated as unset", stepLimitFor(-1, false) === undefined)

const prompt = maxStepsPrompt(32)
check("prompt names limit", prompt.includes("32"))
check("prompt no ask-the-user", !/ask the user/i.test(prompt))
check("prompt notes settings override for default", prompt.includes("maxSteps in settings"))

const lean = agentPrompt("build", { local: true })
check("lean has Result:", lean.includes("Result:"))
check("lean has Files:", lean.includes("Files:"))
check("lean has Verified:", lean.includes("Verified:"))
check("lean has Left / risks:", lean.includes("Left / risks:"))

console.log(`${passed} passed / ${failed} failed`)
if (failed) process.exit(1)
