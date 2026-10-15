import { describeLoop, suggestLoopNextStep, type LoopIncident } from "../src/server/session/loop-health"

const cases: LoopIncident[] = [
  { kind: "same-call", tool: "read" },
  { kind: "edit-repeat", tool: "edit", path: "src/server/session/runner.ts", count: 3, similarity: 0.91 },
  { kind: "bash-retry", tool: "bash", command: "npx tsc --noEmit", count: 3 },
  { kind: "action-streak", tool: "grep", action: "search", count: 4 },
]

let passed = 0
let failed = 0

for (const incident of cases) {
  const note = suggestLoopNextStep(incident)
  const description = describeLoop(incident)
  const ok = note.length > 0 && !/ask the user/i.test(note) && description.length > 0

  if (ok) {
    passed += 1
  } else {
    failed += 1
    console.error(`failed ${incident.kind}: note=${JSON.stringify(note)} description=${JSON.stringify(description)}`)
  }
}

console.log(`${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
