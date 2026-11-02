import type { AssistantMessage, AssistantPart, Message, ToolPart } from "@shared/protocol"
import { parseTextToolCalls } from "./text-tool-parse"

/**
 * What the model is told about the turn it is in, beside the conversation
 * itself, in MCode's own words. MiMo wraps such notes in a system-reminder
 * tag inside a user message; the tag is kept so a model reads them the same
 * way.
 */

/** MiMo's doom-loop threshold: this many identical calls in a row put a question to the user. */
export const LOOP_THRESHOLD = 3

/** The answers the repeated-call question takes; anything else typed is feedback, and refuses. */
export const LOOP_ANSWERS = { once: "once", always: "always", reject: "reject" } as const

/**
 * Whether this call is the third in a row with the same tool and input among
 * the last parts of its reply. Any other part in between breaks the run, as it
 * does in MiMo; the earlier two must already have been started.
 */
export function repeatsCall(parts: readonly AssistantPart[], call: ToolPart): boolean {
  const at = parts.indexOf(call)
  if (at < LOOP_THRESHOLD - 1) return false
  const run = parts.slice(at - LOOP_THRESHOLD + 1, at + 1)
  const input = JSON.stringify(call.input ?? {})
  return run.every(
    (part) => part.type === "tool" && part.name === call.name && (part === call || part.status !== "pending") && JSON.stringify(part.input ?? {}) === input,
  )
}

/**
 * MiMo's text repetition check, as its engine runs one over a reply while it
 * streams (`session/prompt/text-ngram-detection.ts`): a block of at least
 * NGRAM_BLOCK words repeated REPEAT_THRESHOLD times back to back, within the
 * last WINDOW_TOKENS words, is a model talking in circles. The block has to
 * hold a few distinct words of its own, so a run of the same bullet or the
 * same separator is not mistaken for one.
 */
export const NGRAM_BLOCK = 4
export const REPEAT_THRESHOLD = 20
export const WINDOW_TOKENS = 500
const MIN_DISTINCT = 3

/** How many times one turn is told to stop repeating before it is left to finish. */
export const REPEAT_RECOVERIES = 2

/** The words a reply is compared by: folded to lower case, with every CJK character a word of its own. */
export function repeatTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/([　-ヿ㐀-䶿一-鿿豈-﫿＀-￯])/g, " $1 ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

/** Whether any block of `minBlockSize` words or more repeats `threshold` times in a row. */
export function repeatsBlock(
  tokens: readonly string[],
  minBlockSize = NGRAM_BLOCK,
  threshold = REPEAT_THRESHOLD,
  minDistinct = MIN_DISTINCT,
): boolean {
  if (threshold < 2 || tokens.length < minBlockSize * threshold) return false
  const maxPeriod = Math.floor(tokens.length / threshold)
  for (let period = minBlockSize; period <= maxPeriod; period++) {
    let run = 0
    for (let at = 0; at <= tokens.length - period - 1; at++) {
      if (tokens[at] !== tokens[at + period]) {
        run = 0
        continue
      }
      run++
      if (run < period * (threshold - 1)) continue
      const start = at - run + 1
      if (new Set(tokens.slice(start, start + period)).size >= minDistinct) return true
      run = 0
    }
  }
  return false
}

/** Whether the end of a reply has fallen into repeating itself. */
export function repeatsText(text: string): boolean {
  const all = repeatTokens(text)
  return repeatsBlock(all.length > WINDOW_TOKENS ? all.slice(-WINDOW_TOKENS) : all)
}

const REPEAT_NOTE = [
  "Your last reply repeated the same wording over and over instead of moving on.",
  "Stop repeating it: say the next thing in different words, make a different call, or say plainly what is blocking you.",
].join(" ")

const REPEAT_REPLAN_NOTE = [
  "Your reply is repeating itself again, after being told once already.",
  "The approach you are on is stuck. Say what you were trying to do, why it did not work, and what you will do instead - then do that, without reusing the wording from before.",
].join(" ")

/**
 * What a repeating reply is answered with, in MCode's own words: one note the
 * first time and a firmer one the second, as MiMo escalates its two, and
 * nothing after that.
 */
export function repeatNoteFor(text: string, used: number): string | undefined {
  if (used >= REPEAT_RECOVERIES || !repeatsText(text)) return undefined
  return used === 0 ? REPEAT_NOTE : REPEAT_REPLAN_NOTE
}

/** How much new text is written before the monitor looks again; MiMo's own appends per delta. */
export const LOOP_CHECK_CHARS = 400

/** The finish reason a step carries when the stream was cut for repeating itself. */
export const LOOP_FINISH = "text_loop"

/** What the finished reply says when the same wording would not stop coming. */
export const LOOP_ENDED = "The model repeated the same wording until the reply was stopped, twice over, and did not recover."
export const LOOP_ENDED_CODE = "error.replyLoop"

/**
 * The monitor that watches a reply as it streams, so a loop is cut rather than
 * paid for to the output limit.
 *
 * MiMo runs one over its own stream and ends it the moment it fires
 * (`takeUntil(() => textNgramRepeat)`), which is the half MCode was missing:
 * the same n-gram test was only applied once the reply had finished, so a model
 * talking in circles wrote its full output budget first and was told to stop
 * afterwards. Once it has fired it stays fired, and the text is only re-tested
 * every `LOOP_CHECK_CHARS` characters - the test walks the tail on each call,
 * and a delta is often a single token.
 */
export function createLoopMonitor(): { append(text: string): boolean } {
  let buffer = ""
  let checked = 0
  let fired = false
  return {
    append(text: string): boolean {
      if (fired) return true
      buffer += text
      if (buffer.length - checked < LOOP_CHECK_CHARS) return false
      checked = buffer.length
      fired = repeatsText(buffer)
      return fired
    },
  }
}

/** One step's calls as a signature: each call's name and its input with keys sorted. */
function signature(message: AssistantMessage): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value
  return message.parts
    .filter((part): part is ToolPart => part.type === "tool")
    .map((part) => `${part.name}:${JSON.stringify(stable(part.input ?? {}))}`)
    .join("|")
}

const SAME_STEPS = [
  "Your last three steps made exactly the same tool calls with the same arguments, and repeating them again will not change the result.",
  "Change your approach: re-read the file or failing output, run the narrowest check, and fix the reported error; do not stop at a request for advice.",
].join(" ")

/**
 * MiMo's same-steps note: when the last three finished steps each made the
 * very same calls, the latest user message carries a note to change approach.
 * Request only, and never twice.
 */
export function withSameStepsNote(history: Message[]): Message[] {
  const signatures: string[] = []
  for (let index = history.length - 1; index >= 0 && signatures.length < LOOP_THRESHOLD; index--) {
    const message = history[index]!
    if (message.role !== "assistant") continue
    if (message.finish === undefined && message.time.completed === undefined) continue
    const sig = signature(message)
    if (!sig) break
    signatures.push(sig)
  }
  if (signatures.length < LOOP_THRESHOLD || signatures.some((sig) => sig !== signatures[0])) return history
  const target = history.map((message) => message.role).lastIndexOf("user")
  if (target < 0) return history
  const note = reminder(SAME_STEPS)
  return history.map((message, index) =>
    index === target && message.role === "user" && !message.text.includes(SAME_STEPS) ? { ...message, text: `${message.text}\n\n${note}` } : message,
  )
}

/** MiMo's continuation limits, per turn. */
/*
 * `interrupted` matches the stream retry budget: each continuation after a cut
 * stream stands where one retry of that kind would have (RETRY_BUDGETS.stream).
 */
export const CONTINUATION_LIMITS = { length: 3, textTool: 2, empty: 2, interrupted: 5 } as const

/**
 * The finish a step reports when its stream broke after the reply had begun.
 *
 * OpenCode v2 (session/runner/llm.ts, MIT): an incomplete stream after durable
 * output keeps what was written and continues it, where a stream that broke
 * before saying anything is simply sent again. MCode used to throw the words
 * away and ask for the whole reply once more - paying for every token twice,
 * and on a long answer over a flaky link never finishing at all.
 */
export const INTERRUPTED_FINISH = "stream_interrupted"

/**
 * OpenCode v2's continuation, with MCode's append behaviour made explicit.
 * "Without repeating completed content" still lets a model rewrite the last
 * unfinished line. The LAN DeepSeek did exactly that after a dropped socket,
 * but the runner appends the new text verbatim, duplicating that line's start.
 */
export const INTERRUPTED_NOTE = "The previous response was interrupted. Your next text will be appended verbatim to the text already shown. Continue from its exact final character, even inside an unfinished sentence, line, word, or code block. Output only the missing suffix. Do not restart or rewrite the unfinished line, and do not repeat or summarise any earlier content."

export const LENGTH_NOTE =
  "Your previous reply was cut off because it reached the output limit. Continue from exactly where it stopped - do not repeat or summarise what you already wrote."
/**
 * A reply the output limit cut while it was still thinking, with nothing
 * written and nothing called.
 *
 * LENGTH_NOTE asks to carry on "from exactly where it stopped", but a model
 * never sees its own thinking again - the request drops it - so it started the
 * whole plan over and was cut at the same place, four times, and the turn
 * failed (the user's pelican drawing on a local Qwen: 32,000 tokens of design
 * notes each time, no file). The request now carries the thinking's beginning
 * and end in its place (`thoughtDigest` in provider/history.ts), and this says
 * to act on it rather than plan again.
 */
export const THOUGHT_LENGTH_NOTE =
  "Your previous reply spent the whole output limit thinking and wrote no answer and no tool call. Where your thinking had got to is shown above - do not start it over or plan in more detail. Act now: make the tool call or write the answer, and keep any further thinking short. Write to the user in the language of the conversation, not the language of your thinking."
export const TEXT_TOOL_NOTE = "Your previous reply wrote a tool call out as text, so nothing ran. Make that call again as a real tool call."
export const EMPTY_NOTE = "Your previous reply had no answer and no tool call. Answer the user or call a tool; thinking alone is not a reply."

export const ANNOUNCED_NOTE = "Your previous reply said what you were about to do, but made no tool call, so nothing has been done. Do it now with a tool call. If that reply was already your complete answer, say it again and stop."

/**
 * A long think that ends in one short line and no call: the model has planned
 * the work and only announced it. Measured on the user's local Qwen: three turns
 * in five thought 9-23k characters, wrote "我来直接写这个文件" and ended, with no
 * file. Judged by shape, not wording, so it holds in any language; a real short
 * answer after long thought only costs one step that repeats it.
 */
function announcedOnly(message: AssistantMessage, text: string): boolean {
  const thought = message.parts.reduce((sum, part) => sum + (part.type === "reasoning" ? part.text.length : 0), 0)
  return text.length <= 200 && thought >= 2000 && thought >= text.length * 20
}

/** Tool-call markup a model wrote as prose, as MiMo spots it. */
const TEXT_TOOL_CALL = /<invoke name=|<parameter name=|<\/invoke>|<function_calls>|<tool_call>|tool_call:|to=functions\./

/** The finish reasons that mean "this step ended on a tool call", as MiMo's tables map them. */
const TOOL_FINISH = new Set(["tool_calls", "tool_use", "function_call"])

export type Continuation = { note?: string; error?: { message: string; code?: string }; recovered?: { name: string; input: Record<string, unknown> }[] }

/**
 * MiMo's auto-continue after a step that ended without a tool call to run:
 * a reply cut at the output limit is continued, tool calls written as text are
 * asked for again, and an empty or reasoning-only reply is asked to answer,
 * each up to its limit, after which the step ends in error. A GPT model's
 * reasoning-only reply is taken as final.
 *
 * `said` is what the message already held before this step - a reply the
 * output limit cut off carries on inside the same message - so that what this
 * step wrote is what gets judged, and a continuation that answered with
 * nothing is still an empty reply.
 *
 * `opening` is a local model's first step of a turn, the one place it can have
 * announced the work and stopped (`announcedOnly`).
 */
export function continuationFor(
  message: AssistantMessage,
  stop: string,
  finishReason: string | undefined,
  modelID: string,
  counts: { length: number; textTool: number; empty: number; interrupted: number },
  said = "",
  opening = false,
): Continuation {
  if (finishReason === INTERRUPTED_FINISH) {
    // Still breaking after as many continuations as retries: the link is the problem, and the reader is told so.
    if (counts.interrupted >= CONTINUATION_LIMITS.interrupted) return { error: { message: "The reply kept being interrupted and was not finished.", code: "error.network" } }
    counts.interrupted += 1
    return { note: INTERRUPTED_NOTE }
  }
  if (message.parts.some((part) => part.type === "tool")) return {}
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .slice(said.length)
    .trim()
  if (stop === "max_tokens") {
    if (counts.length >= CONTINUATION_LIMITS.length) return { error: { message: "The reply reached the output limit again after three continuations.", code: "error.outputLength" } }
    counts.length += 1
    const thoughtOnly = !text && message.parts.some((part) => part.type === "reasoning" && part.text.trim() !== "")
    return { note: thoughtOnly ? THOUGHT_LENGTH_NOTE : LENGTH_NOTE }
  }
  // MiMo's finish-reason tables fold the older `function_call` in with `tool_calls`;
  // self-hosted gateways and older vLLM/FastChat builds still end a turn with it.
  if (TOOL_FINISH.has(finishReason ?? "") && (TEXT_TOOL_CALL.test(text) || /```json/i.test(text))) {
    const parsed = parseTextToolCalls(text)
    if (parsed.length > 0) {
      return { recovered: parsed, note: `Recovered ${parsed.length} tool call(s) written as text and will run them.` }
    }
    const error = { message: "The model wrote a tool call as text instead of making the call." }
    if (counts.textTool >= CONTINUATION_LIMITS.textTool) return { error }
    counts.textTool += 1
    return { note: TEXT_TOOL_NOTE, error }
  }
  if (text && opening && stop === "end_turn" && counts.empty < CONTINUATION_LIMITS.empty && announcedOnly(message, text)) {
    counts.empty += 1
    return { note: ANNOUNCED_NOTE }
  }
  if (text) return {}
  const reasoned = message.parts.some((part) => part.type === "reasoning" && part.text.trim())
  if (reasoned && /(?:^|\/)gpt-\d/i.test(modelID)) return {}
  if (counts.empty >= CONTINUATION_LIMITS.empty) return { error: { message: "The model returned no usable output.", code: "error.emptyOutput" } }
  counts.empty += 1
  return { note: EMPTY_NOTE }
}

/** The turn's continuation notes, each placed right after the reply it answers. Request only. */
export function withNotes(history: Message[], notes: ReadonlyMap<string, readonly string[]>): Message[] {
  if (notes.size === 0) return history
  return history.flatMap((message): Message[] => {
    if (message.role !== "assistant") return [message]
    const list = notes.get(message.id)
    if (!list?.length) return [message]
    return [
      message,
      ...list.map((note, index) => ({
        id: `${message.id}:note:${index}`,
        sessionID: message.sessionID,
        role: "user" as const,
        text: reminder(note),
        attachments: [],
        time: { created: message.time.completed ?? message.time.created },
      })),
    ]
  })
}

export function reminder(body: string): string {
  return `<system-reminder>\n${body.trim()}\n</system-reminder>`
}

/**
 * MiMo's recall hint, in this app's own words: where a conversation that has
 * memory or tasks can look for what has dropped out of view, and a word not
 * to ask the user for what is written down already.
 */
export function recallHint(memoryFolder: string, actor: boolean): string {
  return reminder(
    [
      `This conversation keeps memory in ${memoryFolder}. To bring back something that is no longer in view:`,
      '- memory({ operation: "search", query: "<words>" })',
      `- read the files under ${memoryFolder}`,
      '- task({ operation: "list" })',
      ...(actor ? ['- actor({ operation: "status", actor_id: "<id>" })'] : []),
      "",
      "Look there before asking the user about something it may already record.",
    ].join("\n"),
  )
}

/** The hint, carried after the latest user message's own text for this request only, as MiMo carries it. */
export function withRecallHint<T extends { role: string; reminders?: string[] }>(history: T[], hint: string | undefined): T[] {
  if (!hint) return history
  const at = history.map((message) => message.role).lastIndexOf("user")
  if (at < 0) return history
  return history.map((message, index) => (index === at ? { ...message, reminders: [...(message.reminders ?? []), hint] } : message))
}

/**
 * MiMo's framing of messages sent while a turn is working: from the second
 * step of a turn on, every user message newer than the last finished reply
 * reaches the model inside a note saying the user sent it mid-task and that it
 * should be dealt with before carrying on. Request only - the transcript keeps
 * the words as typed.
 */
export function frameSteered(history: Message[]): Message[] {
  let finished = -1
  history.forEach((message, index) => {
    if (message.role === "assistant" && (message.finish !== undefined || message.time.completed !== undefined)) finished = index
  })
  if (finished < 0) return history
  return history.map((message, index) => {
    if (index <= finished || message.role !== "user" || !message.text.trim()) return message
    return {
      ...message,
      text: reminder(
        [
          "The user sent this message while you were working on the task:",
          "",
          message.text,
          "",
          "Take it into account now - answer it or change course as it asks - and then carry on with the work.",
        ].join("\n"),
      ),
    }
  })
}
