import "./fenced-home"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { ABORTED_TOOL } from "../src/server/provider/history"
import { BashTool } from "../src/server/tool/bash"
import { ToolError, type ToolContext } from "../src/server/tool/types"

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-shellfs-cancel-"))
  const controller = new AbortController()
  let stoppedDuringPreparation = false

  const context = {
    directory,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    sessionID: "ses_shellfs",
    messageID: "msg_shellfs",
    callID: "call_shellfs_cancel",
    signal: controller.signal,
    permissions: {
      ask: async () => {
        // The first microtask queues Stop behind the continuation of the approved ask.
        queueMicrotask(() => queueMicrotask(() => {
          stoppedDuringPreparation = true
          controller.abort()
        }))
      },
    },
    progress: () => {},
  } as unknown as ToolContext

  try {
    const result = await BashTool.execute({ command: "echo ran > spawned.txt", timeout: 2000 }, context).catch((error: unknown) => error)
    const spawned = await fs.stat(path.join(directory, "spawned.txt")).then(() => true, () => false)
    const aborted = result instanceof ToolError && result.message === ABORTED_TOOL
    const ok = stoppedDuringPreparation && !spawned && aborted
    console.log(`  ${ok ? "ok  " : "FAIL"} Stop during environment preparation prevents spawn -> ${JSON.stringify({ stoppedDuringPreparation, spawned, aborted })}`)
    if (!ok) process.exitCode = 1
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
