import type { Attachment, Message } from "@shared/protocol"
import { historyService, type HistoryService } from "../history/service"
import { parsePartID, partTexts } from "../history/extract"
import { SEARCH_HARD_CAP } from "../history/index"
import { PAGE_DEFAULT, PAGE_MAX, pageOf, summaryOf, withinBudget, withoutInlineMedia } from "../history/text"
import type { ToolDefinition, ToolResult } from "./types"
import { ToolError } from "./types"

/**
 * history: MiMo's raw-history tool - full-text search over past
 * conversations, the messages around a hit, and one part read in pages.
 * MiMo's limits (up to 50 hits, windows of up to 50 messages each side, pages
 * of 1-8,000 characters, about 19.5 KB of summaries per answer) in this app's
 * own words.
 */

/** The most an answer of summaries may take, in bytes. */
export const HISTORY_BUDGET = 19_500
/** Messages either side of the anchor when the call does not say. */
export const AROUND_DEFAULT = 5
export const AROUND_MAX = 50

const MORE = "[More results were left out to keep this short; narrow the search or window, or get a part_id.]"
const ANCHOR_CUT = "[The anchor message was cut short; get its part_id for the rest.]"

function serviceOf(): HistoryService {
  const service = historyService()
  if (!service) throw new ToolError("History search is not available in this session.")
  return service
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
const whole = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

function reply(operation: string, output: string, count = 0, truncated = false): ToolResult {
  return { output, title: `History ${operation}`, metadata: { count, truncated } }
}

/** The conversation holding a message: the one named, the index's answer, or a look through the store. */
async function sessionHolding(service: HistoryService, messageID: string, named?: string): Promise<string | undefined> {
  const exists = (sessionID: string) => service.storage.read<Message>(`session/${sessionID}/message/${messageID}`).then(Boolean, () => false)
  if (named && (await exists(named))) return named
  const indexed = service.index.sessionOf(messageID)
  if (indexed && (await exists(indexed))) return indexed
  for (const sessionID of await service.storage.listDirectories("session")) if (await exists(sessionID)) return sessionID
  return undefined
}

async function search(input: Record<string, unknown>, directory: string): Promise<ToolResult> {
  const query = text(input.query)
  if (!query) return reply("search", "search needs a query.")
  const service = serviceOf()
  const hits = service.index.search({
    query,
    directory: input.scope === "global" ? undefined : directory,
    sessionID: text(input.session_id),
    toolName: text(input.tool_name),
    after: whole(input.time_after),
    before: whole(input.time_before),
    limit: whole(input.limit),
  })
  const building = service.index.building ? " The index is still being built, so older conversations may be missing." : ""
  if (!hits.length) return reply("search", `No matches.${building} Try fewer or rarer words, scope "global", or the memory tool.`)
  const lines = [
    `${hits.length} match${hits.length === 1 ? "" : "es"}, best first. These are snippets: get a part_id to read the whole part.${building}`,
    ...hits.map((hit) => `### session_id=${hit.session_id} message_id=${hit.message_id} part_id=${hit.part_id} time=${hit.time_created}\n${hit.tool_name ?? ""} score=${hit.score.toFixed(3)}\n${summaryOf(hit.snippet)}`),
  ]
  const kept = withinBudget(lines, HISTORY_BUDGET - Buffer.byteLength(MORE) - 1)
  return reply("search", [...kept.lines, ...(kept.cut ? [MORE] : [])].join("\n"), hits.length, kept.cut)
}

async function around(input: Record<string, unknown>): Promise<ToolResult> {
  const messageID = text(input.message_id)
  if (!messageID) return reply("around", "around needs a message_id.")
  const service = serviceOf()
  const sessionID = await sessionHolding(service, messageID, text(input.session_id))
  if (!sessionID) return reply("around", "No message with that id.")
  const messages = await service.store.messages(sessionID)
  const at = messages.findIndex((message) => message.id === messageID)
  if (at < 0) return reply("around", "No message with that id.")
  const before = Math.max(0, Math.min(AROUND_MAX, whole(input.before) ?? AROUND_DEFAULT))
  const after = Math.max(0, Math.min(AROUND_MAX, whole(input.after) ?? AROUND_DEFAULT))
  const window = messages.slice(Math.max(0, at - before), at + after + 1)
  const blocks = window.map((message) => ({
    anchor: message.id === messageID,
    lines: [
      `${message.id === messageID ? ">>>" : "---"} message_id=${message.id} time=${message.time.created}`,
      ...partTexts(message).map((part) => `part_id=${part.part_id} ${part.role} ${part.type}\n${summaryOf(part.text)}`),
    ],
  }))
  const header = `Session ${sessionID}. Summaries only: get a part_id to read the whole part.`
  let room = HISTORY_BUDGET - Buffer.byteLength(header) - Buffer.byteLength(MORE) - 2
  const chosen = new Set<(typeof blocks)[number]>()
  const shown = new Map<(typeof blocks)[number], string[]>()
  // The anchor first, cut down if it has to be; then its neighbours in order while they fit.
  const anchor = blocks.find((block) => block.anchor)
  if (anchor) {
    const fit = withinBudget(anchor.lines, room - Buffer.byteLength(ANCHOR_CUT) - 1)
    const lines = fit.cut ? [...(fit.lines.length ? fit.lines : anchor.lines.slice(0, 1)), ANCHOR_CUT] : fit.lines
    shown.set(anchor, lines)
    chosen.add(anchor)
    room -= lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
  }
  let cut = Boolean(anchor && shown.get(anchor)?.at(-1) === ANCHOR_CUT)
  for (const block of blocks) {
    if (block === anchor) continue
    const size = block.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    if (size > room) {
      cut = true
      break
    }
    shown.set(block, block.lines)
    chosen.add(block)
    room -= size
  }
  const body = blocks.filter((block) => chosen.has(block)).flatMap((block) => shown.get(block) ?? [])
  if (chosen.size < blocks.length) cut = true
  return reply("around", [header, ...body, ...(cut ? [MORE] : [])].join("\n"), window.length, cut)
}

async function get(input: Record<string, unknown>): Promise<ToolResult> {
  const id = text(input.part_id)
  if (!id) return reply("get", "get needs a part_id.")
  const located = parsePartID(id)
  const service = serviceOf()
  const message = located ? await service.storage.read<Message>(`session/${located.sessionID}/message/${located.messageID}`).catch(() => undefined) : undefined
  const part = message ? partTexts(message).find((entry) => entry.part_id === id) : undefined
  if (!part) return reply("get", "No part with that id.")
  let page
  try {
    page = pageOf(withoutInlineMedia(part.text), whole(input.offset) ?? 0, whole(input.length) ?? PAGE_DEFAULT)
  } catch (failure) {
    return reply("get", (failure as Error).message)
  }
  const next = page.has_more ? `More follows: get the same part_id with offset=${page.next_offset}.` : "This is the end of the part."
  const answer = reply("get", `offset=${page.offset} next_offset=${page.next_offset} total_length=${page.total_length} has_more=${page.has_more}\n${next}\n${page.text}`, 1)
  // MiMo's history hands media over rather than describing it: the file this part names goes with the answer.
  const media = mediaOf(message, located?.key)
  return media ? { ...answer, attachments: [media] } : answer
}

/** The file a `file:<n>` part names, when it is media a model could be handed. */
function mediaOf(message: Message | undefined, key: string | undefined): Attachment | undefined {
  const at = /^file:(\d+)$/.exec(key ?? "")
  if (!message || message.role !== "user" || !at) return undefined
  const file = message.attachments[Number(at[1])]
  return file && /^(image|audio|video)\/|^application\/pdf$/.test(file.mime) ? { ...file } : undefined
}

export const HistoryTool: ToolDefinition = {
  name: "history",
  description: [
    "Search the raw record of past conversations: what the user and assistant wrote, reasoning, attached file names, and each finished tool call's name, input and output or error.",
    "Reach for memory first when a curated note would do; use history for exact wording, exact tool arguments or output, or to check whether something was already tried.",
    "operation search: full-text search (every word must appear) ranked best first, with short snippets and ids. scope defaults to this project; \"global\" searches every project. Narrow with session_id, tool_name, time_after and time_before (milliseconds since 1970); limit is 1-50, default 10.",
    "operation around: the messages either side of message_id (before and after, 0-50 each, default 5), as summaries.",
    `operation get: one part_id's whole text, a page at a time. offset counts UTF-16 characters from 0; length is 1-${PAGE_MAX}, default ${PAGE_DEFAULT}. Continue from next_offset while has_more is true.`,
    "search and around only summarise: get the part_id you need before relying on the details. Inline images are replaced by a marker; read attached files by their path instead.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["search", "around", "get"], description: "What to do" },
      query: { type: "string", description: "search: the words to find" },
      scope: { type: "string", enum: ["project", "global"], description: "search: this project (default) or every project" },
      session_id: { type: "string", description: "search: only this conversation; around: the conversation holding message_id, if known" },
      tool_name: { type: "string", description: "search: only calls of this tool" },
      time_after: { type: "number", description: "search: only parts from this time on (ms since 1970)" },
      time_before: { type: "number", description: "search: only parts up to this time (ms since 1970)" },
      limit: { type: "integer", minimum: 1, maximum: SEARCH_HARD_CAP, description: "search: most results, default 10" },
      message_id: { type: "string", description: "around: the message to centre on" },
      before: { type: "integer", minimum: 0, maximum: AROUND_MAX, description: "around: messages before, default 5" },
      after: { type: "integer", minimum: 0, maximum: AROUND_MAX, description: "around: messages after, default 5" },
      part_id: { type: "string", description: "get: the part to read" },
      offset: { type: "integer", minimum: 0, description: "get: where the page starts; use next_offset from the previous page" },
      length: { type: "integer", minimum: 1, maximum: PAGE_MAX, description: `get: page length, default ${PAGE_DEFAULT}` },
    },
    required: ["operation"],
    additionalProperties: false,
  },
  async execute(input, context) {
    // MiMo's explore agent is denied this tool; it is not offered to one, and refused if called anyway.
    if ((await serviceOf().store.get(context.sessionID))?.subagent?.type === "explore") throw new ToolError("An explore subagent cannot search history.")
    const limit = whole(input.limit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_HARD_CAP)) throw new ToolError(`limit must be a whole number from 1 to ${SEARCH_HARD_CAP}.`)
    for (const key of ["before", "after"] as const) {
      const value = whole(input[key])
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > AROUND_MAX)) throw new ToolError(`${key} must be a whole number from 0 to ${AROUND_MAX}.`)
    }
    if (input.operation === "search") return search(input, context.directory)
    if (input.operation === "around") return around(input)
    if (input.operation === "get") return get(input)
    throw new ToolError('operation must be "search", "around" or "get".')
  },
}
