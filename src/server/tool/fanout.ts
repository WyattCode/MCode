import fs from "node:fs/promises"
import path from "node:path"
import type { FanoutOutcome, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { guardPlanWrite } from "../session/plan"
import { currentText, locked } from "./edit"
import { guardFailure } from "./edit-recover"
import { checkFresh, recordWrite, wasRead } from "./read-tracker"

/** Most requests one call may carry; past this the work is better split into steps the model can check between. */
export const FANOUT_MAX_REQUESTS = 16

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
/** Names Windows keeps for devices, whatever the extension: `con.txt` is not a file there. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const EFFORTS = ["off", "low", "medium", "high", "xhigh"] as const

/**
 * Run several independent single-shot generations at once and save each answer
 * to a file.
 *
 * This is the lean counterpart of the actor tool. A subagent is a whole
 * conversation - its own history, tools and agent loop, at the conversation's
 * thinking level - which is right for work that needs looking around and is a
 * poor fit for "write this one part, given a plan that is already settled".
 * Here a request is one prompt and one answer on the conversation's own model,
 * so several can run side by side (measured on one local server: four at once
 * got through about twice the tokens per second of one), and thinking can be
 * switched off for the ones whose job is only to write.
 */
export const FanoutTool: ToolDefinition = {
  name: "fanout",
  description: [
    "Run several independent single-shot generations at the same time on this conversation's model, and save each answer to a file. It is for splitting one large piece of writing into parts that can be written separately, after you have settled the plan they share.",
    "",
    "Each request is one prompt and one answer: no tools, no history, no agent loop. So a request must carry everything it needs - put what every part shares (the interfaces, coordinates, names, formats the parts must agree on) in `system`, and what is particular to a part in its `prompt`. Parts that cannot agree on a shared contract written down first do not fit together afterwards.",
    "",
    "Each answer is written to `<output_dir>/<name>.txt` exactly as the model wrote it. The result lists, for each request, whether it worked, how long it took, how many tokens it used and where its file is; read the files you need, or assemble them with a script. A failed request does not stop the others.",
    "",
    'effort: "off" switches thinking off, which is the fast choice for a part that only has to be written; "low" to "xhigh" ask for that much thinking; leave it out to follow the conversation. Output that is cut off is reported as stop=max_tokens, so raise max_tokens or split the part.',
    "",
    "Use it when there are two or more parts that do not depend on each other's output. Do not use it for a single piece of work, for work that needs to look at the project or run commands (use the actor tool for that), or when the parts cannot be described without seeing each other's results.",
  ].join("\n"),
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      requests: {
        type: "array",
        description: `The parts to write, at most ${FANOUT_MAX_REQUESTS}`,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A short name for the part: letters, digits, dot, dash or underscore. It becomes the file name." },
            prompt: { type: "string", description: "The complete instructions for this part" },
          },
          required: ["name", "prompt"],
          additionalProperties: false,
        },
      },
      output_dir: { type: "string", description: "Folder for the answers, absolute or relative to the project root; created if it is missing" },
      system: { type: "string", description: "Text every request shares, sent as the system prompt of each" },
      system_file: { type: "string", description: "Path of a file whose text is the shared system prompt, absolute or relative to the project root. Use it for a long contract you have already written to a file, instead of typing it again here; if system is given too, it follows the file's text." },
      effort: { type: "string", enum: [...EFFORTS], description: "off turns thinking off; low, medium, high, xhigh ask for that effort; omitted follows the conversation" },
      max_tokens: { type: "integer", description: "Output limit for each request, in tokens" },
      concurrency: { type: "integer", description: "How many run at once (default 4, at most 8). A local server queues what it has no lane for; a cloud API may refuse it with a rate limit, which is waited out and retried" },
      must_contain: { type: "string", description: "Text every answer must contain, for example a code fence marker such as ```js. An answer without it counts as failed and is retried." },
      retries: { type: "integer", description: "How many times a failed request, or one whose answer lacks must_contain, is run again by the tool itself (default 1, at most 3; 0 turns it off)" },
    },
    required: ["requests", "output_dir"],
    additionalProperties: false,
  },
  async execute(input, context) {
    if (!context.fanout) throw new ToolError("fanout is not available here: a subagent cannot fan out work of its own.")
    const raw = input.requests
    if (!Array.isArray(raw) || raw.length === 0) throw new ToolError("requests must be a list with at least one request.")
    if (raw.length > FANOUT_MAX_REQUESTS) throw new ToolError(`At most ${FANOUT_MAX_REQUESTS} requests per call; this one has ${raw.length}.`)
    const seen = new Set<string>()
    const items = raw.map((entry, index) => {
      const record = (entry ?? {}) as Record<string, unknown>
      const name = typeof record.name === "string" ? record.name.trim() : ""
      const prompt = typeof record.prompt === "string" ? record.prompt : ""
      if (!NAME.test(name)) throw new ToolError(`Request ${index + 1} needs a name of letters, digits, dot, dash or underscore (up to 40 characters).`)
      if (!prompt.trim()) throw new ToolError(`Request "${name}" has an empty prompt.`)
      if (RESERVED_NAME.test(name)) throw new ToolError(`Request "${name}" has a name Windows reserves for a device; choose another.`)
      // Compared without case: on a filesystem that ignores it, Bike and bike would be one file.
      const key = name.toLowerCase()
      if (seen.has(key)) throw new ToolError(`Two requests are named "${name}", ignoring case; names must be unique because they become file names.`)
      seen.add(key)
      return { name, prompt }
    })
    const effort = typeof input.effort === "string" ? EFFORTS.find((entry) => entry === input.effort) : undefined
    if (typeof input.effort === "string" && !effort) throw new ToolError(`effort must be one of: ${EFFORTS.join(", ")}.`)
    const dirInput = typeof input.output_dir === "string" ? input.output_dir.trim() : ""
    if (!dirInput) throw new ToolError("output_dir is required.")
    const directory = await resolvePath(context, dirInput, "write")
    /*
     * Held to what the write tool is held to, and all before any request is made,
     * since a refusal should cost no tokens: planning writes nothing but the plan,
     * a file that exists is only replaced once it has been read and is unchanged
     * since, and the user is asked.
     */
    const previous = new Map<string, string | undefined>()
    const displayDir = relative(context.directory, directory) || "."
    for (const item of items) {
      const target = path.join(directory, `${item.name}.txt`)
      const display = relative(context.directory, target)
      guardPlanWrite(context, target, display)
      const text = await currentText(target, display)
      if (text !== undefined) {
        if (!wasRead(context.sessionID, target)) throw await guardFailure(context, target, display, "unread")
        if (await checkFresh(context.sessionID, target, text)) throw await guardFailure(context, target, display, "stale")
      }
      previous.set(item.name, text)
    }
    await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "edit",
      directory: context.directory,
      title: "Write the answers of parallel requests",
      subject: displayDir,
      preview: items.map((item) => relative(context.directory, path.join(directory, `${item.name}.txt`))).join("\n"),
    })
    const maxTokens = typeof input.max_tokens === "number" && input.max_tokens > 0 ? Math.floor(input.max_tokens) : undefined
    const concurrency = typeof input.concurrency === "number" && input.concurrency > 0 ? Math.floor(input.concurrency) : undefined

    // A contract already written to a file is read here, so the model does not have to produce it a second time inside the call.
    const systemParts: string[] = []
    if (typeof input.system_file === "string" && input.system_file.trim()) {
      const file = await resolvePath(context, input.system_file.trim(), "read")
      const text = await fs.readFile(file, "utf8").catch(() => undefined)
      if (text === undefined) throw new ToolError(`Could not read system_file ${relative(context.directory, file)}.`)
      systemParts.push(text)
    }
    if (typeof input.system === "string" && input.system.trim()) systemParts.push(input.system)
    const system = systemParts.length ? systemParts.join("\n\n") : undefined

    const mustContain = typeof input.must_contain === "string" && input.must_contain ? input.must_contain : undefined
    const retries = typeof input.retries === "number" ? Math.max(0, Math.min(3, Math.floor(input.retries))) : 1

    // Made before any request: a folder that cannot exist should cost no tokens.
    await fs.mkdir(directory, { recursive: true }).catch((failure: Error) => {
      throw new ToolError(`Could not create ${displayDir}: ${failure.message}`)
    })
    context.progress(`0/${items.length} done`)
    const outcomes = await context.fanout.generate(
      items,
      { system, effort, maxTokens, concurrency },
      {
        done: (outcome, finished, total) =>
          context.progress(`${finished}/${total} done - ${outcome.name}: ${outcome.ok ? `${outcome.seconds.toFixed(0)}s` : "failed"}`),
      },
    )
    /*
     * A request that failed, or whose answer is not what was asked for (a model
     * that wrote a tool call as text instead of the part, measured on a local
     * Qwen), is run again here, at once and beside the others that are being
     * retried, rather than costing the conversation a whole step to notice and
     * ask. An answer cut at the output limit is not retried, whatever it lacks: it
     * would be cut again. Neither is anything once the turn has been stopped.
     */
    const lacking = (outcome: FanoutOutcome) => !outcome.text.trim() || (mustContain !== undefined && !outcome.text.includes(mustContain))
    const bad = (outcome: FanoutOutcome) => !outcome.ok || (outcome.stop !== "max_tokens" && lacking(outcome))
    const attempts = outcomes.map(() => 1)
    for (let round = 1; round <= retries && !context.signal.aborted; round++) {
      const again = outcomes.map((outcome, index) => ({ outcome, index })).filter(({ outcome }) => bad(outcome))
      if (again.length === 0) break
      context.progress(`retrying ${again.length} request(s): ${again.map(({ outcome }) => outcome.name).join(", ")}`)
      const redone = await context.fanout.generate(again.map(({ index }) => items[index]!), { system, effort, maxTokens, concurrency })
      again.forEach(({ index }, at) => {
        outcomes[index] = redone[at]!
        attempts[index]!++
      })
    }
    // What is still empty or lacks the required text is a failure, whatever the provider said.
    outcomes.forEach((outcome, index) => {
      if (!outcome.ok || !lacking(outcome)) return
      const what = outcome.text.trim() ? `the answer does not contain ${JSON.stringify(mustContain)}, which was required` : "the answer was empty"
      const cut = outcome.stop === "max_tokens" ? "; it stopped at the output limit, so raise max_tokens or split the part" : ""
      outcomes[index] = { ...outcome, ok: false, error: `${what}${cut} (after ${attempts[index]} attempt(s))` }
    })

    const rows: string[] = []
    const files: { name: string; path?: string; ok: boolean; stop?: string; seconds: number; output?: number }[] = []
    for (const [index, outcome] of outcomes.entries()) {
      const tried = attempts[index]! > 1 ? ` (took ${attempts[index]} attempts)` : ""
      if (!outcome.ok) {
        rows.push(`${outcome.name}: FAILED after ${outcome.seconds.toFixed(0)}s${tried} - ${outcome.error ?? "unknown error"}`)
        files.push({ name: outcome.name, ok: false, seconds: outcome.seconds })
        continue
      }
      const target = path.join(directory, `${outcome.name}.txt`)
      const display = relative(context.directory, target)
      // A generation takes minutes: a file someone changed meanwhile is kept, and the answer is not written over it.
      let refusal: string | undefined
      try {
        const written = await locked(target, async () => {
          if ((await currentText(target, display)) !== previous.get(outcome.name)) return false
          await context.snapshot(target)
          await fs.writeFile(target, outcome.text, "utf8")
          await recordWrite(context.sessionID, target, outcome.text)
          return true
        })
        if (!written) refusal = `${display} changed while the answer was being generated, so it was left as it is`
      } catch (failure) {
        // One file that cannot be written (locked by an editor, say) is that part's failure: the other answers are already paid for.
        refusal = `${display} could not be written: ${failure instanceof Error ? failure.message : String(failure)}`
      }
      if (refusal) {
        outcomes[index] = { ...outcome, ok: false }
        rows.push(`${outcome.name}: NOT WRITTEN - ${refusal}`)
        files.push({ name: outcome.name, ok: false, seconds: outcome.seconds })
        continue
      }
      rows.push(summary(outcome, display) + tried)
      files.push({ name: outcome.name, path: display, ok: true, stop: outcome.stop, seconds: outcome.seconds, output: outcome.usage?.output })
    }
    const failed = outcomes.filter((outcome) => !outcome.ok).length
    const cut = outcomes.filter((outcome) => outcome.ok && outcome.stop === "max_tokens").length
    const notes: string[] = []
    if (failed) notes.push(`${failed} request(s) failed; the files for the others are written.`)
    if (cut) notes.push(`${cut} answer(s) stopped at the output limit (stop=max_tokens) and are incomplete: raise max_tokens or split that part.`)
    notes.push(...new Set(outcomes.flatMap((outcome) => (outcome.note ? [outcome.note] : []))))
    return {
      output: [`Ran ${items.length} request(s) side by side; answers are in ${relative(context.directory, directory) || "."}/`, "", ...rows, ...(notes.length ? ["", ...notes] : [])].join("\n"),
      title: `${items.length - failed}/${items.length} written`,
      metadata: { directory: relative(context.directory, directory), files },
    }
  },
}

function summary(outcome: FanoutOutcome, file: string): string {
  const tokens = outcome.usage ? `${outcome.usage.output} output tokens${outcome.usage.reasoning ? ` (${outcome.usage.reasoning} of them thinking)` : ""}` : "token count unknown"
  return `${outcome.name}: ok in ${outcome.seconds.toFixed(0)}s, ${tokens}, stop=${outcome.stop ?? "?"} -> ${file}`
}
