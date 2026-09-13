/**
 * The terminal drawer's shell, driven the way the drawer drives it.
 *
 * The defect this guards against left no trace anywhere else: the drawer opened,
 * xterm laid itself out correctly, commands really ran - and the screen stayed
 * black, because a shell whose output is a pipe prints no prompt and echoes
 * nothing back as it is typed. Every other check passed throughout. The two
 * assertions that would have caught it are the two that need no input at all:
 * something arrives before anything is typed, and what is typed comes back.
 */
import os from "node:os"
import path from "node:path"
import { statSync } from "node:fs"
import { Bus } from "../src/server/bus"
import { Shells } from "../src/server/shell"
import type { ServerEvent } from "@shared/protocol"

const problems: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "BAD "} ${name}${detail ? " - " + detail : ""}`)
  if (!ok) problems.push(name)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Two sessions, because a shell belongs to one and must not be offered to the other. */
const SESSION = "ses_shellcheck_one"
const OTHER = "ses_shellcheck_two"

/**
 * What a reader would actually see, with the control sequences taken out.
 *
 * This matters more than it looks. Conpty answers a new pty with a 23-byte
 * handshake - a window-size report and two mode switches - before the shell
 * behind it has started, so "has it printed anything at all" is satisfied
 * while the screen is still blank. Only visible characters mean a prompt.
 */
function visible(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // window title and other OSC strings
    .replace(/\x1b[[\]()#;?]*[0-9;]*[A-Za-z]/g, "") // CSI and friends
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim()
}

/** The first match for a bare command on PATH - the check's own copy, so it tests rather than trusts. */
function onPath(command: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const suffixes =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""]
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, command + suffix)
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
    }
  }
  return undefined
}

/**
 * git's bash, looked for from both entry points.
 *
 * Deliberately not the module's own gitBash(): a check that reuses the code it
 * is checking agrees with it whether or not either is right. This walks up
 * from git the same way, but the point is that it is written twice.
 */
function gitBashHere(): string | undefined {
  const git = onPath("git")
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

/** Collects what a shell prints, the way the pane collects it. */
function watch(bus: Bus): { text: (id: string) => string; exited: (id: string) => boolean } {
  const data = new Map<string, string[]>()
  const gone = new Set<string>()
  bus.subscribe((event: ServerEvent) => {
    if (event.type === "shell.data") data.set(event.shellID, [...(data.get(event.shellID) ?? []), event.data])
    if (event.type === "shell.exit") gone.add(event.shellID)
  })
  return {
    text: (id) => (data.get(id) ?? []).join(""),
    exited: (id) => gone.has(id),
  }
}

/**
 * Waits for a shell to say something, or gives up.
 *
 * PowerShell takes about three seconds to print its banner on a cold start, so
 * a check that waited a fixed second would fail on a slow machine and pass on a
 * fast one. This waits for the condition instead, up to a generous ceiling.
 */
async function until(condition: () => boolean, ceiling = 25_000): Promise<boolean> {
  const deadline = Date.now() + ceiling
  while (Date.now() < deadline) {
    if (condition()) return true
    await wait(200)
  }
  return condition()
}

async function main(): Promise<void> {
  const bus = new Bus()
  const seen = watch(bus)
  const shells = new Shells(bus)

  console.log("\nA shell that has a terminal to print to")
  {
    const id = shells.open(SESSION, os.tmpdir(), undefined, { cols: 120, rows: 30 })

    /*
     * The whole defect, in one assertion. A pipe-backed shell reaches this
     * point having printed nothing a reader can see, and stays that way.
     */
    const spoke = await until(() => visible(seen.text(id)).length > 0)
    check("prints something readable before anything is typed", spoke, JSON.stringify(visible(seen.text(id)).slice(-70)))

    const prompt = visible(seen.text(id))
    check(
      "and it is a prompt rather than a failure to start",
      prompt.length > 0 && !seen.text(id).includes("[shell error]"),
    )

    const before = seen.text(id).length
    shells.write(id, "echo mcode-shell-check")
    const echoed = await until(() => seen.text(id).slice(before).includes("mcode-shell-check"))
    check("echoes what is typed, before it is even run", echoed)

    shells.write(id, "\r")
    const ran = await until(() => {
      const after = seen.text(id).slice(before)
      // Twice: once as the echo, once as the command's own output.
      return after.split("mcode-shell-check").length > 2
    })
    check("and runs it when the line is entered", ran)

    shells.close(id)
    check("closing it ends the process", await until(() => seen.exited(id)))
  }

  console.log("\nBeing told how big the screen is")
  {
    const id = shells.open(SESSION, os.tmpdir(), undefined, { cols: 100, rows: 24 })
    await until(() => seen.text(id).length > 0)

    let threw = false
    try {
      shells.resize(id, 160, 48)
    } catch {
      threw = true
    }
    check("a live shell accepts a new size", !threw)

    // A size of zero cells is what a hidden pane measures, and it crashes conpty.
    let zeroThrew = false
    try {
      shells.resize(id, 0, 0)
    } catch {
      zeroThrew = true
    }
    check("a size of no cells is refused rather than passed on", !zeroThrew)

    shells.close(id)
    await until(() => seen.exited(id))

    let afterThrew = false
    try {
      shells.resize(id, 80, 24)
    } catch {
      afterThrew = true
    }
    check("resizing one that has already gone does nothing", !afterThrew)
  }

  console.log("\nThe shells a reader can choose in settings")
  {
    /*
     * Each of these is a separate branch of shellCommand, and each used to be
     * handed flags that made sense for a pipe. A chosen shell that opens onto
     * a black rectangle is the same defect as the default one doing it, just
     * behind a setting - so every branch a reader can select is opened here.
     */
    const candidates: Array<{ name: string; file: string }> = []
    if (process.platform === "win32") {
      candidates.push({ name: "cmd", file: process.env.COMSPEC ?? "cmd.exe" })
      const powershell = onPath("powershell")
      if (powershell) candidates.push({ name: "powershell", file: powershell })
      const pwsh = onPath("pwsh")
      if (pwsh) candidates.push({ name: "pwsh", file: pwsh })
      const bash = gitBashHere()
      if (bash) candidates.push({ name: "git bash", file: bash })
    } else {
      for (const file of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
        if (statSync(file, { throwIfNoEntry: false })) candidates.push({ name: path.basename(file), file })
      }
    }

    // Never quietly cover less than it looks like: say what is not here.
    for (const missing of ["pwsh", "git bash"]) {
      if (process.platform === "win32" && !candidates.some((c) => c.name === missing)) {
        console.log(`  --   ${missing} is not installed on this machine, so that branch is untested here`)
      }
    }

    for (const candidate of candidates) {
      const id = shells.open(SESSION, os.tmpdir(), candidate.file, { cols: 100, rows: 30 })
      const spoke = await until(() => visible(seen.text(id)).length > 0)
      check(
        `${candidate.name}, chosen by name, opens onto a prompt`,
        spoke,
        JSON.stringify(visible(seen.text(id)).slice(-52)),
      )
      shells.close(id)
      await until(() => seen.exited(id))
    }
  }

  console.log("\nWhen the window that opened them goes away")
  {
    /*
     * A reload is not an unmount: the pane never gets its onBeforeUnmount, so
     * nothing on the renderer's side closes its shells. Measured before this
     * was handled - one reload with the drawer open left a powershell running
     * until the app quit, and every further reload added another. The socket
     * closing is the only signal that survives a reload, so the shells are
     * owned by whoever asked for them.
     */
    const windowA = { name: "a" }
    const windowB = { name: "b" }
    const mine = shells.open(SESSION, os.tmpdir(), undefined, { cols: 80, rows: 24 }, windowA)
    const theirs = shells.open(SESSION, os.tmpdir(), undefined, { cols: 80, rows: 24 }, windowB)
    await until(() => visible(seen.text(mine)).length > 0 && visible(seen.text(theirs)).length > 0)

    shells.closeOwnedBy(windowA)
    check("the departed window's shell is ended", await until(() => seen.exited(mine)))
    check(
      "and another window's shell is left alone",
      !seen.exited(theirs),
      seen.exited(theirs) ? "it was killed too" : "still running",
    )

    shells.closeOwnedBy(windowB)
    check("until that window goes too", await until(() => seen.exited(theirs)))

    // An owner nothing belongs to must not be an error, and must not be a sweep.
    const orphan = shells.open(SESSION, os.tmpdir(), undefined, { cols: 80, rows: 24 })
    await until(() => visible(seen.text(orphan)).length > 0)
    shells.closeOwnedBy({ name: "never opened anything" })
    check("an unknown owner closes nothing", !seen.exited(orphan))
    shells.close(orphan)
    await until(() => seen.exited(orphan))
  }

  console.log("\nShells that outlive the drawer")
  {
    /*
     * The drawer is mounted under `v-if`, so putting the panel away unmounts
     * every pane. Ending the shells there killed a dev server for each; now
     * the backend keeps them and the drawer asks what is still running. These
     * are the two calls that make that possible.
     */
    const mine = shells.open(SESSION, os.tmpdir(), undefined, { cols: 90, rows: 24 })
    const elsewhere = shells.open(OTHER, os.tmpdir(), undefined, { cols: 90, rows: 24 })
    await until(() => visible(seen.text(mine)).length > 0 && visible(seen.text(elsewhere)).length > 0)

    const listed = shells.list(SESSION)
    check("a session lists its own shell", listed.some((entry) => entry.shellID === mine))
    check(
      "and not another session's",
      !listed.some((entry) => entry.shellID === elsewhere),
      listed.map((entry) => entry.shellID).join(", "),
    )
    check("which it reports as alive", listed.find((entry) => entry.shellID === mine)?.alive === true)
    check(
      "and says which directory it runs in",
      listed.find((entry) => entry.shellID === mine)?.cwd === os.tmpdir(),
      listed.find((entry) => entry.shellID === mine)?.cwd,
    )

    // What a pane coming back would redraw itself from.
    const replay = shells.attach(mine)
    check("attaching gives back what it printed", Boolean(replay && visible(replay.data).length > 0))
    check("and says it is still running", replay?.alive === true)
    check("attaching to a shell that never existed answers nothing", shells.attach("shl_nope") === undefined)

    // A shell that ends keeps its last words rather than vanishing.
    shells.write(mine, "exit\r")
    const ended = await until(() => seen.exited(mine))
    check("a shell that exits is reported", ended)
    const after = shells.list(SESSION).find((entry) => entry.shellID === mine)
    check("but stays listed, marked not alive", after !== undefined && after.alive === false)
    check("with its output still readable", Boolean(shells.attach(mine)?.data.length))

    shells.close(mine)
    check("closing it is what takes it off the list", !shells.list(SESSION).some((e) => e.shellID === mine))
    shells.close(elsewhere)
    await until(() => seen.exited(elsewhere))
  }

  console.log(String.fromCharCode(10) + "A working directory that is no longer there")
  {
    /*
     * The project was moved or deleted while the app still points at it. conpty
     * answers ptySpawn with a handle, starts nothing, prints nothing and throws
     * nothing - so without a check the drawer waits in front of a black
     * rectangle with no explanation, which is the failure this whole file
     * exists to prevent. Found by driving the PACKAGED build against a config
     * whose directory had gone.
     */
    const gone = path.join(os.tmpdir(), "mcode-not-a-directory-" + String(process.pid))
    const id = shells.open(SESSION, gone, undefined, { cols: 80, rows: 24 })
    const spoke = await until(() => seen.text(id).length > 0, 8000)
    check("it says so rather than opening onto nothing", spoke, JSON.stringify(seen.text(id).trim().slice(0, 90)))
    check("and names the directory", seen.text(id).includes(gone), gone)
    check("and the shell is reported as over", await until(() => seen.exited(id), 8000))
    shells.close(id)
  }

  console.log("\nA shell that cannot start")
  {
    const id = shells.open(SESSION, os.tmpdir(), "definitely-not-a-shell-here")
    /*
     * An unknown name is not honoured - it falls back to the platform's own
     * shell - so this must still open. The drawer has already been handed an
     * id by the time anything could go wrong, and a drawer that opens onto
     * nothing at all is the failure being guarded against.
     */
    const spoke = await until(() => visible(seen.text(id)).length > 0)
    check("an unrecognised shell name falls back rather than opening onto nothing", spoke)
    shells.close(id)
    await until(() => seen.exited(id))
  }

  await shells.closeAll()

  console.log("")
  if (problems.length) {
    console.error(`FAILED with ${problems.length} problem(s):`)
    for (const problem of problems) console.error("  " + problem)
    process.exit(1)
  }
  console.log("The drawer opens onto a real terminal: it prompts unprompted, echoes, and can be told its size.")
  process.exit(0)
}

void main()
