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
import { Bus } from "../src/server/bus"
import { SessionStore } from "../src/server/session/store"
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
}
