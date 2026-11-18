import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { nulFields, runGit } from "../src/server/git-process"
import type { LabTask } from "../src/server/lab-catalog"

const rounds = (name: string) => ["node", "scripts/rounds-check.mjs", name]
const npm = (name: string) => ["npm", "run", "-s", name]
const seeds = [
  ["LAB-01", "167d9b9f5d32af036ca314f7f7dc65a43a06dac9", "Keep Chinese paragraphs justified around bare URLs", npm("mdcheck")],
  ["LAB-02", "fd6cf05277ed62a96a9307310f783a113790cc2e", "Fit the home composer at minimum window width", rounds("round21-f4")],
  ["LAB-03", "27776f943379abb80114ebee8f3937243232c618", "Use a gear icon for both Settings entry points", ["node", "-e", "const s = require('fs').readFileSync('src/renderer/src/components/Sidebar.vue','utf8'); const a = require('assert/strict'); a.match(s, /icon: GEAR_ICON/); a.match(s, /<path :d=\"GEAR_ICON\"/); a.match(s, /const GEAR_ICON =\\s*\"M8\\.15/)"]],
  ["LAB-04", "780844beec8ae018173ed418a470b48fb9f73779", "Translate the model and worktree tool labels", npm("i18ncheck")],
  ["LAB-05", "497d46143e5e4acb70fb3ec37e1a5309213842ad", "Keep the filename visible in long step titles", rounds("round10-steps")],
  ["LAB-06", "0c276822550a63e4152da6c1581e31fa7faddac5", "Keep the Android connected status readable in both themes", npm("androidtheme")],
  ["LAB-07", "46543ebe993c199e54cacb434521c7fb68e53672", "Remove the focus box inside the search field", rounds("round21-f4")],
  ["LAB-08", "ca42e738d1b9cf71afa9a6c9f284551039180884", "Remove focus boxes inside the provider and browser text fields", rounds("round21-f4")],
] as const

export async function generateTasks(root: string): Promise<LabTask[]> {
  return Promise.all(seeds.map(async ([id, revision, title, command]) => {
    const commit = (await runGit(root, ["rev-parse", `${revision}^{commit}`])).trim()
    // Reverse the implementation diff only. Acceptance checks stay at the current revision.
    const files = nulFields(await runGit(root, ["diff", "--no-renames", "--name-only", "-z", `${commit}^`, commit, "--", "src", "android"]))
    if (!files.length) throw Error(`${id} has no implementation changes`)
    const regression = await runGit(root, [
      "-c", "core.abbrev=7", "-c", "diff.algorithm=myers", "-c", "diff.indentHeuristic=true",
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3",
      "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/", commit, `${commit}^`, "--", ...files,
    ])
    return { id, title, commit, files, regression, tests: [[...command]] }
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const output = path.join(root, "resources/lab-tasks/tasks.json")
  const contents = JSON.stringify(await generateTasks(root), null, 2) + "\n"
  if (process.argv.includes("--check")) {
    if (await fs.readFile(output, "utf8") !== contents) throw Error("Lab catalog needs regeneration")
  } else {
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, contents)
  }
}
