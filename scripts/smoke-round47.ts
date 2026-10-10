/**
 * Round 47: a custom model says for itself that it thinks, and which levels.
 *
 * MiMo draws an effort menu only for Claude and GPT-5 by name, so a DeepSeek on
 * the user's own server had none: nothing to pick, and no `reasoning_effort`
 * sent, which that server (sglang) answers by not thinking at all. Measured
 * against it: `none` turns thinking off, and low / medium / high / max think for
 * a growing number of tokens; any other word is refused.
 *
 * The custom-model form (WB's layout: thinking on, thinking only, may be turned
 * off, the levels, the default) stores `thinking` on the model. That becomes the
 * menu the window shows, the list the wire accepts, and the fallback a turn
 * clamps the app-wide level to. A model that says nothing keeps MiMo's by-name
 * rule exactly as it was.
 *
 * smoke.ts calls `roundFortySevenChecks` with its own check and section.
 */
import { readFileSync } from "node:fs"
import type { Check } from "./smoke-round5"
import { engine, say } from "./smoke-round5"
import { customModelOf } from "../src/server/config"
import { THINKING_LEVELS, effortToSend, menuEfforts, thinkingMenu, thinkingOf } from "../src/shared/effort-menu"
import { clampEffort } from "../src/renderer/src/lib/model"
import type { CustomModel, Effort } from "../src/shared/protocol"

const source = (path: string) => readFileSync(path, "utf8")

export async function roundFortySevenChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 47: a custom model's own thinking levels (the local DeepSeek that had no menu)")

  // ---------------------------------------------------------------- what is stored
  check("thinking keeps only the five named levels, once each, in their own order", thinkingOf({ efforts: ["max", "low", "banana", "low", "none", "minimal", "high"] })?.efforts.join() === "low,high,max", thinkingOf({ efforts: ["max", "low", "banana", "low", "none"] }))
  check("canOff is kept only when it is exactly true", thinkingOf({ efforts: ["low"], canOff: true })?.canOff === true && thinkingOf({ efforts: ["low"], canOff: "yes" })?.canOff === undefined && thinkingOf({ efforts: ["low"], canOff: false })?.canOff === undefined)
  check("a default must be one of the levels offered", thinkingOf({ efforts: ["low", "high"], default: "high" })?.default === "high" && thinkingOf({ efforts: ["low", "high"], default: "max" })?.default === undefined && thinkingOf({ efforts: ["low"], default: "none" })?.default === undefined)
  check("anything that is not an object is no thinking at all", [undefined, null, "high", 3, true].every((value) => thinkingOf(value) === undefined))
  check("a model that thinks but names no level is kept, with none", JSON.stringify(thinkingOf({ efforts: "low" })) === '{"efforts":[]}')
  check("the five levels are exactly the ones WB's form offers, weakest first", THINKING_LEVELS.join() === "low,medium,high,xhigh,max")

  const stored = customModelOf({ id: "ds", name: "DS", thinking: { efforts: ["high", "low"], canOff: true, default: "low" } } as CustomModel)
  check("a saved model carries its thinking", JSON.stringify(stored.thinking) === '{"efforts":["low","high"],"canOff":true,"default":"low"}', stored.thinking)
  check("and one that says nothing carries none", customModelOf({ id: "ds", name: "DS" }).thinking === undefined)
  check("a bad value is dropped, not stored", customModelOf({ id: "ds", name: "DS", thinking: "yes" } as unknown as CustomModel).thinking === undefined)

  // ---------------------------------------------------------------- the menu
  const menu = (thinking: Parameters<typeof thinkingMenu>[0]) => thinkingMenu(thinking).join()
  check("a model that can be turned off offers none first", menu({ efforts: ["low", "medium", "high", "xhigh", "max"], canOff: true }) === "none,low,medium,high,xhigh,max")
  check("one that only thinks does not", menu({ efforts: ["low", "high"] }) === "low,high")
  check("with no level there is nothing to draw, not even none", menu({ efforts: [], canOff: true }) === "")

  // ---------------------------------------------------------------- the clamp
  const levels: Effort[] = ["none", "low", "medium", "high"]
  check("the app-wide level is kept when offered", effortToSend(levels, "high", "low") === "high")
  check("else the model's own default", effortToSend(levels, "max", "low") === "low")
  check("else medium, as before a model could say", effortToSend(levels, "max") === "medium" && effortToSend(["low", "high"], "max") === "low")
  check("a default the menu lacks is ignored", effortToSend(["low", "high"], "max", "medium") === "low")
  check("no menu, no level", effortToSend([], "high", "low") === undefined)
  check("the window clamps the same way", clampEffort(levels, "max", "high") === "high")

  // ---------------------------------------------------------------- the window and the wire, on a real turn
  const e = await engine({
    custom: {
      models: [
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1", thinking: { efforts: ["low", "medium", "high", "xhigh", "max"], canOff: true } },
        { id: "think-only", name: "Think only", thinking: { efforts: ["low", "high"], default: "high" } },
        { id: "deepseek-plain", name: "DeepSeek plain" },
      ],
    },
  })
  try {
    const listed = e.config.providers().find((entry) => entry.id === "fake")?.models ?? []
    const info = (id: string) => listed.find((model) => model.id === id)
    check("the window is sent the model's own menu", info("deepseek-v4.1-flash")?.variants.join() === "none,low,medium,high,xhigh,max", info("deepseek-v4.1-flash")?.variants)
    check("and that it reasons", info("deepseek-v4.1-flash")?.reasoning === true)
    check("and its default, when it names one", info("think-only")?.defaultEffort === "high" && info("deepseek-v4.1-flash")?.defaultEffort === undefined)
    check("a model that says nothing keeps MiMo's by-name rule: a DeepSeek has no menu", info("deepseek-plain")?.variants.length === 0 && info("deepseek-plain")?.reasoning === false, info("deepseek-plain"))
    check("and the by-name rule itself is untouched", menuEfforts("deepseek-v4.1-flash").length === 0 && menuEfforts("claude-opus-4-7").length > 0)
    check("the wire accepts exactly the menu", e.config.variants({ provider: "fake", model: "deepseek-v4.1-flash" })?.join() === "none,low,medium,high,xhigh,max", e.config.variants({ provider: "fake", model: "deepseek-v4.1-flash" }))

    const send = async (model: string, effort: Effort) => {
      await e.config.set({ effort })
      const session = await e.store.create({ directory: e.project, model: { provider: "fake", model } })
      e.replies.push(say("ok"))
      await e.runner.prompt({ sessionID: session.id, text: "hello" })
      await e.idle(session.id)
      return { body: e.bodies.at(-1), saved: (await e.assistants(session.id)).at(-1) }
    }

    const high = await send("deepseek-v4.1-flash", "high")
    check("a level in the menu goes out as reasoning_effort", high.body?.model === "deepseek-v4.1-flash" && high.body?.reasoning_effort === "high", high.body?.reasoning_effort)
    check("and the reply records it", high.saved?.effort === "high", high.saved?.effort)
    const max = await send("deepseek-v4.1-flash", "max")
    check("max goes out as max", max.body?.reasoning_effort === "max", max.body?.reasoning_effort)
    const off = await send("deepseek-v4.1-flash", "none")
    check("none goes out as none, the server's way of not thinking", off.body?.reasoning_effort === "none", off.body?.reasoning_effort)
    const minimal = await send("deepseek-v4.1-flash", "minimal")
    check("a level the menu lacks falls to medium", minimal.body?.reasoning_effort === "medium", minimal.body?.reasoning_effort)

    const only = await send("think-only", "none")
    check("a model that only thinks is never sent none: it falls to its default (not just its first level)", only.body?.reasoning_effort === "high", only.body?.reasoning_effort)
    const onlyMax = await send("think-only", "max")
    check("nor a level it does not list", onlyMax.body?.reasoning_effort === "high", onlyMax.body?.reasoning_effort)

    const plain = await send("deepseek-plain", "high")
    check("a model that says nothing is sent no level, as before", !("reasoning_effort" in (plain.body ?? {})), plain.body?.reasoning_effort)
    check("and its reply records none", plain.saved?.effort === undefined, plain.saved?.effort)
  } finally {
    await e.close()
  }

  // ---------------------------------------------------------------- the form
  const form = source("src/renderer/src/components/CustomProviderForm.vue")
  check("the form has WB's thinking switches: on, only, may be turned off", ['data-model-thinking="on"', 'data-model-thinking="only"', 'data-model-thinking="canOff"'].every((mark) => form.includes(mark)))
  check("the five levels and the default are chosen there", form.includes(':data-model-effort="level"') && form.includes(":data-model-effort-default"))
  // The first draft put all of this behind a button in a 14-row pop-up that ran off the window. WB lays it out in the card.
  check("in the model's card, as WB lays it out, not in a pop-up behind a button", form.includes("data-model-thinking-block") && !form.includes("data-model-thinking-menu") && !form.includes("data-model-thinking-panel"))
  check("the default is a drop-down and the levels sit in three columns", /<SelectMenu[^>]*:data-model-effort-default/.test(form) && /\.cp-think-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/.test(form))
  check("and saved on the model only when thinking is on", /if \(row\.thinking\.on\) \{\s*model\.thinking = \{/.test(form))
  check("'thinking only' and 'may be turned off' are one switch seen from both ends", form.includes("setCanOff(row, !(") && form.includes("setCanOff(row, ($event"))
}
