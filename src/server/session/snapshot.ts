import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { SnapshotFile } from "./store"

/**
 * What a turn changed in the project, found by comparing the project with
 * itself rather than by asking the tools.
 *
 * The edit and write tools can say which file they touched, because they do the
 * touching. A shell command cannot. A `sed -i`, a formatter, a code generator,
 * a `git checkout`, a Makefile - each of those changes files without telling
 * anyone, and a tool offered by an MCP server is another program entirely.
 * Undo used to record only the two tools that spoke up, and then tell the user
 * the whole turn had been rolled back. The mixed turn was the worst of it: one
 * edit plus one shell change, the edit restored, a file count reported, and
 * nothing to suggest the rest of the turn was still there.
 *
 * So the project is photographed at the start of the turn and again at the end.
 * The camera is a git repository that lives outside the project: its git
 * directory sits in this app's storage and its work tree points at the project,
 * so the project does not have to be a repository itself, and if it is one its
 * own .git is neither read nor written. The difference between the two
 * photographs names every file the turn changed, whoever changed it.
 *
 * This is the shape the reference uses. Its own snapshot repositories are still
 * on this machine, under the app's data directory, each one a git directory
 * whose config names the project as core.worktree with autocrlf off and
 * longpaths on - the same trade, made the same way.
 *
 * Two things sit outside the boundary, because git cannot see them: files the
 * project's own .gitignore excludes, which is build output and dependency trees,
 * and files inside a nested repository, which git treats as somebody else's
 * business. Neither is somewhere people ask to have a turn taken back from, and
 * excluding the first is most of what makes this affordable at all.
 */

/**
 * Ceilings on what one turn's undo may hold.
 *
 * A snapshot keeps whole files, in one document per session, so a turn that
 * regenerates a tree of code would otherwise put hundreds of megabytes there
 * and make every later undo slow to read. Past these the turn is recorded as
 * one that cannot be taken back at all, which is the honest answer: a refusal
 * is better than restoring part of it and reporting a count.
 */
const MAX_FILES = 1000
const MAX_BYTES = 16 * 1024 * 1024

/** Blob modes git uses for an ordinary file. Anything else is not restorable. */
const ORDINARY = new Set(["100644", "100755"])
/** The mode git reports on the side of a diff where the path did not exist. */
const ABSENT = "000000"

/** The outcome of comparing the project against how the turn found it. */
export interface Recorded {
  /** Files the turn changed, holding what they contained before it ran. */
  files: SnapshotFile[]
  /**
   * Why the project could not be compared, when it could not.
   *
   * Only matters if something ran that this app cannot otherwise account for,
   * which is why the caller is left to decide rather than being handed a
   * failure.
   */
  unavailable?: string
  /** Why what was found cannot be held, when it cannot. */
  refused?: string
}

interface Ran {
  code: number
  stdout: Buffer
  stderr: string
}

/**
 * Runs git, with the surrounding environment's opinions removed.
 *
 * A shell that exported GIT_DIR, or a hook that set GIT_INDEX_FILE, would
 * otherwise silently retarget these commands at the user's own repository -
 * where `add -A` would stage their work in progress.
 */
function exec(args: string[], cwd: string, stdin?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
    ]) {
      delete env[name]
    }

    const child = spawn("git", args, { cwd, windowsHide: true, env })
    const out: Buffer[] = []
    let err = ""
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }))
    if (stdin !== undefined) {
      child.stdin.on("error", () => {})
      child.stdin.end(stdin)
    }
  })
}

function reason(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/**
 * The length a `cat-file --batch` header announces, or undefined for a reply
 * that carries no body.
 *
 * Read strictly, because the alternative reply is the request echoed back with
 * "missing" after it, and a request here ends in a path that could contain
 * anything at all. Taking the third word of that as a length would make the
 * reader slice the stream at the wrong place and hand back one file's bytes
 * under another file's name.
 */
function blobSize(header: string): number | undefined {
  const parts = header.split(" ")
  if (parts.length !== 3 || parts[1] !== "blob") return undefined
  const size = Number(parts[2])
  return Number.isInteger(size) && size >= 0 ? size : undefined
}

/** One line of `diff-tree --raw`, reduced to what a restore needs. */
interface Change {
  /** Path relative to the project, as git spells it, with forward slashes. */
  path: string
  /** Mode before the turn, or "000000" if the file did not exist. */
  from: string
  /** Mode after the turn, or "000000" if the turn deleted it. */
  to: string
}

/** The shadow repository for one project directory. */
class Repo {
  /**
   * git calls run one at a time.
   *
   * There is one index per project, and two sessions open on the same directory
   * can be mid-turn together. Overlapping calls would collide on index.lock and
   * fail the scan, which would cost both turns their undo.
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly gitDir: string,
    readonly directory: string,
  ) {}

  private lock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private git(args: string[], stdin?: string): Promise<Ran> {
    return exec(["--git-dir", this.gitDir, ...args], this.directory, stdin)
  }

  /** The project as it stands, as a tree object. */
  tree(): Promise<string> {
    return this.lock(async () => {
      const staged = await this.git(["add", "-A"])
      if (staged.code !== 0) throw new Error(staged.stderr.trim() || "git add failed")
      const written = await this.git(["write-tree"])
      if (written.code !== 0) throw new Error(written.stderr.trim() || "git write-tree failed")
      return written.stdout.toString("utf8").trim()
    })
  }

  /** What differs between two trees, one entry per path. */
  async changes(before: string, after: string): Promise<Change[]> {
    const shown = await this.lock(() => this.git(["diff-tree", "-r", "--raw", "-z", before, after]))
    if (shown.code !== 0) throw new Error(shown.stderr.trim() || "git diff-tree failed")

    /*
     * `--raw -z` emits ":<from mode> <to mode> <from sha> <to sha> <status>"
     * as one NUL-terminated field, then the path as the next one. Rename
     * detection is off, so every change is one path and the fields always
     * come in pairs.
     */
    const fields = shown.stdout.toString("utf8").split("\0")
    const out: Change[] = []
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const header = fields[i]
      const target = fields[i + 1]
      if (!header.startsWith(":") || !target) continue
      const parts = header.slice(1).split(" ")
      if (parts.length < 5) continue
      out.push({ path: target, from: parts[0], to: parts[1] })
    }
    return out
  }

  /** How many bytes each of these paths held in that tree. */
  async sizes(tree: string, paths: string[]): Promise<number> {
    if (paths.length === 0) return 0
    const query = paths.map((entry) => `${tree}:${entry}\n`).join("")
    const checked = await this.lock(() => this.git(["cat-file", "--batch-check"], query))
    if (checked.code !== 0) throw new Error(checked.stderr.trim() || "git cat-file failed")

    let total = 0
    for (const line of checked.stdout.toString("utf8").split("\n")) {
      const size = blobSize(line.trim())
      if (size !== undefined) total += size
    }
    return total
  }

  /**
   * The contents these paths held in that tree.
   *
   * One `cat-file --batch` rather than a process per file: a turn that touched
   * two hundred files would otherwise spend several seconds spawning git.
   */
  async contents(tree: string, paths: string[]): Promise<Map<string, Buffer>> {
    const found = new Map<string, Buffer>()
    if (paths.length === 0) return found

    const query = paths.map((entry) => `${tree}:${entry}\n`).join("")
    const read = await this.lock(() => this.git(["cat-file", "--batch"], query))
    if (read.code !== 0) throw new Error(read.stderr.trim() || "git cat-file failed")

    /*
     * The batch reply is a header line, then exactly the number of bytes it
     * names, then a newline. It has to be walked as bytes rather than split as
     * text: a file's contents may hold anything, newlines included, and are not
     * necessarily valid UTF-8.
     */
    const body = read.stdout
    let at = 0
    for (const entry of paths) {
      const end = body.indexOf(0x0a, at)
      if (end < 0) break
      const header = body.toString("utf8", at, end)
      at = end + 1
      // A path git cannot find answers "<object> missing", with no body to skip.
      const size = blobSize(header)
      if (size === undefined) continue
      found.set(entry, body.subarray(at, at + size))
      at += size + 1
    }
    return found
  }
}

/**
 * One turn's recording.
 *
 * The opening photograph is taken as soon as the turn starts, so that on a
 * large project the scan overlaps the model's first reply instead of being
 * waited for. `ready` is what makes that safe: any tool that could write has to
 * wait for the photograph, or it would be caught in it.
 */
export class Recording {
  private readonly opened: Promise<{ repo: Repo; tree: string } | { failed: string }>

  constructor(opening: Promise<Repo>) {
    this.opened = opening
      .then(async (repo) => ({ repo, tree: await repo.tree() }))
      .catch((cause: unknown) => ({
        failed: `This turn could not be recorded for undo (${reason(cause)}), so it cannot be taken back.`,
      }))
  }

  /** Settles once the project has been photographed, however that went. */
  async ready(): Promise<void> {
    await this.opened
  }

  async finish(): Promise<Recorded> {
    const opened = await this.opened
    if ("failed" in opened) return { files: [], unavailable: opened.failed }
    const { repo, tree } = opened

    let after: string
    try {
      after = await repo.tree()
    } catch (cause) {
      return {
        files: [],
        unavailable: `This turn's changes could not be read back (${reason(cause)}), so it cannot be taken back.`,
      }
    }
    if (after === tree) return { files: [] }

    let changes: Change[]
    try {
      changes = await repo.changes(tree, after)
    } catch (cause) {
      return {
        files: [],
        unavailable: `This turn's changes could not be read back (${reason(cause)}), so it cannot be taken back.`,
      }
    }
    if (changes.length === 0) return { files: [] }
    if (changes.length > MAX_FILES) {
      return {
        files: [],
        refused: `This turn changed ${changes.length} files, more than undo can hold, so it cannot be taken back.`,
      }
    }

    for (const change of changes) {
      /*
       * A submodule, a symlink or a path with a newline in it. Restoring the
       * first two means acting on something other than a file's contents, and
       * the third cannot be asked for through cat-file's line-based input.
       * None can be put back honestly, so none is reported as put back.
       */
      const ordinary =
        (change.from === ABSENT || ORDINARY.has(change.from)) && (change.to === ABSENT || ORDINARY.has(change.to))
      if (!ordinary || change.path.includes("\n")) {
        return {
          files: [],
          refused: `${change.path} is not an ordinary file, so this turn cannot be taken back.`,
        }
      }
    }

    // Only the paths that existed before the turn have anything to fetch; the
    // ones it created go back as deletions.
    const existed = changes.filter((change) => change.from !== ABSENT).map((change) => change.path)
    try {
      const bytes = await repo.sizes(tree, existed)
      if (bytes > MAX_BYTES) {
        return {
          files: [],
          refused: `This turn changed ${Math.round(bytes / 1024 / 1024)} MB of files, more than undo can hold, so it cannot be taken back.`,
        }
      }
    } catch (cause) {
      return {
        files: [],
        unavailable: `This turn's changes could not be measured (${reason(cause)}), so it cannot be taken back.`,
      }
    }

    let before: Map<string, Buffer>
    try {
      before = await repo.contents(tree, existed)
    } catch (cause) {
      return {
        files: [],
        unavailable: `This turn's changes could not be read back (${reason(cause)}), so it cannot be taken back.`,
      }
    }

    const files: SnapshotFile[] = []
    for (const change of changes) {
      const absolute = path.resolve(repo.directory, change.path)
      if (change.from === ABSENT) {
        files.push({ path: absolute, content: null })
        continue
      }
      const held = before.get(change.path)
      if (!held) {
        return {
          files: [],
          unavailable: `${change.path} could not be read back, so this turn cannot be taken back.`,
        }
      }
      files.push({ path: absolute, ...encode(held) })
    }
    return { files }
  }
}

/**
 * A file's bytes as they can be stored in a JSON document.
 *
 * Text goes in as text, which keeps a snapshot readable and its diffs small.
 * Anything that is not valid UTF-8 - an icon a build step rewrote, a compiled
 * artefact - goes in as base64, because reading it back through a UTF-8 string
 * would replace every byte it did not understand and restore a corrupted file.
 */
export function encode(bytes: Buffer): { content: string; base64?: boolean } {
  const text = bytes.toString("utf8")
  if (Buffer.from(text, "utf8").equals(bytes)) return { content: text }
  return { content: bytes.toString("base64"), base64: true }
}

/** One file as it stands right now, in the shape a snapshot holds. */
export async function readSnapshotFile(target: string): Promise<SnapshotFile> {
  const bytes = await fs.readFile(target).catch(() => null)
  // null stands for "did not exist", which a restore turns back into a deletion.
  if (bytes === null) return { path: target, content: null }
  return { path: target, ...encode(bytes) }
}

/** The bytes to write back for one recorded file. */
export function decode(file: SnapshotFile): Buffer {
  return Buffer.from(file.content ?? "", file.base64 ? "base64" : "utf8")
}

/**
 * The shadow repositories, one per project directory.
 *
 * Keeping them keyed by directory rather than by session is what makes this
 * affordable: git's index remembers the size and timestamp of every file it has
 * seen, so every turn after the first only stats the tree rather than reading
 * it. Measured through this code on a Windows laptop, a 5,000 file project cost
 * 5.6 seconds for the very first turn in it and then 0.25 seconds for a whole
 * turn that changed ten files; a 153 file project cost 0.6 seconds and then
 * 0.11. Half of each of those later figures is the opening photograph, which is
 * taken while the model is still composing its reply, so what a turn waits for
 * is smaller again.
 *
 * That first figure is the price of admission, paid once per project, and it is
 * why what a project's .gitignore excludes stays excluded: a dependency tree is
 * most of the cost and none of the value. On the tree this app was written in,
 * indexing node_modules as well would have taken 26 seconds instead of one.
 */
export class Snapshots {
  private readonly repos = new Map<string, Promise<Repo>>()

  constructor(private readonly root: string) {}

  private open(directory: string): Promise<Repo> {
    const key = process.platform === "win32" ? directory.toLowerCase() : directory
    const existing = this.repos.get(key)
    if (existing) return existing

    const opening = this.create(directory).catch((cause: unknown) => {
      // A failure must not be cached: git may be installed a minute later, and
      // a directory that was missing may come back.
      this.repos.delete(key)
      throw cause
    })
    this.repos.set(key, opening)
    return opening
  }

  private async create(directory: string): Promise<Repo> {
    const stat = await fs.stat(directory).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`${directory} is not a directory`)

    /*
     * Only a project that is itself under git is recorded, which is what the
     * reference does - its snapshot service starts with `if (vcs !== "git")
     * return false`, so a folder that is not a repository is never touched.
     *
     * The reason is not tidiness. `git add -A` hashes and stores a copy of
     * every file it can see, and outside a repository there is no .gitignore
     * to stop it: build output, archives, logs and binaries all go in, every
     * turn. Two of this machine's own projects showed what that costs - a
     * 182 MB C server with no .gitignore took 7.9s per turn to stage, and
     * another folder's undo store had reached 44 GB, 1.4 GB blobs of game
     * data stored over and over for turns that `MAX_BYTES` then refused to
     * restore anyway. The work was pure waste in both cases.
     *
     * A turn of ordinary edits is still undoable without this: the tools
     * report what they wrote, and `commitSnapshot` builds the history out of
     * those reports. Only a turn that also ran a shell command or an MCP tool
     * - which leave no account of themselves - loses the ability to be taken
     * back, and it says so.
     */
    const inside = await exec(["rev-parse", "--is-inside-work-tree"], directory)
    if (inside.code !== 0 || inside.stdout.toString("utf8").trim() !== "true") {
      throw new Error("the project is not a git repository, so it cannot be compared against itself")
    }

    /*
     * Named for the project rather than for the session: every session open on
     * the same directory shares one index, which is what keeps the scan a stat
     * walk rather than a full read.
     */
    const key = createHash("sha1")
      .update(process.platform === "win32" ? directory.toLowerCase() : directory)
      .digest("hex")
    const gitDir = path.join(this.root, key)

    /*
     * The attributes file is written last, so its presence is what says the
     * repository is finished rather than half set up by a run that was killed
     * partway. `git init` on an existing repository only reinitialises it, so
     * repeating the whole sequence is safe.
     */
    if (!(await fs.stat(path.join(gitDir, "info", "attributes")).catch(() => undefined))) {
      await fs.mkdir(path.dirname(gitDir), { recursive: true })
      const made = await exec(["init", "--bare", "-q", gitDir], this.root)
      if (made.code !== 0) throw new Error(made.stderr.trim() || "git init failed")

      const settings: [string, string][] = [
        // A bare repository refuses work-tree operations, and the work tree is
        // the only thing this one is for.
        ["core.bare", "false"],
        ["core.worktree", directory],
        /*
         * Line endings are the user's business, not git's. A machine with
         * core.autocrlf set globally would otherwise store LF and hand LF back,
         * so undoing a turn on a CRLF file would rewrite every line in it.
         */
        ["core.autocrlf", "false"],
        // Long paths are ordinary in a JavaScript project on Windows.
        ["core.longpaths", "true"],
        // Undo restores contents, not permission bits, so a filesystem that
        // reports the executable bit differently must not read as a change.
        ["core.filemode", "false"],
        // The file system monitor watches the user's own repositories. This one
        // is written to only by this app, in bursts, and is better off polling.
        ["core.fsmonitor", "false"],
        /*
         * Nothing in here is reachable from a branch, on purpose: the trees are
         * only needed between the start and the end of one turn. A collection
         * would be free to throw away the very tree a turn in flight is about
         * to compare against.
         */
        ["gc.auto", "0"],
      ]
      for (const [name, value] of settings) {
        const set = await exec(["--git-dir", gitDir, "config", name, value], this.root)
        if (set.code !== 0) throw new Error(set.stderr.trim() || `git config ${name} failed`)
      }

      /*
       * Attributes in the git directory outrank a .gitattributes in the project,
       * and turning off text and filter conversion is what makes a stored file
       * the file itself. A project carrying "* text=auto" would otherwise have
       * its CRLF files normalised to LF on the way in, and undo would hand back
       * a file with every line ending changed; one using Git LFS would have a
       * pointer stored in place of the content.
       */
      await fs.writeFile(path.join(gitDir, "info", "attributes"), "* -text -filter\n", "utf8")
    }

    return new Repo(gitDir, directory)
  }

  /**
   * Starts recording a turn.
   *
   * Nothing is awaited here: the photograph is taken in the background while
   * the model composes its first reply, and `Recording.ready` is what a tool
   * waits on before it is allowed to write.
   */
  begin(directory: string): Recording {
    return new Recording(this.open(directory))
  }
}
