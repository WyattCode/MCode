/**
 * Round 53: a conversation's model setup is its own.
 *
 * Its model already was; the reasoning level was MiMo's one app-wide value, so
 * changing it in one conversation changed every other. The user asked (2026-10-11)
 * for each conversation to keep its own, and for a conversation whose models
 * were all deleted to sit on 自动 rather than keep naming the deleted one.
 *
 * smoke.ts calls `roundFiftyThreeChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import type { Check } from "./smoke-round5"
import { calls, engine, say, wireText } from "./smoke-round5"
import { NO_TESTING_NOTE, NO_TESTING_REFUSAL, forbidsTesting } from "../src/shared/no-testing"
import { Bus } from "../src/server/bus"
import { SessionStore } from "../src/server/session/store"
import { STALE_MEDIA_NOTE, toMessages } from "../src/server/provider/openai"
import type { Message } from "../src/shared/protocol"
import { Storage } from "../src/server/storage"

const source = (file: string) => readFileSync(file, "utf8")

export async function roundFiftyThreeChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 53: each conversation keeps its own reasoning level")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r53-"))
  try {
    const store = new SessionStore(new Storage(root), new Bus())
    const model = { provider: "p", model: "m" }
    const a = await store.create({ directory: root, model, effort: "high" })
    const b = await store.create({ directory: root, model })
    check("a conversation made with a level keeps it", a.effort === "high", a)
    check("one made without starts with none of its own", b.effort === undefined, b)

    const before = (await store.require(a.id)).updated
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.setEffort(a.id, "max")
    const afterA = await store.require(a.id)
    const afterB = await store.require(b.id)
    check("setting a level changes that conversation only", afterA.effort === "max" && afterB.effort === undefined, { a: afterA.effort, b: afterB.effort })
    check("and is not activity: the conversation does not climb the list", afterA.updated === before, { before, after: afterA.updated })
    await store.setEffort(b.id, "low")
    check("each keeps what it was given", (await store.require(a.id)).effort === "max" && (await store.require(b.id)).effort === "low")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  const runner = source("src/server/session/runner.ts")
  check("a turn sends the conversation's level, not the app's", /effortToSend\(menu\.levels, session\.effort \?\? config\.effort, menu\.preferred\)/.test(runner))
  check("an older conversation takes the app's level once and keeps it", /if \(!session\.effort\) session = await this\.store\.setEffort\(session\.id, this\.config\.get\(\)\.effort\)/.test(runner))
  const handlers = source("src/server/handlers.ts")
  check("a new conversation starts at the app's last level", /effort: config\.effort,\s*title: request\.title/.test(handlers))
  check("the window can set one conversation's level", /case "session\.effort":[\s\S]{0,200}sessions\.setEffort\(request\.sessionID, request\.effort\)/.test(handlers))

  check("a branch and a subagent start at their origin's level", /\.\.\.\(origin\.effort \? \{ effort: origin\.effort \} : \{\}\)/.test(source("src/server/session/store.ts")) && /\.\.\.\(parent\.effort \? \{ effort: parent\.effort \} : \{\}\)/.test(runner))
  const store = source("src/renderer/src/stores/app.ts")
  check("the window sets a conversation's level on that conversation", /type: "session\.effort", sessionID: target, effort/.test(store))
  check("a side chat's level never becomes the app's", /if \(!target \|\| !isSide\(target\)\) await patchConfig\(\{ effort \}\)/.test(store))
  const composer = source("src/renderer/src/components/Composer.vue")
  check("the chip names the conversation's level first", /clampEffort\(variants\.value, session\.value\?\.effort \?\? app\.config\?\.effort/.test(composer))
  check("choosing a model moves that conversation's level, not everyone's", /app\.setEffort\(effort, sessionID\.value\)/.test(composer) && /app\.setEffort\(level, sessionID\.value\)/.test(composer))
  const app = source("src/renderer/src/App.vue")
  check("the keyboard steps the open conversation's level", (app.match(/app\.current\?\.effort \?\? app\.config\?\.effort/g) ?? []).length === 2)

  section("Round 53: with every model gone, 自动")
  check("nothing left to pick puts the default and each stranded conversation on 自动", /if \(!ref\) \{[\s\S]{0,200}fallBackToSmart\(\)/.test(store) && /\.filter\(\(entry\) => !entry\.smart && !modelAvailable\(providers\.value, entry\.model\)\)/.test(store))
  check("but not at launch, where nothing connected yet is not a loss", /ensureUsableModel\(undefined, \{ smartWhenNone: false \}\)/.test(store))

  section("Round 53: a tool's picture is looked at once, so the server's prefix cache survives")
  /*
   * Measured on the LAN Qwen (2026-10-11): 27k tokens, a second request cached 27286 of them
   * without a picture and 0 with one - wherever it sat, even after an identical text prefix.
   * A 42-minute run took a screenshot, and every later step recomputed 57-78k tokens.
   */
  const shot = [{ path: "a.png", mime: "image/png", data: "iVBORw0KGgo=" }]
  const step = (n: number, withShot: boolean): Message => ({
    id: `msg_a${n}`,
    sessionID: "ses_r53",
    role: "assistant",
    model: { provider: "p", model: "m" },
    agent: "build",
    parts: [{ type: "tool", id: `p${n}`, callID: `call_${n}`, name: "read", status: "completed", input: { file_path: "a.png" }, output: "shown", ...(withShot ? { attachments: shot } : {}), time: { created: n } }],
    time: { created: n },
  })
  const history: Message[] = [{ id: "msg_u", sessionID: "ses_r53", role: "user", text: "look", attachments: [], time: { created: 1 } }, step(2, true), step(3, true), step(4, true)]
  const wire = toMessages("sys", history, { image: true }) as Record<string, any>[]
  const pictures = wire.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"))
  const stale = wire.filter((m) => m.role === "user" && m.content === STALE_MEDIA_NOTE)
  check("only the step the model has not answered keeps its picture", pictures.length === 1 && wire.lastIndexOf(pictures[0]) === wire.length - 1, { pictures: pictures.length })
  check("the earlier two are a short note instead", stale.length === 2, { stale: stale.length })
  check("each picture's message still follows its own tool result", wire.map((m) => m.role).join() === "system,user,assistant,tool,user,assistant,tool,user,assistant,tool,user")
  const later = toMessages("sys", [...history, { id: "msg_a5", sessionID: "ses_r53", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts: [{ type: "text", id: "t5", text: "done" }], time: { created: 5 } } as Message], { image: true }) as Record<string, any>[]
  check("once the model has spoken, none of the pictures is sent again", !later.some((m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")))
  check("a picture the user attached is not touched", (toMessages("sys", [{ id: "msg_u2", sessionID: "ses_r53", role: "user", text: "see", attachments: [{ path: "u.png", mime: "image/png", data: "iVBORw0KGgo=" }], time: { created: 1 } }, step(2, false), { id: "msg_u3", sessionID: "ses_r53", role: "user", text: "and", attachments: [], time: { created: 3 } }] as Message[], { image: true }) as Record<string, any>[]).some((m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")))

  section("Round 53: told not to test, a turn does not drive a browser to check its work")
  const told = ["创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试，只靠你自己完成", "不要测试，直接做", "不用测试", "无需测试", "别验证了", "不要截图验证", "不需要进行任何验证", "Don't test it, just write it", "do not run any tests", "no testing please", "skip verification", "without screenshots", "no need to verify"]
  const asked = ["请帮我测试这个页面", "不要忘记测试", "测试一下并截图给我", "不要测试环境的数据", "不用验证码登录", "无验证码", "Don't forget to test it", "please verify the layout", "write tests for the parser", "不要使用任何skill"]
  check("every way of saying it is understood", told.every((text) => forbidsTesting(text)), told.filter((text) => !forbidsTesting(text)))
  check("a request to test or verify is not mistaken for the opposite", asked.every((text) => !forbidsTesting(text)), asked.filter((text) => forbidsTesting(text)))

  const e = await engine()
  try {
    const session = await e.store.create({ directory: e.project, model: e.model })
    e.replies.push(calls([{ name: "app", input: { action: "open", url: "file:///x.html" } }]), say("done"))
    await e.runner.prompt({ sessionID: session.id, text: "做一个页面，你不需要任何测试" })
    await e.idle(session.id)
    const first = wireText(e.bodies[0])
    check("the turn tells the model, in a note", first.includes(NO_TESTING_NOTE), first.slice(-200))
    const part = (await e.assistants(session.id)).flatMap((message) => message.parts).find((p) => p.type === "tool" && p.name === "app")
    check("and the app tool is refused, as an error it reads back", part?.type === "tool" && part.status === "error" && part.error === NO_TESTING_REFUSAL, part)

    e.replies.push(calls([{ name: "app", input: { action: "close" } }]), say("done"))
    await e.runner.prompt({ sessionID: session.id, text: "现在打开浏览器看一下" })
    await e.idle(session.id)
    const later = (await e.assistants(session.id)).flatMap((message) => message.parts).filter((p) => p.type === "tool" && p.name === "app").at(-1)
    check("the next message, which does not say it, gets the tool back", later?.type === "tool" && later.error !== NO_TESTING_REFUSAL, later)
  } finally {
    await e.close()
  }
}
