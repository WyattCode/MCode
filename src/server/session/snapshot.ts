import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { readBytesWaiting, writeAtomic } from "../storage"
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

/**
 * An untracked file larger than this is left out of the photographs, as MiMo
 * leaves it out: a disk image or a dataset dropped into the project would
 * otherwise be copied into the store on the first turn and make every later
 * turn's scan slow, for a change nobody asks to have undone.
 */
export const LARGE_UNTRACKED_BYTES = 2 * 1024 * 1024

/** The conversation whose turn last left a file as it stands, and when. */
interface Writer {
  session: string
  at: number
}

/**
 * How many files a project's ledger of last writers remembers.
 *
 * Only the newest turns can be taken back at all, so an entry older than that
 * has nothing left to protect and is dropped rather than grown forever.
 */
const WRITERS_KEPT = 4000

/** Blob modes git uses for an ordinary file. Anything else is not restorable. */
const ORDINARY = new Set(["100644", "100755"])
/** The mode git reports on the side of a diff where the path did not exist. */
const ABSENT = "000000"

/** The outcome of comparing the project against how the turn found it. */
export interface Recorded {
  /** Files the turn changed, each pointing at what it contained before the turn ran. */
  files: SnapshotFile[]
  /**
   * How much the turn changed, as MiMo's session row records it.
   *
   * Only where the project could be compared against itself: a turn recorded
   * from what the write tools reported has no second photograph to count
   * against, and reporting nought lines for it would be a figure rather than an
   * absence.
   */
  additions?: number
  deletions?: number
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
 * How long one of the shadow repository's git calls may take (N11-7).
 *
 * Deliberately larger than git-process.ts's GIT_TIMEOUT_MS, which is sized for
 * the informational commands run against the user's own repository: an `add -A`
 * over a large project is legitimately slow, and this bound exists to catch a
 * call that will never return rather than to hurry a slow one.
 */
export const SNAPSHOT_GIT_TIMEOUT_MS = 60_000

/**
 * How long a turn waits for its place in one project's git queue before giving
 * up on being recorded (N11-7).
 *
 * Above the timeout on a single call, so an ordinary backlog is waited out and
 * only a genuine pile-up is abandoned. Giving up costs that turn its undo,
 * which is said in the transcript; hanging costs it everything and says nothing.
 */
export const SNAPSHOT_QUEUE_TIMEOUT_MS = 90_000

/** What a turn that gave up waiting for the queue is told. */
const QUEUE_GAVE_UP = "the project's snapshot queue did not free up"

/**
 * One lock per project for the work that writes its files outside a turn's
 * tools - an undo, a redo, a turn's 撤销 - and for the photographs that mark
 * where each turn begins and ends (N11-15).
 *
 * The photographs already queue on the shadow repository's git lock, but a
 * restore writes files one by one with plain fs calls and took no lock at
 * all, so another conversation's turn could open or close half way through
 * it and count the restored files as its own work. Held outside the git lock
 * everywhere - a restore still reads its bodies through that lock - so the
 * order is always this one first and the two can never wait on each other.
 */
const projectLocks = new Map<string, Promise<unknown>>()

function projectKey(directory: string): string {
  const resolved = path.resolve(directory)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function withProjectLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const key = projectKey(directory)
  const run = (projectLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
  const settled = run.catch(() => undefined)
  projectLocks.set(key, settled)
  void settled.then(() => {
    if (projectLocks.get(key) === settled) projectLocks.delete(key)
  })
  return run
}

/** What a call made after its repository was collected is told. */
const REPO_RETIRED = "this project's snapshot store has been removed"


/**
 * Runs git, with the surrounding environment's opinions removed.
 *
 * A shell that exported GIT_DIR, or a hook that set GIT_INDEX_FILE, would
 * otherwise silently retarget these commands at the user's own repository -
 * where `add -A` would stage their work in progress.
 */
function exec(args: string[], cwd: string, stdin?: string | Buffer): Promise<Ran> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let killer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (timer) clearTimeout(timer)
      if (killer) clearTimeout(killer)
      timer = undefined
      killer = undefined
    }
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
    child.on("error", (cause) => {
      done()
      reject(cause)
    })
    child.on("close", (code) => {
      done()
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err })
    })
    /*
     * A bound, because there was none (N11-7). One project has one shadow
     * repository and every write tool waits on it, so a single git that never
     * returns used to hang every turn open on that project, for ever and with
     * nothing on screen to say why. Killing it turns that into one recording
     * that failed, which the turn already knows how to report.
     */
    timer = setTimeout(() => {
      timer = undefined
      child.kill()
      // Ignored a polite end: SIGKILL, which ConPTY-free children on Windows take as a terminate.
      killer = setTimeout(() => child.kill("SIGKILL"), 2000)
      killer.unref?.()
      reject(new Error(`git ${args[args.indexOf("--git-dir") + 2] ?? args[0]} did not finish within ${SNAPSHOT_GIT_TIMEOUT_MS / 1000}s`))
    }, SNAPSHOT_GIT_TIMEOUT_MS)
    timer.unref?.()
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

/** How a path is compared, on a filesystem that may not mind the case. */
function pathKey(target: string): string {
  const absolute = path.resolve(target)
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}

/**
 * One boundary in a project's life, and what was going on up to it.
 *
 * A project's photographs are shared: every turn recording in the same folder
 * is photographed at the same instants, because the camera is one repository
 * with one index. A boundary is taken whenever a turn opens or closes there,
 * which cuts each turn's life into stretches - and a stretch this turn had to
 * itself names its own changes, while one shared with another conversation
 * names changes that could have come from either.
 */
interface Point {
  tree: string
  /** Another conversation was recording here during the stretch that ended at this tree. */
  shared: boolean
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

  /**
   * The turns recording this project right now.
   *
   * One index means one set of photographs, so the only way to tell two
   * conversations' work apart is to know when each of them was watching.
   */
  private readonly live = new Set<Recording>()

  constructor(
    private readonly gitDir: string,
    readonly directory: string,
  ) {}

  /** Set once the store has been collected; every later call refuses rather than recreating it. */
  private retired = false

  private lock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * The same queue, but the caller stops waiting after `ms`.
   *
   * The queued work is told it was abandoned rather than simply dropped, so it
   * can still do the bookkeeping that costs nothing - taking a turn out of the
   * live set - without taking another photograph nobody is waiting for.
   */
  private raceLock<T>(ms: number, work: (abandoned: () => boolean) => Promise<T>): Promise<T> {
    let gaveUp = false
    const queued = this.lock(() => work(() => gaveUp))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        gaveUp = true
        reject(new Error(QUEUE_GAVE_UP))
      }, ms)
      timer.unref?.()
      queued.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (cause: unknown) => {
          clearTimeout(timer)
          reject(cause instanceof Error ? cause : new Error(String(cause)))
        },
      )
    })
  }

  /**
   * Takes this repository out of use for good, refusing while a turn is still
   * recording here (N11-6).
   *
   * Collection used to be an unlocked `rm -rf` racing whatever the just-aborted
   * turn was still doing on its way out - and `abort` only signals, so that
   * turn's `leave()` and `add -A` carried on afterwards.
   */
  retire(): Promise<boolean> {
    return this.lock(async () => {
      if (this.live.size > 0) return false
      this.retired = true
      return true
    })
  }

  /*
   * `stdin` may be bytes, and for `hash-object` it must be: a file's contents
   * handed over as a string would be written back out as UTF-8, which replaces
   * every byte the decoder did not understand - so a picture or a compiled
   * artefact would be stored corrupted, silently.
   */
  private git(args: string[], stdin?: string | Buffer): Promise<Ran> {
    if (this.retired) return Promise.reject(new Error(REPO_RETIRED))
    return exec(["--git-dir", this.gitDir, ...args], this.directory, stdin)
  }

  /** What the store's own exclude file last held, so an unchanged one is not written again. */
  private excludes: string | undefined

  private async writeExcludes(text: string): Promise<void> {
    if (text === this.excludes) return
    await fs.mkdir(path.join(this.gitDir, "info"), { recursive: true })
    await fs.writeFile(path.join(this.gitDir, "info", "exclude"), text, "utf8")
    this.excludes = text
  }

  /**
   * Keeps the store's view of what to ignore in step with the project's, as
   * MiMo's snapshot does before every scan.
   *
   * The project's own `info/exclude` - the ignore list that lives in its git
   * directory rather than in a `.gitignore` - is copied in, so a local build
   * folder the user excluded there is not photographed either. Untracked files
   * over `LARGE_UNTRACKED_BYTES` are added to it, and anything the store
   * already holds that is now ignored is dropped from its index.
   */
  private async syncExcludes(): Promise<void> {
    const where = await exec(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], this.directory)
    const own = where.code === 0 ? where.stdout.toString("utf8").trim() : ""
    const base = own ? (await fs.readFile(own, "utf8").catch(() => "")).trimEnd() : ""
    const compose = (large: string[]) => {
      const text = [base, ...large.map((file) => `/${file.replaceAll("\\", "/")}`)].filter(Boolean).join("\n")
      return text ? `${text}\n` : ""
    }
    await this.writeExcludes(compose([]))

    const others = await this.git(["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"])
    if (others.code === 0) {
      const untracked = others.stdout.toString("utf8").split("\0").filter(Boolean)
      const large: string[] = []
      for (let at = 0; at < untracked.length; at += 8) {
        const sizes = await Promise.all(
          untracked.slice(at, at + 8).map((file) =>
            fs.stat(path.join(this.directory, file)).then(
              (stat) => (stat.isFile() ? stat.size : 0),
              () => 0,
            ),
          ),
        )
        sizes.forEach((size, index) => {
          if (size > LARGE_UNTRACKED_BYTES) large.push(untracked[at + index]!)
        })
      }
      if (large.length) await this.writeExcludes(compose(large))
    }

    const ignored = await this.git(["-c", "core.quotepath=false", "ls-files", "--cached", "--ignored", "--exclude-standard", "-z"])
    const dropped = ignored.code === 0 ? ignored.stdout.toString("utf8").split("\0").filter(Boolean) : []
    if (dropped.length) {
      await this.git(
        ["rm", "--cached", "-q", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
        `${dropped.join("\0")}\0`,
      )
    }
  }

  /** The project as it stands, as a tree object. Runs under the lock already held. */
  private async treeNow(): Promise<string> {
    await this.syncExcludes()
    const staged = await this.git(["add", "-A"])
    if (staged.code !== 0) throw new Error(staged.stderr.trim() || "git add failed")
    const written = await this.git(["write-tree"])
    if (written.code !== 0) throw new Error(written.stderr.trim() || "git write-tree failed")
    return written.stdout.toString("utf8").trim()
  }

  /**
   * Photographs the project as one turn opens, ending a stretch for every turn
   * already recording here.
   *
   * The photograph and the bookkeeping happen under the same lock, so a turn
   * cannot open between the picture being taken and the set being changed and
   * so end up with a stretch nobody marked as shared.
   */
  join(recording: Recording): Promise<string> {
    // Never in the middle of a restore (N11-15): its files would read as this turn's starting point half put back.
    return withProjectLock(this.directory, () => this.joinNow(recording))
  }

  private joinNow(recording: Recording): Promise<string> {
    return this.raceLock(SNAPSHOT_QUEUE_TIMEOUT_MS, async (abandoned) => {
      // Nothing was added to the live set yet, so an abandoned join has nothing to undo.
      if (abandoned()) throw new Error(QUEUE_GAVE_UP)
      const tree = await this.treeNow()
      /*
       * Asked again once the photograph is in: the caller may have stopped
       * waiting while it was being taken, and a turn whose join was refused
       * gathers nothing - so it never calls leave, and a recording added here
       * would count as live for the rest of the process.
       */
      if (abandoned()) throw new Error(QUEUE_GAVE_UP)
      const shared = this.live.size >= 2
      for (const other of this.live) {
        other.mark(tree, shared)
        other.overlaps(recording)
        recording.overlaps(other)
      }
      this.live.add(recording)
      return tree
    })
  }

  /** Photographs the project as one turn closes, ending a stretch for everyone here. */
  leave(recording: Recording): Promise<string> {
    // Nor at its end (N11-15), or half a restore would be counted as this turn's work.
    return withProjectLock(this.directory, () => this.leaveNow(recording))
  }

  private leaveNow(recording: Recording): Promise<string> {
    return this.raceLock(SNAPSHOT_QUEUE_TIMEOUT_MS, async (abandoned) => {
      // The caller has stopped waiting, but this turn must still stop counting as live.
      if (abandoned()) {
        this.live.delete(recording)
        throw new Error(QUEUE_GAVE_UP)
      }
      /*
       * Out of the live set however this ends. A photograph that throws - the
       * project folder renamed under the turn, a stale index.lock left by a
       * killed subprocess, a full disk - used to leave the turn recording for
       * the life of the process, where `gather()` reports only that one turn as
       * unavailable. Every later turn in the project then saw a second live
       * recording: each stretch counted as shared, every change no tool had
       * named was handed to "another conversation", and `retire()` - so
       * `collect()` - could never take the project's store away.
       */
      try {
        const tree = await this.treeNow()
        const shared = this.live.size >= 2
        for (const other of this.live) other.mark(tree, shared)
        return tree
      } finally {
        this.live.delete(recording)
      }
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
   * How many lines the turn added and removed between two trees.
   *
   * MiMo keeps exactly this on its session row (`summary_additions`,
   * `summary_deletions`) rather than recomputing it from bodies it no longer
   * holds. Asked of git in one call, for the same reason: once the snapshot
   * carries references instead of contents, there is nothing here to count from.
   *
   * A binary file answers "-\t-\t<path>", which is counted as no lines rather
   * than as NaN.
   */
  async numstat(before: string, after: string): Promise<{ additions: number; deletions: number }> {
    const shown = await this.lock(() => this.git(["diff-tree", "-r", "--numstat", "-z", before, after]))
    if (shown.code !== 0) throw new Error(shown.stderr.trim() || "git diff-tree --numstat failed")
    let additions = 0
    let deletions = 0
    /*
     * `--numstat -z` writes "<added>\t<deleted>\t" and then the path as its own
     * NUL-terminated field, so the counts are read off the head of each record
     * and the path is never parsed.
     */
    for (const record of shown.stdout.toString("utf8").split("\0")) {
      const parts = record.split("\t")
      if (parts.length < 2) continue
      const added = Number(parts[0])
      const removed = Number(parts[1])
      if (Number.isInteger(added)) additions += added
      if (Number.isInteger(removed)) deletions += removed
    }
    return { additions, deletions }
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

  /**
   * Keeps one file's bytes as an object, and hands back its id.
   *
   * This is what lets a turn's recording be a reference rather than a body. git
   * addresses an object by the hash of its contents, so a file saved
   * unchanged - or the same file recorded by twenty turns in a row - is stored
   * once however often it is recorded, which the old inline shape could not do.
   */
  async keep(bytes: Buffer): Promise<string> {
    const written = await this.lock(() => this.git(["hash-object", "-w", "--stdin"], bytes))
    if (written.code !== 0) throw new Error(written.stderr.trim() || "git hash-object failed")
    const id = written.stdout.toString("utf8").trim()
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error("git hash-object answered with something that is not an object id")
    return id
  }

  /** One stored object's bytes, or nothing if this store has never held it. */
  async fetch(id: string): Promise<Buffer | undefined> {
    // Asked as bytes through the same batch reader the trees use, so a body that is not text survives.
    const read = await this.lock(() => this.git(["cat-file", "--batch"], `${id}\n`))
    if (read.code !== 0) return undefined
    const body = read.stdout
    const end = body.indexOf(0x0a)
    if (end < 0) return undefined
    const size = blobSize(body.toString("utf8", 0, end))
    if (size === undefined) return undefined
    return body.subarray(end + 1, end + 1 + size)
  }

  /**
   * Packs every object into one pack, unreachable ones included (L12-13).
   *
   * Under this repository's lock and, when the same store is also open for
   * scanning, under that one's too, so no photograph or kept body is written
   * while the packs are being replaced. `--keep-unreachable` is the point: a
   * kept body and a turn's trees are reachable from no ref by design, and a
   * plain `-ad` would drop the ones already packed and leave the loose ones
   * loose. Nothing is ever pruned.
   */
  pack(alongside?: Repo): Promise<boolean> {
    const run = async () => (await this.git(["repack", "-a", "-d", "--keep-unreachable", "-q"])).code === 0
    return this.lock(() => (alongside && alongside !== this ? alongside.lock(run) : run()))
  }
}

/** When the first repack of the checkpoint stores runs after start-up, as MiMo's first snapshot cleanup does. */
export const CHECKPOINT_PACK_FIRST_MS = 60_000
/** And how often after that: MiMo cleans its snapshot stores hourly. */
export const CHECKPOINT_PACK_EVERY_MS = 60 * 60_000

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
  /** Where each stretch of this turn ended, and whether it was shared. */
  private readonly points: Point[] = []
  /** Files this turn's own tools said they wrote, which is what tells two overlapping turns apart. */
  private readonly told = new Set<string>()
  /** The other turns that recorded this project while this one was open. */
  private readonly concurrent = new Set<Recording>()
  /** Whether anything ran that leaves no account of itself - a shell command, an MCP tool. */
  private silent = false
  private settled: Promise<Recorded> | undefined

  constructor(opening: Promise<Repo>) {
    this.opened = opening
      .then(async (repo) => ({ repo, tree: await repo.join(this) }))
      .catch((cause: unknown) => ({
        failed: `This turn could not be recorded for undo (${reason(cause)}), so it cannot be taken back.`,
      }))
  }

  /** Settles once the project has been photographed, however that went. */
  async ready(): Promise<void> {
    await this.opened
  }

  /** The repository, ending a stretch of this turn because another one opened or closed. */
  mark(tree: string, shared: boolean): void {
    this.points.push({ tree, shared })
  }

  /** The repository, naming a turn that was recording at the same time as this one. */
  overlaps(other: Recording): void {
    this.concurrent.add(other)
  }

  /** A tool of this turn's, saying which file it wrote. */
  claim(target: string): void {
    this.told.add(pathKey(target))
  }

  /** Whether this turn's own tools named that file. */
  claimed(target: string): boolean {
    return this.told.has(pathKey(target))
  }

  /** Whether a file changed while two turns were watching is plainly this one's. */
  private owns(target: string): boolean {
    return this.claimed(target) && !this.takenByOther(target)
  }

  /** Whether another turn recording here named the same file. */
  private takenByOther(target: string): boolean {
    for (const other of this.concurrent) {
      if (other.claimed(target)) return true
    }
    return false
  }

  /** Told that something ran which could change a file without saying so. */
  opaque(): void {
    this.silent = true
  }

  /** Whether this turn could have changed a file without any tool reporting it. */
  get quiet(): boolean {
    return !this.silent
  }

  /** Recorded once: a second caller gets the same answer rather than a second scan. */
  finish(): Promise<Recorded> {
    this.settled ??= this.gather()
    return this.settled
  }

  /**
   * What this turn changed, stretch by stretch.
   *
   * Two conversations can be mid-turn in one project, and the photographs are
   * shared, so the difference between the first and the last one is not this
   * turn's work - it is everyone's. Each stretch this turn had to itself is
   * wholly its own; in a stretch it shared, a change belongs to whichever turn's
   * tool named the file, and one that no tool named belongs to whichever of the
   * overlapping turns ran something silent. If that is more than one of them the
   * file is contested, and the turn is recorded as one that cannot be taken back
   * rather than as one that would put another conversation's work back too.
   */
  private async gather(): Promise<Recorded> {
    const opened = await this.opened
    if ("failed" in opened) return { files: [], unavailable: opened.failed }
    const { repo, tree } = opened

    try {
      await repo.leave(this)
    } catch (cause) {
      return {
        files: [],
        unavailable: `This turn's changes could not be read back (${reason(cause)}), so it cannot be taken back.`,
      }
    }

    /** This turn's own changes, first mode kept so a restore reads the tree it opened on. */
    const mine = new Map<string, Change>()
    /** Paths another conversation's turn changed, which this one must not claim. */
    const foreign = new Set<string>()
    const contested = new Set<string>()
    const contest = (target: string) => {
      contested.add(target)
      mine.delete(target)
    }

    let previous = tree
    for (const point of this.points) {
      if (point.tree === previous) continue
      let stretch: Change[]
      try {
        stretch = await repo.changes(previous, point.tree)
      } catch (cause) {
        return {
          files: [],
          unavailable: `This turn's changes could not be read back (${reason(cause)}), so it cannot be taken back.`,
        }
      }
      previous = point.tree
      for (const change of stretch) {
        const absolute = path.resolve(repo.directory, change.path)
        if (point.shared && !this.owns(absolute)) {
          if (contested.has(change.path)) continue
          // Named by another turn's tool: theirs, and never this turn's again.
          if (this.takenByOther(absolute)) {
            foreign.add(change.path)
            if (mine.has(change.path)) contest(change.path)
            continue
          }
          // Nobody named it. Whoever could have changed it without saying so did.
          const silent = [...this.concurrent].filter((other) => !other.quiet)
          if (this.quiet) {
            if (silent.length) foreign.add(change.path)
            if (mine.has(change.path)) contest(change.path)
            continue
          }
          if (silent.length) {
            contest(change.path)
            continue
          }
        }
        if (contested.has(change.path) || foreign.has(change.path)) {
          // Changed by someone else earlier, so the tree this turn opened on no
          // longer holds the contents that would put only this turn back.
          contest(change.path)
          continue
        }
        const known = mine.get(change.path)
        if (known) known.to = change.to
        else mine.set(change.path, { ...change })
      }
    }

    if (contested.size) {
      const named = [...contested].sort()
      const rest = named.length > 1 ? ` (and ${named.length - 1} more)` : ""
      return {
        files: [],
        refused: `Another conversation changed ${named[0]}${rest} while this turn ran, so this turn cannot be taken back on its own.`,
      }
    }

    const changes = [...mine.values()]
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
        // null is how "did not exist" is recorded, which a restore turns back into a deletion.
        files.push({ path: absolute, blob: null })
        continue
      }
      const held = before.get(change.path)
      if (!held) {
        return {
          files: [],
          unavailable: `${change.path} could not be read back, so this turn cannot be taken back.`,
        }
      }
      /*
       * Kept in the store rather than carried in the snapshot. These bodies are
       * already git objects in this very repository - `contents` just read them
       * out of the tree - so writing them back with `hash-object` costs one
       * call and stores nothing twice: the object is already there under the
       * same id, and git recognises it.
       */
      try {
        files.push({ path: absolute, blob: await repo.keep(held) })
      } catch (cause) {
        return {
          files: [],
          unavailable: `${change.path} could not be kept for undo (${reason(cause)}), so this turn cannot be taken back.`,
        }
      }
    }

    /*
     * The turn's size, counted while the trees are still to hand. A failure here
     * costs the figure, never the recording: undo works without a summary.
     */
    let counted: { additions: number; deletions: number } | undefined
    try {
      counted = await repo.numstat(tree, previous)
    } catch {
      counted = undefined
    }
    return { files, ...(counted ?? {}) }
  }
}

/**
 * One file as it stands right now, recorded into a project's checkpoint store.
 *
 * The bytes go to the store and the snapshot keeps the reference. This replaces
 * a reader that returned the whole body: that body then travelled into the
 * conversation's own document and stayed there, which is what made an undo
 * document grow without bound.
 */
export async function keepSnapshotFile(store: Checkpoints, directory: string | undefined, target: string): Promise<SnapshotFile> {
  /*
   * Three answers, not two.
   *
   * This used to be `.catch(() => null)`, and null is what a restore turns back
   * into a deletion. So a file that was merely locked for a blink - the routine
   * Windows EBUSY this project waits out everywhere else - was recorded as
   * "there was no such file before this turn", and the undo the user pressed
   * afterwards **deleted** it, with its contents kept nowhere. Only a genuine
   * ENOENT may say "it did not exist"; anything else is reported up, and the
   * turn is filed as one that cannot be taken back (R25-A1).
   */
  let bytes: Buffer | undefined
  try {
    bytes = await readBytesWaiting(target)
  } catch (cause) {
    return { path: target, unreadable: `${target} could not be read (${reason(cause)})` }
  }
  if (bytes === undefined) return { path: target, blob: null }
  /*
   * Without a project there is no store to put this in, and a turn must never
   * become un-undoable because of where it happened to run: the body is carried
   * in the old shape instead, which every reader still understands. This is the
   * only path that writes an inline body, and nothing reaches it in an ordinary
   * turn, whose project is known before any tool runs.
   */
  if (!directory) return { path: target, ...inline(bytes) }
  return { path: target, blob: await store.keep(directory, bytes) }
}

/**
 * A file's bytes as a JSON document can carry them, for the one case that has
 * nowhere else to put them.
 *
 * Text goes in as text. Anything that is not valid UTF-8 - an icon a build step
 * rewrote, a compiled artefact - goes in as base64, because reading it back
 * through a UTF-8 string would replace every byte it did not understand and
 * restore a corrupted file.
 */
function inline(bytes: Buffer): { content: string; base64?: boolean } {
  const text = bytes.toString("utf8")
  if (Buffer.from(text, "utf8").equals(bytes)) return { content: text }
  return { content: bytes.toString("base64"), base64: true }
}

/** Where a recorded body is fetched from; `Snapshots` is the one that has them. */
export interface Checkpoints {
  keep(directory: string, bytes: Buffer): Promise<string>
  fetch(directory: string, blob: string): Promise<Buffer | undefined>
}

/**
 * The bytes to write back for one recorded file, wherever they are kept.
 *
 * Both shapes are read. An entry carrying a checkpoint reference is fetched
 * from the project's store; one written before the store existed still carries
 * its body, and is decoded exactly as it always was - so a profile nobody has
 * migrated keeps every turn it could take back before.
 *
 * Undefined means the body cannot be found, which the caller has to report
 * rather than write: an empty file in place of a missing one is the one outcome
 * worse than a refusal.
 */
export async function snapshotBytes(store: Checkpoints, directory: string | undefined, file: SnapshotFile): Promise<Buffer | undefined> {
  if (file.blob !== undefined) {
    if (file.blob === null) return Buffer.alloc(0)
    // A reference with no store named is one nothing can answer for; saying so beats writing an empty file.
    if (!directory) return undefined
    return store.fetch(directory, file.blob)
  }
  if (file.content === undefined || file.content === null) return Buffer.alloc(0)
  return Buffer.from(file.content, file.base64 ? "base64" : "utf8")
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
  /**
   * The same repositories, opened as checkpoint stores.
   *
   * Kept apart from `repos` because the two are reached on different terms: a
   * project that is not under git can never be scanned, so `repos` refuses it
   * for good reason, while its turns still have bodies to keep.
   */
  private readonly bares = new Map<string, Promise<Repo>>()
  /** A project's last writer per file, read once and then kept. */
  private readonly ledgers = new Map<string, Promise<Record<string, Writer>>>()
  /** Ledger writes one at a time, so two turns ending together cannot lose one another's entries. */
  private ledgerQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly root: string) {}

  /** A project's name in this app's storage, the same one its shadow repository has. */
  private digest(directory: string): string {
    return createHash("sha1")
      .update(process.platform === "win32" ? directory.toLowerCase() : directory)
      .digest("hex")
  }

  private ledgerFile(directory: string): string {
    return path.join(this.root, `${this.digest(directory)}.writers.json`)
  }

  /**
   * Ledgers whose file could not be read this launch, so nothing is written
   * over them.
   *
   * A read failure used to be answered with `{}` - and that `{}` was cached for
   * the life of the process, so the very next turn wrote it, plus its own
   * paths, over a file holding every other conversation's claims. The guard
   * that refuses an undo because "another conversation has changed X since this
   * turn" then had nothing left to refuse on, and one conversation's undo wrote
   * over another's later work (R25-A5). A file that will not *parse* is still
   * rebuilt from the next turn: that one is derived data with nothing to lose.
   */
  private readonly unreadableLedgers = new Set<string>()

  private ledger(directory: string): Promise<Record<string, Writer>> {
    const file = this.ledgerFile(directory)
    const held = this.ledgers.get(file)
    if (held) return held
    const reading = (async () => {
      let raw: string | undefined
      try {
        raw = await fs.readFile(file, "utf8")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          this.unreadableLedgers.add(file)
          // Not remembered as an answer: the next turn reads again rather than inheriting this blink.
          this.ledgers.delete(file)
          return {}
        }
      }
      if (raw === undefined) return {}
      try {
        const parsed = JSON.parse(raw) as unknown
        return parsed && typeof parsed === "object" ? (parsed as Record<string, Writer>) : {}
      } catch {
        // Derived from the turns themselves; a file that will not parse is
        // rebuilt from the next turn rather than standing in anyone's way.
        return {}
      }
    })()
    this.ledgers.set(file, reading)
    return reading
  }

  /** Records that a conversation's turn left these files as they now stand. */
  async wrote(directory: string, sessionID: string, at: number, files: string[]): Promise<void> {
    if (!files.length) return
    const next = this.ledgerQueue.then(
      () => this.noteWrites(directory, sessionID, at, files),
      () => this.noteWrites(directory, sessionID, at, files),
    )
    this.ledgerQueue = next.catch(() => undefined)
    await next
  }

  private async noteWrites(directory: string, sessionID: string, at: number, files: string[]): Promise<void> {
    const held = await this.ledger(directory)
    // Read but not readable: writing now would replace every other conversation's claim with this one.
    if (this.unreadableLedgers.delete(this.ledgerFile(directory))) return
    for (const file of files) held[pathKey(file)] = { session: sessionID, at }
    const names = Object.keys(held)
    if (names.length > WRITERS_KEPT) {
      // The oldest go first: an undo only ever reaches back through recent turns.
      const oldest = names.sort((a, b) => held[a].at - held[b].at).slice(0, names.length - WRITERS_KEPT)
      for (const name of oldest) delete held[name]
    }
    await writeAtomic(this.ledgerFile(directory), JSON.stringify(held)).catch(() => undefined)
  }

  /**
   * Which of these files another conversation has written since a given moment.
   *
   * This is what lets a refusal be a refusal rather than a guess. A turn's own
   * later work, and the user's own edits, are still written over - that is what
   * "take my last turn back" has to mean. Only a file another conversation
   * wrote afterwards is one this app has no honest way to return, because
   * putting it back would take that conversation's work with it.
   */
  async writtenSince(directory: string, sessionID: string, at: number, files: string[]): Promise<string[]> {
    if (!files.length) return []
    const held = await this.ledger(directory)
    const clashes: string[] = []
    for (const file of files) {
      const writer = held[pathKey(file)]
      if (writer && writer.session !== sessionID && writer.at > at) clashes.push(file)
    }
    return clashes.sort()
  }

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
    return this.bare(directory)
  }

  /**
   * The project's own repository in this app's storage, made if it is not there.
   *
   * Opened without the work-tree check `create` makes, because this is also the
   * checkpoint store. A project that is not itself a repository can be scanned
   * by nothing - which is why `create` refuses it - but its turns are still
   * recorded from what the write tools report, and those bodies have to go
   * somewhere other than the conversation's own document. They go here.
   */
  private async bare(directory: string): Promise<Repo> {
    /*
     * Named for the project rather than for the session: every session open on
     * the same directory shares one index, which is what keeps the scan a stat
     * walk rather than a full read.
     */
    const gitDir = path.join(this.root, this.digest(directory))

    /*
     * The attributes file is written last, so its presence is what says the
     * repository is finished rather than half set up by a run that was killed
     * partway. `git init` on an existing repository only reinitialises it, so
     * repeating the whole sequence is safe.
     */
    if (!(await fs.stat(path.join(gitDir, "info", "attributes")).catch(() => undefined))) {
      /*
       * No sentinel but a folder standing: a set-up or a collection that was
       * interrupted partway (N11-6). `git init` on it would only reinitialise,
       * leaving an index that still names objects the interrupted removal took
       * away - "fatal: bad object" on the very next turn, for good. So whatever
       * is left goes first and the store is built again from nothing.
       */
      await fs.rm(gitDir, { recursive: true, force: true }).catch(() => undefined)
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
   * Removes one project's store: the shadow repository and the ledger beside it.
   *
   * Nothing ever removed these. MiMo's conversation store cascades - deleting a
   * conversation takes everything hanging off it - and its profile carries no
   * equivalent of these repositories at all, while MCode's accumulated for the
   * life of the profile: six of them sat in the profile this was measured in,
   * for two live conversations, holding objects for projects and conversations
   * long since deleted.
   */
  async collect(directory: string): Promise<boolean> {
    const key = process.platform === "win32" ? directory.toLowerCase() : directory
    /*
     * Under the project's own git lock, and only while nothing is recording
     * there (N11-6). The opponent is not another conversation - collection only
     * happens once the last one working here has gone - but the deleted
     * conversation's own just-aborted turn, which is still finishing
     * asynchronously when the delete request returns.
     */
    const open = this.repos.get(key) ?? this.bares.get(key)
    if (open) {
      const repo = await open.catch(() => undefined)
      if (repo && !(await repo.retire())) return false
    }
    this.repos.delete(key)
    this.bares.delete(key)
    this.ledgers.delete(this.ledgerFile(directory))
    const gitDir = path.join(this.root, this.digest(directory))
    /*
     * The sentinel first. `bare()` reads info/attributes as "this repository is
     * finished"; fs.rm's order is its own business, so a removal interrupted
     * partway could leave that file standing over an emptied objects folder,
     * and the next open would hand back a repository that cannot store
     * anything - permanently, since nothing reinitialises it.
     */
    await fs.rm(path.join(gitDir, "info", "attributes"), { force: true }).catch(() => undefined)
    await fs.rm(gitDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(this.ledgerFile(directory), { force: true }).catch(() => undefined)
    return true
  }

  /**
   * Stores belonging to no conversation any more, swept once at start-up.
   *
   * This is what reaches the ones already orphaned, which no deletion can go
   * back and collect. A conversation's `directory` never moves - MiMo's
   * "move to project" changes only the grouping label, and so does this app's -
   * so the live conversations' folders name every store that is still spoken
   * for, and anything else is a project whose conversations have all gone.
   */
  async sweep(live: readonly string[], unreadable: readonly string[] = []): Promise<number> {
    const spokenFor = new Set(live.map((directory) => this.digest(directory)))
    const entries = await fs.readdir(this.root).catch(() => [] as string[])
    /*
     * A conversation whose record could not be read still owns its stores
     * (L12-11): its folder is unknown, but a store whose writers ledger names
     * it is plainly its own, and removing that would take its undo away for
     * good - even after the record is repaired.
     */
    if (unreadable.length) {
      const owners = new Set(unreadable)
      for (const name of entries) {
        if (!name.endsWith(".writers.json")) continue
        const digest = name.slice(0, -".writers.json".length)
        let raw: string
        try {
          raw = await fs.readFile(path.join(this.root, name), "utf8")
        } catch (cause) {
          /*
           * A ledger that cannot be read says nothing about who owns the store,
           * and this pass is the one that deletes stores. Answering "" used to
           * mean the store was spoken for by nobody, so one locked ledger, in
           * the same launch as an unreadable session record, destroyed that
           * conversation's undo bodies for good (R25-A6). Kept instead: a store
           * left behind costs disk, a store deleted costs the work.
           */
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") spokenFor.add(digest)
          continue
        }
        let writers: Record<string, Writer> = {}
        try {
          writers = JSON.parse(raw) as Record<string, Writer>
        } catch {
          // A ledger that will not parse names nobody; it is derived, and the store may go.
        }
        if (Object.values(writers ?? {}).some((writer) => owners.has(writer?.session))) spokenFor.add(digest)
      }
    }
    let removed = 0
    for (const name of entries) {
      const digest = name.endsWith(".writers.json") ? name.slice(0, -".writers.json".length) : name
      // Only this app's own names, so nothing else that finds its way in here is touched.
      if (!/^[0-9a-f]{40}$/.test(digest) || spokenFor.has(digest)) continue
      await fs.rm(path.join(this.root, name), { recursive: true, force: true }).catch(() => undefined)
      removed += 1
    }
    /*
     * Anything held open for a store that has just been removed is dropped with
     * it. A cached repository outliving its directory would go on answering for
     * a git directory that is no longer there, and every command through it
     * would fail - so a project swept and then worked in again would record
     * nothing until the app was restarted. Nothing is cached at start-up, where
     * this runs, but that is a property of the caller rather than of this.
     */
    for (const key of [...this.repos.keys()]) if (!spokenFor.has(this.digest(key))) this.repos.delete(key)
    for (const key of [...this.bares.keys()]) if (!spokenFor.has(this.digest(key))) this.bares.delete(key)
    for (const file of [...this.ledgers.keys()]) {
      const digest = path.basename(file).replace(/\.writers\.json$/, "")
      if (!spokenFor.has(digest)) this.ledgers.delete(file)
    }
    return removed
  }

  /**
   * Repacks the stores of these project folders, once each (L12-13).
   *
   * A store is only ever added to: every turn leaves loose objects, and
   * nothing packed them, so two conversations' stores had reached 7,000 loose
   * objects and 58 MB. MiMo runs `git gc --prune=7.days` over its own hourly;
   * its prune cannot be copied, because every undo body here is unreachable by
   * design, so this packs without ever pruning. A folder with no finished store
   * is skipped rather than given one.
   *
   * @returns how many stores were packed.
   */
  async pack(live: readonly string[]): Promise<number> {
    let packed = 0
    const seen = new Set<string>()
    for (const directory of live) {
      const digest = this.digest(directory)
      if (seen.has(digest)) continue
      seen.add(digest)
      if (!(await fs.stat(path.join(this.root, digest, "info", "attributes")).catch(() => undefined))) continue
      try {
        const key = process.platform === "win32" ? directory.toLowerCase() : directory
        const scanning = await this.repos.get(key)?.catch(() => undefined)
        if (await (await this.checkpoints(directory)).pack(scanning)) packed += 1
      } catch {
        // A store collected or unusable right now is left for the next pass.
      }
    }
    return packed
  }

  /**
   * Keeps one file's bytes in a project's checkpoint store, and hands back the
   * reference a snapshot holds instead of the body.
   *
   * One store per project - the repository undo already keeps for it - so the
   * objects are shared by every conversation working there, and they go when
   * that project's store goes.
   */
  async keep(directory: string, bytes: Buffer): Promise<string> {
    return (await this.checkpoints(directory)).keep(bytes)
  }

  /**
   * What a checkpoint reference stands for, or nothing when the store cannot
   * answer for it.
   *
   * Nothing rather than a throw: the caller has to be able to tell the reader
   * that a particular turn can no longer be put back, which is a sentence, not
   * a failed undo.
   */
  async fetch(directory: string, blob: string): Promise<Buffer | undefined> {
    try {
      return await (await this.checkpoints(directory)).fetch(blob)
    } catch {
      return undefined
    }
  }

  private checkpoints(directory: string): Promise<Repo> {
    const key = process.platform === "win32" ? directory.toLowerCase() : directory
    const existing = this.bares.get(key)
    if (existing) return existing
    // A failure is not cached: git may be installed a minute later, as with `open`.
    const opening = this.bare(directory).catch((cause: unknown) => {
      this.bares.delete(key)
      throw cause
    })
    this.bares.set(key, opening)
    return opening
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
