/**
 * Round 29: two things the user hit using the app.
 *
 *   1. After a compaction the context ring went on showing the size of the
 *      conversation that had just been replaced, until the next message.
 *   2. At full access a delete was still asked about. The user chose
 *      (2026-09-26) that full access means no questions, deletes included -
 *      a deliberate difference from MiMo. Every other level still asks.
 *
 * And one found on the way: a delete waiting for its answer was answered
 * "once" by the next unrelated session update whenever commands were set to
 * "always allow", with nobody having pressed anything.
 *
 * smoke.ts calls `roundTwentyNineChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AssistantMessage, Message, ProviderStatus, SessionInfo } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { Storage } from "../src/server/storage"
import { nextRequestEstimate } from "../src/server/session/summary"
import { readContext } from "../src/renderer/src/components/session-context"
import type { Check } from "./smoke-round5"

export async function roundTwentyNineChecks(check: Check, section: (name: string) => void): Promise<void> {
  // --------------------------------------------------------------- R29-1
  section("Round 29 (1): the context ring answers for the conversation as compacted, not as it was")
  {
    /*
     * Measured in the real window against a stub that counts what it is sent:
     * 41.4% before `/compact`, still 41.4% after it until the next message,
     * then 8.1%. Now ≈8.1% the moment the compaction lands, from the estimate
     * it leaves, and 8.1% once the next turn reports - the estimate and the
     * count agreeing to the tenth.
     */
    const providers = [{ id: "p", name: "P", models: [{ id: "m", name: "M", contextWindow: 262_144 }] }] as unknown as ProviderStatus[]
    const turn = {
      id: "msg_a",
      sessionID: "ses",
      role: "assistant",
      model: { provider: "p", model: "m" },
      parts: [],
      time: { created: 1_000, completed: 2_000 },
      usage: { input: 108_600, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    } as unknown as AssistantMessage
    const messages: Message[] = [turn]
    const mark = { messageID: "msg_a", summary: "s", at: 3_000, trigger: "manual", estimate: 21_362 } as SessionInfo["compacted"]

    const before = readContext(messages, providers)
    check("before any compaction it reads the last turn's count", before?.used === 108_600 && !before?.estimated, before?.used)
    const after = readContext(messages, providers, mark)
    check("after one, with no turn since, it reads the compaction's estimate", after?.used === 21_362 && after?.estimated === true, after?.used)
    check("and the share follows it", after?.percent === Math.round((21_362 / 262_144) * 100), after?.percent)
    const later = { ...turn, id: "msg_b", time: { created: 4_000, completed: 5_000 }, usage: { ...turn.usage!, input: 21_400 } } as AssistantMessage
    const counted = readContext([...messages, later], providers, mark)
    check("a turn that finishes after it replaces the estimate with its own count", counted?.used === 21_400 && !counted?.estimated, counted?.used)
    const older = readContext(messages, providers, { ...mark!, estimate: undefined })
    check("a compaction stored before this round, with no estimate, reads as before", older?.used === 108_600, older?.used)

    /*
     * The estimate is the provider's count for the compaction request, scaled
     * by how much smaller the next request is by the same character estimate.
     */
    check("the part both requests share is kept at the provider's own count", nextRequestEstimate(20_000, 80_000, 1_000, 105_000) === Math.round((105_000 * 21_000) / 100_000))
    check("with nothing reported it is the estimate itself", nextRequestEstimate(20_000, 80_000, 1_000, 0) === 21_000)
    const composer = await fs.readFile(path.join(process.cwd(), "src/renderer/src/components/Composer.vue"), "utf8")
    check("the ring is handed the conversation's compaction", /readContext\(messagesHere\.value, app\.providers, session\.value\?\.compacted\)/.test(composer))
    check("and an estimate says so, with ≈ in front of each figure", /const about = reading\.estimated \? "≈" : ""/.test(composer) && /used: about \+ compactTokens\(used\)/.test(composer))
    const runner = await fs.readFile(path.join(process.cwd(), "src/server/session/runner.ts"), "utf8")
    check("the compaction stores its estimate beside the summary", /compacted: \{ \.\.\.mark, estimate \}/.test(runner))
  }

  // --------------------------------------------------------------- R29-2
  section("Round 29 (2): full access does not ask about a delete; nothing else changed")
  {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r29-"))
    try {
      const storage = new Storage(path.join(temp, "storage"))
      await storage.write("config", {})
      const bus = new Bus()
      const config = new Config(storage, bus, path.join(temp, "credentials.json"))
      await config.load()
      const permissions = new Permissions(bus, config)
      await permissions.load(storage)
      const levels = new Map<string, string>()
      permissions.useSessions(async (id) => levels.get(id))

      const raised: string[] = []
      bus.subscribe((event) => {
        if (event.type === "permission.requested") raised.push(event.request.id)
      })
      const remove = (sessionID: string) =>
        permissions.ask({
          sessionID,
          messageID: "msg",
          callID: `call_${sessionID}_${raised.length}`,
          kind: "bash",
          title: "delete",
          subject: "rm -rf build",
          patterns: ["rm -rf build"],
          always: [],
          forced: true,
        })
      /** Whether the call was let through within a moment, and whether a question went up. */
      const outcome = async (sessionID: string) => {
        const before = raised.length
        let settled = false
        const call = remove(sessionID).then(() => (settled = true)).catch(() => (settled = true))
        await new Promise((resolve) => setTimeout(resolve, 150))
        return { settled, asked: raised.length > before, call }
      }

      levels.set("ses_full", "full")
      const full = await outcome("ses_full")
      check("at full access a delete runs without a question", full.settled && !full.asked, full)

      levels.set("ses_ask", "ask")
      const asked = await outcome("ses_ask")
      check("at the default level it is still asked", !asked.settled && asked.asked, asked)
      permissions.rejectAll("ses_ask")
      await asked.call

      levels.set("ses_auto", "auto")
      const auto = await outcome("ses_auto")
      check("at the middle level it is still asked, and not handed to the model's review", !auto.settled && auto.asked, auto)
      permissions.rejectAll("ses_auto")
      await auto.call

      /*
       * Commands set to "always allow" at the default level: the delete is
       * still put to a person - and stays put. This pass runs on every session
       * update, and it used to answer the delete "once" on the next one.
       */
      await config.set({ permissions: { ...config.get().permissions, bash: "allow" } })
      levels.set("ses_allow", "ask")
      const allowed = await outcome("ses_allow")
      check("with commands always allowed a delete is still asked", !allowed.settled && allowed.asked, allowed)
      bus.publish({ type: "session.updated", session: { id: "ses_allow" } as SessionInfo })
      await permissions.drainDecided()
      await new Promise((resolve) => setTimeout(resolve, 100))
      let answered = false
      void allowed.call.then(() => (answered = true))
      await new Promise((resolve) => setTimeout(resolve, 50))
      check("and an unrelated session update does not answer it", !answered)

      // The reader switching this conversation to full access does.
      levels.set("ses_allow", "full")
      await permissions.drainDecided()
      await new Promise((resolve) => setTimeout(resolve, 50))
      check("switching the conversation to full access lets the waiting delete through", answered)
    } finally {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    }

    /*
     * The confirmation that turns full access on used to be right to say
     * nothing about deletes: they were asked about anyway. Now they are not,
     * so it says so - in every language, since the sentence is this app's own.
     */
    const i18n = await fs.readFile(path.join(process.cwd(), "src/renderer/src/lib/i18n.ts"), "utf8")
    const bodies = [...i18n.matchAll(/"composer\.access\.confirmBody": "((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "")
    check("the full access confirmation says deletes are not asked about either", bodies.some((body) => /删除文件的命令也不会再单独询问/.test(body)) && bodies.some((body) => /delete files are not asked about/.test(body)))
    // Every table has its own; i18ncheck fails on an English sentence left in any of them.
    check("every language has the confirmation", bodies.length === 18, bodies.length)
  }

  // --------------------------------------------------------------- R29-3
  section("Round 29 (3): a drawing's style is written back with every markup character escaped")
  {
    /*
     * Found in the second review of round 28. The style is put back after the
     * drawing's opening tag, found by a pattern on the serialized markup - sound
     * only while the serializer escapes `>` inside attribute values. Chromium
     * 146 does (measured), so this was not open; but with only `<` and `&`
     * escaped, a serializer that did not would have let a `"` in a font name
     * close an attribute and start new ones. All five are escaped now, and the
     * parser decodes them again inside the drawing: re-measured, colours intact.
     */
    const diagram = await fs.readFile(path.join(process.cwd(), "src/renderer/src/lib/diagram.ts"), "utf8")
    check("quotes and > are escaped as well as < and &", /\.replace\(\/>\/g, "&gt;"\)\.replace\(\/"\/g, "&quot;"\)\.replace\(\/'\/g, "&#39;"\)/.test(diagram))
  }
}
