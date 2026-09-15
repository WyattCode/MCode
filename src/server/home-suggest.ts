import fs from "node:fs/promises"
import path from "node:path"
import type { HomeSuggestion, SuggestionIcon } from "@shared/protocol"
import { SUGGESTION_ICONS } from "@shared/protocol"
import type { Runtime } from "./index"
import { IGNORED } from "./tool/fs-util"
import { AnthropicAdapter } from "./provider/anthropic"
import { OpenAICompatible } from "./provider/openai"
import { ChatGPTSubscription } from "./provider/chatgpt"
import type { ProviderAdapter } from "./provider/types"

/**
 * The home screen's example tasks, asked of the default model once per project.
 *
 * MiMo picks three of its own built-in cases; MCode asks the model for three
 * that fit the project instead. The request is short and has no tools, and an
 * answer that is late, missing or unreadable simply leaves the area empty.
 */

/* MCode's own instruction. The answer is JSON so the rows can be read by a rule, not by trusting prose. */
export const SUGGEST_SYSTEM = [
  "You write starting points for the home screen of a coding assistant.",
  "Given a project, suggest three concrete tasks the user could hand the assistant next.",
  'Reply with a JSON array of exactly three objects and nothing else: [{"title": string, "query": string, "icon": string}].',
  "title: a short imperative name for the task, at most 40 characters.",
  "query: the request exactly as the user would type it, one to three sentences, specific to this project.",
  `icon: one of ${SUGGESTION_ICONS.join(", ")}.`,
  "Do not repeat the recent conversations, and do not name files the listing does not show.",
].join("\n")

/* Past this the screen has long been read; the area stays empty rather than popping in late. */
export const SUGGEST_TIMEOUT_MS = 15_000

/* Room for three short objects, and for a model that reasons before answering. */
const SUGGEST_OUTPUT_TOKENS = 1024

/* A good answer is kept for half an hour; a failed one only briefly, so a fixed connection is tried again. */
const KEEP_MS = 30 * 60_000
const KEEP_FAILED_MS = 2 * 60_000

const LISTED_ENTRIES = 40
const RECENT_TITLES = 8

interface Kept {
  at: number
  keep: number
  suggestions: HomeSuggestion[]
}

const kept = new Map<string, Kept>()

/* For tests: the next ask goes to the model again. */
export function forgetSuggestions(): void {
  kept.clear()
}

/** What the model is told about the project. */
export function suggestInput(input: { project: string; entries: string[]; titles: string[]; language?: string }): string {
  return [
    `Project: ${input.project}`,
    `Top-level entries: ${input.entries.length ? input.entries.join(", ") : "(empty folder)"}`,
    "Recent conversations:",
    input.titles.length ? input.titles.map((title) => `- ${title}`).join("\n") : "(none)",
    `Write title and query in the language whose code is ${input.language || "en"}.`,
  ].join("\n")
}

/**
 * Up to three rows out of whatever the model wrote.
 *
 * The array is cut out of the text first, because models wrap JSON in fences
 * or a sentence. A row without both a title and a request is dropped, a
 * repeated title counts once, and an icon outside the set becomes "idea".
 */
export function parseSuggestions(text: string): HomeSuggestion[] {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: HomeSuggestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim().slice(0, 80) : ""
    const query = typeof record.query === "string" ? record.query.trim().slice(0, 1200) : ""
    if (!title || !query || out.some((entry) => entry.title === title)) continue
    const icon = (SUGGESTION_ICONS as readonly string[]).includes(String(record.icon))
      ? (record.icon as SuggestionIcon)
      : "idea"
    out.push({ title, query, icon })
    if (out.length === 3) break
  }
  return out
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function suggestTasks(
  runtime: Runtime,
  directory: string,
  language?: string,
): Promise<{ suggestions: HomeSuggestion[]; generated: boolean }> {
  const root = path.resolve(directory)
  const key = `${process.platform === "win32" ? root.toLowerCase() : root}|${language ?? ""}`
  const held = kept.get(key)
  if (held && Date.now() - held.at < held.keep) return { suggestions: held.suggestions, generated: held.suggestions.length > 0 }

  // Not remembered: connecting a provider should bring the rows at the next visit, not in half an hour.
  const model = runtime.config.get().model
  const definition = runtime.config.definition(model.provider)
  if (!definition || !runtime.config.usable(model.provider)) return { suggestions: [], generated: false }

  const listed = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const entries = listed
    .filter((entry) => !entry.name.startsWith(".") && !IGNORED.has(entry.name))
    .slice(0, LISTED_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  const titles = (await runtime.sessions.list())
    .filter((session) => !session.archived && samePath(session.directory, root))
    .sort((a, b) => b.updated - a.updated)
    .map((session) => session.title)
    .filter((title) => title && title !== "New session")
    .slice(0, RECENT_TITLES)
  const text = suggestInput({ project: path.basename(root) || root, entries, titles, language })

  const adapter: ProviderAdapter =
    definition.kind === "anthropic" ? AnthropicAdapter : definition.kind === "chatgpt" ? ChatGPTSubscription : OpenAICompatible
  const apiKey = runtime.config.apiKey(definition.id) ?? ""
  const tokens =
    definition.kind === "chatgpt" ? await runtime.auth.accessToken(definition.id).catch(() => undefined) : undefined
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let answer = ""
  const asked = adapter
    .stream(
      {
        apiKey: tokens?.access ?? apiKey,
        model,
        system: SUGGEST_SYSTEM,
        history: [
          {
            id: `home-suggest:${Date.now()}`,
            sessionID: "home-suggest",
            role: "user",
            text,
            attachments: [],
            time: { created: Date.now() },
          },
        ],
        tools: [],
        effort: "low",
        showReasoning: false,
        signal: controller.signal,
        baseURL: definition.baseURL,
        headers: definition.headers,
        accountId: tokens?.accountId,
        maxOutput: SUGGEST_OUTPUT_TOKENS,
      },
      (event) => {
        if (event.type === "text.delta") answer += event.text
      },
    )
    .then(() => true)
    .catch(() => false)
  // Raced as well as aborted, so an adapter slow to notice the abort cannot hold the screen.
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(false)
    }, SUGGEST_TIMEOUT_MS)
  })
  const finished = await Promise.race([asked, expired])
  clearTimeout(timer)

  const suggestions = finished ? parseSuggestions(answer) : []
  kept.set(key, { at: Date.now(), keep: suggestions.length ? KEEP_MS : KEEP_FAILED_MS, suggestions })
  return { suggestions, generated: suggestions.length > 0 }
}
