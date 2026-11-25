import { historyService } from "../history/service"
import { MEMORY_SCOPES, type MemoryScope } from "../memory/paths"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"

/**
 * memory: MiMo's memory search over the memory markdown files, in this app's
 * own words. Writing memory is done with the ordinary write and edit tools on
 * the paths the system prompt names; this tool only finds what was written.
 */

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

export const MemoryTool: ToolDefinition = {
  name: "memory",
  description: [
    "Search the memory files kept across conversations: project memory, global memory and per-conversation notes, as markdown under the app's memory folder (<memory>/<scope>/<scope id>/<key>.md).",
    "",
    "What is in them: project memory holds what a project is, the rules the user set for it and decisions worth keeping; global memory holds preferences that hold everywhere; a conversation's notes hold what one conversation worked out. They are ordinary files - read and edit them with the read and edit tools once this has told you where they are.",
    "",
    "When to search: before asking the user something they may already have told you, before deciding a convention this project has probably already settled, and when a task sounds like one that has been done here before. A search costs one call; asking the user again costs their patience.",
    "",
    "How to search:",
    "Words are matched separately and a file matching any of them counts, ranked by how many and how rare; weak matches on common words are dropped. One to three distinctive words - a function name, an id, a rare term - work better than a sentence. Punctuation is ignored, so search the parts of a URL or path rather than the whole.",
    "A result is reliable even when another phrasing found nothing. Snippets are cut short: read the file at the given path for the whole text.",
    "When nothing is found, try fewer or rarer words, widen the scope, search the memory folder with grep for literal strings, or, when your tools include one that searches past conversations, search them for the exact wording.",
    "scope narrows to global, projects or sessions; scope_id to one project or conversation folder; type to memory, notes, progress, checkpoint or free.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["search"], description: "Always search" },
      query: { type: "string", description: "The words to look for" },
      scope: { type: "string", enum: [...MEMORY_SCOPES], description: "Only this scope" },
      scope_id: { type: "string", description: "Only this project or conversation folder" },
      type: { type: "string", description: "Only this type of file" },
      limit: { type: "number", description: "Most results, default 10" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const service = historyService()
    if (!service) throw new ToolError("Memory search is not available in this session.")
    // MiMo's explore agent is denied this tool; it is not offered to one, and refused if called anyway.
    if ((await service.store.get(context.sessionID))?.subagent?.type === "explore") throw new ToolError("An explore subagent cannot search memory.")
    const query = text(input.query) ?? ""
    const scope = text(input.scope)
    if (scope && !(MEMORY_SCOPES as readonly string[]).includes(scope)) throw new ToolError(`scope must be one of ${MEMORY_SCOPES.join(", ")}.`)
    const limit = typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit >= 1 ? Math.floor(input.limit) : undefined
    const hits = await service.memory.search({ query, scope: scope as MemoryScope | undefined, scope_id: text(input.scope_id), type: text(input.type), limit })
    if (!hits.length) {
      return {
        title: "Memory search: 0 results",
        output: [
          `Nothing in memory matched "${query}". That does not mean it was never written down:`,
          "- try one or two rarer words, since every word counts separately and common ones rank low;",
          "- grep the memory folder for a literal string the search splits apart (a URL, a port, a path);",
          "- search past conversations for what was said or run word for word, when your tools include one that does.",
          "Widen step by step: this conversation, the project, global, then past conversations.",
        ].join("\n"),
        metadata: { count: 0 },
      }
    }
    const lines = [
      `${hits.length} result${hits.length === 1 ? "" : "s"}, best first. Read a path for the whole file; when your tools include one that searches past conversations, use it for an exact value the note only paraphrases.`,
      "",
    ]
    for (const hit of hits) {
      lines.push(`### ${hit.path}`, `Scope: ${hit.scope}${hit.scope_id ? `/${hit.scope_id}` : ""}, Type: ${hit.type}, Score: ${hit.score.toFixed(3)}`, hit.snippet, "")
    }
    return { title: `Memory search: ${hits.length} result${hits.length === 1 ? "" : "s"}`, output: lines.join("\n"), metadata: { count: hits.length } }
  },
}
