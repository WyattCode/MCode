/**
 * Round 10, git end to end (G10-1 onwards). Kept apart from smoke.ts the way
 * the earlier rounds are; smoke.ts calls `roundTenGitChecks` with its own check
 * and section. Every repository here is a throwaway one in the temp folder, and
 * the only remote is a bare repository beside it.
 */
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { Check } from "./smoke-round5"
import * as gitOps from "../src/server/git"
import { unifiedDiff } from "../src/server/diff"
import { revertTurnFiles } from "../src/server/session/turn-revert"
import { mergeConflictNotice } from "../src/server/tool/merge-conflict"
import { discoverSkills } from "../src/server/skill"
import { REPO_ROOTS_FRESH_MS, RepoRoots, rootFromCommonDir } from "../src/server/repo-roots"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config, REPOSITORY_PROJECTS_MIGRATION } from "../src/server/config"
import { sessionGroup } from "../src/shared/session-group"
import { projectsByRecency } from "../src/shared/projects"
import { GIT_TIMEOUT_MS, displayLetter, gitEnvironment, parsePorcelain, runGit } from "../src/server/git-process"

const exec = promisify(execFile)

async function sources(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|vue)$/.test(entry.name)) found.set(full, await fs.readFile(full, "utf8"))
    }
  }
  await walk(root)
  return found
}

export async function roundTenGitChecks(check: Check, section: (name: string) => void): Promise<void> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-git-"))
  const hooksOff = path.join(temp, "no-hooks")
  await fs.mkdir(hooksOff)
  const g = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout
  const repo = async (name: string) => {
    const dir = path.join(temp, name)
    await fs.mkdir(dir, { recursive: true })
    await g(dir, "init", "-q", "-b", "main")
    await g(dir, "config", "user.email", "t@example.com")
    await g(dir, "config", "user.name", "t")
    await g(dir, "config", "commit.gpgsign", "false")
    await g(dir, "config", "core.hooksPath", hooksOff)
    await g(dir, "config", "core.autocrlf", "false")
    return dir
  }

  section("Round 10 (G10-1): paths with non-ASCII characters and spaces")
  {
    const dir = await repo("names")
    await fs.writeFile(path.join(dir, "说明.txt"), "one\n")
    await fs.writeFile(path.join(dir, "old name.txt"), "keep\n")
    await g(dir, "add", "-A")
    await g(dir, "commit", "-qm", "base")
    await fs.writeFile(path.join(dir, "说明.txt"), "one\ntwo\n")
    await fs.writeFile(path.join(dir, "新文件.md"), "a\nb\nc\n")
    await fs.writeFile(path.join(dir, " lead space.txt"), "x\n")
    await g(dir, "mv", "old name.txt", "new name.txt")
    const state = await gitOps.status(dir)
    const paths = state.entries.map((entry) => entry.path).sort()
    check(
      "the review lists every file by its own name, a rename by its new one",
      JSON.stringify(paths) === JSON.stringify([" lead space.txt", "new name.txt", "新文件.md", "说明.txt"].sort()),
      state.entries,
    )
    const summary = await gitOps.summary(dir)
    check(
      "the info card counts the same files, and an untracked Chinese file by its lines",
      summary.ok && summary.fileCount === 4 && summary.files.find((file) => file.path === "新文件.md")?.additions === 3,
      summary,
    )
    check("and the edited one by name", summary.files.find((file) => file.path === "说明.txt")?.additions === 1, summary.files)
    const commit = await gitOps.commitState(dir)
    check("the commit card's paths are the real names", commit.changedPaths.includes("说明.txt") && commit.changedPaths.includes("新文件.md"), commit.changedPaths)
    const input = await gitOps.commitMessageInput(dir, commit.changedPaths)
    check("so the commit-message prompt names them", input.includes("- 说明.txt") && !input.includes("\\350"), input.slice(0, 300))
    const patch = await gitOps.diff(dir, "说明.txt")
    check("a diff of one has an unquoted header", patch.includes("+two") && patch.includes("b/说明.txt") && !patch.includes('"b/'), patch.slice(0, 200))

    // The folder under review can reach git in another spelling than git answers with -
    // a junction or link on Windows and macOS, an 8.3 short name on Windows CI. The files
    // are the same files; the review must not read the two spellings as two places.
    const link = path.join(temp, "link-to-names")
    await fs.symlink(dir, link, "junction")
    const viaLink = await gitOps.status(link)
    check(
      "a project reached through a link to its folder lists the same files",
      JSON.stringify(viaLink.entries.map((entry) => entry.path).sort()) === JSON.stringify(paths),
      viaLink.entries,
    )
    const linkPatch = await gitOps.diff(link, "说明.txt")
    check(
      "and its diff still names the file under its own name, not a walk out of the repository",
      linkPatch.includes("+two") && linkPatch.includes("b/说明.txt") && !linkPatch.includes('"b/') && !linkPatch.includes("a/.."),
      linkPatch.slice(0, 200),
    )

    const parsed = parsePorcelain("R  new name\0old name\0 M  spaced \0?? 说明/\0")
    check(
      "NUL-separated status keeps spaces, skips a rename's source and keeps an untracked folder's slash",
      parsed.length === 3 && parsed[0]!.path === "new name" && parsed[0]!.from === "old name" && parsed[1]!.path === " spaced " && parsed[2]!.path === "说明/",
      parsed,
    )
  }

  section("Round 10 (G10-11, G10-12): untracked folders and the review's letters")
  {
    const dir = await repo("letters")
    await fs.writeFile(path.join(dir, "both.txt"), "1\n")
    await fs.writeFile(path.join(dir, "gone.txt"), "1\n")
    await g(dir, "add", "-A")
    await g(dir, "commit", "-qm", "base")
    await fs.mkdir(path.join(dir, "deps", "sub"), { recursive: true })
    for (const name of ["f1.js", "f2.js", "f3.js"]) await fs.writeFile(path.join(dir, "deps", "sub", name), "x\n")
    await fs.writeFile(path.join(dir, "staged-new.txt"), "n\n")
    await g(dir, "add", "staged-new.txt")
    await fs.writeFile(path.join(dir, "staged-new.txt"), "n\nm\n")
    await fs.writeFile(path.join(dir, "both.txt"), "2\n")
    await g(dir, "add", "both.txt")
    await fs.rm(path.join(dir, "gone.txt"))
    const state = await gitOps.status(dir)
    const code = (file: string) => state.entries.find((entry) => entry.path === file)?.code
    check("an untracked folder is one row, as MiMo lists it", state.entries.filter((entry) => entry.path.startsWith("deps")).map((entry) => entry.path).join() === "deps/", state.entries)
    check("and shows as an addition", code("deps/") === "A")
    check("a staged new file edited again shows the working-tree letter", code("staged-new.txt") === "M", state.entries)
    check("a staged-only edit shows the index letter", code("both.txt") === "M" && code("gone.txt") === "D", state.entries)
    const summary = await gitOps.summary(dir)
    check(
      "the info card counts the folder as one file with no lines",
      summary.ok && summary.fileCount === 4 && summary.files.find((file) => file.path === "deps/")?.additions === 0,
      summary,
    )
    check(
      "a conflict and a type change keep their own letters",
      displayLetter({ staged: "U", work: "U", untracked: false }) === "U" &&
        displayLetter({ staged: "T", work: " ", untracked: false }) === "T" &&
        displayLetter({ staged: "R", work: "M", untracked: false }) === "M" &&
        displayLetter({ staged: "A", work: "M", untracked: false }) === "M",
    )

    // A project opened on a folder git does not track at all still lists its files.
    const inside = path.join(dir, "deps")
    const nested = await gitOps.status(inside)
    check("a project inside an untracked folder lists its files", nested.entries.map((entry) => entry.path).sort().join() === "sub/f1.js,sub/f2.js,sub/f3.js", nested.entries)
    const depsLink = path.join(temp, "link-to-deps")
    await fs.symlink(inside, depsLink, "junction")
    const nestedLinked = await gitOps.status(depsLink)
    check(
      "an untracked project reached through a link still lists its files",
      nestedLinked.entries.map((entry) => entry.path).sort().join() === "sub/f1.js,sub/f2.js,sub/f3.js",
      nestedLinked.entries,
    )
  }

  section("Round 10 (G10-3): a status git cannot produce is not a clean tree")
  {
    const dir = await repo("broken")
    await fs.writeFile(path.join(dir, "a.txt"), "a\n")
    await g(dir, "add", "-A")
    await g(dir, "commit", "-qm", "base")
    await fs.writeFile(path.join(dir, ".git", "index"), "DIRC-not-really")
    const state = await gitOps.status(dir)
    check("the failure is reported with git's words", state.repo && typeof state.error === "string" && state.error.length > 0 && state.entries.length === 0, state)
    const review = await fs.readFile(path.join(process.cwd(), "src/renderer/src/components/right/RpReview.vue"), "utf8")
    check("and the review shows it under 读取 git 状态失败", review.includes("failure.value = next.error") && review.includes("rp.review.readStatusFailed"))
  }

  section("Round 10 (G10-4, G10-6, G10-7): how git is started")
  {
    const dir = await repo("locks")
    await fs.writeFile(path.join(dir, "a.txt"), "a\n")
    await g(dir, "add", "-A")
    await g(dir, "commit", "-qm", "base")
    const index = path.join(dir, ".git", "index")
    const later = new Date(Date.now() + 5000)
    await fs.utimes(path.join(dir, "a.txt"), later, later)
    const before = (await fs.stat(index)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 50))
    // `git diff` refreshes the index whatever the setting says (MiMo's diffs do too), so only status is asked here.
    await gitOps.status(dir)
    await gitOps.commitState(dir)
    check("reading status leaves the index file as it was",(await fs.stat(index)).mtimeMs === before, { before, after: (await fs.stat(index)).mtimeMs })

    const env = gitEnvironment()
    check("git runs with optional locks off and its messages in English", env.GIT_OPTIONAL_LOCKS === "0" && env.LC_ALL === "C")

    const spawns: string[] = []
    for (const folder of ["src/server", "src/main"]) {
      for (const [file, text] of await sources(path.join(process.cwd(), folder))) {
        for (const match of text.matchAll(/\b(execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*"git"/g)) {
          const call = text.slice(match.index!, match.index! + 400)
          if (!/windowsHide:\s*true/.test(call)) spawns.push(`${path.relative(process.cwd(), file)} @${match.index}`)
        }
        if (/\brun\(\s*"git"/.test(text)) spawns.push(`${path.relative(process.cwd(), file)} runs git through a bare promisified execFile`)
      }
    }
    check("every git process is started without a console window", spawns.length === 0, spawns)
  }

  section("Round 10 (G10-5, G10-19): time limits and what a failed commit says")
  {
    check("git calls have 15 seconds", GIT_TIMEOUT_MS === 15_000)
    const dir = await repo("slow")
    await fs.writeFile(path.join(dir, "a.txt"), "a\n")
    const hooks = path.join(temp, "slow-hooks")
    await fs.mkdir(hooks)
    await fs.writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nsleep 30\n")
    await fs.chmod(path.join(hooks, "pre-commit"), 0o755)
    await g(dir, "config", "core.hooksPath", hooks)
    const quick = await runGit(dir, ["commit", "-qm", "x"], { timeout: 800 }).then(
      () => "finished",
      (err: { timedOut?: boolean; message: string }) => (err.timedOut ? err.message : `other: ${err.message}`),
    )
    check("a call past its time limit is stopped and says so", quick.includes("timed out"), quick)
    const started = Date.now()
    await g(dir, "add", "-A")
    const slow = await gitOps.commit(dir, "slow hook", false)
    const took = Date.now() - started
    check("a commit whose hook runs past 15 seconds is stopped, as MiMo stops it", !slow.ok && /timed out/.test(slow.error ?? "") && took >= 14_000 && took < 25_000, { slow, took })
    await g(dir, "config", "core.hooksPath", hooksOff)

    const signed = gitOps.commitFailure({ stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object\n" })
    check("a failed commit keeps every line of what git said", signed.error === "error: gpg failed to sign the data\nfatal: failed to write commit object", signed)
    check("cut at 300 characters", gitOps.commitFailure({ stderr: "x".repeat(900) }).error?.length === 300)
    const refused = await gitOps.commit(path.join(temp, "no-such-folder"), "m", true)
    check("a commit outside any repository fails with a reason", !refused.ok && Boolean(refused.error), refused)
  }

  section("Round 10 (G10-2): push goes to origin's branch of the same name")
  {
    const origin = path.join(temp, "origin.git")
    await g(temp, "init", "-q", "--bare", "-b", "main", origin)
    const seed = await repo("seed")
    await fs.writeFile(path.join(seed, "a.txt"), "a\n")
    await g(seed, "add", "-A")
    await g(seed, "commit", "-qm", "base")
    await g(seed, "remote", "add", "origin", origin)
    await g(seed, "push", "-q", "origin", "main")
    const clone = path.join(temp, "clone")
    await g(temp, "clone", "-q", origin, clone)
    for (const [key, value] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", hooksOff]]) {
      await g(clone, "config", key!, value!)
    }
    await g(clone, "checkout", "-q", "-b", "fix", "origin/main")
    check("the fixture's branch tracks origin's main, as git sets it up", (await g(clone, "config", "branch.fix.merge")).trim() === "refs/heads/main")
    await fs.writeFile(path.join(clone, "b.txt"), "b\n")
    await g(clone, "add", "-A")
    await g(clone, "commit", "-qm", "fix")
    const state = await gitOps.commitState(clone)
    check(
      "ahead is counted against origin's own fix, which does not exist yet",
      state.hasUpstream && !state.hasOriginBranch && state.ahead === 0 && !("upstream" in state),
      state,
    )
    const mainBefore = (await g(origin, "rev-parse", "refs/heads/main")).trim()
    const pushed = await gitOps.push(clone)
    check("the push succeeds", pushed.ok, pushed)
    check("origin's main is untouched", (await g(origin, "rev-parse", "refs/heads/main")).trim() === mainBefore)
    check("and the commits are on origin's fix", (await g(origin, "rev-parse", "refs/heads/fix")).trim() === (await g(clone, "rev-parse", "HEAD")).trim())
    const card = await fs.readFile(path.join(process.cwd(), "src/renderer/src/components/InfoCommitCard.vue"), "utf8")
    check("the card's push rule asks for origin first", /if \(!current\.hasOrigin\) return false/.test(card) && !card.includes("if (current.hasUpstream) return current.ahead > 0"))
  }

  section("Round 10 (G10-15, G10-20): worktree rows and the default branch")
  {
    const dir = await repo("trees")
    await fs.writeFile(path.join(dir, "a.txt"), "a\n")
    await g(dir, "add", "-A")
    await g(dir, "commit", "-qm", "base")
    await g(dir, "worktree", "add", "-q", "--detach", path.join(temp, "trees-detached"))
    await g(dir, "worktree", "add", "-q", "-b", "side", path.join(temp, "trees-side"))
    const rows = await gitOps.worktrees(dir)
    check(
      "a detached worktree has no branch, a named one has its name, the first is the main checkout",
      rows.length === 3 && rows[0]!.main && rows[0]!.branch === "main" && rows.find((row) => row.directory.endsWith("trees-detached"))?.branch === undefined && rows.find((row) => row.directory.endsWith("trees-side"))?.branch === "side",
      rows,
    )
    const bare = path.join(temp, "bare-trees.git")
    await g(temp, "clone", "-q", "--bare", dir, bare)
    await g(bare, "worktree", "add", "-q", path.join(temp, "bare-checkout"), "main")
    const bareRows = await gitOps.worktrees(bare)
    check("a bare repository is not listed as a checkout", bareRows.length === 1 && !bareRows[0]!.main && bareRows[0]!.directory.endsWith("bare-checkout"), bareRows)

    const plain = await repo("defaults")
    await fs.writeFile(path.join(plain, "a.txt"), "a\n")
    await g(plain, "add", "-A")
    await g(plain, "commit", "-qm", "base")
    await g(plain, "branch", "-m", "trunk")
    check("with no remote and no main or master, there is no default", (await gitOps.defaultBranch(plain)) === undefined)
    await g(plain, "branch", "dev")
    await g(plain, "config", "init.defaultBranch", "dev")
    check("init.defaultBranch names it when that branch exists", (await gitOps.defaultBranch(plain)) === "dev")
    await g(plain, "branch", "main")
    check("and still wins over main", (await gitOps.defaultBranch(plain)) === "dev")
    await g(plain, "config", "--unset", "init.defaultBranch")
    check("otherwise main", (await gitOps.defaultBranch(plain)) === "main")
    await g(plain, "remote", "add", "mirror", path.join(temp, "origin.git"))
    await g(plain, "update-ref", "refs/remotes/mirror/trunk", "HEAD")
    await g(plain, "symbolic-ref", "refs/remotes/mirror/HEAD", "refs/remotes/mirror/trunk")
    check("the only remote's HEAD wins when there is no origin", (await gitOps.defaultBranch(plain)) === "trunk")
    await g(plain, "remote", "add", "upstream", path.join(temp, "origin.git"))
    await g(plain, "update-ref", "refs/remotes/upstream/main", "HEAD")
    await g(plain, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main")
    check("among several remotes, upstream's HEAD wins over the first listed", (await gitOps.defaultBranch(plain)) === "main")
  }

  section("Round 10 (G10-17): undo finds each file's own repository, inside the project or not")
  {
    // A project that is not a repository, holding one; a second repository beside it; a plain folder too.
    const project = path.join(temp, "undo-project")
    await fs.mkdir(project)
    const inner = await repo(path.join("undo-project", "inner"))
    const beside = await repo("undo-beside")
    const loose = path.join(temp, "undo-loose")
    await fs.mkdir(loose)
    await fs.writeFile(path.join(inner, "a.txt"), "one\ntwo\n")
    await g(inner, "add", "-A")
    await g(inner, "commit", "-qm", "base")
    await fs.writeFile(path.join(beside, "b.txt"), "alpha\nbeta\n")
    await fs.writeFile(path.join(beside, "kept-new.txt"), "tracked\n")
    await g(beside, "add", "-A")
    await g(beside, "commit", "-qm", "base")
    await fs.writeFile(path.join(loose, "c.txt"), "plain\nafter\n")

    // What the turn did.
    await fs.writeFile(path.join(inner, "a.txt"), "one\nTWO\n")
    await fs.writeFile(path.join(inner, "made.txt"), "new\n")
    await fs.writeFile(path.join(beside, "b.txt"), "alpha\nBETA\n")
    await fs.writeFile(path.join(beside, "fresh.txt"), "fresh\n")
    const tool = (id: string, name: string, metadata: Record<string, unknown>) => ({
      type: "tool" as const, id, callID: id, name, status: "completed" as const, input: {}, metadata, time: { created: 0 },
    })
    const turn = {
      id: "m", sessionID: "s", role: "assistant" as const, model: { provider: "p", model: "m" }, agent: "build" as const, time: { created: 0 },
      parts: [
        tool("1", "edit", { diff: unifiedDiff("inner/a.txt", "one\ntwo\n", "one\nTWO\n") }),
        tool("2", "write", { created: true, diff: unifiedDiff("inner/made.txt", "", "new\n") }),
        tool("3", "edit", { diff: unifiedDiff("../undo-beside/b.txt", "alpha\nbeta\n", "alpha\nBETA\n") }),
        tool("4", "write", { created: true, diff: unifiedDiff("../undo-beside/fresh.txt", "", "fresh\n") }),
        tool("5", "write", { created: true, diff: unifiedDiff("../undo-beside/kept-new.txt", "", "tracked\n") }),
        tool("6", "edit", { diff: unifiedDiff("../undo-loose/c.txt", "plain\n", "plain\nafter\n") }),
      ],
    }
    const result = await revertTurnFiles(project, [turn])
    check(
      "two edits go back, two new files go, and what cannot be put back is counted outside",
      result.restored === 2 && result.removed === 2 && result.outside === 2 && result.failed === 0,
      result,
    )
    const read = async (file: string) => (await fs.readFile(file, "utf8")).replace(/\r\n/g, "\n")
    check("a repository nested in a plain project has its file put back", (await read(path.join(inner, "a.txt"))) === "one\ntwo\n")
    check("and the file the turn made there is deleted", !(await fs.stat(path.join(inner, "made.txt")).then(() => true, () => false)))
    check("an edit outside the project, in another repository, is taken back", (await read(path.join(beside, "b.txt"))) === "alpha\nbeta\n")
    check("an untracked file the turn made outside is deleted", !(await fs.stat(path.join(beside, "fresh.txt")).then(() => true, () => false)))
    check("a created file outside that git tracks is left", (await read(path.join(beside, "kept-new.txt"))) === "tracked\n")
    check("an edit in no repository is left as it is", (await read(path.join(loose, "c.txt"))) === "plain\nafter\n")
    const header = (await fs.readFile(path.join(process.cwd(), "src/server/session/turn-revert.ts"), "utf8")).slice(0, 2500)
    check("the file's own account no longer says project-outside paths are never touched", !/outside the project is never touched/.test(header))
  }

  section("Round 10 (G10-10): a merge left in conflict is handed back, not resolved")
  {
    const dir = await repo("conflict")
    await fs.writeFile(path.join(dir, "说明.txt"), "base\n")
    await g(dir, "add", "-A")
    await g(dir, "commit", "-qm", "base")
    await g(dir, "checkout", "-q", "-b", "feature/x")
    await fs.writeFile(path.join(dir, "说明.txt"), "theirs\n")
    await g(dir, "commit", "-qam", "theirs")
    await g(dir, "checkout", "-q", "main")
    await fs.writeFile(path.join(dir, "说明.txt"), "ours\n")
    await g(dir, "commit", "-qam", "ours")
    check("nothing is added to a command that could not have conflicted", (await mergeConflictNotice(dir, "git status", "clean")) === "")
    const merged = await exec("git", ["merge", "feature/x"], { cwd: dir, windowsHide: true }).then(
      (done) => done.stdout,
      (err: { stdout?: string }) => err.stdout ?? "",
    )
    const note = await mergeConflictNotice(dir, "git merge feature/x", merged)
    check(
      "after a conflicted merge the note names the file, the abort and the branch's owner",
      note.includes("  说明.txt") && note.includes("`git merge --abort`") && note.includes("`feature/x`") && note.includes("talk_to_session") && note.includes("Do not repeat this note to the user"),
      note,
    )
    check("a command naming no merge still gets it when git printed CONFLICT", (await mergeConflictNotice(dir, "make integrate", "CONFLICT (content): Merge conflict")).length > 0)
    await g(dir, "merge", "--abort")
    check("once aborted, there is nothing to say", (await mergeConflictNotice(dir, "git merge feature/x", "CONFLICT")) === "")
    await g(dir, "checkout", "-q", "feature/x")
    const rebased = await exec("git", ["rebase", "main"], { cwd: dir, windowsHide: true }).then(
      (done) => done.stdout,
      (err: { stdout?: string }) => err.stdout ?? "",
    )
    const rebaseNote = await mergeConflictNotice(dir, "git rebase main", rebased)
    check("a rebase is named as one, with its own abort", rebaseNote.includes("The rebase stopped") && rebaseNote.includes("`git rebase --abort`"), rebaseNote.slice(0, 300))
    await g(dir, "rebase", "--abort")
    const bash = await fs.readFile(path.join(process.cwd(), "src/server/tool/bash.ts"), "utf8")
    check("the bash tool appends the note to its result", /output \+= await mergeConflictNotice\(cwd, command, output\)/.test(bash))
  }

  section("Round 10 (G10-21, G10-9): built-in worktree and merge skills; no workspace commands")
  {
    const shipped = await discoverSkills({ directory: temp, storageDirectory: path.join(temp, "no-storage") })
    const byName = new Map(shipped.skills.filter((skill) => skill.builtin).map((skill) => [skill.name, skill]))
    const worktree = byName.get("worktree")
    const merge = byName.get("merge")
    check("both skills ship and load", Boolean(worktree && merge) && !shipped.problems.some((problem) => /[\\/](worktree|merge)[\\/]/.test(problem.path)), shipped.problems)
    check(
      "the worktree skill checks for existing isolation, asks with the question tool, remembers the answer and checks the folder is ignored",
      Boolean(worktree?.content.includes("--git-common-dir") && worktree.content.includes("`question` tool") && worktree.content.includes("worktree-preference") && worktree.content.includes("git check-ignore") && worktree.content.includes("--show-superproject-working-tree")),
    )
    check(
      "the merge skill offers four choices and confirms a discard a second time",
      Boolean(merge?.content.includes("`Merge here`") && merge.content.includes("`Pull request`") && merge.content.includes("`Keep`") && merge.content.includes("`Discard`") && merge.content.includes("`Delete it`")),
    )
    const app = await fs.readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8")
    const protocol = await fs.readFile(path.join(process.cwd(), "src/shared/protocol.ts"), "utf8")
    check(
      "no command, dialog or request creates, switches or removes a workspace",
      !/workspace\.(new|switch|remove|create)|namingWorkspace|deletingWorkspace/.test(app) && !/"workspace\.(create|remove)"/.test(protocol) && !("addWorktree" in gitOps) && !("removeWorktree" in gitOps),
    )
  }

  section("Round 10 (G10-8): conversations in a worktree or a subdirectory are filed under the repository")
  {
    const main = await repo("group-main")
    await fs.writeFile(path.join(main, "a.txt"), "a\n")
    await g(main, "add", "-A")
    await g(main, "commit", "-qm", "base")
    const sub = path.join(main, "packages", "web")
    await fs.mkdir(sub, { recursive: true })
    const linked = path.join(temp, "group-linked")
    await g(main, "worktree", "add", "-q", "-b", "side-work", linked)
    const plain = path.join(temp, "group-plain")
    await fs.mkdir(plain)
    const gone = path.join(temp, "group-gone")
    const bareRepo = path.join(temp, "group-bare.git")
    await g(temp, "clone", "-q", "--bare", main, bareRepo)
    const bareTree = path.join(temp, "group-bare-tree")
    await g(bareRepo, "worktree", "add", "-q", bareTree, "main")

    check(
      "the root is the folder holding the shared .git, and nothing else counts",
      rootFromCommonDir("C:/work/repo/.git\n") === path.resolve("C:/work/repo") && rootFromCommonDir("/srv/x.git") === null && rootFromCommonDir("") === null && rootFromCommonDir("D:/r/.git/modules/sub") === null,
    )
    const storage = new Storage(path.join(temp, "group-storage"))
    const roots = new RepoRoots(storage)
    const answer = await roots.resolve([main, sub, linked, plain, gone, bareTree])
    // One folder has more than one spelling on Windows (the 8.3 short name the runner's
    // TEMP carries and the long name git answers with - run 44933235897 shows both forms
    // of one directory inside one cache document) and on macOS (the /var link and /private).
    // They are one folder: a comparison by text is the wrong question, so the checks below
    // ask fs.realpath whether two strings name the same directory.
    const same = async (a?: string, b?: string) => Boolean(a && b) && (await fs.realpath(a!).catch(() => a!)) === (await fs.realpath(b!).catch(() => b!))
    check(
      "a subdirectory and a linked worktree answer the main repository; the repository itself, a plain folder and a bare repository's worktree answer nothing",
      (await same(answer.roots[sub], main)) && (await same(answer.roots[linked], main)) && !(main in answer.roots) && !(plain in answer.roots) && !(bareTree in answer.roots),
      answer,
    )
    check("a folder that is gone is reported, not filed", answer.missing.length === 1 && answer.missing[0] === gone, answer.missing)
    const linkedReal = await fs.realpath(linked)
    if (linkedReal !== linked) await roots.resolve([linkedReal])
    else {
      // The harness hands out an already-canonical TMPDIR on macOS: make the second
      // spelling of the folder deliberately so this check is not vacuous there.
      const viaJunction = path.join(temp, "link-to-linked")
      await fs.symlink(linked, viaJunction, "junction")
      await roots.resolve([viaJunction])
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    const kept = (await storage.read<{ e?: Record<string, { root: string | null }> }>("repo-roots-cache"))?.e ?? {}
    const keptByReal = Object.fromEntries(await Promise.all(Object.keys(kept).map(async (key) => [key, await fs.realpath(key).catch(() => key)] as const)))
    const keptEntriesFor = async (folder: string) => {
      const real = await fs.realpath(folder).catch(() => folder)
      return Object.entries(kept).filter(([key]) => keptByReal[key] === real)
    }
    const keptFor = async (folder: string) => (await keptEntriesFor(folder))[0]?.[1]
    check("one folder in two spellings is one cache entry", (await keptEntriesFor(linked)).length === 1, Object.keys(kept))
    check(
      "answers are kept for the next launch",
      (await same((await keptFor(linked))?.root ?? undefined, main)) && (await keptFor(plain))?.root === null && !(await keptFor(gone)),
      kept,
    )
    let clock = Date.now()
    const later = new RepoRoots(storage, () => clock)
    check("a kept answer is used at once", (await same((await later.resolve([linked])).roots[linked], main)))
    clock += REPO_ROOTS_FRESH_MS + 1
    check("an old answer is still used while a fresh one is asked", (await same((await later.resolve([linked])).roots[linked], main)))

    const listed = new Set([main, plain])
    const context = {
      listed,
      root: (directory: string) => answer.roots[directory],
      missing: (directory: string) => answer.missing.includes(directory),
    }
    const at = (directory: string, extra: { group?: string; scratch?: boolean } = {}) => ({ directory, ...extra })
    check(
      "filing: a listed folder is itself, a worktree or subdirectory goes under the repository, a gone folder under nothing",
      sessionGroup(at(main), context) === main &&
        (await same(sessionGroup(at(linked), context), main)) &&
        (await same(sessionGroup(at(sub), context), main)) &&
        sessionGroup(at(plain), context) === plain &&
        sessionGroup(at(gone), context) === undefined,
    )
    check(
      "a label still wins, a scratch task has no project, and a subdirectory listed as a project keeps its own",
      sessionGroup(at(linked, { group: plain }), context) === plain &&
        sessionGroup(at(linked, { group: "" }), context) === undefined &&
        sessionGroup(at(main, { scratch: true }), context) === undefined &&
        sessionGroup(at(sub), { ...context, listed: new Set([main, sub]) }) === sub,
    )
    check("without a context a conversation is filed by its folder, as before", sessionGroup(at(linked)) === linked)
    const ordered = projectsByRecency({ projects: [main, gone, plain] }, [{ ...at(linked), updated: 50 }, { ...at(plain), updated: 10 }], {
      ...context,
      listed: new Set([main, gone, plain]),
    })
    check("a worktree conversation makes its repository recent, and a gone project is left off the list", ordered.join("|") === [main, plain].join("|"), ordered)

    const configRoot = path.join(temp, "group-config")
    const config = new Config(new Storage(path.join(configRoot, "storage")), new Bus(), path.join(configRoot, "credentials.json"))
    await config.load()
    await config.set({ projects: [], closedProjects: [] })
    await config.adoptProjects([linked], { byRepository: true })
    check("a conversation opened in a worktree adds the repository's project", (config.get().projects ?? []).length === 1 && (await same(config.get().projects?.[0], main)), config.get().projects)
    await config.adoptProjects([sub], { byRepository: true })
    await config.adoptProjects([gone], { byRepository: true })
    check("a subdirectory adds nothing more, and a folder that is gone adds nothing", (config.get().projects ?? []).length === 1, config.get().projects)
    await config.adoptProjects([plain], { byRepository: true })
    await config.adoptProjects([sub])
    check("a plain folder is its own project, and a chosen target is taken as it is", config.get().projects?.includes(plain) && config.get().projects?.includes(sub), config.get().projects)

    await config.set({
      projects: [linked, plain],
      pinnedProjects: [linked],
      migrations: (config.get().migrations ?? []).filter((name) => name !== REPOSITORY_PROJECTS_MIGRATION),
    })
    await config.migrateRepositoryProjects()
    const migrated = config.get()
    check(
      "the one-time migration files an existing worktree project under its repository",
      !migrated.projects?.includes(linked) && Boolean(await Promise.all((migrated.projects ?? []).map((entry) => same(entry, main))).then((filed) => filed.some(Boolean))) && migrated.projects?.includes(plain) && !migrated.pinnedProjects?.includes(linked) && migrated.migrations?.includes(REPOSITORY_PROJECTS_MIGRATION),
      migrated.projects,
    )
    await config.set({ projects: [linked] })
    await config.migrateRepositoryProjects()
    check("and runs only once", config.get().projects?.includes(linked), config.get().projects)
    const sources = await fs.readFile(path.join(process.cwd(), "src/server/handlers.ts"), "utf8")
    check("new conversations are filed by repository", /adoptProjects\(\[directory\], \{ byRepository: true \}\)/.test(sources))
  }

  section("Round 10 (G10-16): no request left that deletes files without a control")
  {
    const protocol = await fs.readFile(path.join(process.cwd(), "src/shared/protocol.ts"), "utf8")
    const server = await fs.readFile(path.join(process.cwd(), "src/server/git.ts"), "utf8")
    check("git.revert, git.init and the branch scope are gone", !/"git\.revert"|"git\.init"|scope\?: "worktree" \| "branch"/.test(protocol))
    check("and nothing in the git module runs git clean", !/"clean"/.test(server) && !("revert" in gitOps) && !("init" in gitOps))
  }

  await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
}
