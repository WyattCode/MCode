/*
 * Asking a model to hand-write a git diff with exact hunk counts is what made the Lab
 * discard everything it produced: one candidate wrote prose and no diff, another wrote a
 * diff that `git apply` called corrupt at line 4. The contract this checks asks for whole
 * files instead and lets Git make the patch. Scope still has to be enforced here, because
 * the reply is model text and a file outside the task must never be written to the checkout.
 */
import { labFiles } from "../src/server/lab"
import type { LabTask } from "../src/server/lab-catalog"

type Check = (label: string, ok: boolean, detail?: unknown) => void

const task: LabTask = {
  id: "T-1",
  title: "a scoped task",
  commit: "0000000",
  files: ["src/a.ts", "src/b.ts"],
  regression: "the check that used to fail",
  tests: [],
}

function refuse(text: string): string {
  try {
    labFiles(text, task)
    return ""
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).split("\n")[0]
  }
}

export async function labFilesChecks(check: Check) {
  const two = [
    "=== FILE src/a.ts ===",
    "export const a = 1",
    "",
    "=== FILE src/b.ts ===",
    "export const b = 2",
    "",
  ].join("\n")

  const parsed = labFiles(two, task)
  check("both files come back", parsed?.length === 2, JSON.stringify(parsed?.map((entry) => entry.file)))
  check("content is kept exactly", parsed?.[0]?.content === "export const a = 1\n", JSON.stringify(parsed?.[0]?.content))
  check("the second file keeps its own content", parsed?.[1]?.content === "export const b = 2\n", JSON.stringify(parsed?.[1]?.content))

  // A model that answers with one file and a sentence around it is still understood.
  const wrapped = labFiles(`Here is the fixed file:\n\n=== FILE src/a.ts ===\nconst a = 2\n=== END ===\nHope that helps.\n`, task)
  check("prose around the file block is ignored", wrapped?.length === 1 && wrapped[0].content === "const a = 2\n", JSON.stringify(wrapped))

  // A reply that is not this contract at all returns nothing, so the caller can fall back to the diff.
  check("a diff reply is not this contract", labFiles("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n", task) === null)
  check("an empty reply is not this contract", labFiles("", task) === null)

  // Scope is the whole point: a file the task does not own is refused by name, not written.
  check("an unscoped file is refused by name", /src\/c\.ts/.test(refuse("=== FILE src/c.ts ===\nnope\n")), refuse("=== FILE src/c.ts ===\nnope\n"))
  check("a reply that changes nothing is refused", /no file content|unchanged/i.test(refuse("=== FILE src/a.ts ===\n=== FILE src/b.ts ===\n")), refuse("=== FILE src/a.ts ===\n=== FILE src/b.ts ===\n"))
}
