import "./fenced-home"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { commandRisk, LOST_WORK } from "../src/server/command-risk"
import { BashTool } from "../src/server/tool/bash"
import { scanCommand } from "../src/server/tool/bash-scan"
import type { ToolContext } from "../src/server/tool/types"

function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-shellfs-gitargs-"))
  try {
    const blocked = new Error("Policy check stopped the fixture")
    let question: { patterns: string[]; forced: boolean; forcedPatterns?: string[] } | undefined
    const context = {
      directory,
      sessionID: "ses_shellfs",
      messageID: "msg_shellfs",
      callID: "call_shellfs_policy",
      signal: new AbortController().signal,
      permissions: { ask: async (input: typeof question) => { question = input; throw blocked } },
      progress: () => {},
    } as unknown as ToolContext
    const result = await BashTool.execute({ command: "echo policy-probe && git clean -fd" }, context).catch((error: unknown) => error)
    check("Mixed command passes every segment to policy", result === blocked && question?.patterns.includes("echo policy-probe") === true && question.patterns.includes("git clean -fd"), question?.patterns)
    check("Only the deletion segment is marked as forcing approval", question?.forced === true && JSON.stringify(question.forcedPatterns) === '["git clean -fd"]', question)

    const cases = [
      ["Git config option consumes its value", "git -c foo=bar clean -fd", true],
      ["Git directory option consumes its value", "git -C project reset --hard", true],
      ["Git quoted path stays one argument", 'git -C "project folder" reset --hard', true],
      ["Git long options accept separate and attached values", "git --git-dir=repo --work-tree project --namespace sample --config-env=foo=VAR clean -fd", true],
      ["Unknown Git global option requires approval", "git --unknown-option status", true],
      ["Missing Git option value requires approval", "git -C", true],
      ["Git global options preserve a known safe subcommand", 'git --no-pager -c "foo=some value" --git-dir repo status', false],
    ] as const
    for (const [name, command, expected] of cases) {
      const risk = commandRisk(command)
      const scan = await scanCommand(command, directory, directory, false)
      const scannerForced = scan.deletes.length > 0
      const riskForced = risk !== undefined && LOST_WORK.includes(risk)
      check(name, scannerForced === expected && riskForced === expected, { risk: risk ?? null, scannerForced })
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
