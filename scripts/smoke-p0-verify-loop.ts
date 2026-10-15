/**
 * Focused checks for P0-4: the session-scoped verify loop.
 *
 * The helpers decide what a tool result says when a post-edit check or a
 * failed verify command leaves problems behind, so the model is told to keep
 * fixing in the same turn rather than stopping to ask. These checks cover the
 * note wording, the round counting and the stuck path, and - when the
 * post-edit checker actually runs - that EditTool appends the loop note.
 *
 * Run on its own: `npx tsx scripts/smoke-p0-verify-loop.ts`.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EditTool } from "../src/server/tool/edit"
import { recordRead } from "../src/server/tool/read-tracker"
import {
  clearVerifyLoops,
  concreteStepFromBashRetry,
  concreteStepFromPostEdit,
  formatStuckSuggestion,
  formatVerifyLoopNote,
  getVerifyLoopRound,
  incrementVerifyLoop,
  resetVerifyLoop,
  VERIFY_LOOP_DEFAULT_MAX,
  verifyLoopMax,
} from "../src/server/session/verify-loop"

let passed = 0
let failed = 0
let currentScenario = "startup"

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function okNote(name: string, note: string) {
  passed++
  console.log(`  ok   ${name} (${note})`)
}

function failUnexpected(name: string, error: unknown) {
  failed++
  const message = error instanceof Error ? error.message : String(error)
  console.log(`  FAIL ${name} -> unexpected exception: ${message}`)
}

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-p0-loop-"))
}

function context(directory: string, sessionID: string): any {
  return {
    sessionID,
    messageID: "m1",
    callID: "c1",
    directory,
    permissions: { ask: async () => {} },
    questions: {},
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
    plan: undefined,
    agent: "build",
  }
}

async function main(): Promise<void> {
  const previousEnv = {
    disable: process.env.MCODE_POST_EDIT_CHECK,
    node: process.env.MCODE_NODE,
    max: process.env.MCODE_VERIFY_LOOP_MAX,
  }

  try {
    // The loop note and the post-edit check must both be live for the EditTool
    // scenario, and the default max (3) is what the assertions expect.
    delete process.env.MCODE_POST_EDIT_CHECK
    delete process.env.MCODE_VERIFY_LOOP_MAX

    // Note wording.
    currentScenario = "note wording"
    try {
      const step = concreteStepFromPostEdit({ checker: "node --check", problems: 1, path: "bad.js" })
      const note = formatVerifyLoopNote(1, 1, 3, step)
      check("note contains round 1/3", note.includes("round 1/3"), note)
      check("note names the loop", note.includes("Verify loop"), note)
      check("note carries the concrete step", note.includes("Re-read bad.js"), note)
      check("note does not ask the user", !/ask the user/i.test(note), note)

      const stuckNote = formatStuckSuggestion(1, 4, 3, step)
      check("stuck note contains Next step", stuckNote.includes("Next step"), stuckNote)
      check("stuck note names the loop", stuckNote.includes("Verify loop stuck"), stuckNote)
      check("stuck note does not ask the user", !/ask the user/i.test(stuckNote), stuckNote)

      const bashStep = concreteStepFromBashRetry("npm test")
      check("bash step names the command", bashStep.includes("npm test"), bashStep)
      check("bash step says rerun", /rerun/i.test(bashStep), bashStep)
      check("bash step does not ask the user", !/ask the user/i.test(bashStep), bashStep)
    } catch (error) {
      failUnexpected("note wording", error)
    }

    // Round counting and the stuck path.
    currentScenario = "round counting"
    try {
      clearVerifyLoops()
      const sid = "s-loop"
      check("round starts at 0", getVerifyLoopRound(sid) === 0, getVerifyLoopRound(sid))
      check("increment 1", incrementVerifyLoop(sid) === 1)
      check("increment 2", incrementVerifyLoop(sid) === 2)
      check("increment 3", incrementVerifyLoop(sid) === 3)
      check("round reads back 3", getVerifyLoopRound(sid) === 3, getVerifyLoopRound(sid))
      check("default max is 3", verifyLoopMax() === 3, verifyLoopMax())
      check("default max constant", VERIFY_LOOP_DEFAULT_MAX === 3, VERIFY_LOOP_DEFAULT_MAX)

      const fourth = incrementVerifyLoop(sid)
      check("fourth round is 4", fourth === 4, fourth)
      check("stuck once past max", fourth > verifyLoopMax(), { fourth, max: verifyLoopMax() })

      resetVerifyLoop(sid)
      check("reset clears the session", getVerifyLoopRound(sid) === 0, getVerifyLoopRound(sid))

      incrementVerifyLoop(sid)
      incrementVerifyLoop("s-other")
      clearVerifyLoops()
      check("clear resets every session", getVerifyLoopRound(sid) === 0 && getVerifyLoopRound("s-other") === 0)
    } catch (error) {
      failUnexpected("round counting", error)
    }

    // The max can be moved for a run without touching the prompt.
    currentScenario = "max from env"
    try {
      process.env.MCODE_VERIFY_LOOP_MAX = "2"
      check("max reads env override", verifyLoopMax() === 2, verifyLoopMax())
      process.env.MCODE_VERIFY_LOOP_MAX = "0"
      check("max ignores non-positive", verifyLoopMax() === VERIFY_LOOP_DEFAULT_MAX, verifyLoopMax())
      process.env.MCODE_VERIFY_LOOP_MAX = "not-a-number"
      check("max ignores garbage", verifyLoopMax() === VERIFY_LOOP_DEFAULT_MAX, verifyLoopMax())
    } catch (error) {
      failUnexpected("max from env", error)
    } finally {
      delete process.env.MCODE_VERIFY_LOOP_MAX
    }

    // EditTool appends the loop note when the post-edit check finds a problem.
    currentScenario = "edit tool verify loop"
    try {
      const root = await tempDir()
      const file = path.join(root, "bad.js")
      const original = "const x = 1\n"
      await fs.writeFile(file, original, "utf8")

      clearVerifyLoops()
      const stat = await fs.stat(file)
      await recordRead("s-edit", file, { mtimeMs: stat.mtimeMs, size: stat.size }, original)

      const result = await EditTool.execute({ file_path: "bad.js", old_string: "const x = 1", new_string: "const x = (" }, context(root, "s-edit"))
      const fired = result.output.includes("Post-edit check")
      if (fired) {
        check("edit output has Verify loop", result.output.includes("Verify loop"), result.output)
        check("edit loop note is round 1/3", result.output.includes("round 1/3"), result.output)
        check("edit loop note does not ask the user", !/ask the user/i.test(result.output), result.output)
        check("edit metadata records the round", result.metadata?.verifyLoop?.round === 1, result.metadata)
        check("edit metadata not stuck", result.metadata?.verifyLoop?.stuck === false, result.metadata)

        const diagnostics = result.metadata?.postEditCheck?.diagnostics
        if (Array.isArray(diagnostics) && diagnostics.length > 0) {
          check("edit loop mentions re-run", /Re-run|rerun/i.test(result.output), result.output)
        } else {
          okNote("edit loop mentions re-run", "no diagnostics metadata")
        }
      } else {
        okNote("edit tool verify loop", "post-edit check did not fire (node unavailable or disabled)")
      }
    } catch (error) {
      failUnexpected("edit tool verify loop", error)
    }
  } catch (error) {
    failUnexpected(currentScenario, error)
  } finally {
    if (previousEnv.disable === undefined) delete process.env.MCODE_POST_EDIT_CHECK
    else process.env.MCODE_POST_EDIT_CHECK = previousEnv.disable
    if (previousEnv.node === undefined) delete process.env.MCODE_NODE
    else process.env.MCODE_NODE = previousEnv.node
    if (previousEnv.max === undefined) delete process.env.MCODE_VERIFY_LOOP_MAX
    else process.env.MCODE_VERIFY_LOOP_MAX = previousEnv.max
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
