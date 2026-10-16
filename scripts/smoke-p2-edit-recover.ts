import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EditTool, WriteTool } from "../src/server/tool/edit"
import { recordRead } from "../src/server/tool/read-tracker"
import { ToolError } from "../src/server/tool/types"

let passed = 0
let failed = 0

function check(name: string, ok: boolean): void {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    console.error(`failed ${name}`)
  }
}

async function toolError(fn: () => Promise<unknown>): Promise<ToolError | undefined> {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error instanceof ToolError ? error : undefined
  }
}

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-p2-edit-recover-"))
  const sessionID = `p2-edit-recover-${Date.now()}`
  const context = {
    sessionID,
    directory: tempDir,
    messageID: "message",
    callID: "call",
    permissions: { ask: async () => undefined },
    questions: { ask: async () => [] },
    signal: new AbortController().signal,
    progress() {},
    snapshot: async () => undefined,
  } as any

  try {
    const unreadFile = path.join(tempDir, "unread.txt")
    const unreadOriginal = "alpha\nbeta\ngamma\n"
    await fs.writeFile(unreadFile, unreadOriginal, "utf8")

    const firstEdit = await toolError(() =>
      EditTool.execute({ file_path: unreadFile, old_string: "beta", new_string: "BETA" }, context),
    )
    check("unread edit throws ToolError", firstEdit !== undefined)
    check("unread edit says not read", firstEdit?.message.includes("has not been read") === true)
    check("unread edit shows current contents", firstEdit?.message.includes("2: beta") === true)
    check("unread edit leaves file unchanged", (await fs.readFile(unreadFile, "utf8")) === unreadOriginal)

    let retryEditOk = true
    try {
      await EditTool.execute({ file_path: unreadFile, old_string: "beta", new_string: "BETA" }, context)
    } catch {
      retryEditOk = false
    }
    check("unread edit succeeds after recovery", retryEditOk)
    check("unread file changed after recovery", (await fs.readFile(unreadFile, "utf8")).includes("BETA"))

    const staleFile = path.join(tempDir, "stale.txt")
    const staleOriginal = "one\ntwo\nthree\n"
    const staleChanged = "one\nTWO\nthree\nfour\n"
    await fs.writeFile(staleFile, staleOriginal, "utf8")
    recordRead(sessionID, staleFile, await fs.stat(staleFile), staleOriginal)
    await fs.writeFile(staleFile, staleChanged, "utf8")

    const staleEdit = await toolError(() =>
      EditTool.execute({ file_path: staleFile, old_string: "TWO", new_string: "two" }, context),
    )
    check("stale edit throws ToolError", staleEdit !== undefined)
    check("stale edit says changed", staleEdit?.message.includes("has changed since you last read it") === true)
    check("stale edit shows new contents", staleEdit?.message.includes("2: TWO") === true)
    check("stale edit leaves file unchanged", (await fs.readFile(staleFile, "utf8")) === staleChanged)

    let retryStaleOk = true
    try {
      await EditTool.execute({ file_path: staleFile, old_string: "TWO", new_string: "two" }, context)
    } catch {
      retryStaleOk = false
    }
    check("stale edit succeeds after recovery", retryStaleOk)
    check("stale file changed after recovery", (await fs.readFile(staleFile, "utf8")).includes("two"))

    const writeUnreadFile = path.join(tempDir, "write-unread.txt")
    const writeOriginal = "keep\nme\n"
    await fs.writeFile(writeUnreadFile, writeOriginal, "utf8")

    const firstWrite = await toolError(() =>
      WriteTool.execute({ file_path: writeUnreadFile, content: "replaced\n" }, context),
    )
    check("unread write throws ToolError", firstWrite !== undefined)
    check("unread write says not read", firstWrite?.message.includes("has not been read") === true)
    check("unread write shows current contents", firstWrite?.message.includes("1: keep") === true)
    check("unread write leaves file unchanged", (await fs.readFile(writeUnreadFile, "utf8")) === writeOriginal)

    let retryWriteOk = true
    try {
      await WriteTool.execute({ file_path: writeUnreadFile, content: "replaced\n" }, context)
    } catch {
      retryWriteOk = false
    }
    check("unread write succeeds after recovery", retryWriteOk)
    check("write file changed after recovery", (await fs.readFile(writeUnreadFile, "utf8")) === "replaced\n")
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .then(() => {
    console.log(`${passed} passed / ${failed} failed`)
    process.exitCode = failed ? 1 : 0
  })
