/**
 * Round 15 (lane T): the tool, MCP, cron and shell fixes, measured against the
 * real code - a stub server started the way a published MCP server is started,
 * a scheduler over a throwaway project, and the tools themselves with a
 * permission gate that records what it was asked. Kept apart from smoke.ts the
 * way the earlier rounds are; smoke.ts calls `roundFifteenToolChecks` with its
 * own check and section.
 */
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionInfo } from "@shared/protocol"
import type { Check } from "./smoke-round5"
import { terminate, windowsLaunch } from "../src/server/mcp-launch"
import { liveProbes, probeTools } from "../src/server/mcp-probe"
import { CronScheduler, bindScheduler } from "../src/server/cron/scheduler"
import { cronFile } from "../src/server/cron/tasks"
import { CronTool } from "../src/server/tool/cron"
import { CreateSessionTool } from "../src/server/tool/session-chat"
import { BashTool, liveBashCommands } from "../src/server/tool/bash"
import type { ToolContext } from "../src/server/tool/types"

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Waits for a process to go, so a kill that is on its way is not read as one that never happened. */
async function gone(pid: number, within = 5000): Promise<boolean> {
  for (let waited = 0; waited < within; waited += 100) {
    if (!alive(pid)) return true
    await wait(100)
  }
  return !alive(pid)
}

/** A permission gate that answers as told and keeps what it was asked. */
function gate(answer: "allow" | "deny" = "allow") {
  const asked: { kind: string; scope?: string; subject?: string }[] = []
  const permissions = {
    allowsOutside: () => false,
    async ask(request: { kind: string; scope?: string; subject?: string }) {
      asked.push({ kind: request.kind, scope: request.scope, subject: request.subject })
      if (answer === "deny") throw new Error(`refused: ${request.kind}`)
    },
  }
  return { asked, permissions: permissions as unknown as ToolContext["permissions"] }
}

function toolContext(directory: string, permissions: ToolContext["permissions"], extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "ses_t15",
    messageID: "msg_t15",
    callID: "call_t15",
    directory,
    permissions,
    signal: new AbortController().signal,
    progress: () => {},
    snapshot: async () => {},
    ...extra,
  } as unknown as ToolContext
}

const session = (id: string, directory: string) => ({ id, directory, title: id, model: "m", createdAt: 0, updatedAt: 0 }) as unknown as SessionInfo

export async function roundFifteenToolChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r15t-"))

  // ---------------------------------------------------------------- T15-1
  if (process.platform === "win32") {
    section("Round 15 (T15-1): a local MCP server started through cmd.exe is stopped with the tree under it")
    /*
     * The npx-style case: the command is a .cmd, so it runs under a cmd.exe of
     * its own and the server is that shell's child. The stub writes its pid
     * down, ignores its input closing and never answers, which is what a server
     * holding a port looks like from here.
     */
    const stubs = path.join(root, "mcp-stub")
    await fs.mkdir(stubs, { recursive: true })
    const script = path.join(stubs, "server.js")
    const launcher = path.join(stubs, "server.cmd")
    const pidFile = (name: string) => path.join(stubs, `${name}.pid`)
    await fs.writeFile(
      script,
      [
        "const fs = require('node:fs')",
        "fs.writeFileSync(process.argv[2], String(process.pid))",
        "process.stdin.resume()",
        "process.stdin.on('end', () => {})",
        "setInterval(() => {}, 1000)",
        "",
      ].join("\n"),
    )
    await fs.writeFile(launcher, ["@echo off", `node "${script}" %*`, ""].join("\r\n"))

    /** The pid the stub wrote, once it is there. */
    const startedPid = async (name: string): Promise<number> => {
      for (let waited = 0; waited < 20_000; waited += 100) {
        const text = await fs.readFile(pidFile(name), "utf8").catch(() => undefined)
        if (text && Number.isInteger(Number(text))) return Number(text)
        await wait(100)
      }
      return 0
    }

    const launch = windowsLaunch(launcher, [pidFile("terminate")])
    check("a .cmd server is launched through cmd.exe, so kill() alone would only reach the shell", launch.command === "cmd.exe" && launch.verbatim)
    const child = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: launch.verbatim })
    const served = await startedPid("terminate")
    check("the stub server is running under that shell", served > 0 && alive(served))
    await terminate(child, 300)
    const stopped = await gone(served)
    check("terminate() ends the server itself, not only the cmd.exe wrapper", stopped, { pid: served })
    if (!stopped) process.kill(served, "SIGKILL")

    const probed = await probeTools({ type: "local", command: [launcher, pidFile("probe")] } as never, { timeoutMs: 1500 })
    const probedPid = await startedPid("probe")
    check("a probe of a server that never answers gives up in words", "error" in probed && probed.error.includes("no answer"), probed)
    const reaped = await gone(probedPid)
    check("and the server it started is reaped, though nothing else holds it", reaped, { pid: probedPid })
    if (!reaped) process.kill(probedPid, "SIGKILL")
    check("no probe is left registered as running", liveProbes() === 0)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
}
