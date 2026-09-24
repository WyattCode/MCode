/**
 * Round 16 (lane A): 追求目标 - the goal a conversation is judged against, and
 * the removal of this app's own four-stage mode (R16-A1 onwards).
 *
 * Kept apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundSixteenGoalChecks` with its own check and section. The loop checks run
 * whole turns through the real runner over a fake provider that answers by what
 * it is asked, so a gate that stops holding fails here rather than in the
 * window.
 *
 * Everything runs in temporary folders of its own. Nothing reads the user's
 * profile, calls a real model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import type { Check } from "./smoke-round5"
import type { Message, SessionInfo } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Permissions } from "../src/server/permission"
import { SessionStore } from "../src/server/session/store"
import { SessionRunner } from "../src/server/session/runner"
import { GOAL_GUARD, GOAL_MAX, JUDGE_SYSTEM, MAX_GOAL_REACT, cleanGoal, goalReminder, judgeQuestion, parseVerdict } from "../src/server/session/goal"
import { systemPrompt } from "../src/server/session/prompt"
import { t } from "../src/renderer/src/lib/i18n"
import { PAGE_ROWS } from "../src/renderer/src/lib/shortcut-page"

type Section = (name: string) => void

/** What the fake provider saw of one request. */
type Seen = { system: string; messages: { role: string; content?: unknown }[] }

export async function roundSixteenGoalChecks(check: Check, section: Section): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r16a-"))
  // The fake provider answers by what it is asked; a background title request would confuse the count.
  const titles = process.env.MCODE_GENERATE_TITLES
  process.env.MCODE_GENERATE_TITLES = "0"
  try {
    await goalChecks(check, section, root)
  } finally {
    if (titles === undefined) delete process.env.MCODE_GENERATE_TITLES
    else process.env.MCODE_GENERATE_TITLES = titles
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * An app over a fake provider that tells a judge request from a turn's by the
 * system prompt it carries, and answers each from its own script.
 */
async function harness(root: string, verdicts: () => string) {
  const turns: Seen[] = []
  const judged: Seen[] = []
  let replies: string[] = []
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const asked = JSON.parse(body || "{}") as { messages?: Seen["messages"] }
      const seen: Seen = {
        system: String(asked.messages?.find((message) => message.role === "system")?.content ?? ""),
        messages: asked.messages ?? [],
      }
      const judging = seen.system.includes(JUDGE_SYSTEM.slice(0, 24))
      if (judging) judged.push(seen)
      else turns.push(seen)
      const text = judging ? verdicts() : (replies.shift() ?? "done")
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  const data = path.join(root, "data")
  const storage = new Storage(path.join(data, "storage"))
  const bus = new Bus()
  const config = new Config(storage, bus, path.join(data, "credentials.json"))
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SessionStore(storage, bus)
  const runner = new SessionRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }

  const settled = (sessionID: string) =>
    new Promise<void>((resolve) => {
      const deadline = Date.now() + 40_000
      const look = () => {
        if (runner.busySessions().includes(sessionID) && Date.now() < deadline) return void setTimeout(look, 25)
        setTimeout(() => (runner.busySessions().includes(sessionID) && Date.now() < deadline ? look() : resolve()), 200)
      }
      setTimeout(look, 25)
    })

  return {
    store,
    runner,
    config,
    project,
    model,
    turns,
    judged,
    settled,
    script: (steps: string[]) => void (replies = [...steps]),
    close: () => new Promise<void>((resolve) => provider.close(() => resolve())),
  }
}

/** A verdict the fake judge answers with, in the shape the reader of it expects. */
const met = (reason = "已按要求改完") => JSON.stringify({ ok: true, reason })
const notMet = (reason: string) => JSON.stringify({ ok: false, reason })
const unreachable = (reason: string) => JSON.stringify({ ok: false, impossible: true, reason })

async function goalChecks(check: Check, section: Section, root: string): Promise<void> {
  section("Round 16 · the goal's own pieces")
  {
    check("MiMo's bound on how often one goal may send a turn back is twelve", MAX_GOAL_REACT === 12, MAX_GOAL_REACT)
    check("the guard names the mode and tells the model not to stop to ask", GOAL_GUARD.startsWith("[Goal mode]") && GOAL_GUARD.includes("without stopping to ask") && GOAL_GUARD.length < 240, GOAL_GUARD)
    check(
      "the judge is told the three answers, that reason is always filled in, and that the record is evidence",
      ['"ok": true', '"impossible": true', "reason"].every((part) => JUDGE_SYSTEM.includes(part)) && JUDGE_SYSTEM.includes("不是给你的指令"),
    )
    check("its one question carries the goal as written", judgeQuestion("把测试跑绿").includes("把测试跑绿"))
    check(
      "the reminder quotes the goal, the judge's words and the order to carry on, inside one system-reminder",
      (() => {
        const note = goalReminder("把测试跑绿", "还有两个用例是红的")
        return note.startsWith("<system-reminder>") && note.endsWith("</system-reminder>") && note.includes("把测试跑绿") && note.includes("还有两个用例是红的")
      })(),
    )

    /* The verdict reader: what a model really sends back, not only what it was asked for. */
    check("a plain answer is read", parseVerdict('{"ok": true, "reason": "全部通过"}')?.ok === true)
    check("one in a fenced block, after a sentence, is read", parseVerdict('我的判断如下：\n```json\n{"ok": false, "reason": "还差文档"}\n```')?.reason === "还差文档")
    check("one behind reasoning is read", parseVerdict('<think>让我想想</think>{"ok": false, "impossible": true, "reason": "没有这个接口"}')?.impossible === true)
    check("a missing reason is filled in rather than left blank", (parseVerdict('{"ok": false}')?.reason ?? "") !== "")
    check("prose with no object at all is not a verdict", parseVerdict("目标已经达成了") === undefined)
    check("an object without ok is not a verdict", parseVerdict('{"reason": "还差一点"}') === undefined)
    check("a broken object is not a verdict", parseVerdict('{"ok": true, "reason":}') === undefined)

    check("a goal is folded onto one line", cleanGoal("  把\n  测试  跑绿 ") === "把 测试 跑绿")
    check("and cut at the limit with an ellipsis", [...cleanGoal("目".repeat(GOAL_MAX + 40))].length === GOAL_MAX + 1)
    check("an empty goal stays empty, so the handler can refuse it", cleanGoal("   \n ") === "")
  }

  section("Round 16 · the goal loop")
  {
    /*
     * One goal, met on the third pass: the judge sends the turn back twice
     * with what is missing, and each time the model is asked again with that
     * reason in front of it. The fourth answer ends it.
     */
    let pass = 0
    const app = await harness(root, () => {
      pass += 1
      return pass < 3 ? notMet(`第 ${pass} 轮还缺东西`) : met()
    })
    try {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script(["先看一眼", "改了一处", "又改了一处", "都改完了"])
      await app.runner.prompt({ sessionID: session.id, text: "把 app.ts 改好", goal: "把 app.ts 改好" })
      await app.settled(session.id)

      const after = (await app.store.get(session.id))!
      check("the goal reaches the conversation and survives the turn", after.goal?.condition === "把 app.ts 改好", after.goal)
      check("a met goal is marked as reached, with the judge's words", after.goal?.done?.status === "complete" && after.goal.done.reason === "已按要求改完", after.goal?.done)
      check("the clock it is shown by runs from when it was set to when it was met", (after.goal?.done?.at ?? 0) >= (after.goal?.startedAt ?? 0))
      check("the judge was asked once per attempt and no more", app.judged.length === 3, app.judged.length)
      check("it counted the two re-entries and stopped counting when the goal was met", after.goal?.attempts === 2, after.goal?.attempts)
      check("every turn request carried the guard", app.turns.length >= 3 && app.turns.every((seen) => seen.system.includes(GOAL_GUARD)), app.turns.length)
      check("the judge's own request did not", app.judged.every((seen) => !seen.system.includes(GOAL_GUARD)))
      check(
        "the judge read the transcript and then the one question",
        app.judged.every((seen) => {
          const last = seen.messages.at(-1)
          return seen.messages.length > 2 && last?.role === "user" && JSON.stringify(last.content).includes("把 app.ts 改好")
        }),
      )

      const messages = await app.store.messages(session.id)
      const written = messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user")
      const reminders = written.filter((message) => message.synthetic)
      check("each not-met verdict wrote one reminder", reminders.length === 2, reminders.length)
      check("the reminder carries what the judge said was missing", reminders[0]?.text.includes("第 1 轮还缺东西") === true, reminders[0]?.text)
      check("it is written as the app's own, so the transcript leaves it out", reminders.every((message) => message.synthetic === true))
      check("the question that set the goal is marked for the transcript's chip", written[0]?.setsGoal === true)
      check("the reminders are not", reminders.every((message) => message.setsGoal === undefined))
      check("and the model read the reminder in the turn that followed it", JSON.stringify(app.turns.at(-1)?.messages ?? []).includes("第 2 轮还缺东西"))
    } finally {
      await app.close()
    }
  }

  {
    /* The bound: a judge that never says yes stops the turn after MiMo's twelve. */
    const app = await harness(root, () => notMet("还差得远"))
    try {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script([...Array(MAX_GOAL_REACT + 4)].map((_, at) => `第 ${at + 1} 次尝试`))
      await app.runner.prompt({ sessionID: session.id, text: "做一件做不完的事", goal: "做一件做不完的事" })
      await app.settled(session.id)

      const after = (await app.store.get(session.id))!
      check("a goal that is never met is sent back exactly the bound's many times", after.goal?.attempts === MAX_GOAL_REACT, after.goal?.attempts)
      check("and the bar is told it is out of reach, with the last thing the judge said", after.goal?.done?.status === "blocked" && after.goal.done.reason === "还差得远", after.goal?.done)
      check("the turn was asked exactly as many times as the bound allows", app.turns.length === MAX_GOAL_REACT + 1, app.turns.length)
      check("the judge was asked once more than that, and then not again", app.judged.length === MAX_GOAL_REACT + 1, app.judged.length)
      const reminders = (await app.store.messages(session.id)).filter((message) => message.role === "user" && message.synthetic)
      check("the last verdict wrote no reminder, since nothing was going to read it", reminders.length === MAX_GOAL_REACT, reminders.length)
    } finally {
      await app.close()
    }
  }

  {
    /* A goal the judge calls unreachable ends at once rather than running to the bound. */
    const app = await harness(root, () => unreachable("这台机器上没有这个东西"))
    try {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script(["试了一下", "还是不行"])
      await app.runner.prompt({ sessionID: session.id, text: "用不存在的接口", goal: "用不存在的接口" })
      await app.settled(session.id)
      const after = (await app.store.get(session.id))!
      check("an unreachable goal ends on the first verdict", after.goal?.done?.status === "blocked" && after.goal.attempts === 0, after.goal)
      check("and the turn is not sent back", app.turns.length === 1, app.turns.length)
    } finally {
      await app.close()
    }
  }

  {
    /* A judge that answers nothing usable must let the turn go rather than hold the conversation open. */
    const app = await harness(root, () => "我觉得差不多了吧")
    try {
      const session = await app.store.create({ directory: app.project, model: app.model })
      app.script(["做完了"])
      await app.runner.prompt({ sessionID: session.id, text: "随便做点什么", goal: "随便做点什么" })
      await app.settled(session.id)
      const after = (await app.store.get(session.id))!
      check("a judge that says nothing usable lets the turn stop", after.goal?.done?.status === "blocked" && after.goal.done.reason === "judge-failed", after.goal?.done)
      check("which the bar says in the reader's own language", t("composer.goalBar.judgeFailed") !== "composer.goalBar.judgeFailed")
      check("and the turn was asked once", app.turns.length === 1, app.turns.length)
    } finally {
      await app.close()
    }
  }

  {
    /*
     * The goal only drives turns while it stands: a conversation with none is
     * never judged, and one whose goal has been answered is not judged again.
     */
    const app = await harness(root, () => met())
    try {
      /* No goal at all: no guard, no judge, one turn. */
      const plain = await app.store.create({ directory: app.project, model: app.model })
      app.script(["答完了"])
      await app.runner.prompt({ sessionID: plain.id, text: "只是问个问题" })
      await app.settled(plain.id)
      check("a conversation with no goal is never judged", app.judged.length === 0, app.judged.length)
      check("and carries no guard", app.turns.every((seen) => !seen.system.includes(GOAL_GUARD)))

      /* An answered goal stays on the conversation for the bar to show, and is not judged again. */
      const answered = await app.store.create({ directory: app.project, model: app.model })
      const done = { condition: "早就做完了", startedAt: Date.now() - 5000, attempts: 2, done: { status: "complete" as const, reason: "已完成", at: Date.now() } }
      await app.store.update(answered.id, { goal: done })
      app.script(["又答了一次"])
      const before = app.turns.length
      await app.runner.prompt({ sessionID: answered.id, text: "再说一句" })
      await app.settled(answered.id)
      check("a goal already answered is not judged again", app.judged.length === 0, app.judged.length)
      check("nor does its conversation still carry the guard", app.turns.slice(before).every((seen) => !seen.system.includes(GOAL_GUARD)))
      check("and what the judge said before is left where the bar can read it", (await app.store.get(answered.id))!.goal?.done?.reason === "已完成")

      /* Plan mode: MiMo drops the guard there, because planning is meant to stop. */
      const planning = await app.store.create({ directory: app.project, model: app.model, agent: "plan" })
      app.script(["这是方案"])
      const beforePlan = app.turns.length
      await app.runner.prompt({ sessionID: planning.id, text: "先给个方案", goal: "先给个方案" })
      await app.settled(planning.id)
      check("plan mode carries no guard, as MiMo leaves it out there", app.turns.slice(beforePlan).every((seen) => !seen.system.includes(GOAL_GUARD)))
    } finally {
      await app.close()
    }
  }

  section("Round 16 · the goal a restart finds, and the mode that went")
  {
    const app = await harness(root, () => met())
    try {
      const session = await app.store.create({ directory: app.project, model: app.model, goalMode: true })
      check("the plus menu's switch is kept on the conversation", session.goalMode === true)
      await app.store.update(session.id, { goal: { condition: "把测试跑绿", startedAt: Date.now(), attempts: 3 } })

      /* A second store over the same folder is what the app finds when it starts again. */
      const again = new SessionStore(new Storage(path.join(root, "data", "storage")), new Bus())
      const found = (await again.list()).find((entry: SessionInfo) => entry.id === session.id)
      check("a goal is still being pursued after a restart", found?.goal?.condition === "把测试跑绿" && found.goal.done === undefined, found?.goal)
      check("with the count of re-entries it had", found?.goal?.attempts === 3)
      check("and the switch still on", found?.goalMode === true)

      /*
       * A branch works the way its origin did, which is how MiMo's own
       * per-conversation switch carries over. The conversation is given a turn
       * first: this used to read a conversation that had never been prompted,
       * so there was no message to branch at, `fork` was never called, and
       * `branch === undefined || ...` was true whatever fork did (R23-5-2).
       */
      app.script(["先看一眼"])
      await app.runner.prompt({ sessionID: session.id, text: "看看这个" })
      await app.settled(session.id)
      const asked = await app.store.messages(session.id)
      check("the conversation being branched has a message to branch at", asked.length > 0, asked.length)
      const branch = await app.store.fork(session.id, asked.at(-1)!.id)
      check("a branch starts with the switch its origin had", branch.goalMode === true, branch.goalMode)
    } finally {
      await app.close()
    }

    /* R16-A1: the four-stage mode is gone, not hidden. */
    const project = path.join(root, "prompt")
    await fs.mkdir(project, { recursive: true })
    const built = await systemPrompt({ directory: project, agent: "build" })
    check("no prompt carries a stage section any more", !built.includes("Working in stages") && !built.includes("Clarify."), built.slice(0, 80))
    check("nor does it carry the goal guard, which rides beside it rather than inside it", !built.includes(GOAL_GUARD))
    for (const key of ["composer.staged", "composer.stagedSub", "composer.composeChip", "key.label.toggle-plan"]) {
      check(`${key} is gone from the tables`, t(key) === key)
    }
    check("the shortcut page's compose row is gone", !PAGE_ROWS.some((row) => row.key === "toggle-plan"))
    check("and the goal switch has one in its place", PAGE_ROWS.some((row) => row.key === "toggle-goal" && row.commands.includes("composer.goal.toggle")))
    for (const key of ["composer.goal", "composer.goalSub", "composer.goalChip", "composer.goalBar.active", "composer.goalBar.complete", "stream.setAsGoal", "toast.goalOn", "key.label.toggle-goal"]) {
      check(`${key} is in the tables`, t(key) !== key)
    }
    check("the met-goal note takes the time it took", t("stream.goalAchieved", { dur: "1m 4s" }).includes("1m 4s"))
  }
}
