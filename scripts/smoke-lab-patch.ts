/*
 * The Lab asks a model for a git diff and then lets that diff into a worktree.
 * Two things have to hold at once: a reply that wraps the diff in a sentence or a
 * code fence is still the diff the model meant (small models add both), and nothing
 * outside the task's scoped files ever reaches the worktree. A reply that is refused
 * has to say which rule it broke, because a run that adopts nothing is otherwise
 * impossible to analyse after the fact.
 */
import { labPatch } from "../src/server/lab"
import type { LabTask } from "../src/server/lab-catalog"

type Check = (label: string, ok: boolean, detail?: unknown) => void

const task: LabTask = {
  id: "T-1",
  title: "a scoped task",
  commit: "0000000",
  files: ["src/a.ts"],
  regression: "the check that used to fail",
  tests: [],
}

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 100644..100644 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n")

function refuse(text: string): string {
  try {
    labPatch(text, task)
    return ""
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).split("\n")[0]
  }
}

function takes(text: string): boolean {
  try {
    return labPatch(text, task).includes("+new")
  } catch {
    return false
  }
}

export async function labPatchChecks(check: Check) {
  check("a bare diff is taken", takes(DIFF))

  // The sentence is what a model actually writes before the patch; refusing it loses the round.
  check("a sentence before the diff is still taken", takes(`Sure, here is the fix:\n\n${DIFF}`))
  check("a fenced diff is taken", takes(`\`\`\`diff\n${DIFF}\n\`\`\``))
  check("a sentence before a fenced diff is taken", takes(`Here you go.\n\`\`\`\n${DIFF}\n\`\`\``))

  // A hunk that itself adds a fenced block must not be truncated at that fence.
  const fenced = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 100644..100644 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+```",
    "+code",
    "+```",
  ].join("\n")
  const fencedReply = "```diff\n" + fenced + "\n```"
  let kept = ""
  try {
    kept = labPatch(fencedReply, task)
  } catch {
    kept = ""
  }
  check("a fence inside the hunk survives the extraction", kept.trimEnd().includes("+```") && kept.trimEnd().endsWith("+```"), kept.slice(-40))

  // Everything below stays refused: the scope is the point of the validator.
  check("a reply with no diff is refused", refuse("I could not find the bug.") !== "")
  check("an unscoped file is refused by name", /src\/b\.ts/.test(refuse(DIFF.replace(/src\/a\.ts/g, "src/b.ts"))), refuse(DIFF.replace(/src\/a\.ts/g, "src/b.ts")))
  check("a binary patch is refused", /binary|mode/i.test(refuse(`${DIFF}\nGIT binary patch\n`)), refuse(`${DIFF}\nGIT binary patch\n`))
  check("a mode change is refused", /mode/i.test(refuse(DIFF.replace("100644 100644", "120000 120000"))), refuse(DIFF.replace("100644 100644", "120000 120000")))
  check("an empty reply is refused", /no git diff/i.test(refuse("")), refuse(""))
  check("the refusal names a rule", /scope|no git diff|header|binary|mode|96KB/i.test(refuse("not a patch at all")), refuse("not a patch at all"))
}
