import path from "node:path"
import { statSync } from "node:fs"
import { spawn as ptySpawn, type IPty } from "@lydell/node-pty"
import { Identifier } from "@shared/id"
import { typedInput } from "@shared/terminal-input"
import type { Bus } from "./bus"
import type { ShellSummary } from "@shared/protocol"

/** How wide and how tall the drawer's grid is, in character cells. */
export interface ShellSize {
  cols: number
  rows: number
}

/**
 * A size to open at before the renderer has measured its own grid.
 *
 * The pty needs a size at spawn, and the shell prints its prompt against
 * whatever it is given. 80x24 is the terminal's own ancient default, so a
 * prompt drawn before the first resize arrives wraps where every other
 * terminal would wrap rather than somewhere arbitrary.
 */
const FALLBACK: ShellSize = { cols: 80, rows: 24 }

/**
 * Whatever opened a shell - in practice the socket the request arrived on.
 *
 * Opaque on purpose: this module has no business knowing what a client is, it
 * only needs to be able to tell two of them apart.
 */
export type ShellOwner = object

/**
 * Interactive shells backing the terminal drawer.
 *
 * These run under a real pty. The alternative - plain pipes - is why this
 * drawer used to open onto a black rectangle: a shell whose stdout is a pipe
 * prints no prompt, echoes nothing back as you type, and leaves every program
 * that asks isatty in its non-interactive mode. Commands still ran; there was
 * simply nothing on screen to say so.
 *
 * The cost is a native module, which is why this was avoided at first.
 * @lydell/node-pty ships prebuilt N-API binaries, so no build toolchain is
 * needed - but they do have to be left outside the asar at packaging time,
 * which is what the asarUnpack entry in electron-builder.yml is for.
 */
/**
 * How much of a shell's output is kept for a pane that comes back.
 *
 * The reference's own number (node-BBwF64dM.js: `BUFFER_LIMIT = 1024 * 1024 *
 * 2`), and it drops the oldest bytes the same way - losing the top of the
 * scrollback rather than the part anyone is reading.
 */
const BUFFER_LIMIT = 1024 * 1024 * 2

/**
 * How many finished shells are kept before the oldest is let go.
 *
 * Also the reference's (`EXITED_LIMIT = 25`). Note what it does NOT cap: shells
 * that are still running. A reader who opens twenty terminals meant to, and
 * each one is a tab they can see; what accumulates without anyone asking is the
 * dead ones, because nothing makes a reader close a tab whose process ended.
 */
const EXITED_LIMIT = 25

interface Running {
  proc: IPty
  sessionID: string
  cwd: string
  owner?: ShellOwner
  /** What it has printed, oldest first, trimmed to BUFFER_LIMIT. */
  output: string[]
  bytes: number
  alive: boolean
  /** Something was typed into it; kept past its exit, as MiMo's userInteracted is. */
  used: boolean
}

/** Time between two kills in a row; see queueKill. */
const KILL_SPACING_MS = 400

export class Shells {
  private readonly shells = new Map<string, Running>()
  /** Finished shells in the order they finished, so the oldest can be let go. */
  private readonly exited: string[] = []
  /** Whoever is waiting for a shell to have ended, by shell id. */
  private readonly exitWaiters = new Map<string, () => void>()

  constructor(private readonly bus: Bus) {}

  open(sessionID: string, cwd: string, chosen?: string, size?: ShellSize, owner?: ShellOwner): string {
    const shellID = Identifier.shell()
    const { command, args } = shellCommand(chosen)
    const grid = usable(size) ? size : FALLBACK

    let proc: IPty
    try {
      /*
       * A working directory that is not there any more.
       *
       * conpty does not fail in a way anyone can catch. ptySpawn returns a
       * handle and starts nothing; the real failure arrives LATER, as an
       * asynchronous throw from the pty's own event target, which the try
       * around this call cannot see. In a packaged build that lands in the
       * main process with nobody listening, so the drawer sits in front of a
       * black rectangle forever - the exact failure the pty work was done to
       * remove. Found by driving the packaged installer against a config whose
       * project directory had been deleted. Checked here, where saying so is
       * still possible, and where the message reaches the pane.
       */
      if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`the working directory no longer exists: ${cwd}`)
      }
      proc = ptySpawn(command, args, {
        name: "xterm-256color",
        cols: grid.cols,
        rows: grid.rows,
        cwd,
        env: environment(),
        ...(process.platform === "win32" ? { useConptyDll: true } : {}),
      })
    } catch (err) {
      /*
       * A shell that will not start is reported into the drawer rather than
       * thrown. The request that opened it has already been answered with an
       * id, and a drawer that stays blank forever is the thing being fixed.
       */
      const reason = err instanceof Error ? err.message : String(err)
      /*
       * Told on the next turn of the loop, not this one.
       *
       * The caller is still inside the request that is about to answer with
       * this id, and the bus reaches the socket immediately - so publishing
       * here sends the failure BEFORE the response, to a window that does
       * not yet know the id and drops both events. The pane then waits in
       * front of a blank rectangle forever, which is the exact failure the
       * pty work was done to remove. A macrotask puts them after the frame.
       */
      setTimeout(() => {
        this.bus.publish({ type: "shell.data", shellID, data: `\r\n[shell error] ${reason}\r\n` })
        this.bus.publish({ type: "shell.exit", shellID, code: null })
      }, 0)
      return shellID
    }

    proc.onData((data) => {
      this.remember(shellID, data)
      this.bus.publish({ type: "shell.data", shellID, data })
    })
    proc.onExit(({ exitCode }) => {
      this.exitWaiters.get(shellID)?.()
      this.exitWaiters.delete(shellID)
      /*
       * Kept rather than dropped. A shell that has ended still has its last
       * words on screen, and a reader who reopens the drawer expects to find
       * them - it is `close` that throws a shell away, not dying.
       */
      const found = this.shells.get(shellID)
      if (found) found.alive = false
      this.exited.push(shellID)
      // Oldest first, so the one a reader is most likely to still care about stays.
      while (this.exited.length > EXITED_LIMIT) {
        const oldest = this.exited.shift()
        if (oldest) this.shells.delete(oldest)
      }
      this.bus.publish({ type: "shell.exit", shellID, code: exitCode })
    })

    this.shells.set(shellID, { proc, sessionID, cwd, owner, output: [], bytes: 0, alive: true, used: false })
    return shellID
  }

  write(shellID: string, data: string): void {
    const found = this.shells.get(shellID)
    if (!found?.alive) return
    // Held here so a pane that comes back still knows to ask before closing.
    if (!found.used && typedInput(data)) found.used = true
    found.proc.write(data)
  }

  /**
   * Tells the shell how big its screen is.
   *
   * Without this a pty keeps whatever size it was opened at, so the shell
   * wraps its lines at eighty columns inside a drawer that is far wider, and
   * anything that redraws itself - a progress bar, an editor, a pager - paints
   * over the wrong cells.
   */
  resize(shellID: string, cols: number, rows: number): void {
    const found = this.shells.get(shellID)
    if (!found?.alive || !usable({ cols, rows })) return
    // A pty that has already exited throws rather than ignoring the call.
    try {
      found.proc.resize(cols, rows)
    } catch {}
  }

  close(shellID: string): void {
    const found = this.shells.get(shellID)
    if (!found) return
    this.shells.delete(shellID)
    const queued = this.exited.indexOf(shellID)
    if (queued >= 0) this.exited.splice(queued, 1)
    if (!found.alive) return
    this.queueKill(found.proc)
  }

  /*
   * Kills one at a time, a little apart. Several conpty shells killed in the
   * same tick - closing three used terminals back to back - crashed Electron
   * in the probe; the same closes spaced out never did. kill() with a signal
   * throws on Windows, so it is always called bare.
   */
  private killQueue: Promise<void> = Promise.resolve()
  private queued = 0

  private queueKill(proc: { kill(): void }): void {
    this.queued += 1
    this.killQueue = this.killQueue
      .then(() => {
        try {
          proc.kill()
        } catch {}
      })
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, KILL_SPACING_MS)))
      .finally(() => {
        this.queued -= 1
      })
  }

  /**
   * Ends every shell, and waits for them to have gone.
   *
   * On Windows a pty still has an exit callback to run after it is killed.
   * Leaving the process straight after the kill ran that callback into a module
   * that was already being torn down, and the prebuilt conpty answered with a
   * native "Assertion failed" dialog on the user's screen. Measured on Windows:
   * the exit arrives about three seconds after the kill however the process is
   * ended, so the bound sits above that. It is still a bound, so a process that
   * will not end cannot hold the app open.
   */
  async closeAll(timeout = 4000): Promise<void> {
    const ending = [...this.shells.entries()]
      .filter(([, entry]) => entry.alive)
      .map(([shellID]) => new Promise<void>((resolve) => this.exitWaiters.set(shellID, resolve)))
    for (const shellID of [...this.shells.keys()]) this.close(shellID)
    if (!ending.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // The kills go out one spacing apart, so the bound waits for the queue too.
    await Promise.race([
      Promise.all(ending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout + this.queued * KILL_SPACING_MS)
      }),
    ])
    clearTimeout(timer)
    this.exitWaiters.clear()
  }

  /**
   * The shells a session is holding, alive or finished.
   *
   * This is what lets the drawer be closed without ending anything: it comes
   * back, asks what is still here, and re-attaches to it. Before this, App.vue
   * unmounting the drawer under `v-if` took every shell with it, so a dev
   * server started in the terminal died the moment the panel was collapsed.
   */
  list(sessionID: string, owner?: ShellOwner): ShellSummary[] {
    const found: ShellSummary[] = []
    for (const [shellID, entry] of this.shells) {
      if (entry.sessionID !== sessionID) continue
      if (owner && entry.owner && entry.owner !== owner) continue
      found.push({ shellID, cwd: entry.cwd, alive: entry.alive, used: entry.used })
    }
    return found
  }

  /** Everything a shell has printed, for a pane that has to redraw itself. */
  attach(shellID: string): { data: string; alive: boolean; used: boolean } | undefined {
    const found = this.shells.get(shellID)
    if (!found) return undefined
    return { data: found.output.join(""), alive: found.alive, used: found.used }
  }

  /** Keeps the tail of what a shell printed, dropping the oldest first. */
  private remember(shellID: string, data: string): void {
    const found = this.shells.get(shellID)
    if (!found) return
    found.output.push(data)
    found.bytes += data.length
    while (found.bytes > BUFFER_LIMIT && found.output.length > 1) {
      found.bytes -= found.output.shift()?.length ?? 0
    }
  }

  /**
   * Ends the shells a departed client opened.
   *
   * A reload is not an unmount, so the pane never gets to close its own shell:
   * the window is torn down and the socket simply goes away. Without this the
   * pty runs until the app quits, and a reader who reloads a few times is
   * carrying that many orphaned shells - measured, not supposed.
   */
  closeOwnedBy(owner: ShellOwner): void {
    for (const [shellID, entry] of [...this.shells.entries()]) {
      if (entry.owner === owner) this.close(shellID)
    }
  }
}

/** A size the pty will accept. Zero or NaN cells crash conpty rather than resize it. */
function usable(size?: ShellSize): size is ShellSize {
  if (!size) return false
  return Number.isFinite(size.cols) && Number.isFinite(size.rows) && size.cols > 0 && size.rows > 0
}

/**
 * The environment an interactive shell is handed.
 *
 * TERM is what tells a program it may use colour and cursor movement at all.
 * The UTF-8 variables are for Windows, where a shell that has not been told
 * otherwise still assumes the legacy code page and prints box-drawing
 * characters and accents as mojibake.
 */
function environment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value
  }
  env.TERM = "xterm-256color"
  env.MCODE_TERMINAL = "1"
  if (process.platform === "win32") {
    env.LC_ALL = "C.UTF-8"
    env.LC_CTYPE = "C.UTF-8"
    env.LANG = "C.UTF-8"
  }
  return env
}

/** Shells whose interactive flags are known, and whether they take -l. */
const KNOWN: Record<string, { login?: boolean }> = {
  bash: { login: true },
  dash: { login: true },
  fish: { login: true },
  ksh: { login: true },
  nu: {},
  powershell: {},
  pwsh: {},
  sh: { login: true },
  zsh: { login: true },
  cmd: {},
}

/** The name a shell is known by, without directory or .exe. */
function shellName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? ""
  return base.replace(/\.exe$/i, "").toLowerCase()
}

/**
 * The interactive shell the terminal drawer opens.
 *
 * A configured shell is honoured when its name is recognised; anything else
 * falls back to the platform's own preference. Note that none of these get the
 * flags the tool's shell gets: a pty hands the shell a real terminal, so it
 * starts interactive on its own, and the flags that used to force that
 * (-NoExit -Command -) instead put PowerShell in a mode that reads a script
 * from stdin and prints no prompt.
 */
function shellCommand(chosen?: string): { command: string; args: string[] } {
  const name = (chosen ?? "").trim()
  const known = KNOWN[shellName(name)]
  if (name && known) return { command: name, args: known.login ? ["-l"] : [] }

  const fallback = preferred()
  return { command: fallback, args: KNOWN[shellName(fallback)]?.login ? ["-l"] : [] }
}

/**
 * The shell to open when the setting names nothing usable.
 *
 * Windows is ordered the way the reference orders it - the newer PowerShell
 * first, then the one every machine has, then git's bash, then whatever
 * COMSPEC points at - because the first two are the only ones on that list
 * that a reader is likely to have configured a prompt in.
 */
function preferred(): string {
  if (process.platform !== "win32") return process.env.SHELL || "/bin/bash"
  return which("pwsh") ?? which("powershell") ?? gitBash() ?? process.env.COMSPEC ?? "cmd.exe"
}

/**
 * git's bundled bash, found by walking up from git itself.
 *
 * The reference goes exactly two directories up and looks in bin/, which holds
 * for the usual install because PATH gets `<root>/cmd/git.exe`. It does not
 * hold when git is found somewhere else in the same install: on this machine
 * PATH carries `<root>/mingw64/bin/git.exe` too, and two up from there is
 * `<root>/mingw64/bin/bash.exe`, which does not exist - so the shell silently
 * became cmd. Walking up until a bin/bash.exe turns up finds the same file
 * from either entry point and stops at the drive root.
 */
function gitBash(): string | undefined {
  const git = which("git")
  if (!git) return undefined
  let dir = path.dirname(git)
  for (let up = 0; up < 4; up += 1) {
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    const bash = path.join(dir, "bin", "bash.exe")
    if (statSync(bash, { throwIfNoEntry: false })?.size) return bash
  }
  return undefined
}

/** The first match for a bare command name on PATH, or undefined. */
function which(command: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const suffixes =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""]
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, command + suffix)
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
    }
  }
  return undefined
}
