/**
 * Round 16 (lane C): what the tools do with code, and the two approval
 * relaxations the user chose.
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundSixteenToolChecks` with its own check and section. Nothing here reaches
 * the network or the reader's own files: the model is a fake provider on
 * 127.0.0.1, and every transcript read is one this file wrote into a temporary
 * folder of its own.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServerEvent, ToolPart } from "../src/shared/protocol"
import { DEFAULT_PERMISSIONS, PERMISSION_KINDS } from "../src/shared/protocol"
import { calls, engine, type Check } from "./smoke-round5"
import { INTERACTIVE_REFUSAL } from "../src/server/tool/bash"

export async function roundSixteenToolChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-round16c-"))

  // ---------------------------------------------------------------- R16-C1
  section("Round 16 (C1): an interactive command is refused in the model's language, and the reader is told once")
  {
    check(
      "the sentence the model reads is Chinese, as MiMo's is",
      /[一-鿿]/.test(INTERACTIVE_REFUSAL) && !/[A-Za-z]{4,}/.test(INTERACTIVE_REFUSAL.replace(/--yes|-Force|-Confirm|\$false/g, "")),
      INTERACTIVE_REFUSAL,
    )
    check(
      "and it names the ways out rather than only refusing",
      INTERACTIVE_REFUSAL.includes("--yes") && INTERACTIVE_REFUSAL.includes("管道"),
      INTERACTIVE_REFUSAL,
    )

    const e = await engine()
    const session = await e.store.create({ directory: e.project, model: e.model })
    const askOnce = () => e.replies.push(calls([{ name: "bash", input: { command: "sudo apt install something", description: "install", interactive: true } }]))
    askOnce()
    e.replies.push(calls([]))
    await e.runner.prompt({ sessionID: session.id, text: "run it" })
    await e.idle(session.id)
    const noticesOf = (list: ServerEvent[]) => list.filter((event) => event.type === "session.notice" && event.code === "toast.bashInteractive")
    check("the reader is told about the skipped command", noticesOf(e.events).length === 1, noticesOf(e.events))
    check("and the conversation records that it has been told", (await e.store.get(session.id))?.interactiveNotice === true)
    const refused = (await e.assistants(session.id))
      .flatMap((message) => message.parts)
      .find((part): part is ToolPart => part.type === "tool" && part.name === "bash")
    check("the step carries the refusal the model read", refused?.output === INTERACTIVE_REFUSAL, refused?.output)

    askOnce()
    e.replies.push(calls([]))
    await e.runner.prompt({ sessionID: session.id, text: "try again" })
    await e.idle(session.id)
    check("a second one in the same conversation says nothing more", noticesOf(e.events).length === 1, noticesOf(e.events))
    await e.close()
    await fs.rm(e.dir, { recursive: true, force: true }).catch(() => undefined)
  }

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  void DEFAULT_PERMISSIONS
  void PERMISSION_KINDS
}
