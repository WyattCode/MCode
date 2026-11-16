/**
 * The checks never read the person's own home directory.
 *
 * `systemPrompt` takes a `home` so that "a check points it somewhere harmless"
 * - its own words - and twenty-five call sites across the suite did not pass
 * one, as did the engine path, which builds a prompt through the runner where
 * no parameter reaches. So every prompt those checks assembled had this
 * machine's real `~/.claude/CLAUDE.md` in it, and `discoverSkills` scanned the
 * real `~/.agents/skills`. That breaks the project's own rule - a check must
 * never read the user's memory, history or skills - and it is why several
 * assertions are machine-dependent: `smoke-round7` asserts the built prompt
 * does *not* contain "## Repository", `smoke.ts` that it does not contain
 * "## Memory", and both were being evaluated over somebody's private files
 * (R25-F). One of them going red said nothing about this code at all.
 *
 * `os.homedir` is replaced rather than the environment, so the checks' own
 * child processes - git, node, npm - keep the environment they would really
 * run in, and only this process's idea of "home" moves. Imported for its side
 * effect, first, before anything that could read a home.
 */
import fs from "node:fs"
import os from "node:os"
import fsp from "node:fs/promises"
import path from "node:path"

const fenced = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-check-home-"))

/** Where a check's idea of home now points, for an assertion that wants to name it. */
export const FENCED_HOME = fenced

os.homedir = () => fenced

// Tests may keep TMPDIR inside the checkout. Their synthetic repositories must
// not inherit its .git: hide only ancestor markers, never a fixture's own marker.
const ancestorMarkers = new Set<string>()
for (let at = path.resolve(os.tmpdir()); ; at = path.dirname(at)) {
  ancestorMarkers.add(path.join(at, ".git"))
  if (path.dirname(at) === at) break
}
const hiddenMarker = (target: unknown) => typeof target === "string" && ancestorMarkers.has(path.resolve(target))
const absentMarker = () => Object.assign(new Error("No such fixture path"), { code: "ENOENT" })
const statSync = fs.statSync
fs.statSync = ((target: unknown, ...args: unknown[]) => {
  if (hiddenMarker(target)) throw absentMarker()
  return (statSync as Function)(target, ...args)
}) as typeof fs.statSync
const stat = fsp.stat
fsp.stat = (async (target: unknown, ...args: unknown[]) => {
  if (hiddenMarker(target)) throw absentMarker()
  return (stat as Function)(target, ...args)
}) as typeof fsp.stat
