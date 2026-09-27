import type { QuestionPrompt, WebSearchProviderID, WebSearchSelection } from "@shared/protocol"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { WEB_SEARCH_PROVIDERS, WebSearchHttpError, searchWeb, webSearchProvider, webSearchText } from "../websearch"

/**
 * OpenCode v2's `websearch` tool (tool/plugin/websearch.ts, MIT).
 *
 * The first search asks the user, once for the app, whether queries may go to
 * the search services and which; the answer is kept in the settings. Turned
 * off, the tool is not offered at all (registry `toolsForTurn`).
 */

/** The consent question's options, as the model and the stored card read them; the window draws its own words. */
export const WEB_SEARCH_ALLOW = "Allow"
export const WEB_SEARCH_CHOOSE = "Choose another provider"
export const WEB_SEARCH_DISABLE = "Disable web search"

// v2's messages for the two refusals it names.
const HTTP_ERRORS = new Map([
  [429, "Web search rate limited (HTTP 429)"],
  [401, "Web search authentication failed (HTTP 401)"],
])

/** One question at a time for the whole app: two searches in one step must not ask twice (v2 providerSelectionLock). */
let choosing: Promise<void> = Promise.resolve()

function consentQuestions(): QuestionPrompt[] {
  const names = WEB_SEARCH_PROVIDERS.map((provider) => provider.name).join(", ")
  return [
    {
      question: "Allow MCode to search the web for up-to-date information?",
      header: "Web Search",
      options: [
        { label: WEB_SEARCH_ALLOW, description: `Allow search via ${names}` },
        { label: WEB_SEARCH_CHOOSE, description: "Search with one of them only" },
        { label: WEB_SEARCH_DISABLE, description: "Do not search the web" },
      ],
      // Only these three answers mean anything; the form offers no box to type in (v2's custom: false).
      custom: false,
      websearch: "consent",
    },
  ]
}

function providerQuestions(): QuestionPrompt[] {
  return [
    {
      question: "Choose a provider for web search.",
      header: "Web Search",
      options: WEB_SEARCH_PROVIDERS.map((provider) => ({ label: provider.name, description: "" })),
      custom: false,
      websearch: "provider",
    },
  ]
}

/** The user's choice, asked for if it has never been made. False when they turned search off. */
async function chosen(context: ToolContext): Promise<WebSearchSelection> {
  const access = context.webSearch
  if (!access) throw new ToolError("Web search is not available here")
  // A value this build does not know - a service name typed by hand into config.json - is asked about again rather than failing every search.
  const known = (value: WebSearchSelection | undefined) => value === false || value === "auto" || (typeof value === "string" && webSearchProvider(value) !== undefined)
  const stored = access.selection()
  if (known(stored)) return stored as WebSearchSelection
  // A subagent cannot put a question in front of the user; the conversation that started it can.
  if (context.subagent) throw new ToolError("Web search has not been allowed yet. Only the main conversation can ask the user; say that you need it.")
  const turn = choosing.then(async () => {
    if (known(access.selection())) return
    const ask = (questions: QuestionPrompt[]) =>
      context.questions
        .ask({ sessionID: context.sessionID, questions, tool: { messageID: context.messageID, callID: context.callID }, signal: context.signal })
        .then((answers) => (answers[0] ?? []).map((entry) => entry.trim()))
    const answer = await ask(consentQuestions())
    if (answer.includes(WEB_SEARCH_DISABLE)) return access.select(false)
    if (answer.includes(WEB_SEARCH_CHOOSE)) {
      const name = (await ask(providerQuestions()))[0]
      const provider = WEB_SEARCH_PROVIDERS.find((entry) => entry.name === name)
      if (!provider) throw new ToolError("Web search cancelled")
      return access.select(provider.id)
    }
    if (answer.includes(WEB_SEARCH_ALLOW)) return access.select("auto")
    throw new ToolError("Web search cancelled")
  })
  // A failed or dismissed question leaves the next search free to ask again.
  choosing = turn.catch(() => undefined)
  try {
    await turn
  } catch (error) {
    if (error instanceof ToolError) throw error
    throw new ToolError("Web search cancelled")
  }
  const now = access.selection()
  return known(now) ? (now as WebSearchSelection) : false
}

export const WebSearchTool: ToolDefinition = {
  name: "websearch",
  // v2's description, with the year worked out at each request rather than at start-up.
  get description() {
    return `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`
  },
  // The network bucket webfetch asks in: a search sends the query to a service, as a fetch sends the address.
  permission: "webfetch",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Websearch query" } },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const query = typeof input.query === "string" ? input.query.trim() : ""
    if (!query) throw new ToolError("query is required")
    const selection = await chosen(context)
    if (selection === false) throw new ToolError("The user has turned web search off. Do not search the web; work from what you already have or ask for a page to fetch.")
    const named = selection === "auto" ? undefined : webSearchProvider(selection)
    await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "webfetch",
      directory: context.directory,
      title: "Search the web",
      subject: query,
      ...(named ? { preview: `${named.name}: ${query}` } : {}),
    })
    let provider: WebSearchProviderID | undefined
    try {
      const found = await searchWeb(query, {
        selection,
        sessionID: context.sessionID,
        signal: context.signal,
        onProvider: (entry) => {
          provider = entry.id
          context.progress(`Searching with ${entry.name}`)
        },
      })
      return { output: webSearchText(found.results), title: query, metadata: { provider: found.provider, results: found.results.length } }
    } catch (error) {
      if (context.signal.aborted) throw error
      const message = error instanceof WebSearchHttpError ? (HTTP_ERRORS.get(error.status) ?? `Web search request failed (HTTP ${error.status})`) : `Unable to search the web for ${query}`
      throw new ToolError(provider ? `${message} [${webSearchProvider(provider)?.name ?? provider}]` : message)
    }
  },
}
