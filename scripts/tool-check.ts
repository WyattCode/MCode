/**
 * The tools, driven the way a turn drives them.
 *
 * These are the parts of the app that touch the machine, and the failures worth
 * guarding against are the quiet ones: a command that appears to stop while what
 * it started keeps running, and an edit that silently changes the wrong line.
 * Neither is visible from the interface and neither is a type error.
 */
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import path from "node:path"
import os from "node:os"
import { execSync, spawn } from "node:child_process"
import { Storage } from "../src/server/storage"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { findTool, TOOLS, toolsFor } from "../src/server/tool/registry"
import { Questions } from "../src/server/tool/question"
// plan: the rule the write tools enforce, which is where planning's read-only promise now lives.
import { guardPlanWrite, planFolders, planWritable } from "../src/server/session/plan"
import { ToolError } from "../src/server/tool/types"
import type { ServerEvent } from "../src/shared/protocol"
import { Shells } from "../src/server/shell"

const problems: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "BAD "} ${name}${detail ? " - " + detail : ""}`)
  if (!ok) problems.push(name)
}

/** Whether a process exists, asked without touching it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function reap(pid: number): void {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" })
    else process.kill(pid, "SIGKILL")
  } catch {
    /* already gone */
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-tool-check-"))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })

  const storage = new Storage(path.join(root, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(root, "credentials.json"))
  // A stored config, so the checks run at the default level rather than a first install's 帮我审批.
  await storage.write("config", {})
  await config.load()
  await config.set({ autoApprove: ["bash", "edit", "write", "outside"], directory: project })
  const permissions = new Permissions(bus, config)
  const questions = new Questions(bus)

  /** Everything published while a call ran, so the events can be asserted on. */
  const events: ServerEvent[] = []
  bus.subscribe((event) => events.push(event))

  /** Paths recorded before a tool wrote them - what undo would put back. */
  const recorded: string[] = []

  const context = (signal: AbortSignal, callID = "c1") =>
    ({
      sessionID: "s1",
      messageID: "m1",
      callID,
      directory: project,
      shell: "",
      permissions,
      questions,
      signal,
      progress: () => undefined,
      snapshot: async (target: string) => {
        recorded.push(target)
      },
    }) as never

  const bash = findTool("bash")
  const edit = findTool("edit")
  if (!bash || !edit) throw new Error("the registry is missing a tool this checks")

  /**
   * Runs a command that starts a second process, and hands back that process's
   * pid once it has announced itself.
   */
  const startTree = async (signal: AbortSignal, timeout: number) => {
    const marker = path.join(project, `child-${Math.floor(Date.now() % 100000)}.pid`)
    const script = path.join(project, "long.js")
    await fs.writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))\n` +
        "setInterval(() => {}, 1000)\n",
      "utf8",
    )
    const running = bash.execute({ command: `node "${script}"`, timeout }, context(signal)).catch(() => undefined)
    let pid = 0
    for (let i = 0; i < 60; i += 1) {
      const raw = await fs.readFile(marker, "utf8").catch(() => "")
      if (raw.trim()) {
        pid = Number(raw.trim())
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { pid, running }
  }

  console.log("stopping a command")
  {
    const controller = new AbortController()
    const { pid, running } = await startTree(controller.signal, 60000)
    check("a command can start another process", pid > 0 && alive(pid))
    controller.abort()
    await running
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const survived = pid > 0 && alive(pid)
    check("stopping it takes that process with it", !survived)
    if (survived) reap(pid)
  }

  console.log("a command that runs out of time")
  {
    const controller = new AbortController()
    // Long enough to start, short enough to be killed by the timeout.
    const { pid, running } = await startTree(controller.signal, 3000)
    await running
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const survived = pid > 0 && alive(pid)
    check("timing out takes that process with it", !survived)
    if (survived) reap(pid)
  }

  console.log("editing")
  {
    const target = path.join(project, "twice.txt")
    await fs.writeFile(target, "alpha\nbeta\nalpha\n", "utf8")
    const controller = new AbortController()

    let refused = false
    await edit
      .execute({ file_path: target, old_string: "alpha", new_string: "gamma" }, context(controller.signal))
      .catch(() => (refused = true))
    check("an edit matching twice is refused rather than guessed at", refused)
    check("and the file is untouched", (await fs.readFile(target, "utf8")) === "alpha\nbeta\nalpha\n")

    await edit
      .execute({ file_path: target, old_string: "beta", new_string: "delta" }, context(controller.signal))
      .catch(() => undefined)
    check("an edit matching once lands", (await fs.readFile(target, "utf8")).includes("delta"))
  }

  /*
   * The question tool, driven the way a turn drives it.
   *
   * Everything here is invisible from a type: the tool parks on a promise
   * nothing else resolves, the event that tells the window about it is fired
   * once, and the sentence the model reads back is copied from the reference
   * word for word. A missing `case` in handlers.ts, an event that stops being
   * published, or a reworded output would all compile and all break the
   * feature silently.
   */
  console.log("asking the reader a question")
  {
    /*
     * A read of a path that is not there names its neighbours, the way the
     * reference's ReadTool.miss does: up to three entries of the same directory
     * whose name contains the requested one or is contained by it, without
     * case. A model that asked for `net` beside `net.c` is told; one that asked
     * for something unlike anything there gets the bare message, not a list of
     * everything in the folder.
     */
    console.log("read tells a miss what is nearby")
    {
      const read = findTool("read")
      if (!read) throw new Error("the registry is missing the read tool")
      const nest = path.join(project, "near")
      await fs.mkdir(nest, { recursive: true })
      for (const name of ["net.c", "net.o", "NET.C.bak", "other.c"]) await fs.writeFile(path.join(nest, name), "x", "utf8")
      const controller = new AbortController()
      const miss = async (rel: string) => {
        try {
          await read.execute({ file_path: rel }, context(controller.signal))
          return "(no error)"
        } catch (failure) {
          return (failure as Error).message
        }
      }
      const near = await miss("near/net")
      check("a near miss lists its neighbours", near.includes("Did you mean one of these?"), near)
      const listed = near.split("Did you mean one of these?")[1]?.trim().split(/\r?\n/) ?? []
    check(
      "the list holds exactly the three that match, whatever order the directory hands them out in",
      listed.length === 3 && ["near/net.c", "near/NET.C.bak", "near/net.o"].every((name) => listed.includes(name)),
      near,
    )
      check("and the file that does not match is left out", !near.includes("other.c"), near)
      const far = await miss("near/nothing-like-it.txt")
      check("a miss with no neighbours is the bare message", far === "File not found: near/nothing-like-it.txt", far)
    }

    /*
     * A command that starts another PowerShell must still finish. The tool
     * hands its child no stdin, as the reference does (`stdin: "ignore"`),
     * because a pipe left open is inherited by whatever the command starts, and
     * PowerShell 5.1 with a redirected stdin reads it to EOF before it exits.
     * Under Electron, whose main process has no console, that was a 120s
     * timeout for a Get-Command. It cannot be seen from node.exe at all - a
     * console-subsystem parent gives every child some console, and the nested
     * shell returns in 300ms with or without the fix - so the case runs under
     * Electron itself, in scripts/tool-check-nested-electron.cjs. Verified to
     * report the full timeout with the fix reverted.
     */
    if (process.platform === "win32") {
      console.log("a nested PowerShell exits when the tool's child has no stdin (under Electron)")
      const bundle = path.resolve("out", "tool-check-nested.mjs")
      const verdict = path.join(root, "nested-verdict.txt")
      execSync(
        `npx esbuild scripts/tool-check-nested.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --packages=external --outfile=${JSON.stringify(bundle)}`,
        { stdio: "ignore" },
      )
      const electron = createRequire(import.meta.url)("electron") as unknown as string
      const child = spawn(electron, [path.resolve("scripts", "tool-check-nested-electron.cjs"), bundle, verdict, project], {
        // Electron gets an open pipe for stdin that this side never closes -
        // the shape it has when launched from a terminal with `&`, which is how
        // the hang was hit. With "ignore" here it cannot be reproduced at all.
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      })
      const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)))
      const said = await fs.readFile(verdict, "utf8").catch(() => "")
      const elapsed = Number(/^(?:done|failed) (\d+)/.exec(said)?.[1] ?? -1)
      check("the nested shell came back", said.startsWith("done"), said.trim().slice(0, 300))
      check("and well inside its timeout", elapsed >= 0 && elapsed < 4000, `${elapsed}ms`)
      check("electron exited cleanly", code === 0, String(code))
    }

    const question = findTool("question")
    if (!question) throw new Error("the registry is missing the question tool")

    check(
      "the question tool is offered to the model",
      TOOLS.some((tool) => tool.name === "question"),
    )

    const controller = new AbortController()
    events.length = 0
    const running = question.execute(
      {
        questions: [
          {
            question: "Which way?",
            header: "Direction",
            options: [
              { label: "Left", description: "towards the river" },
              { label: "Right", description: "towards the hill" },
            ],
          },
          {
            question: "How fast?",
            header: "Speed",
            options: [{ label: "Slow", description: "carefully" }],
          },
        ],
      },
      context(controller.signal, "call-q1"),
    )

    // Published synchronously by `ask`, so it is already there.
    const asked = events.find((event) => event.type === "question.asked")
    check("asking publishes question.asked", asked !== undefined)
    check(
      "and names the call it came from, so the form can find its card",
      asked?.type === "question.asked" && asked.request.tool?.callID === "call-q1",
    )

    const parked = questions.outstanding()
    check("a reloaded window can list what is parked", parked.length === 1, String(parked.length))

    const id = parked[0]?.id ?? ""
    check("replying to an unknown request is refused, not silently accepted", !questions.reply("nope", []))

    check("replying to a parked question is accepted", questions.reply(id, [["Left"], []]))
    const result = await running

    check(
      "the model is told the answers in the reference's own words",
      result.output ===
        'User has answered your questions: "Which way?"="Left", "How fast?"="Unanswered". ' +
          "You can now continue with the user's answers in mind.",
      result.output,
    )
    check("a skipped question reads as Unanswered", result.output.includes('"How fast?"="Unanswered"'))
    check(
      "the answers are stored on the part so the card can redraw",
      JSON.stringify(result.metadata?.answers) === '[["Left"],[]]',
      JSON.stringify(result.metadata?.answers),
    )
    check("and nothing stays parked", questions.outstanding().length === 0)
    check(
      "the reply is announced, so a second window closes its copy",
      events.some((event) => event.type === "question.replied"),
    )
  }

  console.log("a question the reader dismisses")
  {
    const question = findTool("question")!
    const controller = new AbortController()
    const running = question
      .execute(
        { questions: [{ question: "Go on?", header: "Go on", options: [{ label: "Yes", description: "" }] }] },
        context(controller.signal, "call-q2"),
      )
      .then(
        () => "resolved",
        (err: Error) => err.message,
      )

    const id = questions.outstanding()[0]?.id ?? ""
    check("dismissing a parked question is accepted", questions.reject(id))
    check(
      "and the model is told in the reference's own words",
      (await running) === "The user dismissed this question",
      await running,
    )
    check("nothing stays parked after a dismissal", questions.outstanding().length === 0)
  }

  console.log("a question left standing when the turn is stopped")
  {
    const question = findTool("question")!
    const controller = new AbortController()
    const running = question
      .execute(
        { questions: [{ question: "Wait?", header: "Wait", options: [{ label: "Yes", description: "" }] }] },
        context(controller.signal, "call-q3"),
      )
      .then(
        () => "resolved",
        (err: Error) => err.message,
      )
    check("it is parked", questions.outstanding().length === 1)
    /*
     * Stop is the one path that can leave a question with nobody to answer it.
     * Without this the promise never settles, the turn never ends and the
     * session reports itself busy for the life of the process.
     */
    controller.abort()
    check("stopping the turn settles it", (await running) === "The user dismissed this question", await running)
    check("and it is no longer listed", questions.outstanding().length === 0)
  }

  /*
   * Which tools a model is given. MiMo's desktop runs its engine with codex
   * mode off, so every model - GPT included - edits with `edit` and `write`.
   */
  console.log("the tool surface")
  {
    const names = (agent: string) => toolsFor(agent).map((tool) => tool.name)
    const build = names("build")
    check("every model is given edit and write", build.includes("edit") && build.includes("write"), build.join(","))
    check("and never apply_patch", !build.includes("apply_patch") && findTool("apply_patch") === undefined)

    /*
     * plan: round six gave planning its tools back, so this checks the promise
     * where it is now kept.
     *
     * What stood here - "plan gets no way to write at all" - described the old
     * shape, a shorter tool list. MiMo's plan agent keeps every tool and is held
     * to reading by one rule the write tools enforce (`guardPlanWrite`), which
     * is what lets a planning turn run `git log` and write the plan down
     * somewhere the user can keep. The promise is unchanged; taking the tools
     * away was never what made it true, so asserting their absence was
     * asserting the implementation rather than the behaviour.
     */
    const plan = names("plan")
    check("plan keeps the write tools, as MiMo's plan agent does", plan.includes("edit") && plan.includes("write"), plan.join(","))
    check("but keeps the question tool", plan.includes("question"))

    const planPath = path.join(project, ".mcode", "plans", "1-clear-beacon.md")
    const planning = {
      agent: "plan",
      switched: false,
      file: planPath,
      writable: (target: string) => planWritable(target, planFolders({ directory: project, dataRoot: root, repo: true })),
      approve: async () => undefined,
    }
    /** What the guard refuses a write with, or nothing when it lets it through. */
    const guarded = (target: string, control: typeof planning): string | undefined => {
      try {
        guardPlanWrite({ directory: project, plan: control } as never, target, target)
        return undefined
      } catch (failure) {
        return failure instanceof ToolError ? (failure.code ?? "no code") : "not a ToolError"
      }
    }
    const elsewhere = path.join(project, "src", "app.ts")
    check("...and the write tools refuse everything but the plan file", guarded(elsewhere, planning) === "tool.err.planOnly", guarded(elsewhere, planning))
    check("the plan itself is written", guarded(planPath, planning) === undefined, guarded(planPath, planning))
    check(
      "a turn that began planning stays read-only after the plan is approved",
      guarded(elsewhere, { ...planning, switched: true }) === "tool.err.planApproved",
      guarded(elsewhere, { ...planning, switched: true }),
    )
    check("and a building conversation is not held to it", guarded(elsewhere, { ...planning, agent: "build" }) === undefined)

    check("the model is never offered the invalid tool", !build.includes("invalid"))
    check("though a call can still be routed to it", findTool("invalid") !== undefined)
  }

  console.log("a call that could not be dispatched")
  {
    const invalid = findTool("invalid")!
    const controller = new AbortController()
    const result = await invalid.execute(
      { tool: "Reed", error: "Model tried to call unavailable tool 'Reed'." },
      context(controller.signal, "call-i1"),
    )
    check(
      "invalid explains itself in the reference's words",
      result.output === "The arguments provided to the tool are invalid: Model tried to call unavailable tool 'Reed'.",
      result.output,
    )
    check("and titles the card the way the reference does", result.title === "Invalid Tool", result.title)
  }

  console.log("\nthe three defects a second read found")
  {
    /*
     * 1. A question asked on a turn that has ALREADY been stopped.
     *
     * An AbortSignal that has fired does not fire again for a listener attached
     * afterwards, so the guard inside `ask` has to be an up-front test rather
     * than only a listener. Without it the promise never settles: the turn sits
     * parked forever with a form on screen asking the reader to answer
     * something they had just stopped. The window is real - runTool awaits a
     * permission check before it calls execute, and Stop can land inside it.
     */
    const questions = new Questions(new Bus())
    const stopped = new AbortController()
    stopped.abort()
    let settled = "never"
    await Promise.race([
      questions
        .ask({
          sessionID: "ses_review",
          questions: [{ question: "q", header: "h", options: [{ label: "a", description: "b" }] }],
          signal: stopped.signal,
        })
        .then(
          () => (settled = "resolved"),
          () => (settled = "rejected"),
        ),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ])
    check("a question asked after Stop settles rather than parking", settled === "rejected", settled)
    check("and nothing is left outstanding for it", questions.outstanding().length === 0, String(questions.outstanding().length))
  }

  {
    /*
     * 2. A shell that cannot start must still be able to say so.
     *
     * The bus reaches the socket the moment it is published, and `open` is
     * called from inside the request that is about to answer with the id. So a
     * failure published synchronously arrives BEFORE the response, at a window
     * that does not yet know the id and drops it - leaving the pane in front of
     * a blank rectangle with no explanation, which is the very failure the pty
     * work was done to remove. The events have to come after the frame.
     */
    const bus = new Bus()
    const seen: string[] = []
    bus.subscribe((event) => {
      if (event.type === "shell.data" || event.type === "shell.exit") seen.push(event.type)
    })
    const shells = new Shells(bus)
    /*
     * A shell that genuinely cannot start, so the catch above is the path
     * taken. The name has to be one shellCommand RECOGNISES - an unknown one
     * falls back to the platform default and starts fine - so this is a bash
     * at a path that is not there. A first attempt at this assertion opened the
     * default shell instead, which succeeds, and so proved nothing at all.
     */
    const missing = process.platform === "win32" ? "C:/nowhere/at/all/bash.exe" : "/nowhere/at/all/bash"
    const id = shells.open("ses_review", os.tmpdir(), missing, { cols: 80, rows: 24 })
    check("a shell that cannot start still answers with an id", typeof id === "string" && id.length > 0)
    // Whether it started or not, nothing may have been said before this line.
    check("and says nothing before the caller has that id", seen.length === 0, seen.join(","))
    shells.close(id)
  }

  /*
   * R16-B11: which language the tool surface is written in.
   *
   * Round 16 moved MCode's guards into Chinese because MiMo's are. Its tool
   * descriptions are NOT: every tool the desktop adds to its engine
   * (present_files, get_desktop_settings, the session-chat tools) describes
   * itself in English and only its run-time messages are Chinese. That is a
   * deliberate line, so it is asserted from both sides rather than left to
   * drift with whoever edits a tool next.
   */
  {
    const han = /[\u4e00-\u9fff]/
    const described = TOOLS.map((tool) => ({ name: tool.name, text: `${tool.description}${JSON.stringify(tool.parameters)}` }))
    const chinese = described.filter((tool) => han.test(tool.text)).map((tool) => tool.name)
    check("every tool describes itself and its arguments in English, as MiMo's do", chinese.length === 0, chinese.join(", "))
    check("and there are tools to have checked", described.length > 10, String(described.length))
  }

  console.log("")
  if (problems.length) {
    console.error(`FAILED with ${problems.length} problem(s):`)
    for (const problem of problems) console.error("  " + problem)
    process.exit(1)
  }
  console.log(
    "A stopped command takes its children with it, an ambiguous edit is refused, " +
      "and a question survives a reload.",
  )
  process.exit(0)
}

void main()
