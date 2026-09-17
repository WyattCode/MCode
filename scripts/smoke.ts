/**
 * End-to-end smoke test for the backend, driven over the real WebSocket.
 *
 * Everything except the provider call is exercised here: session lifecycle,
 * persistence across a restart, the tool implementations, the permission
 * round-trip, and the diff renderer. No API key is required - the agent loop
 * itself is the one piece this cannot reach without one.
 */
import { nameFromId } from "../src/server/provider/model-name"
import { commandRisk } from "../src/server/command-risk"
import { Permissions } from "../src/server/permission"
import { DEFAULT_PERMISSIONS as PERMISSION_DEFAULTS } from "../src/shared/protocol"
import { discoverModels } from "../src/server/provider/discover"
import { isSummary } from "../src/server/session/summary"
import { OpenAICompatible, toMessages } from "../src/server/provider/openai"
// round 6 (L2): a tool result's media on each wire.
import { toProviderMessages } from "../src/server/provider/anthropic"
import { modelVariants } from "../src/server/provider/variants"
import { ProviderError } from "../src/server/provider/types"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WebSocket } from "ws"
import { startBackend } from "../src/server/index"
import { linkInArgs, parseSessionLink, sessionLink } from "../src/shared/session-link"
import { readTask, smartRoute } from "../src/shared/smart"
import { chimeOf, longTask, migrateChime } from "../src/shared/chime"
import { audioVerdict, isAudioFile, limitMinutes } from "../src/renderer/src/lib/audio-check"
import { draftFileOf, emptyDraftFile, isEmptyDraftFile, readDraftFile, withLegacyHome, type SavedDraft } from "../src/renderer/src/lib/draft-file"
import { findInMessages, searchMessages, snippetAround } from "../src/server/search"
import type { ClientFrame, Request, ServerEvent, ServerFrame } from "../src/shared/protocol"
import { PERMISSION_KINDS } from "../src/shared/protocol"
import { TOOLS, findTool, toolsFor } from "../src/server/tool/registry"
import { repositoryState, systemPrompt } from "../src/server/session/prompt"
// plan: where a plan lives, what planning may write, and what each planning turn is told.
import {
  buildSwitchNote,
  carryOutNote,
  firstPlanNote,
  guardPlanWrite,
  laterPlanNote,
  newSlug,
  planDisplay,
  planFile,
  planFolders,
  planWritable,
  slugOf,
} from "../src/server/session/plan"
import { PlanExitTool } from "../src/server/tool/plan-exit"
import { agentsState, deleteAgents, ensureAgents, setAgentsEnabled } from "../src/server/global-agents"
import { applyVoiceResult, editCue, isClearCommand, micFailure, splitSendWord, transcribeFailure } from "../src/renderer/src/lib/voice"
import { clampEffort, effortFamily, effortLabelKey, modelFamily } from "../src/renderer/src/lib/model"
import { rovingStep } from "../src/renderer/src/lib/composer-menu"
import { displayServerPref, displaySwitches, ozonePlatform, readDisplayServerFile } from "../src/main/display-server"
import { PowerHold } from "../src/main/power"
import { RecoverySchedule, RendererHealth, SHOW_FALLBACK_MS, STARTUP_TIMEOUT, recoveryVisibility } from "../src/main/renderer-health"
import { readBootPrefs, windowBackground, writeBootPrefs } from "../src/main/boot-prefs"
import { deliveryOf, waitForDelivery } from "../src/main/install-notice"
import { boundsOnShow, clampToWorkAreas, closeBounds } from "../src/main/work-area"
import { DailyLog, dayOfLogFile, expiredLogFiles, logFileName, logLine, redactSecrets } from "../src/main/log-file"
import { builtinSuggestions } from "../src/renderer/src/lib/home-suggestions"
import { applyVoiceResult, splitSendWord } from "../src/renderer/src/lib/voice"
import { chordOf, formatChord, isBindable } from "../src/renderer/src/lib/keys"
import { RETIRED_DEFAULTS, normalizeChord, retireKeybinds } from "../src/shared/chord"
import { PAGE_ROWS, pageRows } from "../src/renderer/src/lib/shortcut-page"
import { LIMIT_PRESETS, limitOf, validEndpoint } from "../src/renderer/src/lib/custom-model"
import { mergeMcpSecrets } from "../src/server/mcp-save"
// round 5: MCP names, folder, server messages, results, transports and sampling.
import { McpRequestError, McpServers, mcpToolOutput, mcpToolSchema } from "../src/server/mcp"
// round 6: MiMo's n-gram check on a reply that repeats its own wording.
import { NGRAM_BLOCK, REPEAT_RECOVERIES, REPEAT_THRESHOLD, WINDOW_TOKENS, repeatNoteFor, repeatTokens, repeatsBlock, repeatsText } from "../src/server/session/reminders"
import { createSampler, samplingPolicy, samplingRequest } from "../src/server/mcp-sampling"
import type { McpServerConfig } from "../src/shared/protocol"
import { ToolOutputs } from "../src/server/tool/truncate"
import { readAsks, verdictApproves, wildcardMatch } from "../src/server/permission"
import { dangerousCommand, readOnlyCommand } from "../src/server/command-risk"
import { normalizeToolInput, resolveToolName } from "../src/server/tool/repair"
import { repairableNames } from "../src/server/tool/registry"
import { STALL, stallGuard } from "../src/server/provider/stall"
import { arityPrefix, collectMutationTargets, scanCommand, simpleCommands } from "../src/server/tool/bash-scan"
// round 6 (L8): where a blank project's folder is made.
import { blankProjectDirectory } from "../src/server/scratch"
// round 6 (L6): a thumbnail needs the attachment's bytes, which a saved draft no longer carries.
import { preview } from "../src/renderer/src/lib/attach"
import { blockedIPv4, blockedIPv6 } from "../src/server/tool/webfetch"
import { ago, t } from "../src/renderer/src/lib/i18n"
import {
  VOICE_EDIT_MAX,
  VOICE_EDIT_PROMPT,
  handle,
  parseVoiceEdit,
  voiceDraftOf,
  voiceEditMessages,
  voiceFetchFailure,
  voiceHttpFailure,
} from "../src/server/handlers"
import { PROJECT_LIST_MIGRATION, customModelOf } from "../src/server/config"
import { listedProjects, projectsByRecency, reconciledProjects } from "../src/shared/projects"
import { sessionGroup } from "../src/shared/session-group"
import { askGithub, githubRepository, hasGithubRemote, pullRequestFrom, pullRequestState, type FetchLike, type GitRunner } from "../src/server/pull-request"
import type { AppConfig, ResponseMap } from "../src/shared/protocol"
import { closeHidesToTray } from "../src/shared/protocol"
import { addressToURL, pageMayNavigate, safeURL } from "../src/shared/web-address"
import * as mediaPlatform from "../src/shared/media-platform"
import { serveCover } from "../src/main/media-cover"
import * as abcPlay from "../src/renderer/src/lib/abc-play"
import { SOUNDFONT, soundfontProblem } from "../src/shared/soundfont"
import { readSoundfont } from "../src/main/soundfont"
import * as soundfontScript from "./soundfont.mjs"
import {
  APP_CHORDS,
  barMode,
  browserTabFace,
  loadErrorKind,
  localServerOf,
  pageFavicon,
  pageKeyAction,
  pageMenuGroups,
  routeWindowOpen,
  stepZoom,
  type PageKeyInput,
} from "../src/shared/browser-page"
import { ToolError } from "../src/server/tool/types"
import { argumentProblems, refusedArgumentsNote } from "../src/server/tool/validate"
import { RETRY_BUDGETS, isRetryable, retryDecision } from "../src/server/session/retry"
import { ProviderHttpError } from "../src/server/provider/types"
import type { Annotation, PermissionRecord } from "../src/shared/protocol"
import type { ServerResponse } from "node:http"
import { PermissionDenied, Permissions } from "../src/server/permission"
import { QUESTION_DISMISSED, QuestionTool, Questions } from "../src/server/tool/question"
import { accessAction, defaultAccess, sessionAccess } from "../src/shared/access"
import {
  accessPatch,
  fullAccessOff,
  composerAnswers,
  confirmQueue,
  guideShown,
  mergeCustom,
  nextStop,
  questionOutcome,
  toggleChoice,
} from "../src/renderer/src/lib/confirm-queue"
import type { PermissionRequest, QuestionRequest } from "../src/shared/protocol"
import { parseUnifiedDiff, recountedSection, reverseSection, sectionPatch } from "../src/shared/unified-diff"
import { annotationsBlock } from "../src/shared/annotations"
import { revertTurnFiles } from "../src/server/session/turn-revert"
import { branchTitle } from "../src/server/session/store"
import { failureCode, failureDetail } from "../src/server/session/error-map"
import { turnFileDiffs } from "../src/server/session/turn-diff"
import { cardCut, latestTurnParts, stepPart, stickState, stoppedEmpty } from "../src/renderer/src/components/parts/turn-end"
import type { AssistantPart, ToolPart } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { unifiedDiff } from "../src/server/diff"
import { globToRegExp } from "../src/server/tool/ignore"
import { discoverSubscriptionModels } from "../src/server/provider/discover"
import { workspaceInfo } from "../src/server/workspace"
import * as gitOps from "../src/server/git"
import { sessionArtifacts, sessionReferences } from "../src/shared/session-files"
import { artifactGroups, infoTasks } from "../src/renderer/src/lib/session-info"
import type { TaskItem } from "../src/shared/protocol"
import { TASK_ARCHIVE_MS, applyTask, listedTasks, nextTaskID } from "../src/server/tool/task"
import { buildRows, retryReason } from "../src/renderer/src/lib/step-rows"
import { matchingNames, wordMatch } from "../src/renderer/src/lib/word-match"
import { ARTIFACT_PAGE, artifactAbsolute, artifactAge, artifactCategory, badgeOf } from "../src/renderer/src/lib/artifact-kind"
import { conversationMarkdown, exportFileName } from "../src/renderer/src/lib/convo-markdown"
import { ChatGPTSubscription } from "../src/server/provider/chatgpt"
import type { TurnEvent } from "../src/server/provider/types"
import { toProviderMessages, usageFrom } from "../src/server/provider/anthropic"
import {
  CHATGPT,
  CallbackServer,
  accountId,
  begin,
  beginDevice,
  decodeClaims,
  needsRefresh,
  pollDevice,
  type OAuthProvider,
} from "../src/server/auth/oauth"
import { filterMenu } from "../src/renderer/src/lib/menu"
import { arbitratePanel, boundChord, clampSideWidth, panelWidthShown, sideFits, sideWidthMax, toolHints } from "../src/renderer/src/lib/right-tools"
import { crumbsFor, editCounts, fileCategory, relativeTo, rowIndent, saveFailureKey, treeRows } from "../src/renderer/src/lib/files-tab"
import { capDiff, normalizeLayout, parseDiffFiles, reviewRows, splitPath, splitRows } from "../src/renderer/src/lib/diff-view"
import { interruptedTurn } from "../src/shared/resume"
import { detectCodeLanguage, insertFence } from "../src/renderer/src/lib/paste-code"
import {
  appendMentions,
  mentionBackspace,
  projectRelative,
  promptHistory,
  slashAt,
  slashLead,
} from "../src/renderer/src/lib/composer-text"
import type { Message } from "../src/shared/protocol"
import { DELAY as TIP_DELAY, EDGE as TIP_EDGE, GAP as TIP_GAP, WARM as TIP_WARM, fit as fitTip, openDelay, tipText } from "../src/renderer/src/lib/tip"
import { dismiss, notice, notify, notifyFailure, toastID, toasts } from "../src/renderer/src/lib/toast"
import { imagePreview, imagePreviewFileTools, imagePreviewKey, openImagePreview } from "../src/renderer/src/lib/image-preview"
import {
  clampPanelHeight,
  isPasteKey,
  nextTerminalNumber,
  shouldRespawn,
  showMismatch,
  storedPanelHeight,
  terminalLabel,
  terminalPalette,
} from "../src/renderer/src/lib/terminal"
import { typedInput } from "../src/shared/terminal-input"
import { Shells } from "../src/server/shell"
import { audioBubbleWidth, audioClock } from "../src/renderer/src/lib/media-card"
import { originTransform } from "../src/renderer/src/lib/image-preview"
import { dismiss, notice, notify, notifyFailure, toastID, toastTitle, toasts, zoomNotice } from "../src/renderer/src/lib/toast"
import { t as translate } from "../src/renderer/src/lib/i18n"
import { LINGER as SCROLLBAR_LINGER } from "../src/renderer/src/lib/scrollbars"
// subagents: the task tool driven through the real runner over a fake provider, and the pure pieces the window uses.
import { Storage as SubagentStorage } from "../src/server/storage"
import { Config as SubagentConfig } from "../src/server/config"
import { SessionStore as SubagentStore } from "../src/server/session/store"
import { SessionRunner as SubagentRunner } from "../src/server/session/runner"
import { reachOf } from "../src/server/tool/registry"
import { SUBAGENT_TIMERS, isStalled, noticeText, subagentAnswer, subagentOutput, subagentTone, actorAction, answerSummary, readLegacyMessage, statusHeader } from "../src/shared/subagent"
import { STRUCTURED_REMINDER } from "../src/server/tool/subagent"
import { COMPLETED_CAP, isPill, noticeStatus, pillStatus, subagentItems, subagentTime } from "../src/renderer/src/lib/subagents"
import { stepTitle as subagentStepTitle, stepVerb as subagentStepVerb } from "../src/renderer/src/lib/tool-meta"
import type { SessionInfo as SubagentSession, SubagentNotice, SubagentNoticeStatus } from "../src/shared/protocol"
// round 4: MiMo's built-in window tools and the pieces the window uses.
import type { PresentSkip, PresentedFile } from "../src/server/tool/present"
import { LANGUAGE_IDS, bindDesktopSettings } from "../src/server/tool/desktop-settings"
import { deliveredCard, deliveredFiles, projectPath, relativeInside, sizeLabel } from "../src/renderer/src/lib/delivered"
import { prRowState } from "../src/renderer/src/lib/pr-row"
import { addFileNotice, fileNoticesBlock } from "../src/shared/file-notices"
import { withAnnotations } from "../src/shared/annotations"
import { stepTitle as deliveredStepTitle, toolIcon as deliveredToolIcon, toolVerb as deliveredToolVerb } from "../src/renderer/src/lib/tool-meta"
import { LANGUAGES as INTERFACE_LANGUAGES } from "../src/renderer/src/lib/i18n"
import { freeCopyName, saveCopy } from "../src/main/save-copy"
import { subagentAnswer, subagentOutput, subagentTone } from "../src/shared/subagent"
import { COMPLETED_CAP, isPill, pillStatus, subagentItems, subagentTime } from "../src/renderer/src/lib/subagents"
import {
  WINDOW_MIN,
  badgeCount,
  firstRunSize,
  nextZoom,
  noticeTitle,
  quitPress,
  readTaskNotice,
  textMenuItems,
  wantsNotice,
} from "../src/main/desktop-rules"

// session chat: conversations messaging each other, through the real runner over a fake provider, and the pieces the side column draws.
import { CHAT_HOPS, replyIn, withChatHeaders } from "../src/server/session/chat"
import { IndexDatabase } from "../src/server/history/database"
import { HistoryIndex } from "../src/server/history/index"
import { bindHistory, type HistoryService } from "../src/server/history/service"
import { parsePartID, partID } from "../src/server/history/extract"
import { ftsQuery, pageOf, summaryOf, withoutInlineMedia } from "../src/server/history/text"
import { MemoryIndex } from "../src/server/memory/index"
import { memoryFiles, memoryLocation, memoryType, projectMemoryID } from "../src/server/memory/paths"
import { HISTORY_BUDGET, HistoryTool } from "../src/server/tool/history"
import { MemoryTool } from "../src/server/tool/memory"
import { CronTool, cronOperation } from "../src/server/tool/cron"
import { clampLoopDelay, nextCronRun, oneShotFireAt, parseCron, recurringFireAt } from "../src/server/cron/expr"
import { cronFile, readCronTasks, writeCronTasks } from "../src/server/cron/tasks"
import { CronScheduler, KEEPALIVE_DELAY_SECONDS, bindScheduler } from "../src/server/cron/scheduler"
import { resolvePath as resolveToolPath } from "../src/server/tool/fs-util"
import type { Message as HistoryMessage, SessionInfo as HistorySession } from "../src/shared/protocol"
import type { ToolContext as HistoryToolContext } from "../src/server/tool/types"
import { nextOccurrence, parseRRule, scheduleLabel } from "../src/server/automation/rrule"
import { AutomationService, notifies } from "../src/server/automation/service"
import { AUTOMATION_RUN_NOTE, withAutomationNotes } from "../src/server/automation/framing"
import { isScheduledPrompt } from "../src/shared/scheduled"
import { chatLinkText, convoCard, sortedChatLinks } from "../src/renderer/src/lib/convo-card"
import type { ChatLink, Message as ChatMessage, UserMessage as ChatUserMessage } from "../src/shared/protocol"

import { roundFiveChecks } from "./smoke-round5"
// round 6: the eight differences the user decided on 2026-09-16 to close.
import { roundSixChecks } from "./smoke-round6"
// Round 7: what the model actually receives - the local estimate, pruning, the environment block, provider fields.
import { roundSevenChecks } from "./smoke-round7"
// Round 8: the attack surface - who may reach the backend, what the tools may touch.
import { roundEightSecurityChecks } from "./smoke-round8-security"
import { socketProtocols } from "../src/shared/socket-auth"
// Round 8: the keyboard and assistive-technology barriers (A1-A15).
import { roundEightAccessChecks } from "./smoke-round8-access"
// Round 8: the wording rules the eighteen language tables keep.
import { wordingChecks } from "./smoke-wording"
import { roundEightChecks } from "./smoke-round8"
// Round 9: providers and models - request shaping per family, endpoints, fallbacks, the model catalog.
import { roundNineProviderChecks } from "./smoke-round9-providers"
import { roundNineWindowsChecks } from "./smoke-round9-windows"
import { roundNineMcpChecks } from "./smoke-round9-mcp"
import { roundNineSettingsChecks } from "./smoke-round9-settings"
// round 10: the agent-type tools (subagents, tasks, questions, plans, automations, cross-chat, history, skills).
import { roundTenAgentChecks } from "./smoke-round10-agents"
// The round-six audit of failures and edge cases (F1 onwards).
import { failureChecks } from "./smoke-failures"
// Round 7: the rest of that audit - F14-F42 - closed in this pass.
// round 7 (storage): what the profile keeps, in its own file for the same reason.
import { storageChecks } from "./smoke-storage"
// skills: discovery, frontmatter and the slash list.
import { parseFrontmatter } from "../src/server/frontmatter"
import { builtinSkillsRoot, discoverSkills, isSkillPath, skillReminders, withSkillReminders } from "../src/server/skill"
import { expandCommand, listCommands } from "../src/server/command"
import { expandTemplate, fileReferences, shellPlaceholders, substituteShell } from "../src/shared/command"
import { SEARCH, SKILL_FILE_SAMPLE, SkillSearchTool, SkillTool, searchSkills, searchTokens } from "../src/server/tool/skill"
import { stepTitle as skillStepTitle, toolVerb as skillToolVerb } from "../src/renderer/src/lib/tool-meta"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

function section(name: string) {
  console.log(`\n${name}`)
}

async function main() {
  // round 5: the earlier sections script their providers reply by reply, and a background title request would take one.
  process.env.MCODE_GENERATE_TITLES = "0"
  // round 9: every backend a check starts stays off the network; the models.dev checks use a local server.
  process.env.MCODE_DISABLE_MODELS_FETCH = "1"
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-"))
  /*
   * Never the reader's own home: MCP servers are also read from ~/.claude.json
   * and ~/.mcode, and a check must not start the servers configured there.
   */
  process.env.MCODE_IMPORT_HOME ??= path.join(root, "home")
  const dataDirectory = path.join(root, "data")
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "hello.ts"), "export const greeting = 'hi'\nexport const count = 1\n")
  await fs.mkdir(path.join(project, "src"), { recursive: true })
  await fs.writeFile(path.join(project, "src", "app.ts"), "// TODO: implement\nexport function run() {}\n")
  await fs.writeFile(path.join(project, "AGENTS.md"), "Use two-space indentation.\n")

  // ---------------------------------------------------------------- protocol
  section("WebSocket protocol")
  // Tasks started with no project get folders of their own; keep them in here.
  process.env.MCODE_SCRATCH_ROOT = path.join(root, "scratch")
  // A stored config, so these checks run at the default level rather than a first install's 帮我审批 (R12).
  await fs.mkdir(path.join(dataDirectory, "storage"), { recursive: true })
  await fs.writeFile(path.join(dataDirectory, "storage", "config.json"), "{}")
  const backend = await startBackend(dataDirectory)
  check("backend picked a port", backend.port > 0, backend.port)

  // round 8 (X1): the socket admits only a client holding this launch's secret.
  const socket = new WebSocket(`ws://127.0.0.1:${backend.port}`, socketProtocols(backend.secret))
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })

  const events: ServerEvent[] = []
  const waiters = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let counter = 0

  socket.on("message", (raw) => {
    const frame: ServerFrame = JSON.parse(raw.toString())
    if (frame.kind === "event") {
      events.push(frame.event)
      return
    }
    const waiter = waiters.get(frame.id)
    if (!waiter) return
    waiters.delete(frame.id)
    if (frame.ok) waiter.resolve(frame.data)
    else waiter.reject(new Error(frame.error))
  })

  function call<T = any>(request: Request): Promise<T> {
    const id = `t${++counter}`
    const frame: ClientFrame = { kind: "request", id, request }
    return new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject })
      socket.send(JSON.stringify(frame))
    })
  }

  const config = await call({ type: "config.get" })
  // P9-4: a fresh profile names no model, so the picker reads "choose a model" rather than a provider nobody set up.
  check("config.get returns defaults", config.config.model.provider === "" && config.config.model.model === "", config.config.model)

  const created = await call({ type: "session.create", directory: project })
  const sessionID: string = created.session.id
  check("session.create returns a session", typeof sessionID === "string" && sessionID.startsWith("ses_"), sessionID)
  check("session.create broadcast an event", events.some((event) => event.type === "session.updated"))

  /*
   * "No project" on the home screen: a fresh empty folder under the scratch
   * root, a session marked as such, and a second one never sharing the first's.
   */
  const loose = await call({ type: "session.create", scratch: true })
  const looseAgain = await call({ type: "session.create", scratch: true })
  const looseStat = await fs.stat(loose.session.directory).catch(() => undefined)
  check(
    "a task with no project gets a folder of its own",
    loose.session.scratch === true &&
      path.dirname(loose.session.directory) === process.env.MCODE_SCRATCH_ROOT &&
      looseStat?.isDirectory() === true &&
      (await fs.readdir(loose.session.directory)).length === 0,
    loose.session,
  )
  check(
    "two tasks with no project never share a folder",
    looseAgain.session.directory !== loose.session.directory,
    [loose.session.directory, looseAgain.session.directory],
  )
  check("a task in a project is not marked as having none", created.session.scratch === undefined, created.session)

  /*
   * "Create blank project" on the home picker: an empty folder of the given
   * name under the same root, a taken name numbered rather than reused, and a
   * name Windows would refuse cleaned into one it accepts.
   */
  const blank = await call({ type: "project.createBlank", name: "Probe project" })
  const blankAgain = await call({ type: "project.createBlank", name: "Probe project" })
  const blankOdd = await call({ type: "project.createBlank", name: '  a<b>:c?.  ' })
  const blankStat = await fs.stat(blank.directory).catch(() => undefined)
  check(
    "a blank project is an empty folder of that name under the project location",
    path.dirname(blank.directory) === process.env.MCODE_SCRATCH_ROOT &&
      path.basename(blank.directory) === "Probe project" &&
      blankStat?.isDirectory() === true &&
      (await fs.readdir(blank.directory)).length === 0,
    blank.directory,
  )
  check("a taken blank project name is numbered, not reused", path.basename(blankAgain.directory) === "Probe project (2)", blankAgain.directory)
  check("a blank project name Windows would refuse is cleaned", path.basename(blankOdd.directory) === "a b c", blankOdd.directory)

  /*
   * The search overlay's transcript search: a line around the words with them
   * marked, what was said rather than reasoned, and one hit per conversation
   * with archived ones and side chats left out.
   */
  const cut = snippetAround("x".repeat(60) + "zebra" + "\ny".repeat(60), 60, 5)
  check(
    "a search snippet is one line around the words, cut with ellipses, the words marked",
    cut.text.startsWith("…") && cut.text.endsWith("…") && !cut.text.includes("\n") &&
      cut.text.slice(cut.ranges[0].start, cut.ranges[0].end) === "zebra",
    cut,
  )
  const said = [
    { id: "u1", sessionID: "s", role: "user", text: "Where is the Zebra?", attachments: [], time: { created: 1 } },
    {
      id: "a1", sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build",
      parts: [{ type: "reasoning", id: "r", text: "hidden giraffe", time: { created: 1 } }, { type: "text", id: "t", text: "By the giraffe." }],
      time: { created: 2 },
    },
  ] as unknown as Parameters<typeof findInMessages>[0]
  const zebra = findInMessages(said, "zebra")
  check("search finds the words in what was asked, whatever their case", zebra?.messageID === "u1" && zebra.text.slice(zebra.ranges[0].start, zebra.ranges[0].end) === "Zebra", zebra)
  check("search reads what was answered", findInMessages(said, "by the giraffe")?.messageID === "a1")
  check("search does not read reasoning", findInMessages(said, "hidden") === undefined)
  const sessionsForSearch = [
    { id: "old", updated: 1 },
    { id: "new", updated: 3 },
    { id: "gone", updated: 2, archived: true },
    { id: "side", updated: 4, sideOf: "new" },
  ] as unknown as Parameters<typeof searchMessages>[0]
  const found = await searchMessages(sessionsForSearch, async () => said, "zebra")
  check(
    "search gives one hit per conversation, newest first, without archived ones or side chats",
    found.map((hit) => hit.sessionID).join(",") === "new,old",
    found,
  )
  await call({ type: "session.delete", sessionID: loose.session.id })
  await call({ type: "session.delete", sessionID: looseAgain.session.id })

  /*
   * The default project location: a chosen folder takes the next task with no
   * project, and clearing the choice sends the one after back to the default.
   */
  const chosenRoot = path.join(root, "chosen-root")
  await call({ type: "config.set", patch: { projectRoot: chosenRoot } })
  const placed = await call({ type: "session.create", scratch: true })
  await call({ type: "config.set", patch: { projectRoot: "" } })
  const unplaced = await call({ type: "session.create", scratch: true })
  check(
    "a chosen project location takes the next task with no project",
    path.dirname(placed.session.directory) === chosenRoot,
    placed.session.directory,
  )
  check(
    "clearing the location sends the next one back to the default",
    path.dirname(unplaced.session.directory) === process.env.MCODE_SCRATCH_ROOT,
    unplaced.session.directory,
  )
  await call({ type: "session.delete", sessionID: placed.session.id })
  await call({ type: "session.delete", sessionID: unplaced.session.id })

  /*
   * 移动至项目 and 移出项目, as MiMo's `moveToProject` does them: the grouping
   * label moves and nothing else. The folder the conversation works in stays
   * where it was, so its commands, its relative paths and its per-project
   * approvals all still point at the same place.
   */
  const other = path.join(project, "another-project")
  await fs.mkdir(other, { recursive: true })
  const leaving = await call({ type: "session.create", directory: project })
  const foldersBefore = (await fs.readdir(process.env.MCODE_SCRATCH_ROOT!)).length
  const moved = await call({ type: "session.move", sessionID: leaving.session.id, directory: other })
  check(
    "moving a conversation to another project changes only the grouping label",
    moved.session.group === other && moved.session.directory === project && moved.session.scratch === undefined,
    moved.session,
  )
  check("the conversation is filed under the project it was moved to", sessionGroup(moved.session) === other, sessionGroup(moved.session))
  const left = await call({ type: "session.moveOut", sessionID: leaving.session.id })
  const foldersAfter = (await fs.readdir(process.env.MCODE_SCRATCH_ROOT!)).length
  check(
    "moving out of a project files it under none and still makes no folder",
    left.session.group === "" && sessionGroup(left.session) === undefined && left.session.directory === project && foldersAfter === foldersBefore,
    { session: left.session, foldersBefore, foldersAfter },
  )
  const returned = await call({ type: "session.move", sessionID: leaving.session.id, directory: project })
  check(
    "moving it back to its own project files it there again",
    sessionGroup(returned.session) === project && returned.session.directory === project,
    returned.session,
  )
  const moveOutRefused = await call({ type: "session.moveOut", sessionID: "ses_missing" }).then(
    () => false,
    () => true,
  )
  check("moving out a session that does not exist is refused", moveOutRefused)
  /*
   * Conversations stored before the label existed: one in a project and one
   * with a folder of its own. Neither carries a label, and both must be filed
   * exactly where they always were.
   */
  const storedInProject = { directory: project, updated: 1, scratch: undefined, group: undefined }
  const storedWithoutProject = { directory: path.join(project, "made-for-it"), updated: 1, scratch: true, group: undefined }
  check(
    "a conversation stored before the label is still filed by the folder it works in",
    sessionGroup(storedInProject) === project && sessionGroup(storedWithoutProject) === undefined,
  )
  await call({ type: "session.delete", sessionID: leaving.session.id })

  /*
   * The side column's menus and notices, which are plain logic under their
   * components: a submenu's search keeps its sticky rows and counts only real
   * matches, and a notice raised twice replaces itself rather than stacking.
   */
  const moveRows = [
    { key: "out", label: "Move out", sticky: true },
    { key: "a", label: "Alpha" },
    { key: "b", label: "Beta" },
  ]
  const alpha = filterMenu(moveRows, "  ALP ")
  check("a submenu search keeps sticky rows and matches labels without case", alpha.rows.map((row) => row.key).join(",") === "out,a" && alpha.matched === 1, alpha)
  const none = filterMenu(moveRows, "zzz")
  check("a submenu search that matches nothing reports no matches but keeps sticky rows", none.matched === 0 && none.rows.length === 1, none)
  check("an empty submenu search lists everything", filterMenu(moveRows, "").rows.length === 3)

  /*
   * L2: a tool result's media reaching the model. Anthropic takes a picture
   * inside the tool_result; the chat wire takes only text there, so it follows
   * as a message of its own. A model that reads no pictures gets the words.
   */
  {
    const shot = [{ path: "a.png", mime: "image/png", data: "iVBORw0KGgo=" }]
    const withMedia = (attachments: typeof shot): Parameters<typeof toMessages>[1] => [
      { id: "msg_u", sessionID: "ses_l2", role: "user", text: "look at this", attachments: [], time: { created: 1 } },
      {
        id: "msg_a",
        sessionID: "ses_l2",
        role: "assistant",
        model: { provider: "p", model: "m" },
        agent: "build",
        parts: [
          {
            type: "tool",
            id: "p1",
            callID: "call_1",
            name: "read",
            status: "completed",
            input: { file_path: "a.png" },
            output: '"a.png" is an image file, attached to this result.',
            attachments,
            time: { created: 2 },
          },
        ],
        time: { created: 2 },
      },
    ]
    const blocks = toProviderMessages(withMedia(shot), { image: true }, { provider: "p", model: "m" })
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => (block as { type?: string }).type === "tool_result")
    const inside = (blocks[0] as { content?: unknown })?.content
    check(
      "on the Anthropic wire a tool result carries its picture inside the result",
      Array.isArray(inside) && inside.some((block) => (block as { type?: string }).type === "image") && inside.some((block) => (block as { type?: string }).type === "text"),
      inside,
    )

    const chat = toMessages("sys", withMedia(shot), { image: true })
    const at = chat.findIndex((message) => message.role === "tool")
    const following = chat[at + 1] as { role?: string; content?: unknown }
    check(
      "on the chat wire the result stays text and the picture follows as its own message",
      typeof chat[at]?.content === "string" &&
        following?.role === "user" &&
        Array.isArray(following.content) &&
        following.content.some((piece) => (piece as { type?: string }).type === "image_url"),
      { tool: chat[at]?.content, following },
    )

    const blind = toMessages("sys", withMedia(shot), { image: false })
    check(
      "a model that reads no pictures is told so in the result and is sent none",
      String(blind.find((message) => message.role === "tool")?.content).includes("cannot read image input") &&
        !blind.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((piece) => (piece as { type?: string }).type === "image_url")),
      blind.find((message) => message.role === "tool")?.content,
    )
  }

  // MiMo's settings search: every typed word begins a word, camelCase split, CJK anywhere.
  check("a settings query matches the start of a word, not its middle", wordMatch("Keyboard shortcuts", "short") && !wordMatch("Keyboard shortcuts", "cuts"))
  check("every typed word has to begin some word", wordMatch("Keyboard shortcuts", "key sho") && !wordMatch("Keyboard shortcuts", "key zoom"))
  check("a camelCase word matches by its parts", wordMatch("hardwareAcceleration", "accel") && wordMatch("MCPServers", "servers") && wordMatch("MCPServers", "mcp"))
  check("a Chinese query matches anywhere", wordMatch("硬件加速 GPU", "加速") && !wordMatch("硬件加速", "减速"))
  check("a settings query ignores case and an empty one matches all", wordMatch("GPU rendering", "gpu") && wordMatch("anything", "  "))

  /*
   * L7: the @ menu narrows the folder it already listed, with that same
   * matcher, instead of asking the backend again for every keystroke.
   */
  const folderRows = [{ name: "runner.ts" }, { name: "README.md" }, { name: "hardwareAcceleration.ts" }, { name: "笔记.md" }]
  const namesOf = (query: string) => matchingNames(folderRows, query).map((entry) => entry.name).join(",")
  check("an @ query keeps the entries whose name a typed word begins", namesOf("run") === "runner.ts", namesOf("run"))
  check("it splits camelCase the way the settings search does", namesOf("accel") === "hardwareAcceleration.ts", namesOf("accel"))
  check("a Chinese query matches anywhere in the name", namesOf("笔记") === "笔记.md", namesOf("笔记"))
  check("an empty query keeps the whole folder, and one nothing answers keeps none", matchingNames(folderRows, "  ").length === folderRows.length && matchingNames(folderRows, "zzz").length === 0)

  /*
   * L1: MiMo's n-gram check on a reply that has fallen into repeating its own
   * wording - a block of words repeated back to back inside the last window.
   */
  const looped = (times: number) => Array.from({ length: times }, () => "alpha beta gamma delta").join(" ")
  check("a reply's words are folded to lower case and each CJK character is a word of its own", repeatTokens("Hi  There 你好").join("|") === "hi|there|你|好")
  /* Written as the figures measured from MiMo, not as whatever the constants happen to say, so moving one is a failure rather than a new goalpost. */
  check(
    "the figures are the ones measured from MiMo: a block of 4 words, 20 repeats, a window of 500",
    NGRAM_BLOCK === 4 && REPEAT_THRESHOLD === 20 && WINDOW_TOKENS === 500,
    { NGRAM_BLOCK, REPEAT_THRESHOLD, WINDOW_TOKENS },
  )
  check("a block of 4 words repeated 20 times over is a repeat, and 19 times over is not", repeatsText(looped(20)) && !repeatsText(looped(19)))
  check("the same word over and over is not, because the repeated block holds too few distinct words", !repeatsText("x ".repeat(REPEAT_THRESHOLD * NGRAM_BLOCK)))
  check(
    "how many distinct words the block must hold is what decides it",
    repeatsBlock(repeatTokens(looped(REPEAT_THRESHOLD)), NGRAM_BLOCK, REPEAT_THRESHOLD, 4) &&
      !repeatsBlock(repeatTokens(looped(REPEAT_THRESHOLD)), NGRAM_BLOCK, REPEAT_THRESHOLD, 5),
  )
  check(
    `only the last ${WINDOW_TOKENS} words are looked at, so a repeat already left behind is not one`,
    !repeatsText(`${looped(REPEAT_THRESHOLD)} ${Array.from({ length: WINDOW_TOKENS }, (_unused, at) => `w${at}`).join(" ")}`),
  )
  check(
    "a repeating reply is told once, told again more firmly, and then left to finish",
    repeatNoteFor(looped(REPEAT_THRESHOLD), 0) !== repeatNoteFor(looped(REPEAT_THRESHOLD), 1) &&
      repeatNoteFor(looped(REPEAT_THRESHOLD), REPEAT_RECOVERIES) === undefined &&
      repeatNoteFor("nothing repeats here at all", 0) === undefined,
  )

  // The reconnecting row's reason: one line, or nothing at all.
  check("a retry's reason is drawn on one line", retryReason("  overloaded\n  try later ") === "overloaded try later")
  check("a retry without a reason draws none", retryReason("") === undefined && retryReason(undefined) === undefined && retryReason(" \n ") === undefined)

  // A browser tab's face: the page's favicon when the window may load it, and its title.
  check("a favicon is the first http(s) or inline image address", pageFavicon(["file:///c:/x.ico", "javascript:1", "https://a.test/f.ico", "http://b.test/g.png"]) === "https://a.test/f.ico" && pageFavicon(["data:image/png;base64,AA"]) === "data:image/png;base64,AA")
  check("a page naming no loadable favicon has none", pageFavicon(["data:text/html,x", 3, ""]) === undefined && pageFavicon([]) === undefined)
  check("a browser tab is named by its page's title", browserTabFace({ url: "http://127.0.0.1:1/", title: " Probe \n page ", favicon: "http://127.0.0.1:1/f.png" }).pageTitle === "Probe page")
  check("a blank browser tab keeps the globe and the tool's name", JSON.stringify(browserTabFace({ url: "about:blank", title: "about:blank", favicon: "https://a.test/f.ico" })) === "{}")

  // The right panel's tool hints follow the shortcuts page, and MiMo's narrow-window rule.
  const panelCommands = [
    { id: "view.review", hint: "Ctrl+Shift+G" },
    { id: "app.openFile", hint: "Ctrl+P" },
    { id: "browser.tab", hint: "Ctrl+T" },
    { id: "session.side", hint: "Ctrl+Alt+S" },
  ]
  const panelHints = toolHints(panelCommands, { "app.openFile": "Ctrl+Shift+O", "browser.tab": "" })
  check("a panel tool's hint follows its rebinding", panelHints.files === "Ctrl+Shift+O", panelHints)
  check("a panel tool whose binding was cleared names no hint", panelHints.browser === undefined, panelHints)
  check("untouched panel tools keep their built-in hints", panelHints.review === "Ctrl+Shift+G" && panelHints.chat === "Ctrl+Alt+S" && panelHints.terminal === undefined, panelHints)
  check("a command never rebound answers to its default chord", boundChord("view.right", "Ctrl+Alt+B", {}) === "Ctrl+Alt+B")
  const crampedRoom = { viewport: 1200, sideWidth: 194, sideOpen: true, panelOpen: true, panelWidth: 500, fullscreen: false }
  check("a cramped window shuts the panel when the side column was just opened", arbitratePanel(crampedRoom, true) === "close-panel")
  check("a cramped window folds the side column otherwise", arbitratePanel(crampedRoom, false) === "collapse-side")
  check("480 left for the conversation keeps both open", arbitratePanel({ ...crampedRoom, viewport: 1236 }, false) === "none")
  check("an expanded panel is left out of the narrow-window rule", arbitratePanel({ ...crampedRoom, fullscreen: true }, false) === "none")
  check("a folded side column fits again only once there is room", sideFits({ ...crampedRoom, viewport: 1300 }) && !sideFits(crampedRoom))
  // R5: MiMo's side column drag - 160 to 420 past the rail, less where the conversation's 480 and the panel need it.
  check("the side column is dragged no wider than 420 on a wide window", sideWidthMax(2400, 380) === 420 && clampSideWidth(900, 2400, 380) === 420)
  check("the side column is dragged no narrower than 160", clampSideWidth(40, 2400, 0) === 160)
  check("a window beside an open panel narrows the side column's limit", sideWidthMax(1200, 380) === 1200 - 62 - 380 - 480 && clampSideWidth(400, 1200, 380) === 278)
  check("a very narrow window still allows 160", sideWidthMax(700, 380) === 160 && clampSideWidth(300, 700, 380) === 160)
  check("an unreadable stored width is the default 194", clampSideWidth(NaN, 1600, 0) === 194 && clampSideWidth(250.4, 1600, 0) === 250)
  // A narrow window: the panel is drawn narrower than dragged, down to 300, and gets its width back once there is room.
  check("a wide window shows the panel as dragged", panelWidthShown(380, 1600, 194, 300) === 380)
  check("a narrower window narrows the panel toward 300", panelWidthShown(380, 1050, 160, 300) === 348 && panelWidthShown(380, 800, 0, 300) === 300)
  check("a panel dragged under 300 is drawn at 300", panelWidthShown(120, 1600, 0, 300) === 300)
  const mimoRoom = { viewport: 1050, sideWidth: clampSideWidth(194, 1050, 380), sideOpen: true, panelOpen: true, panelWidth: panelWidthShown(380, 1050, clampSideWidth(194, 1050, 380), 300), fullscreen: false }
  check("the narrow-window rule weighs the panel as drawn, keeping both open at 1050", arbitratePanel(mimoRoom, false) === "none" && sideFits(mimoRoom), mimoRoom)
  const tightRoom = { ...mimoRoom, viewport: 1001, sideWidth: 160, panelWidth: panelWidthShown(380, 1001, 160, 300) }
  check("the side column folds once 160 and 300 no longer leave 480", arbitratePanel(tightRoom, false) === "collapse-side" && !sideFits(tightRoom), tightRoom)

  const noticeOnce = notify("Copied")
  const noticeTwice = notify("Copied")
  check("the same notice raised twice replaces itself", noticeOnce === noticeTwice && toasts.value.length === 1, toasts.value)
  notifyFailure("Copied")
  check("a notice of another level with the same title is a second notice", toasts.value.length === 2, toasts.value)
  notify("One", { level: "success" })
  notify("Two", { level: "warning" })
  check("at most three notices are kept, the oldest dropped", toasts.value.length === 3 && toasts.value[0]?.title === "Copied" && toasts.value[0]?.level === "danger", toasts.value)
  const linked = notice.info("Links", {
    links: [
      { label: "a", run: () => {} },
      { label: "b", run: () => {} },
    ],
    action: { label: "c", run: () => {} },
  })
  check("a notice carries at most two links", toasts.value.find((entry) => entry.id === linked)?.links.length === 2)
  check("a notice's identity is its level and its title", toastID("info", "x") === toastID("info", "x") && toastID("info", "x") !== toastID("danger", "x"))
  const old = notify("Saved", "C:/log.txt", { label: "Show", run: () => {} })
  const oldEntry = toasts.value.find((entry) => entry.id === old)
  check("an older caller's body folds into the title and its action still arrives", oldEntry?.title === "Saved · C:/log.txt" && oldEntry.links[0]?.label === "Show" && oldEntry.level === "info", oldEntry)
  for (const entry of [...toasts.value]) dismiss(entry.id)
  check("dismissing every notice empties the stack", toasts.value.length === 0)

  /* The long-task chime: past a minute only, and an unknown choice plays the default. */
  check(
    "a task of a minute exactly stays quiet and one past it chimes",
    !longTask(60_000) && longTask(60_001) && !longTask(Number.NaN),
  )
  check(
    "an unknown chime plays the default 晨曦 and off stays off",
    chimeOf("bogus") === "bloom" && chimeOf(undefined) === "bloom" && chimeOf("off") === "off" && chimeOf("koto") === "koto",
  )
  // R2: a figure chosen from the retired five keeps being a choice, moved to its nearest of MiMo's eight.
  check(
    "a stored chime from the old five moves to its nearest new one; off and new ids stay",
    migrateChime("settle") === "bloom" &&
      migrateChime("triple") === "vibes" &&
      migrateChime("sweep") === "harp" &&
      migrateChime("duet") === "kalimba" &&
      migrateChime("zen") === "bowl" &&
      migrateChime("off") === "off" &&
      migrateChime("handpan") === "handpan" &&
      migrateChime("nonsense") === "bloom",
  )

  // R15: MiMo reads attached audio before a send; only a file it cannot read, or one past ten minutes, stops it.
  check(
    "only MiMo's six audio extensions are read before a send",
    isAudioFile("C:/a/Voice.M4A") && isAudioFile("clip.flac") && !isAudioFile("clip.mp4") && !isAudioFile("notes.wav.txt"),
  )
  check(
    "an unreadable clip stops the send, a clip past ten minutes stops it, anything else goes",
    audioVerdict({ ok: false, unsupported: true }) === "unsupported" &&
      audioVerdict({ ok: true, durationMs: 600_001 }) === "tooLong" &&
      audioVerdict({ ok: true, durationMs: 600_000 }) === "ok" &&
      audioVerdict({ ok: false, unsupported: false }) === "ok" &&
      audioVerdict(undefined) === "ok" &&
      limitMinutes() === 10,
  )

  // R1: MiMo's saved composer input - every box's draft, its files and chips, and the annotations waiting.
  {
    const note = { id: "a1", kind: "answer", text: "why", quote: "x" } as Annotation
    const kept = new Map<string, SavedDraft>([
      ["home", { text: "hi", attachments: [], mentioned: [], skills: [] }],
      ["main:s1", { text: "", attachments: [{ path: "C:/a.png", mime: "image/png", data: "AAAA" }], mentioned: [], skills: ["review"] }],
      ["main:empty", { text: "", attachments: [], mentioned: ["x"], skills: [] }],
    ])
    const file = draftFileOf(kept, { s1: [note], s2: [] }, "main:s1")
    check(
      "drafts with words, files or chips are written and empty ones are not",
      Object.keys(file.drafts).sort().join(",") === "home,main:s1" && Object.keys(file.annotations).join(",") === "s1" && file.current === "main:s1",
    )
    check("the saved input reads back as it was written", JSON.stringify(readDraftFile(JSON.stringify(file))) === JSON.stringify(file))
    let threw = false
    try {
      readDraftFile("{broken")
    } catch {
      threw = true
    }
    check("a file of another version reads as nothing, and one that is not JSON throws", readDraftFile('{"v":2,"drafts":{}}') === undefined && threw)
    check(
      "malformed entries are left out",
      Object.keys(readDraftFile(JSON.stringify({ v: 1, drafts: { a: { text: 5, attachments: [{ path: 1 }] }, b: { text: "ok" } }, annotations: { s: [{ id: 1 }] } }))?.drafts ?? {}).join(",") === "b",
    )
    check(
      "the old home draft is folded in, never over home words already saved",
      withLegacyHome(emptyDraftFile(), "old words").drafts.home?.text === "old words" &&
        withLegacyHome(file, "old words").drafts.home?.text === "hi" &&
        withLegacyHome(emptyDraftFile(), "").drafts.home === undefined,
    )
    check("an empty state is recognised, so a failed load is never written over with one", isEmptyDraftFile(draftFileOf(new Map(), {})) && !isEmptyDraftFile(file))

    /* L6: MiMo writes down where a file is, not what is in it; only something pasted, with no file of its own, keeps its bytes. */
    const onDisk = { path: "C:/photos/a.png", mime: "image/png", data: "QUJD", byPath: true }
    const pastedIn = { path: "pasted-1.png", mime: "image/png", data: "QUJD" }
    const written = draftFileOf(new Map([["main:s9", { text: "", attachments: [onDisk, pastedIn], mentioned: [], skills: [] }]]), {})
    const keptFiles = written.drafts["main:s9"]?.attachments ?? []
    check(
      "a saved draft keeps only the path for a file on disk, and the bytes only for one with no file",
      keptFiles[0]?.data === "" && keptFiles[0]?.byPath === true && keptFiles[0]?.path === "C:/photos/a.png" && keptFiles[1]?.data === "QUJD",
      keptFiles,
    )
    check("the box goes on holding the bytes it had, so an open draft keeps its thumbnail", onDisk.data === "QUJD")
    check(
      "a thumbnail needs the bytes: one restored by its path alone is drawn as a file instead",
      preview(onDisk) === "data:image/png;base64,QUJD" && preview({ ...onDisk, data: "" }) === undefined,
      preview({ ...onDisk, data: "" }),
    )
  }

  /*
   * The composer's middle access level. The classifier lets everyday commands
   * through and stops what deletes, elevates, kills, changes rights or sends
   * work away - however it is chained. Through Permissions, the level answers
   * a file change and a safe command itself and still asks about a delete.
   */
  section("Access: approve for me")
  const risky = ["git push origin main && rm -rf dist", "rm -rf build", "Remove-Item dist -Recurse", "sudo apt install x", "taskkill /F /IM node.exe", "git push origin main", "npm run build && rm -rf dist", "echo $(rm -rf /)", "chmod 777 run.sh", "git clean -fdx", "Start-Process pwsh -Verb RunAs", "git reset --hard HEAD~1"]
  const everyday = ["git status", "npm test", "npm run build", "ls -la", "git diff --stat", "node scripts/check.js", "git log --oneline -5"]
  check("every risky command is caught", risky.every((command) => commandRisk(command) !== undefined), risky.filter((command) => commandRisk(command) === undefined))
  check("a delete anywhere in a chain is what the chain counts as", commandRisk("git push origin main && rm -rf dist") === "delete", commandRisk("git push origin main && rm -rf dist"))
  check("no everyday command is", everyday.every((command) => commandRisk(command) === undefined), everyday.filter((command) => commandRisk(command) !== undefined))

  const raised: string[] = []
  const levelBus = { subscribe: () => () => {}, publish: (event: { type: string }) => raised.push(event.type) }
  let level: "ask" | "auto" = "auto"
  const levelConfig = { get: () => ({ permissions: { ...PERMISSION_DEFAULTS }, accessLevel: level }) }
  const gate = new Permissions(levelBus as never, levelConfig as never)
  const askAbout = (kind: "edit" | "bash", subject: string) =>
    gate.ask({ sessionID: "ses_level", messageID: "msg_level", callID: `call_${raised.length}_${subject}`, kind, title: subject, subject })
  const settled = async (promise: Promise<void>) =>
    Promise.race([promise.then(() => "ran"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))])
  check("on approve-for-me a file change asks nothing", (await settled(askAbout("edit", "src/app.ts"))) === "ran" && raised.length === 0, raised)
  check("and neither does an everyday command", (await settled(askAbout("bash", "npm test"))) === "ran" && raised.length === 0, raised)
  check("but a delete still asks", (await settled(askAbout("bash", "rm -rf build"))) === "waiting" && raised.includes("permission.requested"), raised)

  /* The model's review of the other risky commands. */
  const reviewed: string[] = []
  let verdict: "approve" | "reject" | "fail" | "hang" = "approve"
  gate.useReviewer(async ({ subject }) => {
    reviewed.push(subject)
    if (verdict === "fail") throw new Error("no model")
    if (verdict === "hang") return new Promise<boolean>(() => {})
    return verdict === "approve"
  }, 40)
  const waited = async (promise: Promise<void>) =>
    Promise.race([promise.then(() => "ran"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 250))])
  raised.length = 0
  check("a risky command the model approves asks nothing", (await waited(askAbout("bash", "sudo apt install x"))) === "ran" && raised.length === 0 && reviewed.includes("sudo apt install x"), { raised, reviewed })
  verdict = "reject"
  check("one it rejects is asked about", (await waited(askAbout("bash", "taskkill /F /IM node.exe"))) === "waiting" && raised.includes("permission.requested") && reviewed.includes("taskkill /F /IM node.exe"), { raised, reviewed })
  verdict = "fail"
  raised.length = 0
  check("so is one the model cannot review", (await waited(askAbout("bash", "chmod 777 run.sh"))) === "waiting" && raised.includes("permission.requested"), raised)
  verdict = "hang"
  raised.length = 0
  check("and one it takes too long over", (await waited(askAbout("bash", "crontab -e"))) === "waiting" && raised.includes("permission.requested"), raised)
  verdict = "approve"
  raised.length = 0
  reviewed.length = 0
  check("a delete is never put to the model", (await waited(askAbout("bash", "git push origin main && rm -rf dist"))) === "waiting" && raised.includes("permission.requested") && reviewed.length === 0, { raised, reviewed })
  check("nor is a hard reset", (await waited(askAbout("bash", "git reset --hard HEAD~1"))) === "waiting" && reviewed.length === 0, reviewed)
  // E33: MiMo's lists decide what is dangerous; an ordinary push is not.
  gate.rejectAll("ses_level")
  raised.length = 0
  reviewed.length = 0
  check("an ordinary push runs unasked and unreviewed, as MiMo's lists do not flag it", (await waited(askAbout("bash", "git push origin main"))) === "ran" && raised.length === 0 && reviewed.length === 0, { raised, reviewed })

  level = "ask"
  raised.length = 0
  check("while the default level still asks about the file change", (await settled(askAbout("edit", "src/other.ts"))) === "waiting" && raised.includes("permission.requested"), raised)
  check("and puts no command to the model", (await waited(askAbout("bash", "sudo reboot"))) === "waiting" && reviewed.length === 0, reviewed)

  /* A side chat is a session of its own that remembers the conversation it sits beside. */
  const sideChat = await call({ type: "session.create", directory: project, title: "Side chat 1", sideOf: sessionID })
  const listedSide = await call({ type: "session.list" })
  check(
    "a side chat remembers the conversation it belongs to",
    sideChat.session.sideOf === sessionID &&
      sideChat.session.id !== sessionID &&
      listedSide.sessions.some((entry: { id: string; sideOf?: string }) => entry.id === sideChat.session.id && entry.sideOf === sessionID),
    sideChat.session,
  )
  check("an ordinary session belongs to no conversation", created.session.sideOf === undefined, created.session)
  await call({ type: "session.delete", sessionID: sideChat.session.id })

  const listed = await call({ type: "session.list" })
  check("session.list includes it", listed.sessions.some((s: any) => s.id === sessionID))
  /*
   * A client that reconnects has missed whatever happened while it was away,
   * and a turn that ended in the gap would leave its session looking busy for
   * good. The list says which sessions are actually mid-turn.
   */
  check("session.list says what is mid-turn", Array.isArray(listed.running), listed.running)
  check("and nothing is, on a fresh backend", listed.running.length === 0, listed.running)

  await call({ type: "session.rename", sessionID, title: "Smoke test" })
  const renamed = await call({ type: "session.get", sessionID })
  check("session.rename persists", renamed.session.title === "Smoke test", renamed.session.title)

  const files = await call({ type: "file.list", directory: project, query: "app" })
  check("file.list filters by query", files.files.some((f: any) => f.path === "src/app.ts"), files.files)

  let rejected = false
  await call({ type: "session.get", sessionID: "ses_missing" }).catch(() => (rejected = true))
  check("unknown session rejects", rejected)

  // ------------------------------------------------------------------- tools
  section("Tools")
  const bus = new Bus()
  const permissions = new Permissions(bus, backend.runtime.config)
  const controller = new AbortController()

  const context = (callID: string) => ({
    sessionID,
    messageID: "msg_test",
    callID,
    directory: project,
    permissions,
    signal: controller.signal,
    progress: () => {},
    // The suite exercises tools directly; recording is the runner's job.
    snapshot: async () => {},
  })

  const read = await findTool("read")!.execute({ file_path: "hello.ts" }, context("c1"))
  check(
    "read numbers lines as N: text inside its tags",
    read.output.includes("<type>file</type>") && read.output.includes("1: export const greeting") && read.output.includes("(End of file - 2 lines in all)"),
    read.output.slice(0, 200),
  )

  /*
   * Leaving the project asks rather than refusing. Wanting to read the folder
   * next door is ordinary; the sandbox is there so the user decides, not so the
   * answer is always no.
   */
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-outside-"))
  await fs.mkdir(path.join(outsideRoot, "nested"))
  await fs.writeFile(path.join(outsideRoot, "nested", "note.txt"), "hello")

  const answer = (response: "once" | "always" | "reject") => {
    const timer = setInterval(() => {
      const [first] = permissions.outstanding()
      if (first) {
        clearInterval(timer)
        permissions.respond(first.id, response)
      }
    }, 10)
    return () => clearInterval(timer)
  }

  let stop = answer("reject")
  const denied = await findTool("list")!
    .execute({ path: outsideRoot }, context("c-esc1"))
    .then(() => undefined, (error: unknown) => error)
  stop()
  check("an outside path asks, and a refusal is honoured", denied instanceof PermissionDenied, denied)

  stop = answer("always")
  const granted = await findTool("list")!
    .execute({ path: outsideRoot }, context("c-esc2"))
    .then((result) => result, (error: unknown) => error)
  stop()
  check("approving lets the tool through", typeof (granted as { output?: string })?.output === "string", granted)

  // "always" covers the tree, so walking into it does not ask a second time.
  const nested = await findTool("read")!
    .execute({ file_path: path.join(outsideRoot, "nested", "note.txt") }, context("c-esc3"))
    .then((result) => result, (error: unknown) => error)
  check("an approved directory covers what is under it", !(nested instanceof Error), nested)
  check("no second prompt was raised", permissions.outstanding().length === 0)

  /*
   * The switch labelled "permission requests will be approved automatically".
   * It offered nine kinds; five belonged to tools that never ask, and the one
   * that guards reaching outside the project was not among them - so with the
   * switch on, that prompt still stopped the agent.
   */
  check("every kind offered can actually be asked for", PERMISSION_KINDS.includes("outside" as any), PERMISSION_KINDS)

  await backend.runtime.config.set({ autoApprove: [...PERMISSION_KINDS] })
  // A directory nothing has approved: `outsideRoot` carries the "always" from
  // above, and would answer for itself whatever the setting said.
  const unseen = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-outside1-"))
  const running = findTool("list")!
    .execute({ path: unseen }, context("c-esc4"))
    .then((result) => result, (error: unknown) => error)
  /*
   * If a prompt goes up, this answers it so the tool settles and the run moves
   * on; waiting behind an unanswered prompt would hang the suite instead of
   * reporting the fault.
   */
  let asked = false
  const watch = setInterval(() => {
    const [first] = permissions.outstanding()
    if (!first) return
    asked = true
    permissions.respond(first.id, "reject")
  }, 10)
  const unattended = await running
  clearInterval(watch)
  check("with everything approved, an outside path does not ask", !asked && !(unattended instanceof Error), {
    asked,
    unattended,
  })
  await fs.rm(unseen, { recursive: true, force: true })

  /*
   * Approvals are stored by name, and the set of names has changed once. A name
   * left behind by an older build must not survive to pre-approve a future kind
   * that reuses it.
   *
   * The two throwaway names have to be ones that really are not buckets. This
   * case used to spend `read` and `glob` on that job, from a time when they were
   * declared on tools but matched nothing; they are real, configurable buckets
   * now, so the case was asserting that two live settings get thrown away.
   */
  await backend.runtime.config.set({ autoApprove: ["lsp", "websearch", "bash"] as never })
  check(
    "an approval that names nothing is dropped",
    !(backend.runtime.config.get().autoApprove as string[]).some(
      (kind) => kind === "lsp" || kind === "websearch",
    ) && backend.runtime.config.get().autoApprove.includes("bash"),
    backend.runtime.config.get().autoApprove,
  )

  /*
   * Off again - against a directory nothing has approved yet, since the
   * "always" above is remembered for `outsideRoot` and would answer for it.
   */
  await backend.runtime.config.set({ autoApprove: [] })
  const untouched = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-outside2-"))
  const asksAgain = answer("reject")
  const blocked = await findTool("list")!
    .execute({ path: untouched }, context("c-esc5"))
    .then(() => undefined, (error: unknown) => error)
  asksAgain()
  check("turning it off restores the prompt", blocked instanceof PermissionDenied, blocked)
  await fs.rm(untouched, { recursive: true, force: true })

  await fs.rm(outsideRoot, { recursive: true, force: true })

  const glob = await findTool("glob")!.execute({ pattern: "**/*.ts" }, context("c2"))
  check("glob lists absolute paths of nested files", glob.output.includes(path.join(project, "src", "app.ts")) && glob.output.includes(path.join(project, "hello.ts")), glob.output)

  const grep = await findTool("grep")!.execute({ pattern: "TODO" }, context("c3"))
  check(
    "grep groups its matches under each file as Line N rows",
    grep.output.startsWith("Found 1 matches") && grep.output.includes(`${path.join(project, "src", "app.ts")}:\n  Line 1: // TODO: implement`),
    grep.output,
  )

  // E2: matched as ripgrep matches for MiMo - a name glob at any depth, hidden files searched, .git and ignored files not.
  {
    const tree = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-glob-"))
    const put = async (rel: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(tree, rel)), { recursive: true })
      await fs.writeFile(path.join(tree, rel), text)
    }
    await put(".git/HEAD", "ref: refs/heads/main\n")
    await put(".git/config.ts", "needle\n")
    await put(".gitignore", "ignored/\n*.log\n!keep.log\n")
    await put("top.ts", "needle\n")
    await put("src/deep/inner.ts", "needle\n")
    await put("src/app.ts", "needle\n")
    await put(".hidden/secret.ts", "needle\n")
    await put("ignored/skip.ts", "needle\n")
    await put("debug.log", "needle\n")
    await put("keep.log", "needle\n")
    const inTree = (callID: string) => ({ ...context(callID), directory: tree })
    // Paths come back absolute; compared with forward slashes so the checks read the same on every platform.
    const posix = (output: string) => output.split("\\").join("/")
    const any = posix((await findTool("glob")!.execute({ pattern: "*.ts" }, inTree("g-e2-1"))).output)
    check("glob *.ts matches at any depth", ["top.ts", "src/deep/inner.ts", "src/app.ts"].every((file) => any.includes(file)), any)
    check("hidden files are searched, .git and .gitignore'd files are not", any.includes(".hidden/secret.ts") && !any.includes("ignored/skip.ts") && !any.includes("config.ts"), any)
    const sub = posix((await findTool("glob")!.execute({ pattern: "*.ts", path: "src" }, inTree("g-e2-2"))).output)
    check("a name glob inside a subdirectory finds its files", sub.includes("src/app.ts") && sub.includes("src/deep/inner.ts") && !sub.includes("top.ts"), sub)
    const anchored = posix((await findTool("glob")!.execute({ pattern: "src/*.ts" }, inTree("g-e2-3"))).output)
    check("a glob with a slash is anchored to the folder searched", anchored.includes("src/app.ts") && !anchored.includes("inner.ts"), anchored)
    const logs = posix((await findTool("glob")!.execute({ pattern: "*.log" }, inTree("g-e2-4"))).output)
    check("an ignore rule can be negated", logs.includes("keep.log") && !logs.includes("debug.log"), logs)
    const found = posix((await findTool("grep")!.execute({ pattern: "needle", include: "*.ts" }, inTree("g-e2-5"))).output)
    check(
      "grep's include matches at any depth and skips ignored files",
      found.includes("src/deep/inner.ts") && found.includes(".hidden/secret.ts") && !found.includes("ignored/") && !found.includes(".log"),
      found,
    )
    await fs.rm(tree, { recursive: true, force: true })
  }

  // E24 and E25: read, edit, glob and grep as MiMo's.
  {
    const e24 = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-read-"))
    const put = async (rel: string, data: string | Buffer) => {
      await fs.mkdir(path.dirname(path.join(e24, rel)), { recursive: true })
      await fs.writeFile(path.join(e24, rel), data)
    }
    const inE24 = (callID: string) => ({ ...context(callID), sessionID: "ses_e24", directory: e24 })
    const run = (tool: string, input: Record<string, unknown>, callID: string) =>
      findTool(tool)!
        .execute(input, inE24(callID))
        .then(
          (result) => ({ output: result.output, metadata: result.metadata }),
          (error: Error) => ({ output: `ERROR ${error.message}`, metadata: undefined as Record<string, unknown> | undefined }),
        )
    const approving = setInterval(() => {
      for (const request of permissions.outstanding()) permissions.respond(request.id, "once")
    }, 10)

    await put("AGENTS.md", "Root rule.\n")
    await put("src/a.ts", "alpha\n")
    await put("src/lib/b.ts", "beta\n")
    const listing = await run("read", { file_path: "src" }, "r-dir")
    check("reading a folder lists it, folders marked, with a count", listing.output.includes("<type>directory</type>") && listing.output.includes("a.ts\nlib/") && listing.output.includes("(2 entries)"), listing.output)
    /* L2: MiMo attaches a picture from read; the words still describe it for a model that cannot read one. */
    await put("shot.png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))
    const attachedShot = await findTool("read")!.execute({ file_path: "shot.png" }, inE24("r-png"))
    check(
      "read hands a picture to the model as an attachment on its result",
      attachedShot.attachments?.length === 1 && attachedShot.attachments[0].byPath === true && attachedShot.output.includes("attached to this result"),
      { attachments: attachedShot.attachments, output: attachedShot.output },
    )
    await put("wide.txt", "z".repeat(2500))
    check("a line past 2,000 characters is cut with a note", (await run("read", { file_path: "wide.txt" }, "r-wide")).output.includes("(line cut at 2000 characters)"))
    await put("big.txt", Array.from({ length: 1000 }, (_, i) => `${i + 1} ${"y".repeat(96)}`).join("\n"))
    const big = await run("read", { file_path: "big.txt" }, "r-big")
    check("50 KB of text stops the read and says where to continue", big.metadata?.truncated === true && big.output.includes("Stopped at 50 KB") && big.output.includes("offset="), big.output.slice(-200))
    check("an offset past the end is refused", (await run("read", { file_path: "src/a.ts", offset: 50 }, "r-past")).output.startsWith("ERROR Offset 50 is past the end"))
    check("an offset below 1 is refused", (await run("read", { file_path: "src/a.ts", offset: 0 }, "r-zero")).output.startsWith("ERROR offset"))
    await put("blob.txt", Buffer.from([65, 0, 66]))
    check("a file with a NUL in it is binary", (await run("read", { file_path: "blob.txt" }, "r-bin")).output.startsWith("ERROR Cannot read binary file"))
    await put("pic.png", "not really")
    const picture = await run("read", { file_path: "pic.png" }, "r-png")
    check("an image is described and handed over, not an error", !picture.output.startsWith("ERROR") && picture.output.includes("attached to this result"), picture.output)
    await put("pkg/AGENTS.md", "Pkg rule: tabs.\n")
    await put("pkg/deep/code.ts", "code\n")
    const nestedRead = await run("read", { file_path: "pkg/deep/code.ts" }, "r-agents1")
    check(
      "instructions between the file and the project root come with it, the root's own do not",
      nestedRead.output.includes("Pkg rule: tabs.") && !nestedRead.output.includes("Root rule.") && Array.isArray(nestedRead.metadata?.loaded) && (nestedRead.metadata?.loaded as unknown[]).length === 1,
      nestedRead.output,
    )
    check("and only once in a conversation", !(await run("read", { file_path: "pkg/deep/code.ts" }, "r-agents2")).output.includes("Pkg rule: tabs."))

    await put("crlf.txt", "one\r\ntwo\r\n")
    await run("edit", { file_path: "crlf.txt", old_string: "one\ntwo", new_string: "uno\ndos" }, "e-crlf")
    check("an edit keeps a file's CRLF line endings", (await fs.readFile(path.join(e24, "crlf.txt"), "utf8")) === "uno\r\ndos\r\n")
    await run("edit", { file_path: "made/new.txt", old_string: "", new_string: "fresh\n" }, "e-create")
    check("an empty old_string writes the whole file, creating it", (await fs.readFile(path.join(e24, "made", "new.txt"), "utf8").catch(() => "")) === "fresh\n")
    await put("indent.txt", "    indented line\n")
    const miss = await run("edit", { file_path: "indent.txt", old_string: "  indented   line", new_string: "x" }, "e-miss")
    check("a text not found comes back with the closest text in the file", miss.output.startsWith("ERROR old_string was not found") && miss.output.includes("closest text") && miss.output.includes("    indented line"), miss.output)
    await put("twice.txt", "x\nx\n")
    check("two matches without replace_all say so", (await run("edit", { file_path: "twice.txt", old_string: "x", new_string: "y" }, "e-twice")).output.includes("replace_all is not set"))

    for (let i = 0; i < 150; i++) await put(`many/f${i}.txt`, "n")
    const many = await run("glob", { pattern: "*.txt", path: "many" }, "g-many")
    check("glob lists at most 100 and says there were more", many.output.split("\n").filter((line) => line.endsWith(".txt")).length === 100 && many.metadata?.truncated === true, many.output.slice(-200))
    check("glob's path has to be a folder", (await run("glob", { pattern: "*", path: "src/a.ts" }, "g-file")).output.includes("has to be a folder"))
    const inFile = await run("grep", { pattern: "x", path: "twice.txt" }, "gr-file")
    check("grep searches a single file named as its path", inFile.output === `Found 2 matches\n${path.join(e24, "twice.txt")}:\n  Line 1: x\n  Line 2: x`, inFile.output)
    await put("old.md", "needle\n")
    const hourAgo = (Date.now() - 3_600_000) / 1000
    await fs.utimes(path.join(e24, "old.md"), hourAgo, hourAgo)
    await put("new.md", "needle\n")
    const sorted = await run("grep", { pattern: "needle", include: "*.md" }, "gr-sort")
    check("grep lists the newest file first", sorted.output.indexOf("new.md") !== -1 && sorted.output.indexOf("new.md") < sorted.output.indexOf("old.md"), sorted.output)
    await put("long.txt", `needle${"q".repeat(2500)}`)
    const longHit = await run("grep", { pattern: "needle", path: "long.txt" }, "gr-long")
    check("a matching line past 2,000 characters is cut", longHit.output.endsWith("...") && !longHit.output.includes("q".repeat(2001)), longHit.output.slice(-40))
    clearInterval(approving)
    await fs.rm(e24, { recursive: true, force: true })
  }

  // E30: MiMo's notebook_edit.
  {
    const nb = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-notebook-"))
    const file = path.join(nb, "work.ipynb")
    const notebook = {
      nbformat: 4,
      nbformat_minor: 4,
      metadata: {},
      cells: [
        { cell_type: "code", source: ["print(1)\n", "print(2)"], metadata: { tag: "keep" }, outputs: [{ output_type: "stream", text: ["1\n"] }], execution_count: 3 },
        { cell_type: "markdown", source: ["# Title"], metadata: {} },
      ],
    }
    await fs.writeFile(file, JSON.stringify(notebook, null, 1) + "\n")
    const inNotebook = (callID: string) => ({ ...context(callID), directory: nb })
    const approving = setInterval(() => {
      for (const request of permissions.outstanding()) permissions.respond(request.id, "once")
    }, 10)
    const change = (input: Record<string, unknown>, callID: string) =>
      findTool("notebook_edit")!
        .execute(input, inNotebook(callID))
        .then((result) => result.output, (error: Error) => `ERROR ${error.message}`)
    type Cell = { id: string; cell_type: string; source: string[]; outputs?: unknown[]; execution_count?: number | null; metadata?: Record<string, unknown> }
    const load = async () => JSON.parse(await fs.readFile(file, "utf8")) as { nbformat_minor: number; cells: Cell[] }

    const replaced = await change({ notebook_path: "work.ipynb", cell_id: "#0", new_source: "print(10)\nprint(20)" }, "nb-1")
    let doc = await load()
    check(
      "replacing a code cell by #N keeps its outputs, count and metadata",
      !replaced.startsWith("ERROR") &&
        JSON.stringify(doc.cells[0].source) === JSON.stringify(["print(10)\n", "print(20)"]) &&
        doc.cells[0].outputs?.length === 1 &&
        doc.cells[0].execution_count === 3 &&
        doc.cells[0].metadata?.tag === "keep",
      { replaced, cell: doc.cells[0] },
    )
    check("cells without ids get eight-character ids and the notebook is marked 4.5", doc.cells.every((cell) => /^[0-9a-f-]{8}$/.test(cell.id)) && doc.nbformat_minor === 5, doc)
    check("the file keeps its trailing newline", (await fs.readFile(file, "utf8")).endsWith("}\n"))
    const firstID = doc.cells[0].id
    await change({ notebook_path: "work.ipynb", cell_id: firstID, edit_mode: "insert", cell_type: "markdown", new_source: "Notes" }, "nb-2")
    await change({ notebook_path: "work.ipynb", edit_mode: "insert", cell_type: "code", new_source: "" }, "nb-3")
    doc = await load()
    check(
      "insert goes after the named cell, or first without one",
      doc.cells.length === 4 && doc.cells[0].cell_type === "code" && doc.cells[0].source.length === 0 && doc.cells[1].id === firstID && JSON.stringify(doc.cells[2].source) === '["Notes"]',
      doc.cells.map((cell) => [cell.cell_type, cell.source]),
    )
    await change({ notebook_path: "work.ipynb", cell_id: "#3", edit_mode: "delete" }, "nb-4")
    doc = await load()
    check("delete removes the cell", doc.cells.length === 3 && !doc.cells.some((cell) => JSON.stringify(cell.source) === '["# Title"]'), doc.cells.map((cell) => cell.source))
    const unknownCell = await change({ notebook_path: "work.ipynb", cell_id: "nope", new_source: "x" }, "nb-5")
    check("a cell that is not there is refused, naming the cells there are", unknownCell.startsWith("ERROR No cell nope") && unknownCell.includes(firstID), unknownCell)
    check("only a .ipynb file is taken", (await change({ notebook_path: "notes.txt", cell_id: "#0", new_source: "x" }, "nb-6")).includes(".ipynb"))
    check("an insert needs a cell type", (await change({ notebook_path: "work.ipynb", edit_mode: "insert", new_source: "x" }, "nb-7")).includes("cell_type is required"))
    check(
      // plan: it is offered while planning as well, and refused there by the plan rule rather than by absence.
      "notebook_edit is offered in both modes and recorded as a file change",
      toolsFor("plan").some((tool) => tool.name === "notebook_edit") && toolsFor("build").some((tool) => tool.name === "notebook_edit") && reachOf("notebook_edit") === "reports",
    )
    clearInterval(approving)
    await fs.rm(nb, { recursive: true, force: true })
  }

  // E26: MiMo's webfetch - formats, 5 MB, internal addresses refused before anything is sent, a Cloudflare challenge tried once more.
  {
    let challenged = 0
    const site = createServer((request, response) => {
      const agent = String(request.headers["user-agent"] ?? "")
      if (request.url === "/page") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        response.end(
          `<html><head><title>T</title><style>.x{}</style></head><body><h1>Title</h1><p>Some <strong>bold</strong> and <a href="http://example.com/">a link</a>.</p><ul><li>one</li><li>two</li></ul><pre><code>let x = 1 &lt; 2</code></pre><script>secret()</script></body></html>`,
        )
      } else if (request.url === "/plain") {
        response.writeHead(200, { "content-type": "text/plain" })
        response.end("just text")
      } else if (request.url === "/huge") {
        response.writeHead(200, { "content-type": "text/plain", "content-length": String(6 * 1024 * 1024) })
        response.flushHeaders()
        setTimeout(() => response.destroy(), 300)
      } else if (request.url === "/guarded") {
        if (agent === "mcode") {
          response.writeHead(200, { "content-type": "text/plain" })
          response.end("past the challenge")
        } else {
          challenged++
          response.writeHead(403, { "cf-mitigated": "challenge" })
          response.end()
        }
      } else if (request.url === "/hop") {
        response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" })
        response.end()
      } else if (request.url === "/pic") {
        response.writeHead(200, { "content-type": "image/png" })
        response.end(Buffer.from([137, 80, 78, 71]))
      } else {
        response.writeHead(404)
        response.end()
      }
    })
    const sitePort = await new Promise<number>((resolve) => site.listen(0, "127.0.0.1", () => resolve((site.address() as { port: number }).port)))
    const base = `http://127.0.0.1:${sitePort}`
    const approving = setInterval(() => {
      for (const request of permissions.outstanding()) permissions.respond(request.id, "once")
    }, 10)
    const fetched = (input: Record<string, unknown>) =>
      findTool("webfetch")!
        .execute(input, context("wf"))
        .then((result) => result.output, (error: Error) => `ERROR ${error.message}`)

    const markdown = await fetched({ url: `${base}/page` })
    check(
      "an HTML page comes back as Markdown by default",
      markdown.includes("# Title") &&
        markdown.includes("**bold**") &&
        markdown.includes("[a link](http://example.com/)") &&
        markdown.includes("- one") &&
        markdown.includes("```\nlet x = 1 < 2\n```") &&
        !markdown.includes("secret()") &&
        !markdown.includes("<p>"),
      markdown,
    )
    const words = await fetched({ url: `${base}/page`, format: "text" })
    // The page's own "1 &lt; 2" decodes to a "<", so it is tags that must be gone, not the character.
    check("format text keeps the words and drops the markup and scripts", words.includes("Title") && words.includes("bold") && !/<\/?[a-z]/i.test(words) && !words.includes("secret()"), words)
    check("format html is the page as sent", (await fetched({ url: `${base}/page`, format: "html" })).includes("<h1>Title</h1>"))
    check("a body that is not HTML comes back as it is", (await fetched({ url: `${base}/plain` })) === "just text")
    check("a response over 5 MB is refused", (await fetched({ url: `${base}/huge` })).includes("larger than 5 MB"))
    check("a Cloudflare challenge is tried once more as this app", (await fetched({ url: `${base}/guarded` })) === "past the challenge" && challenged === 1, challenged)
    check("a redirect to an internal address is refused before it is followed", (await fetched({ url: `${base}/hop` })).startsWith("ERROR Refused"))
    const refusedBefore = permissions.outstanding().length
    check(
      "an internal address is refused before anything is asked",
      (await fetched({ url: "http://10.1.2.3/" })).startsWith("ERROR Refused") &&
        (await fetched({ url: "http://[fe80::1]/" })).startsWith("ERROR Refused") &&
        (await fetched({ url: "http://metadata.google.internal/" })).startsWith("ERROR Refused") &&
        refusedBefore === 0,
    )
    check(
      "the blocked ranges are MiMo's, loopback left out",
      blockedIPv4("192.168.1.1") && blockedIPv4("100.100.100.200") && blockedIPv4("0.0.0.0") && !blockedIPv4("127.0.0.1") && !blockedIPv4("8.8.8.8") && blockedIPv6("::ffff:10.0.0.1") && blockedIPv6("fd00::1") && !blockedIPv6("::1"),
    )
    check("an image is named, not passed on", (await fetched({ url: `${base}/pic` })).includes("image/png"))
    check("only http and https are fetched", (await fetched({ url: "ftp://example.com/" })).includes("http://"))
    clearInterval(approving)
    site.closeAllConnections()
    await new Promise<void>((resolve) => site.close(() => resolve()))
  }

  // E27: MiMo's desktop never hands a GPT model apply_patch; every model edits with edit and write.
  const surface = toolsFor("build").map((tool) => tool.name)
  check("every model is offered edit and write, and no apply_patch", surface.includes("edit") && surface.includes("write") && !surface.includes("apply_patch") && findTool("apply_patch") === undefined, surface)

  // E21: MiMo's shared cap - over 2,000 lines or 50 KB is cut, and the whole output saved to a file the result names.
  {
    const outputsDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-tool-output-"))
    const outputs = new ToolOutputs(outputsDir)
    const short = await outputs.cap("one\ntwo")
    check("output inside the cap is left alone", short.text === "one\ntwo" && !short.truncated && short.file === undefined, short)
    const many = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n")
    const cut = await outputs.cap(many)
    const cutLines = cut.text.split("\n")
    check(
      "over 2,000 lines keeps the first 2,000 and says how many were cut",
      cut.truncated && cutLines[0] === "line 1" && cutLines[1999] === "line 2000" && !cut.text.includes("line 2001") && cut.text.includes("500 lines cut"),
      cut.text.slice(-300),
    )
    check("the complete output is saved and named", Boolean(cut.file) && cut.text.includes(cut.file ?? "?") && (await fs.readFile(cut.file ?? "", "utf8").catch(() => "")) === many)
    const wide = await outputs.cap(`${"x".repeat(60 * 1024)}\nend`)
    check("over 50 KB is cut by bytes", wide.truncated && wide.text.includes(`${60 * 1024 + 4} bytes cut`), wide.text.slice(0, 200))
    const failing = await outputs.cap(Array.from({ length: 3000 }, (_, i) => `step ${i + 1}`).join("\n") + "\nError: the build failed")
    check(
      "an end that looks like a failure keeps the start and the end",
      failing.truncated &&
        failing.text.startsWith("step 1\n") &&
        failing.text.includes("step 1400\n") &&
        !failing.text.includes("step 1401\n") &&
        failing.text.includes("Error: the build failed") &&
        failing.text.includes("lines left out between the start and the end"),
      failing.text.slice(0, 120),
    )
    check("a conversation that can start subagents is pointed at one", !cut.text.includes("subagent") && (await outputs.cap(many, true)).text.includes("explore subagent"))
    check("only a saved output counts as the output folder", Boolean(cut.file) && outputs.holds(cut.file ?? "") && !outputs.holds(project))
    const stopAsking = answer("reject")
    const readBack = await findTool("read")!
      .execute({ file_path: cut.file ?? "" }, { ...context("c-e21-read"), toolOutputs: outputs })
      .then((result) => result.output, (error: Error) => `ERROR ${error.message}`)
    stopAsking()
    check("a saved output is read without asking to leave the project", readBack.includes("line 1") && !readBack.startsWith("ERROR"), readBack.slice(0, 120))
    const old = await outputs.save("old")
    const fresh = await outputs.save("fresh")
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    await fs.utimes(old, eightDaysAgo, eightDaysAgo)
    await outputs.sweep()
    check("a saved output older than a week is swept and a new one kept", !(await exists(old)) && (await exists(fresh)))
    await fs.rm(outputsDir, { recursive: true, force: true })
  }

  const list = await findTool("list")!.execute({}, context("c4"))
  check("list renders a tree", list.output.includes("src/") && list.output.includes("hello.ts"), list.output)

  const taskless = await findTool("task")!
    .execute({ action: "create", summary: "Write the thing" }, context("c5"))
    .then(() => "", (err: Error) => err.message)
  check("the task tool needs a conversation's registry to work on", taskless.includes("not available"), taskless)

  /*
   * Traversal must never proceed silently, however it is spelled. It is no
   * longer a flat refusal - it raises the same prompt as any other path outside
   * the project - but nothing reaches disk until the user has said yes.
   */
  const traversal = findTool("read")!
    .execute({ file_path: "../../../etc/passwd" }, context("c6"))
    .then(() => "read it", (error: unknown) => (error instanceof PermissionDenied ? "denied" : String(error)))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const traversalPrompt = permissions.outstanding()
  check("traversal raises a prompt rather than sneaking through", traversalPrompt.length === 1, traversalPrompt.length)
  check("the prompt names the directory being reached into", traversalPrompt[0]?.subject.endsWith("*") ?? false, traversalPrompt[0]?.subject)
  permissions.respond(traversalPrompt[0]!.id, "reject")
  check("refusing traversal stops the read", (await traversal) === "denied")

  let refused = false
  await findTool("bash")!
    .execute({ command: "rm -rf /", description: "destroy" }, context("c7"))
    .catch((err: Error) => (refused = err.message.includes("Refused")))
  check("bash refuses recursive force delete", refused)

  // E22: MiMo's bash - workdir, max_output_tokens with the middle left out and the whole saved, a timeout that returns what ran, the exit code kept out of the output.
  {
    const bashOutputs = new ToolOutputs(await fs.mkdtemp(path.join(os.tmpdir(), "mcode-bash-output-")))
    const bashContext = (callID: string) => ({ ...context(callID), toolOutputs: bashOutputs })
    const bash = findTool("bash")!
    const approving = setInterval(() => {
      for (const request of permissions.outstanding()) permissions.respond(request.id, "once")
    }, 10)
    const long = await bash.execute({ command: `node -e "process.stdout.write('ab'.repeat(3000))"`, description: "Print a lot", max_output_tokens: 100 }, bashContext("b-e22-1"))
    const whole = await fs.readFile(String(long.metadata?.outputPath ?? ""), "utf8").catch(() => "")
    check(
      "past max_output_tokens the middle is left out and the whole output saved",
      long.output.startsWith("The output was cut: about 1500 tokens in all.") && long.output.includes("tokens left out") && long.metadata?.truncated === true && whole.length === 6000,
      { output: long.output.slice(0, 200), metadata: long.metadata, saved: whole.length },
    )
    const where = await bash.execute({ command: `node -e "console.log(process.cwd())"`, workdir: "src" }, bashContext("b-e22-2"))
    check("workdir sets where the command runs", where.output.trim().toLowerCase() === path.join(project, "src").toLowerCase(), where.output)
    const failing = await bash.execute({ command: `node -e "process.exit(3)"` }, bashContext("b-e22-3"))
    // PowerShell reports a failed native command as 1 rather than passing its code on; either way it is not 0.
    check(
      "an exit code is kept in metadata, not written into the output",
      failing.output === "(no output)" && typeof failing.metadata?.exit === "number" && failing.metadata.exit !== 0,
      failing,
    )
    const startedAt = Date.now()
    const slow = await bash
      .execute({ command: `node -e "console.log('started'); setInterval(() => {}, 1000)"`, timeout: 1500 }, bashContext("b-e22-4"))
      .then((result) => result.output, (error: Error) => `ERROR ${error.message}`)
    check(
      "a timeout stops the command and returns what it printed, with a note",
      slow.includes("started") && slow.includes("1500 ms timeout") && !slow.startsWith("ERROR") && Date.now() - startedAt < 10_000,
      slow,
    )
    if (process.platform === "win32") {
      const python = await bash.execute({ command: `node -e "console.log(process.env.PYTHONIOENCODING)"` }, bashContext("b-e22-5"))
      check("Python is told to write UTF-8 on Windows", python.output.trim() === "utf-8", python.output)
    }
    const negative = await bash.execute({ command: "echo x", timeout: -1 }, bashContext("b-e22-6")).then(() => "ran", (error: Error) => error.message)
    check("a negative timeout is refused before anything runs", negative.includes("timeout"), negative)
    clearInterval(approving)
  }

  // E23: what bash asks, as MiMo's tool reads a command - prefixes for "always", deletes asked on their own, outside folders first.
  {
    const e23 = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-bash-scan-"))
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-bash-elsewhere-"))
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-bash-temp-"))
    await fs.writeFile(path.join(e23, "notes.txt"), "x")
    await fs.writeFile(path.join(elsewhere, "secret.txt"), "x")

    const posix = await scanCommand("FOO=1 git status --short && npm run build -- --watch 2>&1 | tee log.txt; cd sub", e23, e23, false)
    check(
      "a command line is read as its simple commands, each saved by its prefix, a bare cd asking nothing",
      JSON.stringify(posix.always) === JSON.stringify(["git status *", "npm run build *", "tee *"]) && posix.patterns.length === 3 && posix.deletes.length === 0,
      posix,
    )
    check("substitutions are read too", simpleCommands('echo "$(rm -rf out)" `rm x`', false).some((entry) => entry.tokens[0] === "rm"))
    check("MiMo's arities decide the prefix", arityPrefix(["docker", "compose", "up", "-d"]).join(" ") === "docker compose up" && arityPrefix(["kubectl", "get", "pods"]).join(" ") === "kubectl get" && arityPrefix(["myscript", "a"]).join(" ") === "myscript")
    const deleting = await scanCommand("git push --force; Remove-Item -Recurse -Force build", e23, e23, true)
    check("deletes and force pushes are picked out, PowerShell's too", deleting.deletes.length === 2 && !deleting.tempOnlyDeletes, deleting)
    check("a plain push is not a delete", (await scanCommand("git push origin main", e23, e23, false)).deletes.length === 0)
    const reaching = await scanCommand(`cat "${path.join(elsewhere, "secret.txt")}"`, e23, e23, false)
    check("a file argument outside the project names its folder", reaching.dirs.length === 1 && path.resolve(reaching.dirs[0]) === path.resolve(elsewhere), reaching)
    check("a delete only of files in the temp folder needs no question of its own", (await scanCommand(`rm "${path.join(scratch, "old.txt")}"`, e23, e23, false)).tempOnlyDeletes)
    check("but one inside the project does, and so does one whose target is not known", !(await scanCommand("rm notes.txt", e23, e23, false)).tempOnlyDeletes && !(await scanCommand("rm $TARGET", e23, e23, false)).tempOnlyDeletes)

    /* L4: where a command would write, so a change made through bash raises the worktree notice too. */
    const wrote = (line: string, ps = false) => collectMutationTargets(line, e23, ps).paths.map((entry) => path.resolve(entry))
    check(
      "a redirection names the file it writes, and one that only reads names nothing",
      wrote("echo hi > out.txt").includes(path.join(e23, "out.txt")) && wrote("cat < in.txt").length === 0,
      wrote("echo hi > out.txt"),
    )
    check(
      "a write command names its paths, and a copy only its destination",
      wrote("touch a.txt").includes(path.join(e23, "a.txt")) &&
        wrote("cp src.txt dest.txt").includes(path.join(e23, "dest.txt")) &&
        !wrote("cp src.txt dest.txt").includes(path.join(e23, "src.txt")),
      wrote("cp src.txt dest.txt"),
    )
    check("sed in place counts as a write", wrote("sed -i s/a/b/ notes.txt").includes(path.join(e23, "notes.txt")))
    check(
      "a git subcommand that changes the repository counts, and looking does not",
      collectMutationTargets("git commit -m x", e23, false).gitMutate && !collectMutationTargets("git status", e23, false).gitMutate,
    )
    check(
      "git worktree counts only where it touches a tree that is already there",
      collectMutationTargets("git worktree remove old", e23, false).gitMutate && !collectMutationTargets("git worktree add new", e23, false).gitMutate,
    )
    check("cd decides where the command after it writes", wrote("cd sub && touch b.txt").includes(path.join(e23, "sub", "b.txt")), wrote("cd sub && touch b.txt"))
    check("git -C names the repository it is pointed at", wrote("git -C other commit -m x").includes(path.join(e23, "other")), wrote("git -C other commit -m x"))
    check("a command that writes nothing names nothing at all", collectMutationTargets("git status && ls -la", e23, false).paths.length === 0)

    /* L8: MiMo's blank-project dialog can put the folder somewhere else; with no choice it is the default project location. */
    const chosenRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-blank-"))
    const madeThere = await blankProjectDirectory("Ideas", chosenRoot)
    check(
      "a blank project is made where the dialog said, under the name given",
      path.dirname(madeThere) === path.resolve(chosenRoot) && path.basename(madeThere) === "Ideas",
      madeThere,
    )
    const secondTry = await blankProjectDirectory("Ideas", chosenRoot)
    check("a name already taken there is numbered rather than opening the folder that is already there", path.basename(secondTry) === "Ideas (2)", secondTry)
    await fs.rm(chosenRoot, { recursive: true, force: true })

    const gate = new Permissions(new Bus(), { get: () => ({ permissions: { ...PERMISSION_DEFAULTS } }) } as never)
    const seen: PermissionRequest[] = []
    const replies: Record<string, PermissionResponse> = {}
    const answering = setInterval(() => {
      for (const request of gate.outstanding()) {
        seen.push(request)
        gate.respond(request.id, replies[request.kind] ?? "reject")
      }
    }, 10)
    let calls = 0
    const bashIn = (sessionID: string, command: string) =>
      findTool("bash")!
        .execute({ command }, { ...context(`b-e23-${++calls}`), sessionID, directory: e23, permissions: gate })
        .then((result) => result.output, (error: Error) => `ERROR ${error.message}`)

    await bashIn("s-e23", "rm notes.txt")
    check("a delete is asked on its own, as one that is never remembered", seen.at(-1)?.kind === "bash" && seen.at(-1)?.forced === true, seen.at(-1))
    check("and nothing was deleted when it was refused", await exists(path.join(e23, "notes.txt")))
    const before = seen.length
    await bashIn("s-e23", `cat "${path.join(elsewhere, "secret.txt")}"`)
    check("a folder outside the project is asked about before the command", seen[before]?.kind === "outside" && seen.length === before + 1, seen.slice(before))
    replies.outside = "once"
    const tempAt = seen.length
    await bashIn("s-e23", `rm "${path.join(scratch, "old.txt")}"`)
    const tempBash = seen.slice(tempAt).find((request) => request.kind === "bash")
    check("a delete of temp files asks as an ordinary command", tempBash !== undefined && tempBash.forced !== true, seen.slice(tempAt))
    replies.bash = "always"
    await bashIn("s-e23-a", "git status")
    const alwaysAt = seen.length
    await bashIn("s-e23-b", "git status --short")
    check("always on a command covers its prefix in another conversation of the project", seen.length === alwaysAt, seen.slice(alwaysAt))

    // As MiMo forces its delete question: commands allowed, or full access, still ask before a delete; only Deny refuses first.
    const allowing = new Permissions(new Bus(), { get: () => ({ permissions: { ...PERMISSION_DEFAULTS, bash: "allow" }, accessLevel: "full" }) } as never)
    const deleteUnderAllow = allowing
      .ask({ sessionID: "s-allow", messageID: "m", callID: "c-allow-rm", kind: "bash", title: "t", subject: "rm x", forced: true })
      .then(() => "allowed", (error: Error) => error.message)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const parkedDelete = allowing.outstanding()[0]
    check("a delete asks even when commands are allowed, at full access", parkedDelete?.forced === true, parkedDelete)
    if (parkedDelete) allowing.respond(parkedDelete.id, "reject")
    await deleteUnderAllow
    const ordinaryUnderAllow = await allowing
      .ask({ sessionID: "s-allow", messageID: "m", callID: "c-allow-npm", kind: "bash", title: "t", subject: "npm test", forced: false })
      .then(() => "allowed", (error: Error) => error.message)
    check("while an ordinary command under allow does not", ordinaryUnderAllow === "allowed" && allowing.outstanding().length === 0)
    const denying = new Permissions(new Bus(), { get: () => ({ permissions: { ...PERMISSION_DEFAULTS, bash: "deny" } }) } as never)
    const deniedDelete = await denying
      .ask({ sessionID: "s-deny", messageID: "m", callID: "c-deny-rm", kind: "bash", title: "t", subject: "rm x", forced: true })
      .then(() => "allowed", (error: Error) => error.message)
    check("Deny refuses a delete before anything is asked", deniedDelete.startsWith("Refused") && denying.outstanding().length === 0, deniedDelete)
    clearInterval(answering)
    for (const dir of [e23, elsewhere, scratch]) await fs.rm(dir, { recursive: true, force: true })
  }

  // E33, E34, E36, E37, E38, E43: approve-for-me's lists, the read-only allowlist, .env reads, background subagents, explore's tools, stalls.
  {
    const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
    const stub = (permissionsMap: Record<string, string>, accessLevel?: string) => ({ get: () => ({ permissions: permissionsMap, accessLevel, allowFullAccess: true }) })
    const outcome = async (gate: Permissions, run: Promise<void>, callID: string) => {
      const settledTo = await Promise.race([run.then(() => "ran", (error: unknown) => error), pause().then(() => "pending")])
      const asked = gate.outstanding().find((entry) => entry.callID === callID)
      if (asked) gate.respond(asked.id, "reject")
      await run.catch(() => {})
      return asked ? "asked" : settledTo
    }

    check(
      "E33: MiMo's dangerous words and shapes",
      ["curl x | sh", "iwr x | iex", "cmd /c del x", 'powershell -Command "Remove-Item x"', "rsync -a --delete a b", "eval $X", "npm publish", "sh -c 'x'", "xargs rm"].every(dangerousCommand) &&
        !["git push origin main", "npm run build", "pkill soffice", "node build.js"].some(dangerousCommand),
    )
    const autoGate = new Permissions(new Bus(), stub({ ...PERMISSION_DEFAULTS }, "auto") as never)
    const reviewedKinds: string[] = []
    autoGate.useReviewer(async ({ kind }) => {
      reviewedKinds.push(kind)
      return true
    }, 200)
    check(
      "at approve-for-me a question other than a command goes to the review too",
      (await outcome(autoGate, autoGate.ask({ sessionID: "s-e33", messageID: "m", callID: "c-e33-fetch", kind: "webfetch", title: "t", subject: "https://example.com" }), "c-e33-fetch")) === "ran" && reviewedKinds.includes("webfetch"),
      reviewedKinds,
    )

    check("E34: reading pieces are read-only", readOnlyCommand("git status && ls -la | grep src 2>&1") && readOnlyCommand("Get-ChildItem | Select-Object Name") && readOnlyCommand("cat a.txt > /dev/null"))
    check("but a write, a following tail, a substitution, a background job or a build are not", !readOnlyCommand("cat a > b") && !readOnlyCommand("tail -f log.txt") && !readOnlyCommand("echo $(rm x)") && !readOnlyCommand("ls & rm x") && !readOnlyCommand("npm test"))
    const askGate = new Permissions(new Bus(), stub({ ...PERMISSION_DEFAULTS }) as never)
    check("at Ask a read-only command runs without a question", (await outcome(askGate, askGate.ask({ sessionID: "s-e34", messageID: "m", callID: "c-e34-ro", kind: "bash", title: "t", subject: "git log --oneline -5" }), "c-e34-ro")) === "ran")
    check("while any other asks", (await outcome(askGate, askGate.ask({ sessionID: "s-e34", messageID: "m", callID: "c-e34-rw", kind: "bash", title: "t", subject: "npm test" }), "c-e34-rw")) === "asked")

    check("E36: .env and .env.local ask, .env.example does not", readAsks(".env") && readAsks("config/.env.local") && !readAsks("app/.env.example") && !readAsks("environment.ts"))
    const readCheck = (gate: Permissions, file: string, callID: string) =>
      outcome(gate, gate.check({ sessionID: "s-e36", messageID: "m", callID, tool: "read", kind: "read", arguments: { file_path: file } }), callID)
    check("reading .env asks though reading is allowed", (await readCheck(askGate, ".env", "c-e36-env")) === "asked")
    check("reading .env.example does not", (await readCheck(askGate, ".env.example", "c-e36-example")) === "ran")
    const fullGate = new Permissions(new Bus(), stub(Object.fromEntries(PERMISSION_KINDS.map((kind) => [kind, "allow"]))) as never)
    check("and at full access nothing asks", (await readCheck(fullGate, ".env", "c-e36-full")) === "ran")

    const bgProject = path.join(root, "background-project")
    const bg = new Permissions(new Bus(), stub({ ...PERMISSION_DEFAULTS }) as never)
    bg.markBackground("s-child", "s-parent")
    const command = (sessionID: string, callID: string, extra: Record<string, unknown> = {}) =>
      bg.ask({ sessionID, messageID: "m", callID, kind: "bash", title: "t", subject: "npm test", patterns: ["npm test"], always: ["npm test *"], directory: bgProject, ...extra })
    // Raced against a pause and anything left waiting refused, so a question raised by mistake fails the check rather than hanging the run.
    const settledOrAsked = async (run: Promise<void>) => {
      const result = await Promise.race([run.then(() => "ran", (error: unknown) => error), pause(200).then(() => "still waiting")])
      bg.rejectAll("s-child")
      await run.catch(() => {})
      return result
    }
    const refusedChild = await settledOrAsked(command("s-child", "c-bg-1"))
    check("E37: a background subagent's call nothing allows is refused without a question", refusedChild instanceof PermissionDenied && !refusedChild.byUser && bg.outstanding().length === 0, refusedChild)
    const parentAsk = command("s-parent", "c-bg-2")
    await pause(20)
    const parentQuestion = bg.outstanding().find((entry) => entry.callID === "c-bg-2")
    if (parentQuestion) bg.respond(parentQuestion.id, "always")
    await parentAsk.catch(() => {})
    check("one its project already allows with always runs", (await settledOrAsked(command("s-child", "c-bg-3"))) === "ran")
    const childDelete = await settledOrAsked(command("s-child", "c-bg-4", { subject: "rm x", patterns: ["rm x"], always: [], forced: true }))
    check("and a delete from the background is refused, never asked", childDelete instanceof PermissionDenied && bg.outstanding().length === 0, childDelete)
    bg.markBackground("s-child", undefined)
    const foreground = command("s-child", "c-bg-5", { subject: "rm y", patterns: ["rm y"], always: [], forced: true })
    check("a subagent running in the foreground asks as a conversation does", (await outcome(bg, foreground, "c-bg-5")) === "asked")

    check("E38: an explore subagent gets read, glob, grep, list, bash and webfetch only", toolsFor("explore").map((tool) => tool.name).sort().join() === "bash,glob,grep,list,read,webfetch", toolsFor("explore").map((tool) => tool.name))

    const stallTimes = { ...STALL }
    Object.assign(STALL, { headerMs: 300, chunkMs: 300 })
    const quiet = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`)
    })
    const quietPort = await new Promise<number>((resolve) => quiet.listen(0, "127.0.0.1", () => resolve((quiet.address() as { port: number }).port)))
    const stallStarted = Date.now()
    // The check's own limit: a stall that never fires fails here after 5s instead of hanging the run.
    const giveUp = new AbortController()
    const stopWaiting = setTimeout(() => giveUp.abort(new Error("the stall never fired")), 5000)
    const stalled = await OpenAICompatible.stream(
      { apiKey: "k", model: { provider: "x", model: "m" }, system: "", history: [], tools: [], effort: "", variants: [], showReasoning: false, signal: giveUp.signal, baseURL: `http://127.0.0.1:${quietPort}/v1` },
      () => {},
    ).then(() => undefined, (error: unknown) => error)
    clearTimeout(stopWaiting)
    check("E43: a stream that goes quiet is cut off after the stall timeout, as a failure to retry", stalled instanceof Error && Date.now() - stallStarted < 5000 && isRetryable(stalled), String(stalled))
    const waiting = stallGuard(new AbortController().signal, true)
    await pause(450)
    check("and so is a response whose headers never come", waiting.signal.aborted && isRetryable(waiting.failure(new Error("aborted"))))
    waiting.dispose()
    Object.assign(STALL, stallTimes)
    quiet.closeAllConnections()
    quiet.close()
  }

  // -------------------------------------------------------------- permission
  section("Permissions")
  // edit is not auto-approved, so this must park until answered.
  const editPromise = findTool("edit")!.execute(
    { file_path: "hello.ts", old_string: "const count = 1", new_string: "const count = 2" },
    context("c8"),
  )
  await new Promise((resolve) => setTimeout(resolve, 60))
  const outstanding = permissions.outstanding()
  check("edit raised a permission request", outstanding.length === 1, outstanding.length)
  check("request carries a diff preview", outstanding[0]?.preview?.includes("+export const count = 2") ?? false)

  permissions.respond(outstanding[0].id, "once")
  const edited = await editPromise
  check("edit applied after approval", edited.output.includes("Edited hello.ts"), edited.output)
  const afterEdit = await fs.readFile(path.join(project, "hello.ts"), "utf8")
  check("file actually changed on disk", afterEdit.includes("count = 2"), afterEdit)

  const denyPromise = findTool("write")!
    .execute({ file_path: "denied.ts", content: "nope" }, context("c9"))
    .then(() => "allowed")
    .catch((err: Error) => err.message)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const second = permissions.outstanding()
  permissions.respond(second[0].id, "reject")
  const denyResult = await denyPromise
  check("rejection stops the tool", String(denyResult).includes("Permission denied"), denyResult)
  check("rejected write created no file", !(await exists(path.join(project, "denied.ts"))))

  // "always" should suppress the next prompt in the same bucket.
  const firstWrite = findTool("write")!.execute({ file_path: "a.txt", content: "one" }, context("c10"))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const third = permissions.outstanding()
  permissions.respond(third[0].id, "always")
  await firstWrite
  await findTool("write")!.execute({ file_path: "b.txt", content: "two" }, context("c11"))
  check("always suppresses the next prompt", permissions.outstanding().length === 0)
  check("both writes landed", (await exists(path.join(project, "a.txt"))) && (await exists(path.join(project, "b.txt"))))

  // A refusal with a reason hands the reason on to the model.
  const asking = (sessionID: string, kind: "write" | "bash", subject: string) =>
    permissions
      .ask({ sessionID, messageID: "m-perm", callID: `c-${subject}`, kind, title: "t", subject })
      .then(() => "allowed", (err: Error) => err.message)
  const reasoned = asking("s-reason", "write", "notes.md")
  await new Promise((resolve) => setTimeout(resolve, 20))
  permissions.respond(permissions.outstanding()[0]!.id, "reject", "use the docs folder instead")
  const reasonedResult = await reasoned
  check(
    "a refusal carries the user's reason",
    reasonedResult.includes("Permission denied") && reasonedResult.includes("use the docs folder instead"),
    reasonedResult,
  )

  // A delete is asked every time: "always" neither covers it nor is remembered for it.
  const build = asking("s-forced", "bash", "npm test")
  await new Promise((resolve) => setTimeout(resolve, 20))
  const buildAsk = permissions.outstanding()[0]
  check("an ordinary command is not forced", buildAsk?.forced === undefined, buildAsk)
  permissions.respond(buildAsk!.id, "always")
  await build
  const removal = asking("s-forced", "bash", "rm -rf build")
  await new Promise((resolve) => setTimeout(resolve, 20))
  const removalAsk = permissions.outstanding()[0]
  check("a delete asks despite an earlier always", removalAsk?.forced === true, removalAsk)
  if (removalAsk) permissions.respond(removalAsk.id, "always")
  check("the delete ran once approved", (await removal) === "allowed")
  const again = asking("s-forced", "bash", "rm -rf build")
  await new Promise((resolve) => setTimeout(resolve, 20))
  const againAsk = permissions.outstanding()[0]
  check("always on a delete is not remembered", againAsk?.forced === true, againAsk)
  if (againAsk) permissions.respond(againAsk.id, "reject")
  await again

  // E35: "always" is kept per project, as a pattern, and lets through what is still waiting that it now covers.
  {
    const projectA = path.join(root, "rules-a")
    const projectB = path.join(root, "rules-b")
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
    const inProject = (sessionID: string, directory: string, callID: string, command: string, always: string[]) =>
      permissions
        .ask({ sessionID, messageID: "m-rules", callID, kind: "bash", title: "t", subject: command, patterns: [command], always, directory })
        .then(() => "allowed", (err: Error) => err.message)
    const waiting = (callID: string) => permissions.outstanding().find((entry) => entry.callID === callID)
    const settleIfAsked = (callID: string) => {
      const asked = waiting(callID)
      if (asked) permissions.respond(asked.id, "reject")
      return Boolean(asked)
    }

    // Commands that ask: a read-only one (git status) runs without a question at all.
    const first = inProject("s-rule-1", projectA, "c-rule-1", "npm run build", ["npm run build *"])
    await pause()
    const firstAsk = waiting("c-rule-1")
    if (firstAsk) permissions.respond(firstAsk.id, "always")
    await first
    const same = inProject("s-rule-2", projectA, "c-rule-2", "npm run build --watch", ["npm run build *"])
    await pause()
    check("always on a command prefix covers it in another conversation of the same project", Boolean(firstAsk) && !settleIfAsked("c-rule-2") && (await same) === "allowed")
    const otherCommand = inProject("s-rule-2", projectA, "c-rule-3", "npm test", ["npm test *"])
    await pause()
    check("but not a command with another prefix", settleIfAsked("c-rule-3"))
    await otherCommand
    const otherProject = inProject("s-rule-3", projectB, "c-rule-4", "npm run build", ["npm run build *"])
    await pause()
    check("nor the same command in another project", settleIfAsked("c-rule-4"))
    await otherProject

    const heard: PermissionRecord[] = []
    const stopHearing = permissions.onDecided("c-rule-6", (record) => heard.push(record))
    const logOne = inProject("s-rule-4", projectA, "c-rule-5", "make all", ["make all *"])
    const logTwo = inProject("s-rule-5", projectA, "c-rule-6", "make all -j2", ["make all *"])
    await pause()
    const logAsk = waiting("c-rule-5")
    if (logAsk) permissions.respond(logAsk.id, "always")
    // Raced against a pause and settled after, so a release that never comes fails here rather than hanging the run.
    const secondSettled = await Promise.race([logTwo, new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 500))])
    const stillParked = settleIfAsked("c-rule-6")
    check("answering always lets through a question already waiting that it covers", (await logOne) === "allowed" && secondSettled === "allowed" && !stillParked, secondSettled)
    await logTwo
    check("recorded as let through by that always", heard[0]?.decided === "allow-always", heard)
    stopHearing()

    check(
      "MiMo's wildcard: a trailing ' *' also matches the words alone, slashes match either way",
      wildcardMatch("git status", "git status *") && wildcardMatch("git status -s", "git status *") && !wildcardMatch("git statusx", "git status *") && wildcardMatch("C:\\work\\a\\b.txt", "C:/work/*"),
    )
  }

  // A decided question is reported to whoever listens for its call, so the part can keep it.
  {
    const heard: PermissionRecord[] = []
    const resolved: ServerEvent[] = []
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === "permission.resolved") resolved.push(event)
    })
    const listen = (callID: string) => permissions.onDecided(callID, (record) => heard.push(record))
    const decide = async (callID: string, respond: (id: string) => void) => {
      const stop = listen(callID)
      const asked = permissions
        .ask({ sessionID: "s-record", messageID: "m-record", callID, kind: "write", title: "t", subject: `${callID}.md`, preview: "--- a/x\n+++ b/x\n" })
        .then(() => "allowed", (err: Error) => err.message)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const request = permissions.outstanding().find((entry) => entry.callID === callID)
      if (request) respond(request.id)
      const result = await asked
      stop()
      return result
    }

    const refused = await decide("c-rec-reason", (id) => permissions.respond(id, "reject", "not this file"))
    check("a refusal with a reason is recorded as such", heard[0]?.decided === "reject-with-reason" && heard[0]?.reason === "not this file", heard[0])
    check("and the model still reads the reason", refused.includes("not this file"), refused)
    check("the record carries what was asked", heard[0]?.kind === "write" && heard[0]?.subject === "c-rec-reason.md" && heard[0]?.preview?.startsWith("--- a/x") === true, heard[0])
    check("permission.resolved says how it ended", resolved.some((event) => event.type === "permission.resolved" && event.decided === "reject-with-reason" && event.reason === "not this file"), resolved)

    await decide("c-rec-plain", (id) => permissions.respond(id, "reject"))
    check("a bare refusal is recorded as a reject", heard[1]?.decided === "reject" && heard[1]?.reason === undefined, heard[1])

    await decide("c-rec-once", (id) => permissions.respond(id, "once"))
    check("an approval for once is recorded", heard[2]?.decided === "allow-once", heard[2])

    await decide("c-rec-stop", () => permissions.rejectAll("s-record"))
    check("a question closed by Stop is recorded as cancelled", heard[3]?.decided === "cancelled", heard[3])

    // Who said no decides whether the turn ends: a person does; a setting or a Stop does not.
    const refusalOf = async (gate: Permissions, callID: string, settle: (id: string) => void) => {
      const asked = gate
        .ask({ sessionID: "s-byuser", messageID: "m-byuser", callID, kind: "write", title: "t", subject: `${callID}.md` })
        .then(() => undefined, (err: unknown) => err)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const request = gate.outstanding().find((entry) => entry.callID === callID)
      if (request) settle(request.id)
      return asked
    }
    const plainRefusal = await refusalOf(permissions, "c-by-plain", (id) => permissions.respond(id, "reject"))
    const reasonedRefusal = await refusalOf(permissions, "c-by-reason", (id) => permissions.respond(id, "reject", "not here"))
    const stoppedRefusal = await refusalOf(permissions, "c-by-stop", () => permissions.rejectAll("s-byuser"))
    check(
      "a person's refusal is marked as theirs, with or without a reason",
      plainRefusal instanceof PermissionDenied && plainRefusal.byUser && reasonedRefusal instanceof PermissionDenied && reasonedRefusal.byUser,
      [plainRefusal, reasonedRefusal],
    )
    check("a Stop is not", stoppedRefusal instanceof PermissionDenied && !stoppedRefusal.byUser, stoppedRefusal)
    const denyingGate = new Permissions(new Bus(), { get: () => ({ permissions: { ...PERMISSION_DEFAULTS, write: "deny" } }) } as never)
    const settingRefusal = await refusalOf(denyingGate, "c-by-setting", () => {})
    check("nor is a bucket set to Deny", settingRefusal instanceof PermissionDenied && !settingRefusal.byUser, settingRefusal)

    const before = heard.length
    const unheard = permissions
      .ask({ sessionID: "s-record", messageID: "m-record", callID: "c-rec-none", kind: "write", title: "t", subject: "x.md" })
      .catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    permissions.rejectAll("s-record")
    await unheard
    check("a call nobody listens for records nothing", heard.length === before, heard.slice(before))
    unsubscribe()
  }

  section("Question dock")
  {
    const asking = new Questions(bus)
    const questionContext = (callID: string, signal: AbortSignal) => ({ ...context(callID), questions: asking, signal })
    const input = {
      questions: [
        { question: "Which runtime?", header: "Runtime", options: [{ label: "Node", description: "" }, { label: "Bun", description: "" }] },
        { question: "Which checks?", header: "Checks", options: [{ label: "lint", description: "" }], multiple: true },
      ],
    }

    // The dock's X replies with every answer empty rather than refusing.
    const running = QuestionTool.execute(input, questionContext("c-q-dismiss", controller.signal) as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const parked = asking.outstanding()[0]
    check("a question is stamped with when it was asked", typeof parked?.time === "number" && parked.time > 0, parked)
    if (parked) asking.reply(parked.id, parked.questions.map(() => []))
    const dismissedResult = await running
    check("dismissing replies with every answer empty", JSON.stringify(dismissedResult.metadata?.answers) === "[[],[]]", dismissedResult.metadata)
    check("which the model reads as unanswered, not as an error", dismissedResult.output.includes('"Which runtime?"="Unanswered"'), dismissedResult.output)
    check("and the transcript shows as cancelled", questionOutcome({ status: "completed", metadata: dismissedResult.metadata }) === "cancelled")
    check("an answer shows as answered", questionOutcome({ status: "completed", metadata: { answers: [["Node"], []] } }) === "answered")
    check("a stopped question is cancelled too", questionOutcome({ status: "error" }) === "cancelled")
    check("a waiting one is neither", questionOutcome({ status: "running" }) === "pending")

    const stopper = new AbortController()
    const stopped = QuestionTool.execute(input, questionContext("c-q-stop", stopper.signal) as never).then(
      () => undefined,
      (err: unknown) => err,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    stopper.abort()
    const stopError = await stopped
    check("Stop refuses with a code, so nothing reads English", stopError instanceof ToolError && stopError.code === QUESTION_DISMISSED, stopError)
    check("and leaves nothing parked", asking.outstanding().length === 0, asking.outstanding())

    check("composer text answers question one only", JSON.stringify(composerAnswers("  use bun ", 3)) === '[["use bun"],[],[]]')
    check("blank composer text answers nothing", composerAnswers("   ", 2) === undefined)

    const perm = (id: string, sessionID: string, time: number): PermissionRequest => ({
      id,
      sessionID,
      messageID: "m",
      callID: `c-${id}`,
      kind: "bash",
      title: "t",
      subject: "s",
      time,
    })
    const ask = (id: string, sessionID: string, time: number): QuestionRequest => ({ id, sessionID, questions: [], time })
    const queued = confirmQueue("s1", [perm("p1", "s1", 100), perm("p2", "s1", 300), perm("px", "s2", 50)], [ask("q1", "s1", 200), ask("qx", "s2", 10)])
    check("the dock queues questions and permissions by arrival", queued.map((item) => item.id).join() === "p1,q1,p2", queued.map((item) => item.id))
    check("1/N counts both kinds, this session only", queued.length === 3)
    check("a question that arrived first is shown first", confirmQueue("s1", [perm("p1", "s1", 100)], [ask("q0", "s1", 90)])[0]?.kind === "question")
    check("no session, no queue", confirmQueue(undefined, [perm("p1", "s1", 1)], []).length === 0)

    check("a single choice picks, and a second click clears it", JSON.stringify(toggleChoice([], "a", false)) === '["a"]' && toggleChoice(["a"], "a", false).length === 0)
    check("a multi choice toggles each label", JSON.stringify(toggleChoice(["a"], "b", true)) === '["a","b"]' && JSON.stringify(toggleChoice(["a", "b"], "a", true)) === '["b"]')
    check("typed text is appended once", JSON.stringify(mergeCustom([["a"], []], ["b", " "])) === '[["a","b"],[]]' && JSON.stringify(mergeCustom([["a"]], ["a"])) === '[["a"]]')
    check("advancing goes on, then back to the first gap, then submits", nextStop([false, false], 0) === 1 && nextStop([false, true], 1) === 0 && nextStop([true, true], 1) === "submit")
  }

  section("Permission guide")
  {
    const counted = { allowCount: 3, dismissed: false, taskAllowOn: false }
    check("offered after three approvals by hand", guideShown(counted, "ask", "permission", false))
    check("not before", !guideShown({ ...counted, allowCount: 2 }, "ask", "permission", false))
    check(
      "never over a delete, a question, or once waved off",
      !guideShown(counted, "ask", "permission", true) &&
        !guideShown(counted, "ask", "question", false) &&
        !guideShown({ ...counted, dismissed: true }, "ask", "permission", false),
    )
    check(
      "nor while the task is allowed, or at another level",
      !guideShown({ ...counted, taskAllowOn: true }, "ask", "permission", false) &&
        !guideShown(counted, "auto", "permission", false) &&
        !guideShown(counted, "full", "permission", false),
    )
    const allAllowed = Object.fromEntries(PERMISSION_KINDS.map((kind) => [kind, "allow"]))
    check(
      "the level is read the way the composer chip reads it",
      defaultAccess({ accessLevel: "auto" }) === "auto" && defaultAccess({ permissions: { ...PERMISSION_DEFAULTS } }) === "ask" && defaultAccess({ permissions: allAllowed }) === "full",
    )

    section("round 5: turning off the full access switch (D2)")
    {
      const mine = { ...PERMISSION_DEFAULTS, bash: "allow" as const, webfetch: "deny" as const }
      const toFull = accessPatch({ permissions: mine, accessLevel: "ask" }, "full")!
      check(
        "full allows every bucket but a deny, and keeps the map it replaced",
        defaultAccess(toFull) === "full" && toFull.permissions.webfetch === "deny" && toFull.accessBefore?.bash === "allow",
        toFull,
      )
      const off = fullAccessOff({ ...toFull })
      check(
        "switching off at full access drops to the default level with the user's own answers back",
        off.dropped &&
          off.patch.allowFullAccess === false &&
          off.patch.accessLevel === "ask" &&
          defaultAccess(off.patch) === "ask" &&
          off.patch.permissions?.bash === "allow" &&
          off.patch.permissions?.edit === PERMISSION_DEFAULTS.edit &&
          off.patch.accessBefore === undefined,
        off,
      )
      const offAsk = fullAccessOff({ permissions: { ...PERMISSION_DEFAULTS }, accessLevel: "auto" })
      check(
        "switching off below full access only turns the switch off",
        !offAsk.dropped && JSON.stringify(offAsk.patch) === JSON.stringify({ allowFullAccess: false }),
        offAsk,
      )
      const guardConfig = { permissions: toFull.permissions, accessBefore: toFull.accessBefore, accessLevel: "full", allowFullAccess: false }
      const guarded = new Permissions(new Bus(), { get: () => guardConfig } as never)
      check(
        "the server does not honour full access while its switch is off",
        guarded.action("edit") === PERMISSION_DEFAULTS.edit && guarded.action("bash") === "allow" && guarded.action("webfetch") === "deny",
      )
      guardConfig.allowFullAccess = true
      check("and honours it once the switch is on", guarded.action("edit") === "allow")

      const fullData = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-fullswitch-"))
      const fullStorage = new SubagentStorage(path.join(fullData, "storage"))
      await fullStorage.write("config", { permissions: allAllowed, accessLevel: "full", allowFullAccess: false })
      const fullConfig = new SubagentConfig(fullStorage, new Bus(), path.join(fullData, "credentials.json"))
      await fullConfig.load()
      check("a config already at full access keeps it on upgrade by turning the switch on", fullConfig.get().allowFullAccess === true)
      await fullStorage.write("config", { permissions: { ...PERMISSION_DEFAULTS }, allowFullAccess: false })
      const askConfig = new SubagentConfig(fullStorage, new Bus(), path.join(fullData, "credentials.json"))
      await askConfig.load()
      check("a config below full access leaves the switch off", askConfig.get().allowFullAccess === false)

      /* R12, the user's 2026-09-15 decision: MiMo's first-install defaults, and only where nothing is stored. */
      const freshData = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-firstinstall-"))
      const freshStorage = new SubagentStorage(path.join(freshData, "storage"))
      const freshConfig = new SubagentConfig(freshStorage, new Bus(), path.join(freshData, "credentials.json"))
      await freshConfig.load()
      check(
        "a first install starts on 帮我审批 with full access allowed",
        freshConfig.get().accessLevel === "auto" && freshConfig.get().allowFullAccess === true,
        { accessLevel: freshConfig.get().accessLevel, allowFullAccess: freshConfig.get().allowFullAccess },
      )
      check("and its permission map is the ordinary default", JSON.stringify(freshConfig.get().permissions) === JSON.stringify(PERMISSION_DEFAULTS))
      const storedAsk = { permissions: { ...PERMISSION_DEFAULTS }, allowFullAccess: false, theme: "dark" }
      await freshStorage.write("config", storedAsk)
      const keptConfig = new SubagentConfig(freshStorage, new Bus(), path.join(freshData, "credentials.json"))
      await keptConfig.load()
      check(
        "a stored config without an access level keeps the default level and the switch off",
        keptConfig.get().accessLevel === undefined && keptConfig.get().allowFullAccess === false,
        { accessLevel: keptConfig.get().accessLevel, allowFullAccess: keptConfig.get().allowFullAccess },
      )
      const onDisk = JSON.parse(await fs.readFile(path.join(freshData, "storage", "config.json"), "utf8")) as Record<string, unknown>
      check("and nothing rewrites those stored fields", onDisk.accessLevel === undefined && onDisk.allowFullAccess === false, { accessLevel: onDisk.accessLevel, allowFullAccess: onDisk.allowFullAccess })
      await fs.rm(freshData, { recursive: true, force: true })
      await fs.rm(fullData, { recursive: true, force: true })
    }

    // 帮我审批 turns on the middle level; what it lets through stops waiting, a delete does not.
    let level = "ask"
    const guideBus = new Bus()
    const gate = new Permissions(guideBus, { get: () => ({ permissions: { ...PERMISSION_DEFAULTS }, accessLevel: level }) } as never)
    const heardGuide: PermissionRecord[] = []
    const stopEdit = gate.onDecided("c-guide-edit", (record) => heardGuide.push(record))
    const settle = (callID: string, kind: "edit" | "bash", subject: string) =>
      gate.ask({ sessionID: "s-guide", messageID: "m", callID, kind, title: "t", subject }).then(
        () => "allowed",
        (err: Error) => err.message,
      )
    const editAsk = settle("c-guide-edit", "edit", "a.ts")
    const deleteAsk = settle("c-guide-rm", "bash", "rm -rf build")
    await new Promise((resolve) => setTimeout(resolve, 20))
    check("both wait at the default level", gate.outstanding().length === 2, gate.outstanding())
    level = "auto"
    guideBus.publish({ type: "config.updated", config: {} as never })
    check("the edit goes through once the level changes", (await editAsk) === "allowed")
    check("recorded as allowed for this time", heardGuide[0]?.decided === "allow-once", heardGuide)
    check("while a delete still waits", gate.outstanding().length === 1 && gate.outstanding()[0]?.forced === true, gate.outstanding())
    gate.rejectAll("s-guide")
    await deleteAsk
    stopEdit()

    // R3: MiMo keeps the access level per conversation; one without follows the default.
    const own = { permissions: { ...PERMISSION_DEFAULTS }, allowFullAccess: true }
    check(
      "a conversation without a level of its own follows the default",
      sessionAccess(undefined, own) === "ask" && sessionAccess(undefined, { ...own, accessLevel: "auto" }) === "auto" && sessionAccess("bogus", own) === "ask",
    )
    check(
      "a conversation's own level wins over the default",
      sessionAccess("auto", own) === "auto" && sessionAccess("full", own) === "full" && sessionAccess("ask", { ...own, accessLevel: "auto" }) === "ask",
    )
    check("its own full access lapses once full access is not allowed", sessionAccess("full", { ...own, allowFullAccess: false }) === "ask")
    const fullDefault = { permissions: { ...allAllowed, bash: "deny" }, accessBefore: { ...PERMISSION_DEFAULTS }, allowFullAccess: true }
    check(
      "below full access a conversation runs on the map full access set aside, and a refusal holds at every level",
      defaultAccess(fullDefault) === "full" &&
        accessAction("edit", "ask", fullDefault) === PERMISSION_DEFAULTS.edit &&
        accessAction("edit", "full", fullDefault) === "allow" &&
        accessAction("bash", "ask", fullDefault) === "deny" &&
        accessAction("bash", "full", fullDefault) === "deny",
    )
    const levelsBus = new Bus()
    const levels: Record<string, string | undefined> = { "s-own": "auto" }
    const levelGate = new Permissions(levelsBus, { get: () => ({ ...own }) } as never)
    levelGate.useSessions(async (id) => levels[id])
    const editIn = (sessionID: string) => levelGate.ask({ sessionID, messageID: "m", callID: `c-${sessionID}`, kind: "edit", title: "t", subject: "a.ts" })
    const within = (promise: Promise<void>) => Promise.race([promise.then(() => "ran"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))])
    const waitingEdit = editIn("s-other")
    check(
      "an edit runs in the conversation on 帮我审批 and waits in one on the default",
      (await within(editIn("s-own"))) === "ran" && (await within(waitingEdit)) === "waiting",
    )
    levels["s-other"] = "full"
    levelsBus.publish({ type: "session.updated", session: {} as never })
    check("raising that one conversation's level lets its waiting edit through", (await within(waitingEdit)) === "ran" && levelGate.outstanding().length === 0)
  }

  section("Tool arguments")
  {
    const readSchema = findTool("read")!.parameters
    check("arguments that fit have no problems", argumentProblems(readSchema, { file_path: "a.ts", limit: 20 }).length === 0)
    const missing = argumentProblems(readSchema, {})
    check("a missing required field is named", missing.length === 1 && missing[0] === "file_path is required", missing)
    const wrong = argumentProblems(readSchema, { file_path: 5 })
    check("a wrong type is named with what arrived", wrong[0] === "file_path should be string, got integer", wrong)
    const nestedEnum = { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { status: { type: "string", enum: ["pending", "done"] } } } } } }
    const todos = argumentProblems(nestedEnum, {
      todos: [{ id: "1", content: "x", status: "doing" }],
    })
    check("a nested enum is checked", todos.length === 1 && todos[0]!.startsWith("todos[0].status should be one of"), todos)
    check(
      "a schema construct the checker does not know is let through",
      argumentProblems({ type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } }, { value: true }).length === 0,
    )
    // E20: MiMo's repair of a tool call.
    const offered = repairableNames()
    check(
      "a tool name is repaired by case, then with dashes, underscores and spaces ignored",
      resolveToolName("READ", offered) === "read" && resolveToolName("NotebookEdit", offered) === "notebook_edit" && resolveToolName("mcp__fake__echo", ["fake_echo"]) === "fake_echo" && resolveToolName("reed", offered) === undefined,
    )
    check(
      "argument names are put onto the schema's spelling, an exact one winning",
      JSON.stringify(normalizeToolInput({ filePath: "a.ts", offset: 2 }, readSchema)) === JSON.stringify({ offset: 2, file_path: "a.ts" }) && normalizeToolInput({ file_path: "x", filePath: "y" }, readSchema).file_path === "x",
    )
    const note = refusedArgumentsNote("read", wrong)
    check("the note says nothing ran and what to send", note.includes("was not run") && note.includes("path should be string"), note)
  }

  section("Provider retries")
  {
    check("a dropped connection is retried", isRetryable(new TypeError("fetch failed")))
    check("a 503 from an OpenAI-compatible provider is retried", isRetryable(new ProviderHttpError("The provider returned 503. This is usually transient.", 503, {})))
    check("a rate limit is retried", isRetryable(new Error("Rate limited by the provider. Wait a moment and try again.")))
    check("a refused key is not retried", !isRetryable(new Error("Authentication failed - check the API key in Settings.")))
    check(
      "a prompt too long for the model is not retried",
      !isRetryable(new Error("request (22530 tokens) exceeds the available context size (8192 tokens), try increasing it")),
    )
    const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" })
    check("a reset hidden in the cause is retried", isRetryable(new TypeError("request failed", { cause })))
    // MiMo's network budget: five seconds doubling to a minute, no jitter, and no giving up.
    const dropped = new TypeError("fetch failed")
    check("a dropped connection first waits five seconds", retryDecision(dropped, 1, 0, 1)?.wait === 5000, retryDecision(dropped, 1, 0, 1))
    check("it doubles", retryDecision(dropped, 3, 0, 0)?.wait === 20000, retryDecision(dropped, 3, 0, 0))
    check("and stops at a minute", retryDecision(dropped, 9, 0, 1)?.wait === 60000, retryDecision(dropped, 9, 0, 1))
    check("and is never given up", retryDecision(dropped, 500, 24 * 60 * 60_000)?.kind === "network")
    const busy = new ProviderHttpError("The provider returned 503. This is usually transient.", 503, {})
    check("a server error has eight attempts, then it gives up", retryDecision(busy, RETRY_BUDGETS.server.retries, 0) !== undefined && retryDecision(busy, RETRY_BUDGETS.server.retries + 1, 0) === undefined)
  }

  // ------------------------------------------------------------- turn revert
  section("Turn revert")
  {
    const before = "alpha\nbeta\ngamma\ndelta\n"
    const after = "alpha\nBETA\ngamma\ndelta\nepsilon\n"
    const turnDiff = unifiedDiff("notes.txt", before, after)
    const parsed = parseUnifiedDiff(turnDiff)
    check("a diff splits into its file", parsed.length === 1 && parsed[0]!.file === "notes.txt", parsed)
    check("reversing a section restores the text", reverseSection(after, parsed[0]!) === before)
    const later = "intro\n" + after
    check("a hunk is found where later edits moved it", reverseSection(later, parsed[0]!) === "intro\n" + before)
    check("a hunk whose lines are gone refuses", reverseSection("something else\n", parsed[0]!) === undefined)
    const tricky = parseUnifiedDiff(unifiedDiff("a.txt", "-- x\n", "++ y\n") + "\n" + unifiedDiff("b.txt", "", "new\n"))
    check("a removed '-- ' line is not read as a file header", tricky.map((s) => s.file).join(",") === "a.txt,b.txt", tricky)

    const root = path.join(project, "turn-revert")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "kept.txt"), "one\ntwo\nthree\n")
    await fs.writeFile(path.join(root, "made.txt"), "brand new\n")
    const tool = (id: string, name: string, metadata: Record<string, unknown>) => ({
      type: "tool" as const, id, callID: id, name, status: "completed" as const, input: {}, metadata, time: { created: 0 },
    })
    const turnMessage = {
      id: "msg_turn", sessionID: "s", role: "assistant" as const, model: { provider: "p", model: "m" }, agent: "build" as const,
      parts: [
        tool("t1", "edit", { path: "kept.txt", diff: unifiedDiff("kept.txt", "one\n2\nthree\n", "one\ntwo\nthree\n") }),
        tool("t2", "write", { path: "made.txt", created: true, diff: unifiedDiff("made.txt", "", "brand new\n") }),
        tool("t3", "write", { path: "../escape.txt", diff: unifiedDiff("../escape.txt", "", "x\n") }),
      ],
      time: { created: 0 },
    }
    /*
     * Taking a turn back goes through git, as MiMo's does. Outside a
     * repository it refuses and writes nothing; inside one it reverse-applies
     * the turn's patches, recomputes a patch whose hunk later edits have
     * moved, and falls back to `git checkout --` for a tracked file whose
     * lines are gone altogether.
     */
    const refused = await revertTurnFiles(root, [turnMessage])
    check("outside a repository a revert refuses and touches nothing", refused.noRepo === true && refused.restored === 0 && refused.removed === 0, refused)
    check("the file the refusal did not touch is as the turn left it", (await fs.readFile(path.join(root, "kept.txt"), "utf8")) === "one\ntwo\nthree\n")
    check("the file the refusal did not touch is still there", await exists(path.join(root, "made.txt")))

    const repo = path.join(project, "turn-revert-repo")
    await fs.mkdir(repo, { recursive: true })
    const inRepo = async (...args: string[]) => await promisify(execFile)("git", args, { cwd: repo })
    await inRepo("init", "-q")
    await inRepo("config", "user.email", "smoke@example.invalid")
    await inRepo("config", "user.name", "Smoke")
    await fs.writeFile(path.join(repo, "kept.txt"), "one\ntwo\nthree\n")
    await fs.writeFile(path.join(repo, "moved.txt"), "alpha\nbeta\ngamma\n")
    await fs.writeFile(path.join(repo, "gone.txt"), "first\nsecond\n")
    await inRepo("add", "-A")
    await inRepo("commit", "-qm", "before the turn")
    /* What the turn did: an edit in each file, and one file it created. */
    await fs.writeFile(path.join(repo, "kept.txt"), "one\n2\nthree\n")
    await fs.writeFile(path.join(repo, "moved.txt"), "alpha\nBETA\ngamma\n")
    await fs.writeFile(path.join(repo, "gone.txt"), "first\nSECOND\n")
    await fs.writeFile(path.join(repo, "made.txt"), "brand new\n")
    const repoTurn = {
      ...turnMessage,
      parts: [
        tool("g1", "edit", { path: "kept.txt", diff: unifiedDiff("kept.txt", "one\ntwo\nthree\n", "one\n2\nthree\n") }),
        tool("g2", "edit", { path: "moved.txt", diff: unifiedDiff("moved.txt", "alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n") }),
        tool("g3", "edit", { path: "gone.txt", diff: unifiedDiff("gone.txt", "first\nsecond\n", "first\nSECOND\n") }),
        tool("g4", "write", { path: "made.txt", created: true, diff: unifiedDiff("made.txt", "", "brand new\n") }),
        tool("g5", "write", { path: "../escape.txt", diff: unifiedDiff("../escape.txt", "", "x\n") }),
      ],
    }
    /* Since the turn: lines added above one file's hunk, and another rewritten past recognising. */
    await fs.writeFile(path.join(repo, "moved.txt"), "header\nlines\nadded\nalpha\nBETA\ngamma\n")
    await fs.writeFile(path.join(repo, "gone.txt"), "nothing the turn wrote is here\n")
    const throughGit = await revertTurnFiles(repo, [repoTurn])
    check(
      "inside a repository the turn's edits go back and the file it made is deleted",
      throughGit.noRepo === undefined && throughGit.restored === 3 && throughGit.removed === 1 && throughGit.failed === 0 && throughGit.outside === 1,
      throughGit,
    )
    const back = async (name: string) => (await fs.readFile(path.join(repo, name), "utf8")).replace(/\r\n/g, "\n")
    check("a plain edit is reverse-applied", (await back("kept.txt")) === "one\ntwo\nthree\n", await back("kept.txt"))
    check(
      "a hunk later edits moved is found and only that hunk is taken back",
      (await back("moved.txt")) === "header\nlines\nadded\nalpha\nbeta\ngamma\n",
      await back("moved.txt"),
    )
    check("a tracked file whose lines are gone falls back to git checkout", (await back("gone.txt")) === "first\nsecond\n", await back("gone.txt"))
    check("the created file is gone", !(await exists(path.join(repo, "made.txt"))))
    check("a path outside the project is never written", !(await exists(path.join(project, "escape.txt"))))

    /* An untracked file the turn edited has no index to fall back on, so a lost hunk fails rather than being invented. */
    await fs.writeFile(path.join(repo, "loose.txt"), "kept as it is\n")
    const looseTurn = {
      ...turnMessage,
      parts: [tool("g6", "edit", { path: "loose.txt", diff: unifiedDiff("loose.txt", "was\n", "now\n") })],
    }
    const loose = await revertTurnFiles(repo, [looseTurn])
    check("an untracked file whose hunk is gone is counted as failed and left alone", loose.failed === 1 && loose.restored === 0, loose)
    check("that file still reads exactly as it did", (await fs.readFile(path.join(repo, "loose.txt"), "utf8")) === "kept as it is\n")

    /* The pure halves, so the patch writer and the recount are covered without a repository. */
    const oneSection = parseUnifiedDiff(unifiedDiff("x.txt", "a\nb\n", "a\nB\n"))[0]!
    const written = sectionPatch(oneSection)
    check("a section writes back out as a patch git can read", written.startsWith("--- a/x.txt\n+++ b/x.txt\n@@ ") && written.includes("-b") && written.includes("+B"), written)
    /* The file's final newline must not become a context line past the end of the file, or git apply refuses the hunk. */
    check("a patch does not ask git to match a line past the end of the file", written.includes("@@ -1,2 +1,2 @@") && !written.endsWith("\n \n"), written)
    const shifted = recountedSection("pad\npad\na\nB\n", oneSection)
    check("a recount moves the hunk to where its lines now stand", shifted?.hunks[0]?.newStart === 3, shifted?.hunks[0])
    check("a recount of lines that are gone answers nothing", recountedSection("unrelated\n", oneSection) === undefined)
  }

  // ------------------------------------------------------------------- units
  section("Units")
  const diff = unifiedDiff("f.ts", "a\nb\nc\n", "a\nB\nc\n")
  check("diff marks the changed line", diff.includes("-b") && diff.includes("+B"), diff)
  check("diff keeps context", diff.includes(" a") && diff.includes(" c"))
  check("identical input yields no diff", unifiedDiff("f.ts", "same", "same") === "")

  check("glob ** spans directories", globToRegExp("**/*.ts").test("src/deep/x.ts"))
  check("glob **/ matches at root", globToRegExp("**/*.ts").test("x.ts"))
  check("glob * stops at separator", !globToRegExp("*.ts").test("src/x.ts"))
  check("glob alternation works", globToRegExp("src/{a,b}.ts").test("src/b.ts"))

  check("every tool has a schema", TOOLS.every((tool) => tool.parameters && tool.description.length > 20))
  check("tool names are unique", new Set(TOOLS.map((t) => t.name)).size === TOOLS.length)

  // ---------------------------------------------------- provider conversion
  section("Provider conversion")
  // MiMo's annotations reach the model after what was typed; the transcript keeps them beside it.
  const annotated = toProviderMessages([
    {
      id: "msg_ann",
      sessionID,
      role: "user",
      text: "tidy this",
      attachments: [],
      annotations: [
        { id: "ann-1", kind: "answer", quote: "quick brown", occ: 2, occTotal: 3, text: "shorter" },
        { id: "ann-2", kind: "file", path: "/p/a.ts", name: "a.ts", text: "" },
      ],
      time: { created: 1 },
    },
  ])
  const annotatedText = ((annotated[0]?.content as any[]) ?? []).map((block) => block.text).join("\n")
  check(
    "annotations follow the typed text for the model",
    annotatedText.startsWith("tidy this\n\n<annotations>") &&
      annotatedText.includes('(occurrence 2 of 3): "quick brown"') &&
      annotatedText.includes("Note: shorter") &&
      annotatedText.includes("File /p/a.ts (the whole file)") &&
      annotatedText.trimEnd().endsWith("</annotations>"),
    annotatedText,
  )
  check("no annotations adds nothing", annotationsBlock([]) === "" && annotationsBlock(undefined) === "")
  const pdfBlock = annotationsBlock([
    {
      id: "ann-pdf",
      kind: "pdf",
      path: "/p/doc.pdf",
      name: "doc.pdf",
      page: 2,
      quote: "Second page",
      occ: 1,
      occTotal: 1,
      rect: { x: 72, y: 700, w: 120.25, h: 24, pageW: 612, pageH: 792 },
      text: "look here",
    },
  ])
  check(
    "a PDF annotation names its page and where on it",
    pdfBlock.includes("PDF /p/doc.pdf, page 2") &&
      pdfBlock.includes('Selected text: "Second page"') &&
      pdfBlock.includes("Position: x 72, y 700, width 120.3, height 24 (PDF points from the bottom-left corner of a 612 x 792 page)"),
    pdfBlock,
  )
  const slideBlock = annotationsBlock([
    { id: "ann-s1", kind: "pptx", path: "/p/deck.pptx", slide: 1, slideId: "257", shapeId: "4", shapeName: "Chart 3", quote: "Q3", occ: 1, occTotal: 1, region: { fx: 0.1, fy: 0.2, fw: 0.5, fh: 0.4 }, text: "" },
    { id: "ann-s2", kind: "pptx", path: "/p/deck.pptx", slide: 0, slideId: "256", region: { fx: 0.604, fy: 0.25, fw: 0.2, fh: 0.1 }, boxed: true, text: "move this" },
  ])
  const sheetBlock = annotationsBlock([
    { id: "ann-c", kind: "xlsx", path: "/p/b.xlsx", sheet: "Data", sheetId: "sheet_0_1", a1: "B2:C3", quote: "10 | 7", text: "" },
    { id: "ann-g", kind: "chart", path: "/p/b.xlsx", sheet: "Data", chartKind: "column", dataRef: "Data!$A$2:$A$4 / Data!$B$2:$B$4", text: "recolour" },
    { id: "ann-h", kind: "html", path: "/p/landing.html", name: "landing.html", selector: "#hero", tag: "h1", quote: "Grow faster", text: "bolder" },
  ])
  check(
    "sheet, chart and web page annotations name their place",
    sheetBlock.includes('Spreadsheet /p/b.xlsx, sheet "Data"!B2:C3') &&
      sheetBlock.includes("Current cell values: 10 | 7") &&
      sheetBlock.includes('chart "(untitled)" (column; Data!$A$2:$A$4 / Data!$B$2:$B$4)') &&
      sheetBlock.includes("the module matching CSS selector `#hero` <h1>, containing \"Grow faster\"") &&
      sheetBlock.includes("A web page module is found by its selector"),
    sheetBlock,
  )
  check(
    "a slide annotation names the shape it matched, or the region drawn",
    slideBlock.includes('Presentation /p/deck.pptx, slide 2 (slide id 257), shape "Chart 3" (shape id 4)') &&
      slideBlock.includes('Selected text: "Q3"') &&
      slideBlock.includes("Presentation /p/deck.pptx, slide 1 (slide id 256), the region roughly from (60%, 25%) to (80%, 35%) of the slide") &&
      slideBlock.includes("Note: move this"),
    slideBlock,
  )
  // The API rejects a tool_use that is not answered by a tool_result with the
  // same id in the very next turn, so this mapping is where history bugs hide.
  const converted = toProviderMessages([
    {
      id: "msg_1",
      sessionID,
      role: "user",
      text: "fix it",
      attachments: [],
      time: { created: 1 },
    },
    {
      id: "msg_2",
      sessionID,
      role: "assistant",
      model: { provider: "anthropic", model: "claude-opus-5" },
      agent: "build",
      parts: [
        { type: "reasoning", id: "p0", text: "pondering", time: { created: 1 } },
        { type: "text", id: "p1", text: "Reading the file." },
        {
          type: "tool",
          id: "p2",
          callID: "toolu_ok",
          name: "read",
          status: "completed",
          input: { path: "a.ts" },
          output: "contents",
          time: { created: 1 },
        },
        {
          type: "tool",
          id: "p3",
          callID: "toolu_bad",
          name: "edit",
          status: "error",
          input: { path: "a.ts" },
          error: "no match",
          time: { created: 1 },
        },
        {
          type: "tool",
          id: "p4",
          callID: "toolu_never",
          name: "bash",
          status: "running",
          input: {},
          time: { created: 1 },
        },
      ],
      time: { created: 1 },
    },
  ])

  const assistantTurn = converted.find((m) => m.role === "assistant")
  const resultTurn = converted.filter((m) => m.role === "user").at(-1)
  const blocks = assistantTurn?.content as any[]
  const results = resultTurn?.content as any[]

  const useIDs = blocks.filter((b) => b.type === "tool_use").map((b) => b.id)
  const resultIDs = results.map((b) => b.tool_use_id)
  check("every tool_use has a matching tool_result", JSON.stringify(useIDs) === JSON.stringify(resultIDs), {
    useIDs,
    resultIDs,
  })
  // MiMo answers a call that never finished as interrupted rather than dropping it.
  check(
    "an unfinished tool is answered as interrupted",
    useIDs.includes("toolu_never") && results.find((b) => b.tool_use_id === "toolu_never")?.content === "[Tool execution was interrupted]",
    results,
  )
  check("failed tool is marked is_error", results.find((b) => b.tool_use_id === "toolu_bad")?.is_error === true)
  check("failed tool sends its error as content", results.find((b) => b.tool_use_id === "toolu_bad")?.content === "no match")
  check("reasoning is not replayed", !blocks.some((b) => b.type === "thinking"), blocks.map((b) => b.type))
  check("assistant text survives", blocks.some((b) => b.type === "text" && b.text === "Reading the file."))
  check("turn order is user, assistant, tool results", converted.map((m) => m.role).join(",") === "user,assistant,user")

  // usageFrom now takes the pricing entry directly: discovered providers have
  // no published rates, so the caller decides whether a rate exists at all.
  const cost = usageFrom(
    { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
    { input: 5, output: 25 },
  )
  check("cost applies the supplied rate", Math.abs(cost.cost - 30) < 0.001, cost.cost)

  const unpriced = usageFrom(
    { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
    undefined,
  )
  check("unpriced models report no cost", unpriced.cost === 0, unpriced.cost)

  // ----------------------------------------------------------- durability
  section("Storage")
  {
    /*
     * A streaming reply saves itself every 500ms while the turn runs, so writes
     * to one key overlap. Sharing a temp file made the second rename fail with
     * ENOENT, which surfaced as a red box in the transcript.
     */
    const store = backend.runtime.storage
    const key = "probe/concurrent"
    /*
     * Deliberately uneven: the first write carries a megabyte and the last
     * carries almost nothing. Without ordering the big early write finishes
     * last and overwrites the newer value, which equal-sized payloads hide by
     * completing in the order they started.
     */
    const writes = Array.from({ length: 40 }, (_, index) =>
      store.write(key, { index, filler: "x".repeat((40 - index) * 40_000) }),
    )
    const settled = await Promise.allSettled(writes)
    const failures = settled.filter((entry) => entry.status === "rejected")
    check("concurrent writes to one key all succeed", failures.length === 0, (failures[0] as PromiseRejectedResult)?.reason?.message)

    const finalValue = await store.read<{ index: number }>(key)
    check("the last write is the one kept", finalValue?.index === 39, finalValue?.index)

    // Nothing half-written left lying about.
    const dir = await fs.readdir(path.join(dataDirectory, "probe")).catch(() => [] as string[])
    check("no temp files are left behind", !dir.some((name) => name.endsWith(".tmp")), dir)

    await store.remove(key)

    /*
     * The credential file holds every key and token in the app, so a truncated
     * one costs more than any other file here.
     *
     * These checks guard the write path - valid JSON, no residue - and not the
     * property that motivated it. Crash-safety cannot be shown without crashing
     * mid-write, and this file is small enough that a direct write passes here
     * too; the temp-then-rename is what makes the window not exist.
     */
    const config = backend.runtime.config
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => config.setApiKey("probe-provider", `key-${index}`)),
    )
    const credentialFile = path.join(dataDirectory, "credentials.json")
    const raw = await fs.readFile(credentialFile, "utf8")
    const parsed = JSON.parse(raw) as { keys: Record<string, string> }
    check("concurrent credential writes leave valid JSON", typeof parsed.keys === "object", raw.slice(0, 40))
    check("the credential survives", Boolean(parsed.keys["probe-provider"]), parsed.keys["probe-provider"])

    const beside = await fs.readdir(dataDirectory)
    check("no credential temp files are left", !beside.some((name) => name.startsWith("credentials.json.")), beside)

    await config.setApiKey("probe-provider", "")

    /*
     * A damaged message file is reachable - an interrupted write leaves one -
     * and it used to make the whole session refuse to open.
     */
    const damaged = await backend.runtime.sessions.create({
      directory: project,
      model: { provider: "anthropic", model: "claude-opus-5" },
    })
    await backend.runtime.sessions.saveMessage({
      id: "msg_good",
      sessionID: damaged.id,
      role: "user",
      text: "readable",
      attachments: [],
      time: { created: Date.now() },
    })
    const messageDir = path.join(dataDirectory, "session", damaged.id, "message")
    await fs.mkdir(messageDir, { recursive: true })
    await fs.writeFile(path.join(messageDir, "msg_broken.json"), "{ this is not json", "utf8")
    const loaded = await backend.runtime.sessions.messages(damaged.id)
    check("a damaged message is skipped, not fatal", loaded.length === 1, loaded.length)
    check("and the readable one survives", loaded[0]?.id === "msg_good", loaded[0]?.id)
  }

  section("Every connected model is offered (S9-2)")
  {
    const models = [{ id: "alpha" }, { id: "beta" }]
    const fake = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: models }))
    })
    await new Promise<void>((resolve) => fake.listen(8794, "127.0.0.1", resolve))

    const config = backend.runtime.config
    // A curation list an older build left behind has no say any more.
    await config.set({ providerEndpoints: { lmstudio: "http://127.0.0.1:8794/v1" }, ...({ enabledModels: ["anthropic/claude-opus-5"] } as object) })

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })
    const offered = config.enabled().filter((entry) => entry.provider === "lmstudio").map((entry) => entry.model.id)
    check("connecting offers every model the provider serves", offered.join() === "alpha,beta", offered)
    await call({ type: "provider.discover", provider: "lmstudio" })
    const listed = (config.get() as unknown as Record<string, unknown>).enabledModels
    check("and a curation list sent by an older window is not kept", listed === undefined, listed)

    // Left as it was found: the next section asserts on this provider too.
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await config.set({ providerEndpoints: {} })
    fake.close()
  }

  section("Model discovery")
  {
    // A provider lists everything it serves; a model picker must offer only
    // what can hold a conversation.
    const served = [
      { id: "qwen/qwen3.8-27b" },
      { id: "text-embedding-nomic-embed-text-v1.5" },
      // vLLM and SGLang send the window under this name and no other.
      { id: "mimo-v2.5", max_model_len: 262144 },
      { id: "mimo-v2-tts" },
      { id: "bge-reranker-v2-m3" },
      { id: "whisper-large-v3" },
    ]
    const fake = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: served }))
    })
    await new Promise<void>((resolve) => fake.listen(8793, "127.0.0.1", resolve))

    const found = await discoverModels(
      { id: "probe", name: "Probe", kind: "openai-compatible", description: "", baseURL: "http://127.0.0.1:8793/v1" },
      "test",
    )
    const ids = found.map((entry) => entry.id)
    check("chat models are kept", ids.includes("qwen/qwen3.8-27b") && ids.includes("mimo-v2.5"), ids)
    check("embeddings are dropped", !ids.some((id) => id.includes("embed")), ids)
    check("rerankers are dropped", !ids.some((id) => id.includes("rerank")), ids)
    check("speech models are dropped", !ids.some((id) => id.includes("tts") || id.includes("whisper")), ids)
    // Looked up by id: the list comes back sorted, so position proves nothing.
    const qwen = found.find((entry) => entry.id === "qwen/qwen3.8-27b")
    check("discovery still names them", qwen?.name === "qwen/Qwen3.8-27B", qwen?.name)
    /*
     * vLLM and SGLang send the window under their own name and no other, so a
     * local server reporting 262,144 was read as having no window at all - and
     * a model with no window is never compacted by count, which is how a
     * conversation reached 230k of transcript and was refused outright.
     */
    const local = found.find((entry) => entry.id === "mimo-v2.5")
    check("a window sent as max_model_len is read", local?.contextWindow === 262144, String(local?.contextWindow))

    /*
     * Where a summary begins, when the last message alone is over the part
     * kept word for word. Only tool output is cut before it is measured, so a
     * long reasoning block or a pasted file can do this. Reading the split as
     * an index here crashed the compaction, and a crashed compaction leaves a
     * turn on the provider's refusal.
     */
    {
      /*
       * What counts as a summary. The two real failures were one sentence of
       * the task carrying on; a model that translates the section headings
       * still writes sections, and refusing it would leave the turn on the
       * provider's 400. (round 5, E8: the conversation is now replayed as
       * messages, so there is no quoted split left to check.)
       */
      check(
        "a continuation of the task is not a summary",
        !isSummary("我再核查 `GameCategory` 枚举值是否与前端 'PC'/'主机' 匹配。"),
      )
      check(
        "a summary with translated headings is one",
        isSummary("## 目标\n- 审计两个新功能\n\n## 工作状态\n- 已完成构建\n\n## 下一步\n1. 修复枚举"),
      )
      check("the sections as written are one", isSummary("## Task overview\n- audit\n\n## Next steps\n1. (none)"))
    }

    /*
     * The header line of a Windows notification is whatever the system can
     * match this process's AppUserModelID to. The installer writes appId onto
     * the Start Menu shortcut; a process claiming any other id is not matched,
     * and the toast is headed by the raw id - "electron.app.MCode" - with no
     * name and no icon. So the two have to be the same string.
     */
    {
      const builder = await fs.readFile("electron-builder.yml", "utf8")
      const main = await fs.readFile("src/main/index.ts", "utf8")
      const declared = /^appId:\s*(\S+)/m.exec(builder)?.[1]
      const constant = /const APP_ID = "([^"]+)"/.exec(main)?.[1]
      check(
        "the process claims the id the installer gives its shortcut",
        Boolean(declared) && declared === constant,
        `${constant} vs ${declared}`,
      )
      // And it is the id actually passed on - a constant nobody reads would
      // satisfy the line above while the process kept Electron's default.
      check("and it is the id passed to setAppUserModelId", /setAppUserModelId\([^)]*\bAPP_ID\b/.test(main))
    }

    fake.close()
  }

  section("Per-model reasoning efforts")
  {
    /*
     * The effort control is per model in the reference, not global, and the
     * three interesting answers are all here: a model that does not reason has
     * no efforts at all, a family that stops short of `xhigh` is not offered
     * it, and a model whose table entry states an empty list gets none even
     * though it reasons. Getting any of these wrong shows a control whose
     * settings the provider will ignore.
     */
    const claude = (id: string) =>
      modelVariants("anthropic", { id, name: id, contextWindow: 0, input: 0, output: 0, reasoning: true })
    check("Claude 5 offers all five levels", claude("claude-opus-5").join() === "low,medium,high,xhigh,max", claude("claude-opus-5"))
    check("Claude 4.7 does too", claude("claude-opus-4-7").join() === "low,medium,high,xhigh,max", claude("claude-opus-4-7"))
    check("Claude 4.6 has no xhigh", claude("claude-opus-4-6").join() === "low,medium,high,max", claude("claude-opus-4-6"))
    check("Claude 4.5 falls back to the budget pair", claude("claude-haiku-4-5").join() === "high,max", claude("claude-haiku-4-5"))

    const notReasoning = modelVariants("openai-compatible", {
      id: "some-chat-model",
      name: "Some Chat Model",
      contextWindow: 0,
      input: 0,
      output: 0,
    })
    check("a model that does not reason has no efforts", notReasoning.length === 0, notReasoning)

    const stated = modelVariants("chatgpt", {
      id: "gpt-5.3-codex-spark",
      name: "Spark",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
      efforts: [],
    })
    check("an explicit empty list wins over the heuristic", stated.length === 0, stated)

    const codex = modelVariants("chatgpt", {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
    })
    check("a GPT-5.2+ id reaches xhigh", codex.join() === "none,low,medium,high,xhigh", codex)

    const compatible = modelVariants("openai-compatible", {
      id: "some-reasoner",
      name: "Some Reasoner",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
    })
    check("an openai-compatible reasoner gets the three widely supported levels", compatible.join() === "low,medium,high", compatible)

    const excluded = modelVariants("openai-compatible", {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      contextWindow: 0,
      input: 0,
      output: 0,
      reasoning: true,
    })
    check("a family the reference excludes gets none even though it reasons", excluded.length === 0, excluded)

    // And the same answer has to survive the wire, not just the function.
    const wired = backend.runtime.config.providers().find((entry) => entry.id === "anthropic")
    const opus = wired?.models.find((entry) => entry.id === "claude-opus-4-6")
    check("the wire carries the per-model list", opus?.variants.join() === "low,medium,high,max", opus?.variants)
    check("and the capability record beside it", opus?.reasoning === true && opus?.inputs.pdf === true, opus)
    check("and the output limit", opus?.maxOutput === 128_000, opus?.maxOutput)
  }

  section("A custom provider")
  {
    const config = backend.runtime.config
    /*
     * Everything the reference's form collects, end to end: the id is the
     * user's own rather than a slug of the name, the models are the ones typed
     * in because nothing discovers them, the headers reach the definition, and
     * `{env:VAR}` names a variable instead of storing a secret.
     */
    process.env.SMOKE_CUSTOM_KEY = "from-the-environment"
    await call({
      type: "provider.addCustom",
      id: "mygateway",
      name: "My Gateway",
      baseURL: "https://gateway.example.com/v1",
      apiKey: "{env:SMOKE_CUSTOM_KEY}",
      headers: { "X-Route": "fast", "  ": "dropped" },
      models: [
        { id: "big", name: "Big Model" },
        { id: "small", name: "Small Model" },
      ],
    })

    const stored = config.get().customProviders.find((entry) => entry.id === "mygateway")
    check("the id is the one that was typed, not a slug of the name", Boolean(stored), config.get().customProviders)
    check("headers are kept", stored?.headers?.["X-Route"] === "fast", stored?.headers)
    check("a blank header pair is dropped", Object.keys(stored?.headers ?? {}).length === 1, stored?.headers)
    check("the models are the ones typed in", stored?.models?.map((m) => m.id).join() === "big,small", stored?.models)
    check("an {env:VAR} key stores the variable, not the key", stored?.environment === "SMOKE_CUSTOM_KEY", stored?.environment)
    check("and no secret is written", config.apiKey("mygateway") === "from-the-environment", "read from the environment")
    check(
      "the interface is told which variable connects it",
      config.environmentKey("mygateway") === "SMOKE_CUSTOM_KEY",
      config.environmentKey("mygateway"),
    )

    const definition = config.definition("mygateway")
    check("the definition carries the headers", definition?.headers?.["X-Route"] === "fast", definition?.headers)
    check("and is marked as hand-entered", definition?.handEntered === true, definition?.handEntered)

    const onWire = config.providers().find((entry) => entry.id === "mygateway")
    check("both models reach the picker", onWire?.models.map((m) => m.name).join() === "Big Model,Small Model", onWire?.models)

    // Discovery would replace the typed-in list with whatever /models returned,
    // or with nothing at all, so it is refused rather than attempted.
    const refused = await call({ type: "provider.discover", provider: "mygateway" }).then(
      () => "",
      (error: Error) => error.message,
    )
    check("refreshing a hand-entered list is refused", refused.includes("nothing to discover"), refused)

    // A second provider cannot take an id that is already in use, custom or not.
    const clash = await call({
      type: "provider.addCustom",
      id: "anthropic",
      name: "Impostor",
      baseURL: "https://example.com/v1",
      apiKey: "",
      models: [{ id: "x", name: "X" }],
    }).then(
      () => "",
      (error: Error) => error.message,
    )
    check("a built-in's id cannot be taken", clash.includes("already exists"), clash)

    const malformed = await call({
      type: "provider.addCustom",
      id: "Not Valid",
      name: "Bad",
      baseURL: "https://example.com/v1",
      apiKey: "",
      models: [{ id: "x", name: "X" }],
    }).then(
      () => "",
      (error: Error) => error.message,
    )
    check("a malformed id is refused", malformed.includes("not a valid provider id"), malformed)

    const offered = config.enabled().filter((entry) => entry.provider === "mygateway").map((entry) => entry.model.id)
    check("its models are offered in the picker", offered.join() === "big,small", offered)

    /*
     * Editing and copying, MiMo's 编辑 / 复制. An edit keeps the id; a blank key
     * keeps whatever the key came from, and a typed one replaces it. A copy
     * lands under a free id with the key copied in the backend.
     */
    await call({
      type: "provider.updateCustom",
      id: "mygateway",
      name: "My Gateway Two",
      baseURL: "https://gateway.example.com/v2",
      apiKey: "",
      headers: { "X-Route": "slow" },
      models: [
        { id: "big", name: "Big Model" },
        { id: "tiny", name: "Tiny Model" },
      ],
    })
    const edited = config.get().customProviders.find((entry) => entry.id === "mygateway")
    check(
      "an edit keeps the id and writes the new fields",
      edited?.name === "My Gateway Two" &&
        edited.baseURL === "https://gateway.example.com/v2" &&
        edited.headers?.["X-Route"] === "slow" &&
        edited.models?.map((m) => m.id).join() === "big,tiny",
      edited,
    )
    check("a blank key keeps the variable it came from", edited?.environment === "SMOKE_CUSTOM_KEY", edited?.environment)
    await call({
      type: "provider.updateCustom",
      id: "mygateway",
      name: "My Gateway Two",
      baseURL: "https://gateway.example.com/v2",
      apiKey: "typed-key",
      models: [{ id: "big", name: "Big Model" }],
    })
    const retyped = config.get().customProviders.find((entry) => entry.id === "mygateway")
    check(
      "a typed key replaces the variable",
      !retyped?.environment && config.apiKey("mygateway") === "typed-key" && !config.environmentKey("mygateway"),
      retyped,
    )
    const firstCopy = await call({ type: "provider.copyCustom", provider: "mygateway", name: "My Gateway Two copy" })
    const copied = config.get().customProviders.find((entry) => entry.id === "mygateway-copy")
    check(
      "a copy lands under a free id with the fields and the key",
      firstCopy.id === "mygateway-copy" &&
        copied?.name === "My Gateway Two copy" &&
        copied.baseURL === "https://gateway.example.com/v2" &&
        copied.models?.map((m) => m.id).join() === "big" &&
        config.apiKey("mygateway-copy") === "typed-key",
      { firstCopy, copied },
    )
    const secondCopy = await call({ type: "provider.copyCustom", provider: "mygateway", name: "again" })
    check("a second copy takes the next free id", secondCopy.id === "mygateway-copy-2", secondCopy.id)
    await call({ type: "provider.removeCustom", provider: "mygateway-copy" })
    await call({ type: "provider.removeCustom", provider: "mygateway-copy-2" })

    await call({ type: "provider.removeCustom", provider: "mygateway" })
    delete process.env.SMOKE_CUSTOM_KEY
  }

  section("Provider headers and reasoning effort on the wire")
  {
    let seen: { headers: Record<string, string>; body: any } | undefined
    const fake = createServer((request, response) => {
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        seen = { headers: request.headers as Record<string, string>, body: JSON.parse(raw) }
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end("data: [DONE]\n\n")
      })
    })
    await new Promise<void>((resolve) => fake.listen(8791, "127.0.0.1", resolve))

    const base = {
      apiKey: "secret",
      model: { provider: "mygateway", model: "big" },
      system: "",
      history: [],
      tools: [],
      showReasoning: false,
      signal: new AbortController().signal,
      baseURL: "http://127.0.0.1:8791",
    }

    /*
     * The fake answers an empty stream, which the adapter rightly calls a
     * failure - what is under test is the request it sent, so the failure is
     * swallowed here rather than dressed up as a passing turn.
     */
    const send = (extra: Record<string, unknown>) =>
      OpenAICompatible.stream({ ...base, ...extra } as never, () => {}).catch(() => {})

    await send({
      effort: "high",
      headers: { "x-route": "fast", authorization: "Bearer impostor" },
      variants: ["low", "medium", "high"],
    })
    check("a custom provider's header is sent", seen?.headers["x-route"] === "fast", seen?.headers["x-route"])
    check(
      "and cannot displace the bearer token",
      seen?.headers["authorization"] === "Bearer secret",
      seen?.headers["authorization"],
    )
    check("the chosen effort is sent", seen?.body.reasoning_effort === "high", seen?.body.reasoning_effort)

    await send({ effort: "high", variants: [] })
    check(
      "a model with no efforts is sent none",
      seen?.body.reasoning_effort === undefined,
      seen?.body.reasoning_effort,
    )

    await send({ effort: "max", variants: ["low", "medium", "high"] })
    check(
      "and a level the model does not accept is dropped rather than sent",
      seen?.body.reasoning_effort === undefined,
      seen?.body.reasoning_effort,
    )

    /*
     * Not knowing is not the same as knowing there are none. Until every call
     * site says which levels the model takes, an unqualified request has to
     * keep sending the field - withholding it there would leave the control
     * inert, which is the state this change exists to end.
     */
    await send({ effort: "high" })
    check(
      "a caller that says nothing about the model still sends the effort",
      seen?.body.reasoning_effort === "high",
      seen?.body.reasoning_effort,
    )

    const known = backend.runtime.config.variants({ provider: "anthropic", model: "claude-opus-4-6" })
    check("the server can answer which levels a model takes", known?.join() === "low,medium,high,max", known)
    const unknown = backend.runtime.config.variants({ provider: "anthropic", model: "no-such-model" })
    check("and says it does not know rather than saying none", unknown === undefined, unknown)

    fake.close()
  }

  section("Streamed provider errors")
  {
    /*
     * The shape LM Studio actually returns when the prompt outgrows the loaded
     * context: HTTP 200, then an `event: error` frame - the engine's JSON
     * wrapped inside the gateway's own message string. Every field below was
     * copied from a real response.
     */
    const FAILURE =
      "Engine protocol predict request returned 400: " +
      JSON.stringify({
        error: {
          code: 400,
          message: "request (15553 tokens) exceeds the available context size (8192 tokens), try increasing it",
          type: "exceed_context_size_error",
        },
      })

    let body = ""
    const fake = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(body)
    })
    await new Promise<void>((resolve) => fake.listen(8794, "127.0.0.1", resolve))

    /** Frames as a server would send them, terminator included. */
    const feed = (...frames: unknown[]) =>
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + `data: [DONE]\n\n`

    let announced: TurnEvent[] = []
    const ask = () => (
      (announced = []),
      OpenAICompatible.stream(
        {
          apiKey: "local",
          model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" },
          system: "",
          history: [],
          tools: [],
          effort: "medium",
          showReasoning: true,
          signal: new AbortController().signal,
          baseURL: "http://127.0.0.1:8794/v1",
        },
        (event) => announced.push(event),
      ).then(
        (outcome) => `finished: ${outcome.stop} with ${outcome.toolCalls.length} calls`,
        (failure: Error) => {
          reportedError = failure as ProviderError
          return failure.message
        },
      )
    )
    let reportedError: ProviderError | undefined
    const callIDs = () =>
      announced.filter((event) => event.type === "tool").map((event) => (event as { callID: string }).callID)

    body = `event: error\ndata: ${JSON.stringify({ error: { message: FAILURE }, message: FAILURE })}\n\n`
    const reported = await ask()
    check("an error inside a 200 stream is raised, not skipped", !reported.startsWith("finished:"), reported)
    check(
      "and the innermost message is what surfaces",
      reported.includes("exceeds the available context size (8192 tokens)"),
      reported,
    )
    check(
      "and it is coded so the interface can phrase it",
      reportedError?.code === "error.contextExceeded",
      reportedError?.code,
    )
    check(
      "with the provider's own numbers passed through",
      reportedError?.params?.detail?.includes("8192 tokens"),
      reportedError?.params,
    )

    // Providers are not obliged to make `message` a string, and reaching for
    // string methods on whatever turned up replaced the error with a TypeError.
    body = `data: ${JSON.stringify({ error: { code: 502, message: { detail: "upstream gone" } } })}\n\n`
    const odd = await ask()
    check("an error with no plain message still reports something", !odd.startsWith("finished:"), odd)
    check("and it is not a TypeError from our own parsing", !odd.includes("is not a function"), odd)

    // A stream that says nothing at all is a failure the provider left unnamed.
    body = ""
    const silent = await ask()
    check("an empty stream is not a finished turn", !silent.startsWith("finished:"), silent)

    // Reasoning is not a reply; a stream that stops after it has not answered.
    body = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n`
    const mute = await ask()
    check("reasoning alone is not a finished turn", !mute.startsWith("finished:"), mute)

    // The ordinary path must still complete: an empty *reply* with a stated
    // finish_reason is the model's choice, not a fault.
    body = feed({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })
    const fine = await ask()
    check("a normal stream still finishes", fine === "finished: end_turn with 0 calls", fine)

    /*
     * llama.cpp and some vLLM builds stream a tool call with neither `id` nor
     * `index`. Discarding it looked identical to the model deciding to stop.
     */
    body = feed({
      choices: [
        {
          delta: { tool_calls: [{ function: { name: "list", arguments: '{"path":"."}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    })
    const anonymous = await ask()
    check("a tool call with no id is still a tool call", anonymous === "finished: tool_use with 1 calls", anonymous)

    /*
     * Two calls in one delta, neither carrying `index`. Folding them onto a
     * single slot concatenated the names into a tool that does not exist.
     */
    body = feed({
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { name: "list", arguments: '{"path":"."}' } },
              { function: { name: "read", arguments: '{"path":"a.txt"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    const both = await ask()
    check("two index-less calls stay two calls", both === "finished: tool_use with 2 calls", both)

    /*
     * An id that only turns up in a later delta. Announcing a stand-in id first
     * left the real call unmatched: one card stuck on pending, one duplicate.
     */
    body = feed(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "list" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_real", function: { arguments: '{"path":"."}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    )
    const late = await ask()
    check("a late id still yields one call", late === "finished: tool_use with 1 calls", late)
    check(
      "and nothing was announced against an id the call does not have",
      callIDs().every((id) => id === "call_real"),
      callIDs(),
    )

    fake.close()
  }

  section("Local providers")
  {
    /*
     * Pointed at a port nothing can be listening on. Testing against LM Studio's
     * real port made the result depend on whether the developer happened to have
     * it running - the suite passed or failed for reasons outside the code.
     */
    await backend.runtime.config.set({
      providerEndpoints: { lmstudio: "http://127.0.0.1:9/v1" },
    })

    // A runtime on this machine either answers or it does not; connecting to
    // one that is down used to succeed and leave the row green and empty.
    const down = await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" }).then(
      () => "connected",
      (failure: Error) => failure.message,
    )
    check("connecting a runtime that is down is refused", down.includes("did not answer"), down)
    check(
      "and it stays disconnected",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.configured === false,
    )

    /*
     * Disconnecting is not connecting. Applying the reachability check to both
     * meant a runtime that had stopped could never be disconnected - the state
     * it was in was exactly the state that blocked the way out.
     */
    await backend.runtime.config.setApiKey("lmstudio", "local")
    check(
      "a stale connection can exist",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.configured === true,
    )
    const left = await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" }).then(
      () => "ok",
      (failure: Error) => failure.message,
    )
    check("disconnecting a runtime that is down still works", left === "ok", left)
    check(
      "and it really is disconnected",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.configured === false,
    )

    /*
     * A runtime on a port other than the default. The endpoint field only
     * appeared under an already-connected provider, so this was unreachable
     * from the interface: connecting is exactly what fails when the address is
     * wrong. Both connection surfaces now set the endpoint before connecting,
     * which is what this asserts the server honours.
     */
    const elsewhere = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
    })
    await new Promise<void>((resolve) => elsewhere.listen(8795, "127.0.0.1", resolve))

    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8795/v1" } } })
    check(
      "the endpoint the user typed is the one in force",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.baseURL ===
        "http://127.0.0.1:8795/v1",
      backend.runtime.config.providers().find((p) => p.id === "lmstudio")?.baseURL,
    )

    const moved = await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" }).then(
      () => "connected",
      (failure: Error) => failure.message,
    )
    check("a runtime on a non-default port connects", moved === "connected", moved)
    const reachable = backend.runtime.config.providers().find((p) => p.id === "lmstudio")
    check("and its models come from there", reachable?.models.some((m) => m.id === "qwen/qwen3.8-27b"), reachable?.models)

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    elsewhere.close()
  }

  section("A failed turn")
  {
    /*
     * One failure used to produce two identical notices: the runner wrote it
     * onto the assistant message and then rethrew, and the outer handler
     * broadcast it as a session error as well. This drives a whole turn against
     * a runtime that fails mid-stream and counts what the user would see.
     */
    const FAILURE = JSON.stringify({
      error: {
        message: "request (22530 tokens) exceeds the available context size (8192 tokens), try increasing it",
      },
    })
    const flaky = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(`event: error\n\ndata: ${FAILURE}\n\n`)
    })
    await new Promise<void>((resolve) => flaky.listen(8796, "127.0.0.1", resolve))

    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8796/v1" } } })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })

    const failing = await call({ type: "session.create", directory: project })
    const failingID: string = failing.session.id
    await call({
      type: "session.model",
      sessionID: failingID,
      model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" },
    })

    const before = events.length
    await call({ type: "session.prompt", sessionID: failingID, text: "hello" })
    // The turn runs detached; idle marks its end whether it worked or not.
    const finished = await new Promise<boolean>((resolve) => {
      const started = Date.now()
      const poll = setInterval(() => {
        const done = events
          .slice(before)
          .some((event) => event.type === "session.idle" && event.sessionID === failingID)
        // Generous, because this runs beside a build on a busy machine; the
        // point of the bound is to fail rather than hang.
        if (done || Date.now() - started > 60_000) {
          clearInterval(poll)
          resolve(done)
        }
      }, 50)
    })
    check("the turn finished before anything was asked about it", finished)

    const raised = events
      .slice(before)
      .filter((event) => event.type === "session.error" && event.sessionID === failingID)
    check("a failure the message carries is not broadcast as well", raised.length === 0, raised)

    const after = await call({ type: "session.get", sessionID: failingID })
    const failed = after.messages.filter((message: any) => message.role === "assistant")
    check("the turn is marked failed", failed.at(-1)?.finish === "error", failed.at(-1)?.finish)
    check(
      "and carries the key the interface phrases it with",
      failed.at(-1)?.errorCode === "error.contextExceeded",
      failed.at(-1)?.errorCode,
    )

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await call({ type: "config.set", patch: { providerEndpoints: {} } })
    flaky.close()
  }

  section("Steps: refused arguments, kept answers, reconnecting")
  {
    /*
     * Whole turns against a runtime that answers from a script, one reply per
     * request: what the transcript keeps is what the renderer draws, so it is
     * read back from the session rather than from the runner's memory.
     */
    const replies: ((response: ServerResponse) => void)[] = []
    const frames = (...list: unknown[]) => list.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"
    const stream = (body: string) => (response: ServerResponse) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(body)
    }
    const toolCall = (id: string, name: string, args: string) =>
      stream(frames({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] }))
    const reply = stream(frames({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }))
    const bodies: any[] = []
    const scripted = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
        return
      }
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        bodies.push(raw ? JSON.parse(raw) : undefined)
        ;(replies.shift() ?? reply)(response)
      })
    })
    await new Promise<void>((resolve) => scripted.listen(8799, "127.0.0.1", resolve))
    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8799/v1" } } })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })

    const created = await call({ type: "session.create", directory: project })
    const stepsID: string = created.session.id
    await call({ type: "session.model", sessionID: stepsID, model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" } })

    const idle = (from: number, timeout = 60_000) =>
      new Promise<boolean>((resolve) => {
        const started = Date.now()
        const poll = setInterval(() => {
          const done = events.slice(from).some((event) => event.type === "session.idle" && event.sessionID === stepsID)
          if (done || Date.now() - started > timeout) {
            clearInterval(poll)
            resolve(done)
          }
        }, 50)
      })
    const toolPart = async (callID: string) => {
      const state = await call({ type: "session.get", sessionID: stepsID })
      const assistants = state.messages.filter((message: any) => message.role === "assistant")
      const part = assistants.flatMap((message: any) => message.parts).find((entry: any) => entry.type === "tool" && entry.callID === callID)
      return { part, last: assistants.at(-1), messages: state.messages }
    }

    // Arguments that do not fit: refused before running, marked recoverable, and the turn goes on.
    replies.push(toolCall("call_badargs", "read", '{"file_path": 5}'))
    let from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "read something" })
    check("the turn with a refused call finished", await idle(from))
    let found = await toolPart("call_badargs")
    check("a call with arguments that do not fit is an error part", found.part?.status === "error", found.part)
    check("marked recoverable, which the transcript draws as skipped", found.part?.metadata?.recoverable === true, found.part?.metadata)
    check("its note names the problem", String(found.part?.error).includes("path should be string"), found.part?.error)
    check("and the turn carried on to an answer", found.last?.finish === "end_turn", found.last?.finish)
    check(
      "the model was told why",
      JSON.stringify(bodies.at(-1) ?? {}).includes("was not run"),
      JSON.stringify(bodies.at(-1) ?? {}).slice(0, 400),
    )

    // Arguments that are not JSON at all.
    replies.push(toolCall("call_cutoff", "read", '{"file_path": "hel'))
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "read again" })
    await idle(from)
    found = await toolPart("call_cutoff")
    check("arguments cut off mid-object are refused the same way", found.part?.metadata?.recoverable === true && String(found.part?.error).includes("not valid JSON"), found.part)

    // E20: through a real turn, a name in the wrong case and an argument named its own way are repaired.
    replies.push(toolCall("call_repair", "READ", '{"filePath": "hello.ts"}'))
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "read it by another name" })
    await idle(from)
    found = await toolPart("call_repair")
    check("a mis-cased tool name and a camelCase argument are repaired and run", found.part?.name === "read" && found.part?.status === "completed" && found.part?.input?.file_path === "hello.ts", found.part)

    // A refusal with a reason: kept on the part, and the turn ends there, as MiMo stops on a rejection.
    const askedFor = (callID: string, since: number) =>
      new Promise<string | undefined>((resolve) => {
        const started = Date.now()
        const poll = setInterval(() => {
          const event = events.slice(since).find((entry) => entry.type === "permission.requested" && entry.request.callID === callID)
          if (event?.type === "permission.requested" || Date.now() - started > 10_000) {
            clearInterval(poll)
            resolve(event?.type === "permission.requested" ? event.request.id : undefined)
          }
        }, 50)
      })
    replies.push(toolCall("call_perm", "write", '{"file_path": "steps-denied.md", "content": "no"}'))
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "write a note" })
    const asked = await askedFor("call_perm", from)
    check("the write asked", asked !== undefined)
    const requestsBeforeRefusal = bodies.length
    if (asked) await call({ type: "permission.respond", requestID: asked, response: "reject", reason: "keep notes elsewhere" })
    check("the refused turn finished", await idle(from))
    found = await toolPart("call_perm")
    const kept = (found.part?.metadata?.permissions ?? []) as PermissionRecord[]
    check("the decision is kept on the part", kept.length === 1 && kept[0]?.decided === "reject-with-reason" && kept[0]?.reason === "keep notes elsewhere", kept)
    check("with the question it answered", kept[0]?.kind === "write" && typeof kept[0]?.requestID === "string", kept[0])
    check("the refusal and its reason stay on the call", found.part?.status === "error" && String(found.part?.error).includes("keep notes elsewhere"), found.part?.error)
    check("a refusal ends the turn", found.last?.finish === "aborted", found.last?.finish)
    check("without handing the refusal back to the model", bodies.length === requestsBeforeRefusal, bodies.length - requestsBeforeRefusal)
    check("nothing was written", !(await exists(path.join(project, "steps-denied.md"))))

    // The next message takes the refusal, and its reason, to the model as context.
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "then put it in docs" })
    check("the next turn finished", await idle(from))
    check(
      "the model reads the reason with the next message",
      JSON.stringify(bodies.at(-1) ?? {}).includes("keep notes elsewhere"),
      JSON.stringify(bodies.at(-1) ?? {}).slice(0, 600),
    )

    // A refusal without a reason ends the turn the same way.
    replies.push(toolCall("call_perm_bare", "write", '{"file_path": "steps-bare.md", "content": "no"}'))
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "write another note" })
    const bareAsk = await askedFor("call_perm_bare", from)
    const requestsBeforeBare = bodies.length
    if (bareAsk) await call({ type: "permission.respond", requestID: bareAsk, response: "reject" })
    check("the bare refusal finished", await idle(from))
    found = await toolPart("call_perm_bare")
    const bareKept = (found.part?.metadata?.permissions ?? []) as PermissionRecord[]
    check("a refusal without a reason ends the turn too", found.last?.finish === "aborted" && bodies.length === requestsBeforeBare, [found.last?.finish, bodies.length - requestsBeforeBare])
    check("recorded as a plain reject", bareKept[0]?.decided === "reject" && bareKept[0]?.reason === undefined, bareKept)

    /*
     * E21: a tool that does not cap its own output is cut by the runner's shared cap before the model reads it,
     * and the whole of it saved. read, glob, grep and bash cap themselves, as MiMo's do, so an MCP tool carries it.
     */
    await call({ type: "config.set", patch: { mcpServers: { rich: { type: "local", command: ["node", path.join(process.cwd(), "scripts/fixtures/mcp-rich-server.cjs")] } } } })
    // A saved server reaches the conversations once a new one starts, this one included (MiMo's rule).
    await call({ type: "session.create", directory: project })
    const richUp = await (async () => {
      const end = Date.now() + 20_000
      while (Date.now() < end) {
        const listed = await call({ type: "mcp.list" })
        if (listed.servers.some((server: { name: string; status: string }) => server.name === "rich" && server.status === "connected")) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return false
    })()
    check("the MCP server with a long output connects", richUp)
    replies.push(toolCall("call_long", "rich_big", "{}"))
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "fetch the long output" })
    const longAsk = await askedFor("call_long", from)
    if (longAsk) await call({ type: "permission.respond", requestID: longAsk, response: "once" })
    check("the turn with a long output finished", await idle(from))
    found = await toolPart("call_long")
    const savedAt = String(found.part?.metadata?.outputPath ?? "")
    check(
      "a long tool output is cut by the shared cap, and says where the rest is",
      found.part?.status === "completed" && found.part?.metadata?.truncated === true && String(found.part?.output).includes(savedAt) && !String(found.part?.output).includes("row 1000 "),
      { metadata: found.part?.metadata, tail: String(found.part?.output).slice(-300) },
    )
    check("the saved file holds the whole output", savedAt !== "" && (await fs.readFile(savedAt, "utf8").catch(() => "")).includes("row 1000 "))
    check("and the model was sent the cut output", !JSON.stringify(bodies.at(-1) ?? {}).includes("row 1000 ") && JSON.stringify(bodies.at(-1) ?? {}).includes("row 1 "))
    await call({ type: "config.set", patch: { mcpServers: {} } })

    // A transient failure: retried in the open, then the turn completes.
    replies.push((response) => {
      response.writeHead(503, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "upstream overloaded" } }))
    })
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "try through a blip" })
    check("the turn through a 503 finished", await idle(from))
    const retried = events
      .slice(from)
      .filter((event) => event.type === "message.updated" && event.message.role === "assistant" && event.message.retry)
    check(
      "the window was told it was reconnecting",
      retried.length === 1 && retried[0]?.type === "message.updated" && retried[0].message.role === "assistant" && retried[0].message.retry?.attempt === 1,
      retried,
    )
    const settled = await toolPart("none")
    check("the retried turn completed", settled.last?.finish === "end_turn" && !settled.last?.error, settled.last)
    check("the retry is never written to disk", settled.messages.every((message: any) => message.retry === undefined))
    check(
      "the update after the retry clears it",
      events.slice(from).filter((event) => event.type === "message.updated" && event.message.role === "assistant").at(-1)?.type === "message.updated" &&
        !(events.slice(from).filter((event) => event.type === "message.updated").at(-1) as { message: { retry?: unknown } }).message.retry,
    )

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await call({ type: "config.set", patch: { providerEndpoints: {} } })
    scripted.close()
  }

  section("Approve for me: the model's review on the wire")
  {
    /*
     * The real path, not a stub reviewer: the runner asks the session's own
     * model through its provider, with no tools, and only an APPROVE lets the
     * command run. Anything else raises the ordinary question.
     */
    let verdict = "APPROVE"
    let seen: any
    const judge = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
        return
      }
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        seen = JSON.parse(raw)
        response.writeHead(200, { "content-type": "text/event-stream" })
        // MiMo's judge answers through its verdict tool; a verdict written as text is no answer.
        const answer =
          verdict === "TEXT"
            ? { choices: [{ delta: { content: "APPROVE" } }] }
            : { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_verdict", type: "function", function: { name: "permission_verdict", arguments: JSON.stringify({ decision: verdict }) } }] } }] }
        response.end(
          `data: ${JSON.stringify(answer)}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: verdict === "TEXT" ? "stop" : "tool_calls" }] })}\n\n` +
            "data: [DONE]\n\n",
        )
      })
    })
    await new Promise<void>((resolve) => judge.listen(8797, "127.0.0.1", resolve))
    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8797/v1" }, accessLevel: "auto" } })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })
    const judged = await call({ type: "session.create", directory: project })
    const judgedID: string = judged.session.id
    await call({ type: "session.model", sessionID: judgedID, model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" } })

    const gateOf = backend.runtime.permissions
    const within = async (promise: Promise<void>, ms: number) =>
      Promise.race([promise.then(() => "ran", () => "refused"), new Promise((resolve) => setTimeout(() => resolve("waiting"), ms))])
    const askRun = (subject: string) =>
      gateOf.ask({ sessionID: judgedID, messageID: "msg_judge", callID: `call_judge_${subject.length}`, kind: "bash", title: subject, subject })

    const before = events.length
    check("a risky command the model approves runs", (await within(askRun("sudo apt install x"), 10_000)) === "ran", seen)
    check("the model was asked with only the verdict tool", Array.isArray(seen?.tools) && seen.tools.length === 1 && seen.tools[0]?.function?.name === "permission_verdict", seen?.tools)
    const sent = JSON.stringify(seen?.messages ?? [])
    check("and was shown what is asked and the command", sent.includes("sudo apt install x") && sent.includes("bash"), sent.slice(0, 400))
    check("and told to answer through the verdict tool, with 64 tokens", sent.includes("permission_verdict") && seen?.max_tokens === 64, { sent: sent.slice(0, 400), max: seen?.max_tokens })
    check(
      "and nothing was asked of the user",
      !events.slice(before).some((event) => event.type === "permission.requested" && event.request.sessionID === judgedID),
      events.slice(before).map((event) => event.type),
    )

    verdict = "TEXT"
    const inProse = askRun("chmod 700 run.sh")
    check("an APPROVE written as text is no answer, so the user is asked", (await within(inProse, 3_000)) === "waiting")
    const proseQuestion = events.slice(before).find((event) => event.type === "permission.requested" && event.request.subject === "chmod 700 run.sh")
    if (proseQuestion) gateOf.respond((proseQuestion as any).request.id, "reject")
    await inProse.catch(() => {})
    check("the verdict counts only as one call with only a decision", verdictApproves([{ name: "permission_verdict", input: { decision: "APPROVE" } }], "") && !verdictApproves([{ name: "permission_verdict", input: { decision: "APPROVE", why: "x" } }], "") && !verdictApproves([{ name: "permission_verdict", input: { decision: "APPROVE" } }], "sure"))

    verdict = "DENY"
    const rejected = askRun("taskkill /F /IM node.exe")
    check("one the model rejects waits for the user", (await within(rejected, 3_000)) === "waiting")
    const question = events
      .slice(before)
      .find((event) => event.type === "permission.requested" && event.request.subject === "taskkill /F /IM node.exe")
    check("with the ordinary question", Boolean(question), events.slice(before).map((event) => event.type))
    if (question) gateOf.respond((question as any).request.id, "reject")
    await rejected.catch(() => {})

    await call({ type: "session.delete", sessionID: judgedID })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await call({ type: "config.set", patch: { providerEndpoints: {}, accessLevel: "ask" } })
    judge.close()
  }

  section("Session links")
  {
    const link = sessionLink("ses_abc 1", "/work/My project & more")
    check("a link names the session under the app's own scheme", link.startsWith("mcode://open-session?") && link.includes("session=ses_abc%201"), link)
    const back = parseSessionLink(link)
    check("and reads back to the same session and project", back?.sessionID === "ses_abc 1" && back?.directory === "/work/My project & more", back)
    check("a link without a session opens nothing", parseSessionLink("mcode://open-session?directory=x") === undefined)
    check("nor does another scheme", parseSessionLink("https://open-session?session=x") === undefined)
    check("nor another action", parseSessionLink("mcode://delete-session?session=x") === undefined)
    check("the link is found among launch arguments", linkInArgs(["MCode.exe", "--flag", link]) === link && linkInArgs(["MCode.exe", "--flag"]) === undefined)
  }

  section("Smart")
  {
    check("software work goes to the main model", smartRoute({ scene: "software", difficulty: "easy", confidence: 1 }) === "main")
    check("and so does research", smartRoute({ scene: "research", difficulty: "easy", confidence: 1 }) === "main")
    check("an easy everyday task it is sure of goes to the fast model", smartRoute({ scene: "chat", difficulty: "easy", confidence: 0.9 }) === "fast")
    check("but not one it is unsure of", smartRoute({ scene: "chat", difficulty: "easy", confidence: 0.89 }) === "main")
    check("nor a hard one", smartRoute({ scene: "writing", difficulty: "hard", confidence: 0.99 }) === "main")
    check("an answer with no reading in it goes to the main model", smartRoute(readTask("I cannot tell")) === "main")
    const wrapped = readTask('Sure: {"scene":"chat","difficulty":"easy","confidence":0.95} - done')
    check("a reading wrapped in prose is still read", wrapped?.scene === "chat" && wrapped?.confidence === 0.95, wrapped)

    let reading = '{"scene":"chat","difficulty":"easy","confidence":0.95}'
    const bodies: any[] = []
    const smartServer = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "fast-one" }, { id: "main-one" }] }))
        return
      }
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        const body = JSON.parse(raw)
        bodies.push(body)
        const sorting = JSON.stringify(body.messages ?? []).includes("You sort one request")
        const text = sorting ? reading : "done"
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
            "data: [DONE]\n\n",
        )
      })
    })
    await new Promise<void>((resolve) => smartServer.listen(8798, "127.0.0.1", resolve))
    await call({
      type: "config.set",
      patch: {
        providerEndpoints: { lmstudio: "http://127.0.0.1:8798/v1" },
        smartFast: { provider: "lmstudio", model: "fast-one" },
        smartMain: { provider: "lmstudio", model: "main-one" },
      },
    })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })

    const idleAfter = (sessionID: string, before: number) =>
      new Promise<boolean>((resolve) => {
        const started = Date.now()
        const poll = setInterval(() => {
          const done = events.slice(before).some((event) => event.type === "session.idle" && event.sessionID === sessionID)
          if (done || Date.now() - started > 60_000) {
            clearInterval(poll)
            resolve(done)
          }
        }, 50)
      })

    const easy = await call({ type: "session.create", directory: project })
    const easyID: string = easy.session.id
    await call({ type: "session.model", sessionID: easyID, model: { provider: "lmstudio", model: "main-one" } })
    const marked = await call({ type: "session.smart", sessionID: easyID })
    check("choosing Smart marks the conversation", marked.session.smart === true && marked.session.smartRoute === undefined, marked.session)
    let before = events.length
    await call({ type: "session.prompt", sessionID: easyID, text: "what is the capital of France" })
    check("the Smart turn finished", await idleAfter(easyID, before))
    const easyAfter = await call({ type: "session.get", sessionID: easyID })
    check(
      "an easy everyday request is routed to the fast model",
      easyAfter.session.smartRoute === "fast" && easyAfter.session.model.model === "fast-one",
      easyAfter.session,
    )
    const sorting = bodies.find((body) => JSON.stringify(body.messages ?? []).includes("You sort one request"))
    check("the sorting request went to the main model with no tools", sorting?.model === "main-one" && !(sorting?.tools?.length > 0), sorting && { model: sorting.model, tools: sorting.tools })
    check("and the turn itself ran on the fast model", bodies.some((body) => body.model === "fast-one"), bodies.map((body) => body.model))

    reading = '{"scene":"software","difficulty":"easy","confidence":0.99}'
    const code = await call({ type: "session.create", directory: project })
    const codeID: string = code.session.id
    await call({ type: "session.smart", sessionID: codeID })
    before = events.length
    await call({ type: "session.prompt", sessionID: codeID, text: "fix the failing test in src/app.ts" })
    check("the second Smart turn finished", await idleAfter(codeID, before))
    const codeAfter = await call({ type: "session.get", sessionID: codeID })
    check("software work is routed to the main model", codeAfter.session.smartRoute === "main" && codeAfter.session.model.model === "main-one", codeAfter.session)

    const picked = await call({ type: "session.model", sessionID: codeID, model: { provider: "lmstudio", model: "fast-one" } })
    check("choosing a model by name turns Smart off", picked.session.smart === undefined && picked.session.smartRoute === undefined, picked.session)

    await call({ type: "config.set", patch: { smart: true } })
    const inherits = await call({ type: "session.create", directory: project })
    check("with Smart as the default a new conversation starts on it", inherits.session.smart === true, inherits.session)

    for (const id of [easyID, codeID, inherits.session.id]) await call({ type: "session.delete", sessionID: id })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await call({
      type: "config.set",
      patch: { providerEndpoints: {}, smart: false, smartFast: { provider: "", model: "" }, smartMain: { provider: "", model: "" } },
    })
    smartServer.close()
  }

  section("Plan mode")
  {
    /*
     * The agent reached the prompt builder and the turn request and was read by
     * neither, so choosing Plan changed a label and nothing else - a plan could
     * rewrite the project it was describing.
     */
    const planning = toolsFor("plan").map((tool) => tool.name)
    const building = toolsFor("build").map((tool) => tool.name)
    check("build keeps every tool", building.length === TOOLS.length, building)
    /*
     * plan: and so does planning, as MiMo's plan agent does. What holds it to
     * reading is the rule the write tools enforce, not a shorter list - a plan
     * mode that could not run `git log` or write the plan down was weaker than
     * MiMo's at the same promise.
     */
    check("planning keeps every tool too", planning.length === TOOLS.length, planning)
    check("including the shell, the writing tools and the cross-conversation ones", ["bash", "write", "edit", "notebook_edit", "talk_to_session", "create_session", "update_session", "contacts"].every((name) => planning.includes(name)), planning)
    check("plan_exit is offered in both modes, as MiMo offers it", planning.includes("plan_exit") && building.includes("plan_exit"))
    check("but never to an explore subagent", !toolsFor("explore").some((tool) => tool.name === "plan_exit"), toolsFor("explore").map((tool) => tool.name))

    // plan: where the plan file goes, and what may be written while planning.
    const repoPlace = { directory: "/work/app", dataRoot: "/data", repo: true }
    const looseePlace = { directory: "/work/app", dataRoot: "/data", repo: false }
    const named = { created: 1758000000000, slug: "steady-lantern" }
    check(
      "a repository keeps its plans with the code",
      planFile(repoPlace, named) === path.join(path.resolve("/work/app"), ".mcode", "plans", "1758000000000-steady-lantern.md"),
      planFile(repoPlace, named),
    )
    check(
      "a folder that is not one keeps them in the app's own folder",
      planFile(looseePlace, named) === path.join(path.resolve("/data"), "plans", "1758000000000-steady-lantern.md"),
      planFile(looseePlace, named),
    )
    check("a conversation stored before slugs existed is named by its id", slugOf({ id: "ses_old" }) === "ses_old" && slugOf({ id: "ses_old", slug: "brisk-ferry" }) === "brisk-ferry")
    check("a fresh slug is two words", /^[a-z]+-[a-z]+$/.test(newSlug()), newSlug())

    const folders = planFolders(repoPlace)
    check("the plan file itself may be written", planWritable(planFile(repoPlace, named), folders))
    check("so may another markdown file in either plan folder", planWritable(path.join("/data", "plans", "other.md"), folders) && planWritable(path.join("/work/app", ".mcode", "plans", "older.md"), folders))
    check("a source file may not", !planWritable(path.join("/work/app", "src", "main.ts"), folders))
    check("nor anything but markdown in the plan folder", !planWritable(path.join("/work/app", ".mcode", "plans", "notes.txt"), folders))
    check("nor a path that only looks like it is inside one", !planWritable(path.join("/work/app", ".mcode", "plans-elsewhere", "x.md"), folders))
    check(
      "the path is shown relative to the project, and in full from outside it",
      planDisplay("/work/app", planFile(repoPlace, named)) === ".mcode/plans/1758000000000-steady-lantern.md" &&
        planDisplay("/work/app", planFile(looseePlace, named)) === planFile(looseePlace, named),
      [planDisplay("/work/app", planFile(repoPlace, named)), planDisplay("/work/app", planFile(looseePlace, named))],
    )

    /*
     * The refusal itself. It happens before the user is asked anything: a
     * planning turn that could ask its way out of being read-only would not be
     * read-only, and the user would be answering for a promise the app made.
     */
    const planContext = (agent: string) =>
      ({
        directory: "/work/app",
        plan: { agent, file: planFile(repoPlace, named), writable: (target: string) => planWritable(target, folders), approve: async () => {} },
      }) as never
    let refused: unknown
    try {
      guardPlanWrite(planContext("plan"), path.join("/work/app", "src", "main.ts"), "src/main.ts")
    } catch (err) {
      refused = err
    }
    check("planning refuses a write outside the plan file", refused instanceof ToolError && (refused as ToolError).code === "tool.err.planOnly", refused)
    check("and names the plan file in the refusal, so the model knows where to write instead", String((refused as Error)?.message).includes(".mcode/plans/1758000000000-steady-lantern.md"), (refused as Error)?.message)
    let allowed = true
    try {
      guardPlanWrite(planContext("plan"), planFile(repoPlace, named), ".mcode/plans/1758000000000-steady-lantern.md")
      guardPlanWrite(planContext("build"), path.join("/work/app", "src", "main.ts"), "src/main.ts")
    } catch {
      allowed = false
    }
    check("the plan file goes through, and building writes anything", allowed)

    // plan: what each turn is told, in this app's own words.
    const firstNote = firstPlanNote(".mcode/plans/p.md", false)
    check("the first planning turn is told to write the plan and how the turn may end", firstNote.includes("No plan file exists yet") && firstNote.includes(".mcode/plans/p.md") && firstNote.includes("plan_exit"), firstNote.slice(0, 120))
    check("and is told to edit it once it is there", firstPlanNote(".mcode/plans/p.md", true).includes("A plan is already written"))
    check("later turns get one line naming the same file", laterPlanNote(".mcode/plans/p.md").includes(".mcode/plans/p.md") && laterPlanNote(".mcode/plans/p.md").split("\n").length === 1)
    check("the switch note says the mode changed and that writing is allowed again", buildSwitchNote().includes("plan mode to build mode") && buildSwitchNote().includes("no longer read-only"))
    check("and the plan is named when one exists", carryOutNote(".mcode/plans/p.md").includes(".mcode/plans/p.md"))

    check("plan_exit takes no arguments, as MiMo's does", JSON.stringify(PlanExitTool.parameters) === JSON.stringify({ type: "object", properties: {}, additionalProperties: false }), PlanExitTool.parameters)
    const outsidePlan = await PlanExitTool.execute({}, { plan: { agent: "build", file: "x", writable: () => false, approve: async () => {} }, directory: "/work/app" } as never)
    check("and does nothing in build mode rather than failing", outsidePlan.metadata?.switched === false && outsidePlan.output.includes("not in plan mode"), outsidePlan)

    /*
     * The choice has to reach the session, since that is where the turn takes
     * it from. It used to be written to the config alone, and every session was
     * created as "build" whatever the config said - so Plan could never run.
     */
    const planned = await call({ type: "session.create", directory: project })
    const planID: string = planned.session.id
    check("a new session starts in the stored default", planned.session.agent === "build", planned.session.agent)

    const switched = await call({ type: "session.agent", sessionID: planID, agent: "plan" })
    check("choosing an agent lands on the session", switched.session.agent === "plan", switched.session.agent)
    const reread = await call({ type: "session.get", sessionID: planID })
    check("and survives a reload", reread.session.agent === "plan", reread.session.agent)

    await call({ type: "config.set", patch: { agent: "plan" } })
    const inherited = await call({ type: "session.create", directory: project })
    check("the next session starts where the last left off", inherited.session.agent === "plan", inherited.session.agent)
    await call({ type: "config.set", patch: { agent: "build" } })
    await call({ type: "session.delete", sessionID: planID })
    await call({ type: "session.delete", sessionID: inherited.session.id })

    const planPrompt = await systemPrompt({ directory: project, agent: "plan" })
    const buildPrompt = await systemPrompt({ directory: project, agent: "build" })
    check("plan is told what mode it is in", planPrompt.includes("plan mode"), planPrompt.slice(0, 80))
    /*
     * Round 8: the general agent prompt describes both modes, as MiMo's
     * default prompt does, so "plan mode" appearing at all proves nothing. What
     * build must not carry is the section that says it is planning.
     */
    check("build is not", !buildPrompt.includes("This conversation is in plan mode") && !buildPrompt.includes("# Plan mode"))
    // plan: the prompt says how planning ends and what it may write; the per-turn note carries the path.
    check("plan is told how the mode ends", planPrompt.includes("plan_exit"), planPrompt.slice(0, 200))
    check("and that one file is writable rather than that nothing is", planPrompt.includes("apart from writing the plan file each turn names") && !planPrompt.includes("are not available to you"), planPrompt.slice(0, 400))

    /*
     * Standing instructions. They are the reader's own rather than the
     * project's, so they are announced as such and placed before the project's
     * own files - a repository that disagrees about, say, commit style should
     * win inside that repository.
     */
    const withStanding = await systemPrompt({
      directory: project,
      agent: "build",
      instructions: "  Always use pnpm in my projects.  ",
    })
    check(
      "standing instructions reach the prompt",
      withStanding.includes("Always use pnpm in my projects."),
      withStanding.slice(0, 120),
    )
    check(
      "and are named as the user's own",
      withStanding.includes("## Standing instructions"),
      withStanding.slice(0, 120),
    )
    check(
      "they come before the environment block",
      withStanding.indexOf("## Standing instructions") < withStanding.indexOf("## Environment"),
    )
    check("writing none adds no section", !buildPrompt.includes("## Standing instructions"))
    const blankStanding = await systemPrompt({
      directory: project,
      agent: "build",
      instructions: "   " + String.fromCharCode(10) + "  ",
    })
    check("and neither does whitespace", !blankStanding.includes("## Standing instructions"))

    /*
     * The global AGENTS.md. Read into every conversation while it is there, not
     * once it is switched off (renamed) or deleted, and placed before the
     * project's own instructions, which win where the two disagree.
     */
    const globalAgents = path.join(root, "global", "AGENTS.md")
    check("with no global file its state is none", (await agentsState(globalAgents)) === "none")
    check("ensuring it writes a starting file", (await ensureAgents(globalAgents)) === "loaded" && (await exists(globalAgents)))
    await fs.writeFile(globalAgents, "Prefer small commits.", "utf8")
    const withGlobal = await systemPrompt({ directory: project, agent: "build", globalAgentsFile: globalAgents })
    check(
      "a global AGENTS.md reaches the prompt",
      withGlobal.includes("## Global instructions") && withGlobal.includes("Prefer small commits."),
    )
    check(
      "before the project's own instructions",
      // Present first: a missing section's -1 would otherwise count as "before".
      withGlobal.indexOf("## Global instructions") >= 0 &&
        withGlobal.indexOf("## Global instructions") < withGlobal.indexOf("## Project instructions"),
    )
    check(
      "switching it off renames it",
      (await setAgentsEnabled(globalAgents, false)) === "disabled" &&
        !(await exists(globalAgents)) &&
        (await exists(globalAgents + ".disabled")),
    )
    const offGlobal = await systemPrompt({ directory: project, agent: "build", globalAgentsFile: globalAgents })
    check("and takes it out of the prompt", !offGlobal.includes("Prefer small commits."))
    check("switching it on brings it back", (await setAgentsEnabled(globalAgents, true)) === "loaded")
    await setAgentsEnabled(globalAgents, false)
    await deleteAgents(globalAgents)
    check("deleting removes it even while it is off", (await agentsState(globalAgents)) === "none")

    /*
     * Staged mode. The section is there when asked for, names its stages, and
     * is kept out of plan mode - which already stops before building, and would
     * otherwise be told both to stop and to build.
     */
    const staged = await systemPrompt({ directory: project, agent: "build", staged: true })
    check("staged mode reaches the prompt", staged.includes("## Working in stages"), staged.slice(0, 120))
    check(
      "and names all four stages",
      ["Clarify.", "Plan.", "Build.", "Review."].every((stage) => staged.includes(stage)),
    )
    check("off by default", !buildPrompt.includes("## Working in stages"))
    const stagedPlan = await systemPrompt({ directory: project, agent: "plan", staged: true })
    check(
      "plan mode is not told to build",
      stagedPlan.includes("plan mode") && !stagedPlan.includes("## Working in stages"),
    )
  }

  section("Voice")
  {
    /*
     * Only the end of a recording counts. "Send" in the middle of a sentence
     * is a word someone said, and a box that submitted on it would be unusable
     * for talking about sending anything.
     */
    check("the send word is taken off the end", splitSendWord("打开安装包 发送").text === "打开安装包")
    check("and is reported", splitSendWord("打开安装包 发送").send)
    check("spoken punctuation after it still counts", splitSendWord("open it 发送。").send)
    check("English too", splitSendWord("open the installer send").send)
    check(
      "a send in the middle is left alone",
      splitSendWord("send the patch to review").send === false,
      splitSendWord("send the patch to review"),
    )
    check(
      "and the words survive it",
      splitSendWord("send the patch to review").text === "send the patch to review",
    )
    check("nothing said is nothing sent", splitSendWord("   ").send === false)
  }

  section("Display server (Linux)")
  {
    check("an unknown choice reads as auto", displayServerPref("gtk") === "auto" && displayServerPref(undefined) === "auto")
    check("the three choices read as themselves", displayServerPref("wayland") === "wayland" && displayServerPref("x11") === "x11")
    check("a missing or broken file is auto", readDisplayServerFile("") === "auto" && readDisplayServerFile("[1]") === "auto")
    check("the written file reads back", readDisplayServerFile(JSON.stringify({ displayServer: "x11" })) === "x11")
    check("auto follows a Wayland session", ozonePlatform("auto", { XDG_SESSION_TYPE: "wayland" }) === "wayland")
    check("or a Wayland display", ozonePlatform("auto", { WAYLAND_DISPLAY: "wayland-0" }) === "wayland")
    check("auto on X11 forces nothing", ozonePlatform("auto", { XDG_SESSION_TYPE: "x11" }) === undefined)
    check("a choice overrides the session", ozonePlatform("x11", { XDG_SESSION_TYPE: "wayland" }) === "x11")
    check("no switches off Linux", displaySwitches("win32", "wayland", {}).length === 0)
    const onX11 = displaySwitches("linux", "auto", { XDG_SESSION_TYPE: "x11" })
    check("X11 keeps GTK 3 and no platform", onX11.length === 1 && onX11[0]?.name === "gtk-version" && onX11[0]?.value === "3", onX11)
    const onWayland = displaySwitches("linux", "wayland", {}).map((entry) => entry.name)
    check(
      "Wayland adds the platform and its input method, as MiMo does",
      onWayland.join(",") === "gtk-version,ozone-platform,enable-wayland-ime,wayland-text-input-version",
      onWayland,
    )
  }

  section("Turn power hold (MiMo's prevent-app-suspension while a turn runs)")
  {
    const calls: string[] = []
    let next = 7
    const hold = new PowerHold({
      start: (type) => {
        calls.push(`start:${type}`)
        return next++
      },
      stop: (id) => void calls.push(`stop:${id}`),
    })
    hold.sync(["a"])
    hold.sync(["a", "b"])
    check("the first busy session starts one blocker, the second adds none", calls.join(",") === "start:prevent-app-suspension" && hold.state.id === 7, calls)
    hold.sync(["b"])
    check("the hold stays while any session is busy", calls.length === 1 && hold.state.held.join(",") === "b", hold.state)
    hold.sync([])
    check("the last session ending stops that blocker", calls.join(",") === "start:prevent-app-suspension,stop:7" && hold.state.id === undefined, calls)
    hold.sync([])
    check("idle again stops nothing twice", calls.length === 2)
    hold.sync(["c"])
    check("a later turn starts a fresh blocker", calls.at(-1) === "start:prevent-app-suspension" && hold.state.id === 8, calls)
    const failing = new PowerHold({
      start: () => {
        throw new Error("no blocker")
      },
      stop: () => void calls.push("stop:unexpected"),
    })
    failing.sync(["x"])
    failing.sync([])
    check("a blocker that fails to start holds nothing and stops nothing", failing.state.held.length === 0 && !calls.includes("stop:unexpected"))
  }

  section("Installing notice (MiMo's wait for delivery before quitting)")
  {
    const fake = () => {
      const pending: { run: () => void; ms: number; id: number }[] = []
      let id = 0
      return {
        pending,
        timers: {
          setTimeout: (run: () => void, ms: number) => (pending.push({ run, ms, id: ++id }), id),
          clearTimeout: (handle: unknown) => void pending.splice(pending.findIndex((entry) => entry.id === handle), 1),
        },
      }
    }
    let settled = false
    const none = fake()
    await waitForDelivery(undefined, 1500, none.timers)
    check("with no notice there is nothing to wait for", none.pending.length === 0)

    const shown = fake()
    let show: () => void = () => {}
    const delivered = new Promise<void>((resolve) => (show = resolve))
    const waiting = waitForDelivery(delivered, 1500, shown.timers).then(() => (settled = true))
    check("the wait is bounded at 1.5 s", shown.pending.length === 1 && shown.pending[0]?.ms === 1500)
    show()
    await waiting
    check("a notice shown ends the wait at once and clears the bound", settled && shown.pending.length === 0)

    const lost = fake()
    settled = false
    const never = waitForDelivery(new Promise<void>(() => {}), 1500, lost.timers).then(() => (settled = true))
    lost.pending[0]?.run()
    await never
    check("a notice never delivered lets the quit go on after the bound", settled)

    const failed = fake()
    settled = false
    const rejected = waitForDelivery(Promise.reject(new Error("no toast")), 1500, failed.timers).then(() => (settled = true))
    await rejected
    check("a delivery that fails ends the wait too", settled && failed.pending.length === 0)

    const listeners = new Map<string, () => void>()
    const notice = { once: (event: "show" | "failed", listener: () => void) => void listeners.set(event, listener) }
    let fired = false
    const ofShow = deliveryOf(notice).then(() => (fired = true))
    listeners.get("failed")?.()
    await ofShow
    check("delivery settles on show or on failed", fired && listeners.has("show"))
  }

  section("Pre-ready choices (theme and hardware acceleration)")
  {
    check("no file or a broken one is the defaults", readBootPrefs("").theme === "system" && readBootPrefs("[]").hardwareAcceleration === true && readBootPrefs("{").theme === "system")
    check("the saved theme reads back, anything else follows the system", readBootPrefs('{"theme":"dark"}').theme === "dark" && readBootPrefs('{"theme":"light"}').theme === "light" && readBootPrefs('{"theme":"dracula"}').theme === "system")
    check("acceleration is only off when turned off", readBootPrefs('{"hardwareAcceleration":false}').hardwareAcceleration === false && readBootPrefs('{"hardwareAcceleration":"0"}').hardwareAcceleration === false && readBootPrefs('{"hardwareAcceleration":"no"}').hardwareAcceleration === true)
    const written = writeBootPrefs({ theme: "dark", hardwareAcceleration: false })
    check("what is written reads back the same", JSON.stringify(readBootPrefs(written)) === JSON.stringify({ theme: "dark", hardwareAcceleration: false }), written)
    check("the first paint is MiMo's plane for each scheme", windowBackground(true) === "#181818" && windowBackground(false) === "#ffffff")
  }

  section("Work areas (windows pulled back onto a screen)")
  {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 }
    const right = { x: 1920, y: 0, width: 1280, height: 984 }
    check("a window wholly on a screen stays where it is", clampToWorkAreas({ x: 100, y: 100, width: 800, height: 600 }, [primary, right]) === undefined)
    check("with no displays reported nothing is moved", clampToWorkAreas({ x: 5000, y: 0, width: 800, height: 600 }, []) === undefined)
    const straddling = clampToWorkAreas({ x: 1700, y: 200, width: 800, height: 600 }, [primary, right])
    check("one straddling two goes into the screen it overlaps most", JSON.stringify(straddling) === JSON.stringify({ x: 1920, y: 200, width: 800, height: 600 }), straddling)
    const orphan = clampToWorkAreas({ x: 3500, y: 300, width: 900, height: 700 }, [primary])
    check("one left on an unplugged screen comes back to the nearest, at its edge", JSON.stringify(orphan) === JSON.stringify({ x: 1020, y: 300, width: 900, height: 700 }), orphan)
    const huge = clampToWorkAreas({ x: -50, y: -50, width: 2600, height: 1400 }, [primary])
    check("one larger than the screen is shrunk to it", JSON.stringify(huge) === JSON.stringify(primary), huge)
    check(
      "bounds a scaling round-trip moved by a pixel or so count as the same; a real move does not",
      closeBounds(primary, { ...primary, width: primary.width + 1, height: primary.height - 2 }) && !closeBounds(primary, { ...primary, x: 5 }),
    )
    check("hiding from full screen restores nothing", boundsOnShow({ x: 10, y: 10, width: 900, height: 700 }, true, [primary]) === undefined && boundsOnShow(undefined, false, [primary]) === undefined)
    check("recorded bounds on a live screen come back as they were", JSON.stringify(boundsOnShow({ x: 10, y: 10, width: 900, height: 700 }, false, [primary])) === JSON.stringify({ x: 10, y: 10, width: 900, height: 700 }))
    check("recorded bounds on a screen since removed are pulled back", boundsOnShow({ x: 2000, y: 10, width: 900, height: 700 }, false, [primary])?.x === 1020)
  }

  section("Renderer recovery (MiMo's silent replacement)")
  {
    const a = {}
    const b = {}
    const health = new RendererHealth<object>()
    health.track(a)
    check("a new renderer is starting", health.state(a) === "starting" && health.state(undefined) === "missing")
    check("a subframe failure or a cancelled load (-3) leaves it alone", !health.didFailLoad(a, { errorCode: -105, isMainFrame: false }) && !health.didFailLoad(a, { errorCode: -3, isMainFrame: true }) && health.state(a) === "starting")
    check("finishing its first load makes it ready, and only once", health.didFinishLoad(a) && !health.didFinishLoad(a) && health.state(a) === "ready")
    check("the startup watchdog does nothing to a ready renderer", !health.startupTimedOut(a))
    check("a main-frame failure makes it gone, reported once", health.didFailLoad(a, { errorCode: -6, isMainFrame: true }) && !health.renderProcessGone(a) && health.state(a) === "missing")
    check("destroying one already gone is not a second failure", !health.destroyed(a))
    health.track(b)
    check("a renderer that never finishes starting times out", health.startupTimedOut(b) && health.state(b) === "missing")
    const c = {}
    health.track(c)
    check("destroyed contents that were alive are a failure", health.destroyed(c) && !health.destroyed(c))

    check("nothing is recovered while quitting", recoveryVisibility({ becameUnavailable: true, windowClosing: false, quitting: true, platform: "win32" }) === "none")
    check("a closing window is not brought back on Windows", recoveryVisibility({ becameUnavailable: true, windowClosing: true, quitting: false, platform: "win32" }) === "none")
    check("on macOS a closing one comes back hidden", recoveryVisibility({ becameUnavailable: true, windowClosing: true, quitting: false, platform: "darwin" }) === "hidden")
    check("otherwise the replacement keeps the old visibility", recoveryVisibility({ becameUnavailable: true, windowClosing: false, quitting: false, platform: "linux" }) === "preserve-visibility")

    // Fake timers: each scheduled run is kept with its delay and fired by hand.
    let clock: { run: () => void; ms: number; id: number }[] = []
    let nextId = 1
    const timers = {
      schedule: (run: () => void, ms: number) => {
        const id = nextId++
        clock.push({ run, ms, id })
        return id
      },
      cancel: (id: number) => void (clock = clock.filter((entry) => entry.id !== id)),
    }
    const fire = () => {
      const entry = clock.shift()
      entry?.run()
      return entry?.ms
    }
    const recovery = new RecoverySchedule<number>(timers)
    let made = 0
    const failing = () => {
      made++
      return false
    }
    check("the first attempt is scheduled at once", recovery.request(failing) === "scheduled" && clock[0]?.ms === 0)
    check("a second request while one is queued joins it", recovery.request(failing) === "pending" && clock.length === 1)
    const delays = [fire(), fire(), fire(), fire()]
    check("failed attempts retry after 0, 250, 1000 and 5000 ms, then stop", delays.join(",") === "0,250,1000,5000" && made === 4 && clock.length === 0 && recovery.snapshot.exhausted, { delays, made })
    check("an exhausted schedule makes no more attempts", recovery.request(failing) === "exhausted" && clock.length === 0)

    const fresh = new RecoverySchedule<number>(timers)
    fresh.request(() => true)
    fire()
    check("a successful attempt ends the retries", fresh.snapshot.attempts === 1 && !fresh.snapshot.retryScheduled && clock.length === 0)
    fresh.rendererReady()
    check("a ready replacement starts the 30 s stable timer", fresh.snapshot.stableScheduled && clock[0]?.ms === 30_000)
    fire()
    check("staying up for it resets the attempt count", fresh.snapshot.attempts === 0 && !fresh.snapshot.stableScheduled)
    fresh.request(() => true)
    fresh.cancel()
    check("cancelling on quit drops a queued attempt", clock.length === 0 && fresh.request(() => true) === "stopped")
  }

  section("Log files (MiMo's userData/logs, one file a day, 15 days)")
  {
    const at = (text: string) => new Date(`${text}T12:00:00`)
    check("a file is named for its local day", logFileName(new Date(2026, 8, 5, 23, 59)) === "2026-09-05.log")
    check("a dated name reads back and anything else does not", dayOfLogFile("2026-09-05.log")?.getDate() === 5 && dayOfLogFile("notes.log") === undefined && dayOfLogFile("2026-02-30.log") === undefined)
    const names = ["2026-09-15.log", "2026-09-01.log", "2026-08-31.log", "2026-07-01.log", "notes.txt", "2026-08-01.log.bak"]
    check(
      "files 15 or more days old expire; 14 days and other files are kept",
      expiredLogFiles(names, at("2026-09-15")).join(",") === "2026-08-31.log,2026-07-01.log",
      expiredLogFiles(names, at("2026-09-15")),
    )
    const secret = "sk-" + "a1b2c3d4e5f6g7h8i9j0"
    const redacted = redactSecrets(`request failed Authorization: Bearer abc.def-123 {"apiKey":"${secret}"} url?key=XYZ123&x=1 token=hunter2`)
    check(
      "keys, bearer tokens and key-like assignments never reach the line",
      !redacted.includes(secret) && !redacted.includes("abc.def-123") && !redacted.includes("XYZ123") && !redacted.includes("hunter2") && redacted.includes("x=1"),
      redacted,
    )
    check("an ordinary line is left as it is", redactSecrets("[update] check failed (silent): HTTP 404") === "[update] check failed (silent): HTTP 404")
    const line = logLine("warn", "x".repeat(9000), new Date(Date.UTC(2026, 8, 15, 1, 2, 3)))
    check("a line carries its time and level and is cut past 8000 characters", line.startsWith("2026-09-15T01:02:03.000Z [warn] ") && line.endsWith("[cut 1000 chars]"), line.slice(0, 40))

    const dir = path.join(root, "logs")
    await fs.mkdir(dir, { recursive: true })
    for (const name of ["2026-08-20.log", "2026-09-10.log", "keep.txt"]) await fs.writeFile(path.join(dir, name), "old\n")
    let now = at("2026-09-15")
    const daily = new DailyLog({ dir, now: () => now })
    check("opening the log prunes what has expired", !(await exists(path.join(dir, "2026-08-20.log"))) && (await exists(path.join(dir, "2026-09-10.log"))) && (await exists(path.join(dir, "keep.txt"))))
    daily.write("info", "first day")
    now = at("2026-09-26")
    daily.write("error", `second day ${secret}`)
    await daily.close()
    daily.write("info", "after close")
    const first = await fs.readFile(path.join(dir, "2026-09-15.log"), "utf8")
    const second = await fs.readFile(path.join(dir, "2026-09-26.log"), "utf8")
    check("each day's lines go to that day's file", first.includes("[info] first day") && second.includes("[error] second day"), { first, second })
    check("a day change prunes again", !(await exists(path.join(dir, "2026-09-10.log"))))
    check("the file never holds the secret, and nothing is written after close", !second.includes(secret) && !second.includes("after close"))
  }

  section("Composer menus and home starters")
  {
    check("a level the new model takes is kept", clampEffort(["low", "medium", "high"], "high") === "high")
    check("one it lacks snaps to medium", clampEffort(["low", "medium", "high"], "max") === "medium")
    check("without medium, the first", clampEffort(["low", "high"], "xhigh") === "low")
    check("unset snaps the same way", clampEffort(["minimal", "low"], undefined) === "minimal")
    check("a model without levels has none", clampEffort([], "high") === undefined)
    check(
      "the family is read off the model, not the provider",
      modelFamily("anthropic/claude-sonnet-4.5") === "claude" && modelFamily("gpt-5.4", "GPT-5.4") === "openai",
    )
    check("o-series ids are OpenAI's", modelFamily("o3-mini") === "openai" && modelFamily("foo3") === undefined)
    check(
      "the other families",
      modelFamily("deepseek-chat") === "deepseek" &&
        modelFamily("kimi-k2") === "kimi" &&
        modelFamily("glm-4.6") === "glm" &&
        modelFamily("MiniMax-M2") === "minimax" &&
        modelFamily("qwen3-coder") === "qwen" &&
        modelFamily("hunyuan-t1") === "hunyuan" &&
        modelFamily("gemini-2.5-pro") === "gemini",
    )
    check("an unknown model has no family", modelFamily("llama-3.3-70b", "Llama 3.3") === undefined)
    check(
      "Claude's levels are named from Claude's set",
      effortFamily("claude-opus-4-6") === "claude" && effortLabelKey("claude-opus-4-6", "Claude Opus", "xhigh") === "effort.claude.xhigh",
    )
    check(
      "every other model's from the other set",
      effortLabelKey("gpt-5.4", "GPT-5.4", "low") === "effort.gpt.low" && effortLabelKey("deepseek-v4", "", "max") === "effort.gpt.max",
    )
    check("a level Claude's set lacks falls back to the other", effortLabelKey("claude-x", "", "none") === "effort.gpt.none")
    const rows = ["a", "b", "c"] as const
    check(
      "Down from nothing starts at the top, Up at the bottom",
      rovingStep(rows, undefined, "ArrowDown") === "a" && rovingStep(rows, undefined, "ArrowUp") === "c",
    )
    check("the walk wraps at both ends", rovingStep(rows, "c", "ArrowDown") === "a" && rovingStep(rows, "a", "ArrowUp") === "c")
    check("Home and End jump to the ends", rovingStep(rows, "b", "Home") === "a" && rovingStep(rows, "b", "End") === "c")
    check("an empty list has nowhere to go", rovingStep([], undefined, "ArrowDown") === undefined)
    const starters = builtinSuggestions((key) => `[${key}]`)
    check(
      "three built-in starters, each with its own words and mark",
      starters.length === 3 &&
        starters.every((row) => row.title.endsWith(".title]") && row.query.endsWith(".query]")) &&
        new Set(starters.map((row) => row.icon)).size === 3,
      starters,
    )
  }

  section("Voice cues")
  {
    check("quick input's clear words empty the box", isClearCommand("清空") && isClearCommand("删掉重来。") && isClearCommand(" 清空输入！"))
    check("a sentence about clearing is typed as words", !isClearCommand("清空这个文件夹里的日志") && !isClearCommand("hello"))
    check("an edit that changed the box rewrote it", editCue("周五开会", "周四开会", true) === "rewritten")
    check("an edit that left nothing cleared it", editCue("周五开会", "", true) === "cleared")
    check("no change, or no edit, says nothing", editCue("a", "a", true) === undefined && editCue("a", "b", false) === undefined)
  }

  section("Voice failures (MiMo's messages)")
  {
    const dom = (name: string, message = "") => Object.assign(new Error(message), { name })
    check("a refused microphone is micDenied and opens the OS page", JSON.stringify(micFailure(dom("NotAllowedError"))) === JSON.stringify({ key: "voice.micDenied", guide: true }))
    check("a security refusal is the same denial", micFailure(dom("SecurityError")).key === "voice.micDenied")
    check("no device, or none that fits, is micNotFound", micFailure(dom("NotFoundError")).key === "voice.micNotFound" && micFailure(dom("OverconstrainedError")).key === "voice.micNotFound")
    check(
      "a device another program holds is micInUse",
      ["NotReadableError", "TrackStartError", "AbortError"].every((name) => micFailure(dom(name)).key === "voice.micInUse" && !micFailure(dom(name)).guide),
    )
    const other = micFailure(dom("TypeError", "boom"))
    check("anything else is micAccessFailed with its words", other.key === "voice.micAccessFailed" && other.params?.msg === "boom" && !other.guide, other)
    check("no recorder keeps its own message", micFailure(new Error("voice.noRecorder")).key === "voice.noRecorder")

    const abort = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    check("a timed-out request is voice.timeout", voiceFetchFailure(abort) === "voice.timeout")
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    check("a refused or unresolvable endpoint is voice.network", voiceFetchFailure(refused) === "voice.network" && voiceFetchFailure(Object.assign(new Error("x"), { code: "ENOTFOUND" })) === "voice.network")
    check("a bare fetch TypeError is voice.network", voiceFetchFailure(new TypeError("fetch failed")) === "voice.network")
    check("an unknown rejection keeps its own words", voiceFetchFailure(new Error("odd")) === "odd")
    check("404 is the model being unavailable", voiceHttpFailure(404, "") === "voice.modelUnavailable")
    check(
      "a body naming an unknown model is too",
      voiceHttpFailure(400, '{"error":{"message":"The model `whisper-9` does not exist"}}') === "voice.modelUnavailable" &&
        voiceHttpFailure(400, "Invalid model: foo") === "voice.modelUnavailable",
    )
    check("other statuses carry their number", voiceHttpFailure(503, "Service Unavailable") === "voice.http:503" && voiceHttpFailure(400, "Invalid file format") === "voice.http:400")

    const shown = (code: string) => transcribeFailure(new Error(code))
    check("the window names each code with MiMo's key", shown("voice.timeout").key === "voice.timeout" && shown("voice.network").key === "voice.networkUnreachable" && shown("voice.modelUnavailable").key === "voice.modelUnavailable" && shown("voice.emptyResult").key === "voice.emptyResult")
    check("an HTTP status is passed to its message", JSON.stringify(shown("voice.http:502")) === JSON.stringify({ key: "voice.serviceHttp", params: { status: "502" } }))
    check("the configuration codes keep their own messages", shown("voice.notConfigured").key === "voice.notConfigured" && shown("voice.noEndpoint").key === "voice.noEndpoint")
    const raw = shown("Lost connection to the backend")
    check("anything else is MiMo's plain failure with the words under it", raw.key === "voice.failed" && raw.detail === "Lost connection to the backend", raw)
    check("every key the failures name exists in zh-CN", [
      "voice.micDenied", "voice.micNotFound", "voice.micInUse", "voice.micAccessFailed", "voice.timeout", "voice.networkUnreachable",
      "voice.modelUnavailable", "voice.serviceHttp", "voice.emptyResult", "voice.failed", "composer.replacePending",
    ].every((key) => t(key) !== key))
  }

  section("Voice smart edit")
  {
    /* No model is called: the prompt, the parser and the window's hook are held on their own. */
    const draft = { text: "周五开会，记得带电脑。", selectionStart: 2, selectionEnd: 2 }
    const [system, user] = voiceEditMessages(draft, "把周五改成周四")
    check("the smart edit call uses MCode's own instruction", system.role === "system" && system.content === VOICE_EDIT_PROMPT, system)
    check("the caret is marked where the draft has it", user.content === "<box>周五‸开会，记得带电脑。</box>\n<speech>把周五改成周四</speech>", user.content)
    const selected = voiceEditMessages({ text: "one two three", selectionStart: 4, selectionEnd: 7 }, "delete that")[1]
    check("a selection is wrapped instead", selected.content.startsWith("<box>one ⟦two⟧ three</box>"), selected.content)

    const edit = parseVoiceEdit('{"before": "周四开会，", "selected": "", "after": "记得带电脑。"}')
    check(
      "an answer becomes the whole text with the caret between before and after",
      edit?.text === "周四开会，记得带电脑。" && edit.selectionStart === 5 && edit.selectionEnd === 5,
      edit,
    )
    const fenced = parseVoiceEdit('Sure:\n```json\n{"before": "", "selected": "hello", "after": " world"}\n```')
    check("a fence and prose around the object are tolerated", fenced?.selectionStart === 0 && fenced.selectionEnd === 5, fenced)
    check("an answer that is not JSON is refused", parseVoiceEdit("周四开会，记得带电脑。") === undefined)
    check("an answer without string before and after is refused", parseVoiceEdit('{"text": "x", "cursor": 1}') === undefined)
    check("a non-string selection is refused", parseVoiceEdit('{"before": "a", "selected": 3, "after": "b"}') === undefined)
    check("an array is refused", parseVoiceEdit('[{"before": "a", "after": "b"}]') === undefined)
    const marked = parseVoiceEdit('{"before": "a‸", "after": "⟦b⟧"}')
    check("stray markers never reach the message", marked?.text === "ab" && marked.selectionStart === 1, marked)
    check("an answer past the cap is refused", parseVoiceEdit(JSON.stringify({ before: "x".repeat(VOICE_EDIT_MAX + 1), after: "" })) === undefined)
    check("an emptied box is a valid edit", parseVoiceEdit('{"before": "", "selected": "", "after": ""}')?.text === "")

    check("a draft is clamped into its text", JSON.stringify(voiceDraftOf({ text: "abc", selectionStart: 9, selectionEnd: -2 })) === JSON.stringify({ text: "abc", selectionStart: 0, selectionEnd: 3 }))
    check("a malformed draft is ignored", voiceDraftOf({ text: 3, selectionStart: 0, selectionEnd: 0 }) === undefined && voiceDraftOf(undefined) === undefined)

    const typed = applyVoiceResult({ text: "hello world", selectionStart: 6, selectionEnd: 11 }, { text: "there", heard: "there" })
    check("without an edit the words replace the selection", typed.text === "hello there" && typed.selectionStart === 11 && !typed.send, typed)
    const spaced = applyVoiceResult({ text: "open", selectionStart: 4, selectionEnd: 4 }, { text: "the file", heard: "the file" })
    check("Latin words get a space between them", spaced.text === "open the file", spaced)
    const joined = applyVoiceResult({ text: "打开", selectionStart: 2, selectionEnd: 2 }, { text: "安装包", heard: "安装包" })
    check("CJK text gets none", joined.text === "打开安装包" && joined.selectionStart === 5, joined)
    const sending = applyVoiceResult({ text: "", selectionStart: 0, selectionEnd: 0 }, { text: "打开安装包 发送", heard: "打开安装包发送" })
    check("a trailing send word is taken off and reported", sending.text === "打开安装包" && sending.send, sending)
    const moved = applyVoiceResult(
      { text: "abc", selectionStart: 3, selectionEnd: 3 },
      { text: "光标移到开头", heard: "光标移到开头", edit: { text: "abc", selectionStart: 0, selectionEnd: 0 } },
    )
    check("an edit that only moves the caret keeps the text", moved.text === "abc" && moved.selectionStart === 0 && !moved.send, moved)
    const editSend = applyVoiceResult(
      { text: "", selectionStart: 0, selectionEnd: 0 },
      { text: "hi send", heard: "hi send", edit: { text: "hi send", selectionStart: 7, selectionEnd: 7 } },
    )
    check("a send word the model left in is still an instruction", editSend.text === "hi" && editSend.send && editSend.selectionStart === 2, editSend)
    const wild = applyVoiceResult(
      { text: "", selectionStart: 0, selectionEnd: 0 },
      { text: "x", heard: "x", edit: { text: "abc", selectionStart: 99, selectionEnd: -5 } },
    )
    check("an edit's offsets are clamped into its text", wild.selectionStart === 0 && wild.selectionEnd === 3, wild)
  }

  section("Close to tray")
  {
    const base = { quitting: false, otherWindows: 0, platform: "win32", trayEnabled: true }
    check("the last window hides while the tray is on", closeHidesToTray(base))
    check("and closes with it off", !closeHidesToTray({ ...base, trayEnabled: false }))
    check("macOS hides the last window either way", closeHidesToTray({ ...base, platform: "darwin", trayEnabled: false }))
    check("a quit in progress always closes", !closeHidesToTray({ ...base, quitting: true }) && !closeHidesToTray({ ...base, platform: "darwin", quitting: true }))
    check("a window that is not the last one closes", !closeHidesToTray({ ...base, otherWindows: 1 }))
    check("Linux follows the switch too", closeHidesToTray({ ...base, platform: "linux" }) && !closeHidesToTray({ ...base, platform: "linux", trayEnabled: false }))
  }

  section("Custom model limits")
  {
    const plain = customModelOf({ id: " big ", name: " Big " })
    check("a plain model is trimmed and carries nothing else", JSON.stringify(plain) === JSON.stringify({ id: "big", name: "Big" }), plain)
    const full = customModelOf({ id: "m", name: "M", attachment: false, limit: { context: 131072, output: 16384 } })
    check("the image switch and both limits are kept", full.attachment === false && full.limit?.context === 131072 && full.limit.output === 16384, full)
    check("an input limit alone is fine", customModelOf({ id: "m", name: "M", limit: { context: 32768 } }).limit?.output === undefined)
    const refuses = (limit: { context?: number; output?: number }) => {
      try {
        customModelOf({ id: "m", name: "M", limit })
        return false
      } catch {
        return true
      }
    }
    check("an output limit without an input limit is refused", refuses({ output: 8192 }))
    check("zero, negative and fractional limits are refused", refuses({ context: 0 }) && refuses({ context: -1 }) && refuses({ context: 1.5 }) && refuses({ context: 1024, output: 2.5 }))

    const config = backend.runtime.config
    await call({
      type: "provider.addCustom",
      id: "limits",
      name: "Limits",
      baseURL: "https://limits.example.com/v1",
      apiKey: "k",
      models: [
        { id: "seeing", name: "Seeing", attachment: true, limit: { context: 262144, output: 65536 } },
        { id: "blind", name: "Blind", attachment: false },
        { id: "plain", name: "Plain" },
      ],
    })
    const stored = config.get().customProviders.find((entry) => entry.id === "limits")
    check("advanced fields are stored", stored?.models?.[0]?.limit?.context === 262144 && stored.models[1]?.attachment === false && stored.models[2]?.attachment === undefined, stored?.models)
    const seeing = config.modelEntry({ provider: "limits", model: "seeing" })
    check("the input limit becomes the context window", seeing?.contextWindow === 262144, seeing)
    check("the output limit becomes the output cap", seeing?.maxOutput === 65536, seeing)
    const info = config.providers().find((entry) => entry.id === "limits")?.models
    check(
      "the picker is told which models read images",
      info?.find((m) => m.id === "seeing")?.attachment === true && info?.find((m) => m.id === "blind")?.attachment === false,
      info,
    )
    check("an unset limit stays the provider default", config.modelEntry({ provider: "limits", model: "plain" })?.contextWindow === 0)
    const refused = await call({
      type: "provider.updateCustom",
      id: "limits",
      name: "Limits",
      baseURL: "https://limits.example.com/v1",
      apiKey: "",
      models: [{ id: "seeing", name: "Seeing", limit: { output: 4096 } }],
    }).then(
      () => "",
      (error: Error) => error.message,
    )
    check("the backend refuses an output limit without an input limit", refused.includes("output limit needs an input limit"), refused)
    await call({ type: "provider.removeCustom", provider: "limits" })
  }

  section("The address bar")
  {
    /* What a page may navigate to: the web, and nothing with another scheme. */
    check("a page may not be sent to a file", safeURL("file:///C:/Windows/win.ini") === undefined)
    check("and so is anything else with a scheme", safeURL("mcode://settings") === undefined)
    check("http survives", safeURL("http://example.com/") === "http://example.com/")

    /* The user's 2026-09-15 decision: MiMo's address bar opens local files, encoded as MiMo encodes them. */
    check("a Windows path opens as a file", addressToURL("C:\\Users\\a b\\x#1?.html") === "file:///C:/Users/a%20b/x%231%3F.html", addressToURL("C:\\Users\\a b\\x#1?.html"))
    check("a drive path with forward slashes too", addressToURL("d:/notes/index.html") === "file:///d:/notes/index.html", addressToURL("d:/notes/index.html"))
    check("a path from the root too", addressToURL("/tmp/page.html") === "file:///tmp/page.html", addressToURL("/tmp/page.html"))
    check("a typed file address opens", addressToURL("file:///C:/notes/") === "file:///C:/notes/")
    check("file://localhost is this machine", addressToURL("file://localhost/C:/notes/a.txt") === "file:///C:/notes/a.txt", addressToURL("file://localhost/C:/notes/a.txt"))
    check("a network share is refused as a path", addressToURL("\\\\server\\share\\a.html") === undefined)
    check("and as //server", addressToURL("//server/share/a.html") === undefined)
    check("and as a file address with a host", addressToURL("file://server/share/a.html") === undefined)
    check("and as file://// with an empty host", addressToURL("file:////server/share/a.html") === undefined)
    // Never opened as what they are: at most they are words to search for, as before.
    const searchOnly = (typed: string) => {
      const url = addressToURL(typed)
      return url === undefined || url.startsWith("https://www.google.com/search?q=")
    }
    check("javascript stays refused", searchOnly("javascript:alert(1)"), addressToURL("javascript:alert(1)"))
    check("data stays refused", searchOnly("data:text/html,<b>x</b>"), addressToURL("data:text/html,<b>x</b>"))
    check("the app's own scheme stays refused", addressToURL("mcode://settings") === undefined)
    check("so does devtools", addressToURL("devtools://devtools/bundled/inspector.html") === undefined)

    /* Links: the web from anywhere, a file only from a local page. */
    check("a local page may link to its neighbour", pageMayNavigate("file:///C:/notes/a.html", "file:///C:/notes/b.html"))
    check("a local page may link to the web", pageMayNavigate("file:///C:/notes/a.html", "https://example.com/"))
    check("a web page may not link to a file", !pageMayNavigate("https://example.com/", "file:///C:/Windows/win.ini"))
    check("a blank page may not be sent to a file", !pageMayNavigate("", "file:///C:/Windows/win.ini"))
    check("a local page may not reach a network share", !pageMayNavigate("file:///C:/notes/a.html", "file://server/share/x.html"))
    check("a local page may not run javascript: as a navigation", !pageMayNavigate("file:///C:/notes/a.html", "javascript:alert(1)"))

    /*
     * A port means a development server, and a development server means http.
     * Guessing https there fails with an empty panel and no explanation.
     */
    check("a port on this machine is http", addressToURL("127.0.0.1:5173") === "http://127.0.0.1:5173/")
    check("localhost too", addressToURL("localhost:3000/app") === "http://localhost:3000/app")
    check("a bare domain is https", addressToURL("example.com") === "https://example.com/")
    check(
      "and words are a Google search, as MiMo's are",
      addressToURL("how to fix a flaky test") === "https://www.google.com/search?q=how%20to%20fix%20a%20flaky%20test",
    )
    check("nothing typed goes nowhere", addressToURL("   ") === undefined)
  }

  section("The browser panel's pages")
  {
    /* MiMo's popups: the web becomes a panel tab, mailto and tel the system's, the rest nowhere. */
    check("a popup to the web is a new tab", routeWindowOpen("https://example.com/a").type === "newtab")
    check("mailto goes to the system", routeWindowOpen("mailto:someone@example.com").type === "external")
    check("tel too", routeWindowOpen("tel:+100").type === "external")
    check("file is refused, unlike MiMo", routeWindowOpen("file:///C:/Windows/notepad.exe").type === "deny")
    check("javascript is refused", routeWindowOpen("javascript:alert(1)").type === "deny")
    check("nothing is refused", routeWindowOpen("").type === "deny")

    const ids = (groups: { id: string; enabled: boolean }[][]) => groups.map((group) => group.map((item) => item.id).join(","))
    check(
      "a web link offers a new tab and its address",
      JSON.stringify(ids(pageMenuGroups({ linkURL: "https://example.com/" }))) === JSON.stringify(["openLinkNewTab,copyLink"]),
    )
    check(
      "a link that is not the web only its address",
      JSON.stringify(ids(pageMenuGroups({ linkURL: "javascript:void(0)" }))) === JSON.stringify(["copyLink"]),
    )
    check(
      "an image in a link: both groups, link first",
      JSON.stringify(ids(pageMenuGroups({ linkURL: "https://example.com/", mediaType: "image", srcURL: "https://example.com/a.png" }))) ===
        JSON.stringify(["openLinkNewTab,copyLink", "copyImage,copyImageUrl"]),
    )
    check(
      "selected page text: copy and select all",
      JSON.stringify(ids(pageMenuGroups({ selectionText: "hello", editFlags: { canCopy: true } }))) === JSON.stringify(["copy,selectAll"]),
    )
    check(
      "an empty field hides cut and copy rather than greying them",
      JSON.stringify(ids(pageMenuGroups({ isEditable: true, selectionText: "", editFlags: { canCopy: false, canCut: false, canPaste: true, canSelectAll: false } }))) ===
        JSON.stringify(["paste,selectAll"]),
    )
    const bare = pageMenuGroups({ canGoBack: false, canGoForward: true })
    check(
      "nothing under the pointer: back greyed, forward and reload",
      JSON.stringify(bare) === JSON.stringify([[{ id: "back", enabled: false }, { id: "forward", enabled: true }, { id: "reload", enabled: true }]]),
    )

    /* Keys pressed while a page has focus. */
    const press = (key: string, code: string, mods: Partial<PageKeyInput> = {}): PageKeyInput => ({
      type: "keyDown", key, code, control: false, shift: false, alt: false, meta: false, ...mods,
    })
    check("Ctrl+L reaches the window", pageKeyAction(press("l", "KeyL", { control: true })).kind === "forward")
    check("Ctrl+T too", pageKeyAction(press("t", "KeyT", { control: true })).kind === "forward")
    check("Ctrl+period, for annotating", pageKeyAction(press(".", "Period", { control: true })).kind === "forward")
    check("Ctrl+Shift+B, by its capital letter", pageKeyAction(press("B", "KeyB", { control: true, shift: true })).kind === "forward")
    check("Ctrl+Shift+slash, typed as ?", pageKeyAction(press("?", "Slash", { control: true, shift: true })).kind === "forward")
    check(
      "chords MiMo lacks are left to the page",
      ["Ctrl+Shift+.", "Ctrl+U", "Ctrl+G", "Alt+←", "Ctrl+Alt+1"].every((chord) => !APP_CHORDS.includes(chord)) &&
        pageKeyAction(press("u", "KeyU", { control: true })).kind === "none",
    )
    check("Ctrl+R reloads the page itself", JSON.stringify(pageKeyAction(press("r", "KeyR", { control: true }))) === JSON.stringify({ kind: "reload", force: false }))
    check("Ctrl+Shift+R force-reloads it", JSON.stringify(pageKeyAction(press("R", "KeyR", { control: true, shift: true }))) === JSON.stringify({ kind: "reload", force: true }))
    check("Ctrl+C stays with the page", pageKeyAction(press("c", "KeyC", { control: true })).kind === "none")
    check("Ctrl+F, Ctrl+A and Ctrl+V too", ["f", "a", "v"].every((key) => pageKeyAction(press(key, `Key${key.toUpperCase()}`, { control: true })).kind === "none"))
    check("Ctrl+Z is not the app's", pageKeyAction(press("z", "KeyZ", { control: true })).kind === "none")
    check("plain typing is never taken", pageKeyAction(press("l", "KeyL")).kind === "none")
    check("a key coming up is not a press", pageKeyAction({ ...press("l", "KeyL", { control: true }), type: "keyUp" }).kind === "none")
    check(
      "a chord the reader bound is taken only once bound",
      pageKeyAction(press("y", "KeyY", { control: true, shift: true })).kind === "none" &&
        pageKeyAction(press("Y", "KeyY", { control: true, shift: true }), new Set(["Ctrl+Shift+Y"])).kind === "forward",
    )
    check("binding Ctrl+V does not take paste from the page", pageKeyAction(press("v", "KeyV", { control: true }), new Set(["Ctrl+V"])).kind === "none")

    /*
     * The chord list against App.vue's keydown handler. A chord added there and
     * not here would work everywhere except inside a page, which nobody notices.
     */
    const appSource = await fs.readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8")
    const block = (start: string) => {
      const at = appSource.indexOf(start)
      return at === -1 ? "" : appSource.slice(at, appSource.indexOf("\n  }\n", at))
    }
    const keysIn = (text: string) => [...text.matchAll(/^\s+(?:"([^"]+)"|([a-z0-9]))\s*:/gm)].map((match) => (match[1] ?? match[2]).toUpperCase())
    const plainKeys = keysIn(block("const handlers: Record<string, () => void> = {"))
    const shiftedKeys = keysIn(block("const shifted: Record<string, () => void> = {"))
    const altKeys = [...appSource.matchAll(/mod && event\.altKey && event\.key\.toLowerCase\(\) === "([a-z])"/g)].map((match) => match[1].toUpperCase())
    check("App.vue's handler tables were found", plainKeys.length > 12 && shiftedKeys.length > 6 && altKeys.length > 6, { plainKeys, shiftedKeys, altKeys })
    const wanted = [
      ...plainKeys.filter((key) => key !== "F" && key !== "R").map((key) => `Ctrl+${key}`),
      ...shiftedKeys.filter((key) => key !== "R").map((key) => `Ctrl+Shift+${key}`),
      ...altKeys.map((key) => `Ctrl+Alt+${key}`),
    ]
    const unlisted = wanted.filter((chord) => !APP_CHORDS.includes(chord))
    check("every chord App.vue answers is taken from a page", unlisted.length === 0, unlisted)

    /* The page menu's words have to be sent to the main process, or they read in English. */
    const pageMenuSource = await fs.readFile(path.join(process.cwd(), "src/main/browser-page.ts"), "utf8")
    const i18nSource = await fs.readFile(path.join(process.cwd(), "src/renderer/src/lib/i18n.ts"), "utf8")
    const menuKeys = i18nSource.slice(i18nSource.indexOf("const MENU_KEYS = ["), i18nSource.indexOf("]", i18nSource.indexOf("const MENU_KEYS = [")))
    const asked = [...pageMenuSource.matchAll(/\["((?:rp\.browser\.ctx|edit)\.[\w]+)", "/g)].map((match) => match[1])
    const unsent = asked.filter((key) => !menuKeys.includes(`"${key}"`))
    check("the page menu names its eleven rows", asked.length === 11, asked)
    check("and every one of them is published to the main process", unsent.length === 0, unsent)

    /* The channels the page module and the panel send on, which the preload must forward. */
    const preloadSource = await fs.readFile(path.join(process.cwd(), "src/preload/index.ts"), "utf8")
    const browserSource = await fs.readFile(path.join(process.cwd(), "src/main/browser.ts"), "utf8")
    const channels = [...`${pageMenuSource}\n${browserSource}`.matchAll(/(?:send|on)\("(mcode:browser-[a-z-]+)"/g)].map((match) => match[1])
    const unforwarded = [...new Set(channels)].filter((channel) => !preloadSource.includes(`"${channel}"`))
    check("the page's channels were found", channels.length >= 3, channels)
    check("and the preload carries each of them", unforwarded.length === 0, unforwarded)

    /* MiMo's zoom: whole tens of percent, 25% to 300%. */
    check("a step in from 100%", stepZoom(1, 1) === 1.1)
    check("an odd factor steps from its rounded percent", stepZoom(1.05, -1) === 0.95)
    check("300% is the ceiling", stepZoom(2.95, 1) === 3 && stepZoom(3, 1) === 3)
    check("25% is the floor", stepZoom(0.3, -1) === 0.25 && stepZoom(0.25, -1) === 0.25)

    /* Failed loads, by number or by name. */
    check("-21 is a connection failure", loadErrorKind(-21) === "connection")
    check("an aborted connection is too, by its name", loadErrorKind(-103, "ERR_CONNECTION_ABORTED") === "connection")
    check("a socket error is too", loadErrorKind(-15, "ERR_SOCKET_NOT_CONNECTED") === "connection")
    check("a name that did not resolve is dns", loadErrorKind(-105) === "dns" && loadErrorKind(-1, "ERR_NAME_RESOLUTION_FAILED") === "dns")
    check("no network is offline", loadErrorKind(-106) === "offline")
    check("a certificate error is generic", loadErrorKind(-202, "ERR_CERT_AUTHORITY_INVALID") === "generic")

    /* The bar's widths. */
    check("under 300 is mini", barMode(299) === "mini")
    check("300 to 379 is compact", barMode(300) === "compact" && barMode(379.5) === "compact")
    check("380 is full", barMode(380) === "full")

    /* Local servers, as MiMo names and filters them. */
    const page = (body: string, status = 200) => ({ status, contentType: "text/html; charset=utf-8", server: "", body })
    check("AirPlay is not a development server", localServerOf(5000, { status: 403, contentType: "", server: "AirTunes/860.7.1", body: "" }) === undefined)
    check("a 4xx that is not a page is left out", localServerOf(8080, { status: 404, contentType: "application/json", server: "", body: "{}" }) === undefined)
    check("a 4xx page is kept", localServerOf(8080, page("<title>Not here</title>", 404))?.name === "Not here")
    const vite = localServerOf(5173, page("<head><title>\n  My   App\n</title></head>"))
    check(
      "a title is folded, on a localhost address and label",
      vite?.name === "My App" && vite.label === "localhost:5173" && vite.url === "http://localhost:5173",
      vite,
    )
    check("a long title stops at 60 with an ellipsis", localServerOf(3000, page(`<title>${"x".repeat(80)}</title>`))?.name === `${"x".repeat(60)}\u2026`)
    check("no title is named by its address", localServerOf(3000, page("<p>hi</p>"))?.name === "localhost:3000")
    check("a body that is not a page is not read for a title", localServerOf(3000, { status: 200, contentType: "text/plain", server: "", body: "<title>no</title>" })?.name === "localhost:3000")
  }

  section("Attachments")
  {
    /*
     * Both of these adapters filtered images out and sent only the text files,
     * so a picture reached the transcript and stopped there - the model was
     * asked about something it had never been shown.
     */
    const withImage: any = {
      id: "msg_att",
      sessionID: "ses_att",
      role: "user",
      text: "what is in this",
      attachments: [
        { path: "shot.png", mime: "image/png", data: "AAAB" },
        { path: "notes.txt", mime: "text/plain", data: "hello from a file" },
      ],
      time: { created: 1 },
    }

    // round 5 (E1): images go only to a model that reads them, so this model is said to.
    const openai = toMessages("sys", [withImage], { image: true }) as any[]
    const user = openai.find((entry) => entry.role === "user")
    check("the image is sent, not dropped", Array.isArray(user?.content), user?.content)
    const parts = (user?.content ?? []) as any[]
    check(
      "as a data url the format understands",
      parts.some((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,")),
      parts,
    )
    check(
      "and the text file still rides along with the words",
      parts.some((part) => part.type === "text" && part.text.includes("notes.txt") && part.text.includes("what is in this")),
      parts,
    )

    // Text alone keeps the plain shape: fewer of these servers accept the
    // multipart form, and nothing is gained by using it.
    const plain = toMessages("sys", [{ ...withImage, attachments: [] }]) as any[]
    check(
      "a message without images stays a plain string",
      typeof plain.find((entry) => entry.role === "user")?.content === "string",
      plain.find((entry) => entry.role === "user")?.content,
    )
  }

  section("Model names")
  {
    // A second load of one model in LM Studio; the suffix must not disturb the
    // casing of the name it is attached to.
    check(
      "an instance suffix keeps the name cased",
      nameFromId("qwen/qwen3.8-27b:2") === "qwen/Qwen3.8-27B:2",
      nameFromId("qwen/qwen3.8-27b:2"),
    )
    check(
      "and the plain id is unaffected",
      nameFromId("qwen/qwen3.8-27b") === "qwen/Qwen3.8-27B",
      nameFromId("qwen/qwen3.8-27b"),
    )
    const cases: [string, string][] = [
      // What the vendor writes, for the ones we can check against a real client.
      ["mimo-v2.5", "MiMo-V2.5"],
      ["mimo-v2.5-pro", "MiMo-V2.5-Pro"],
      ["mimo-v2-tts", "MiMo-V2-TTS"],
      ["mimo-v2.5-tts-voiceclone", "MiMo-V2.5-TTS-VoiceClone"],
      ["gpt-5.6-sol", "GPT-5.6-Sol"],
      ["deepseek-chat", "DeepSeek-Chat"],
      ["glm-4-plus", "GLM-4-Plus"],
      // A parameter count is capitalised; a context size is not.
      ["llama-3.3-70b", "Llama-3.3-70B"],
      ["doubao-pro-32k", "Doubao-Pro-32k"],
      // Someone else's capitalisation is left alone.
      ["MiniMax-M2", "MiniMax-M2"],
      // A publisher prefix is an account name and is echoed, not title-cased;
      // the model half is still cased, and a hub's lowercase v is kept.
      ["qwen/qwen3.8-27b", "qwen/Qwen3.8-27B"],
      ["mistralai/mistral-7b-instruct-v0.3", "mistralai/Mistral-7B-Instruct-v0.3"],
      ["lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF", "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF"],
      ["google/gemma-3-12b", "google/Gemma-3-12B"],
    ]
    for (const [id, expected] of cases) {
      const actual = nameFromId(id)
      check(`${id} reads as ${expected}`, actual === expected, actual)
    }

    // The catalog's own name wins over anything derived from the id.
    const curated = backend.runtime.config.models("xiaomi").find((entry) => entry.id === "mimo-v2.5")
    check("a curated name survives discovery", curated?.name === "MiMo-V2.5", curated?.name)
  }

  section("Undo")
  {
    const store = backend.runtime.sessions
    const undoSession = await store.create({
      directory: project,
      model: { provider: "anthropic", model: "claude-opus-5" },
    })

    const existing = path.join(project, "hello.ts")
    const created = path.join(project, "brand-new.ts")
    const before = await fs.readFile(existing, "utf8")

    // What the runner records as a turn edits files: the state it found them in.
    await store.pushSnapshot(undoSession.id, {
      at: Date.now(),
      files: [
        { path: existing, content: before },
        // null is how "did not exist" is recorded.
        { path: created, content: null },
      ],
    })

    await fs.writeFile(existing, "changed by the turn", "utf8")
    await fs.writeFile(created, "made by the turn", "utf8")

    const undone = await backend.runtime.runner.undo(undoSession.id)
    check("undo reports the files it touched", undone === 2, undone)
    check("undo restores an edited file", (await fs.readFile(existing, "utf8")) === before)
    check("undo deletes a file the turn created", !(await exists(created)))

    const afterUndo = await store.historyDepth(undoSession.id)
    check("undo moves the step onto the redo stack", afterUndo.undo === 0 && afterUndo.redo === 1, afterUndo)

    const redone = await backend.runtime.runner.redo(undoSession.id)
    check("redo reports the same files", redone === 2, redone)
    check("redo puts the edit back", (await fs.readFile(existing, "utf8")) === "changed by the turn")
    check("redo puts the new file back", await exists(created))

    const afterRedo = await store.historyDepth(undoSession.id)
    check("redo returns the step to the undo stack", afterRedo.undo === 1 && afterRedo.redo === 0, afterRedo)

    // Whole files are stored per step, so the stack cannot grow forever.
    for (let step = 0; step < 25; step++) {
      await store.pushSnapshot(undoSession.id, { at: Date.now(), files: [{ path: existing, content: `step ${step}` }] })
    }
    const capped = await store.historyDepth(undoSession.id)
    check("the undo stack is bounded", capped.undo === 20, capped)

    // A fresh change has to end the redo line, as it does in any editor.
    await store.pushSnapshot(undoSession.id, { at: Date.now(), files: [{ path: existing, content: "x" }] })
    const afterNew = await store.historyDepth(undoSession.id)
    check("a new change clears the redo stack", afterNew.redo === 0, afterNew)

    await backend.runtime.runner.undo(undoSession.id)
    await fs.writeFile(existing, before, "utf8")
    await fs.rm(created, { force: true })
  }

  section("Round 3: edit and retry, branch names, failure sentences, per-file diffs, turn ends")
  {
    const store = backend.runtime.sessions
    const model = { provider: "anthropic", model: "claude-opus-5" }
    const talk = await store.create({ directory: project, model })
    const now = Date.now()
    // Ids that sort in the order they were written, as real ones do.
    const asked = (id: string, at: number) =>
      ({ id, sessionID: talk.id, role: "user", text: id, attachments: [], time: { created: now + at } }) as Message
    const answered = (id: string, at: number) =>
      ({
        id,
        sessionID: talk.id,
        role: "assistant",
        model,
        agent: "build",
        parts: [],
        finish: "end_turn",
        time: { created: now + at, completed: now + at + 1 },
      }) as Message
    for (const message of [asked("msg_r3_1", 0), answered("msg_r3_2", 10), asked("msg_r3_3", 20), answered("msg_r3_4", 30)]) {
      await store.saveMessage(message, true)
    }
    await store.update(talk.id, { title: "Plan", compacted: { messageID: "msg_r3_4", summary: "summary", at: now } })
    const later = path.join(project, "r3-later.txt")
    await fs.writeFile(later, "written by a later turn", "utf8")

    // P3-5: MiMo's edit and retry delete messages and leave the files.
    const cut = await call({ type: "session.revert", sessionID: talk.id, messageID: "msg_r3_3", files: false })
    const left = (await store.messages(talk.id)).map((message) => message.id)
    check("an edit or retry deletes the message and everything after it", left.join() === "msg_r3_1,msg_r3_2", left)
    check("and moves no file", (await fs.readFile(later, "utf8")) === "written by a later turn")
    check("and says none was written", cut.files === 0, cut.files)
    check("a summary over the deleted messages goes with them", (await store.require(talk.id)).compacted === undefined)
    const gone = await call({ type: "session.revert", sessionID: talk.id, messageID: "msg_r3_3", files: false }).then(
      () => "accepted",
      (err: Error) => err.message,
    )
    check("deleting from a message that is gone is refused", gone !== "accepted", gone)
    await fs.rm(later, { force: true })

    // P5-15: MiMo's branch names.
    const kept = await call({ type: "session.fork", sessionID: talk.id, messageID: "msg_r3_2" })
    check("continuing in a new conversation keeps the title", kept.session.title === "Plan", kept.session.title)
    const branched = await call({ type: "session.fork", sessionID: talk.id, messageID: "msg_r3_2", titleSuffix: true })
    check("a branch off a reply is named 「(分支)」", branched.session.title === "Plan (分支)", branched.session.title)
    const again = await call({ type: "session.fork", sessionID: branched.session.id, messageID: "msg_r3_2", titleSuffix: true })
    check("and a branch of a branch counts on", again.session.title === "Plan (分支 2)", again.session.title)
    check("then to 3", branchTitle("Plan (分支 2)") === "Plan (分支 3)", branchTitle("Plan (分支 2)"))
    check("a title that only mentions the word is not a branch yet", branchTitle("分支 notes") === "分支 notes (分支)", branchTitle("分支 notes"))

    // P5-1: MiMo's short failure sentences.
    const code = (err: unknown) => failureCode(err)?.code
    check("an unreachable host reads as the network", code(new Error("getaddrinfo ENOTFOUND api.example.com")) === "error.network")
    const dropped = new Error("request failed", { cause: Object.assign(new Error("other side closed"), { code: "ECONNRESET" }) })
    check("so does a dropped socket hiding in a cause", code(dropped) === "error.network", failureDetail(dropped))
    check("and the detail keeps the cause", failureDetail(dropped).includes("ECONNRESET"), failureDetail(dropped))
    check("a rate limit", code(new Error("Rate limited by the provider. Wait a moment and try again.")) === "error.rateLimited")
    check("too many requests", code(new Error("429 Too Many Requests")) === "error.rateLimited")
    check("a refused key", code(new Error("Authentication failed - check the API key in Settings.")) === "error.authInvalid")
    check("a key the provider calls wrong", code(new Error("Incorrect API key provided.")) === "error.authInvalid")
    check("a status written into the sentence", code(new Error("ChatGPT request failed (401) denied")) === "error.authInvalid")
    check(
      "a conversation too long for the model",
      code(new Error("request (22530 tokens) exceeds the available context size (8192 tokens)")) === "error.contextExceeded",
    )
    check("a model the provider does not have", code(new Error("The provider does not recognise this model (404). nope")) === "error.modelUnavailable")
    check("a server error that outlasted the retries", code(new Error("The provider returned 503. This is usually transient.")) === "error.serverError")
    check("a code the provider set is kept", code(new ProviderError("closed", "error.noReply")) === "error.noReply")
    const odd = code(new Error("The model refused the tool schema"))
    check("anything else keeps the provider's words", odd === undefined, odd)

    // P3-11/P3-12: each of a turn's files as it stands now.
    const git3 = (cwd: string, ...args: string[]) => promisify(execFile)("git", args, { cwd })
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r3-diff-"))
    const repo3 = path.join(parent, "repo")
    await fs.mkdir(repo3)
    await git3(repo3, "init", "-q")
    await fs.writeFile(path.join(repo3, "tracked.txt"), "one\n")
    await git3(repo3, "add", "tracked.txt")
    await git3(repo3, "-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "start")
    await fs.writeFile(path.join(repo3, "tracked.txt"), "one\ntwo\n")
    await fs.writeFile(path.join(repo3, "fresh.txt"), "new\n")
    await fs.writeFile(path.join(parent, "outside.txt"), "not the project's\n")
    const diffs = await turnFileDiffs(repo3, ["tracked.txt", "fresh.txt", "../outside.txt"])
    const patchOf = (file: string) => diffs.files.find((entry) => entry.path === file)?.patch ?? ""
    check("in a repository each file is diffed as it stands", diffs.repo && patchOf("tracked.txt").includes("+two"), patchOf("tracked.txt"))
    check("a file the turn created is diffed whole", patchOf("fresh.txt").includes("+new"), patchOf("fresh.txt"))
    check("a path that leaves the project gets nothing", patchOf("../outside.txt") === "", patchOf("../outside.txt"))
    const asks = await call({ type: "git.diffFiles", directory: repo3, files: ["tracked.txt"] })
    check("and the window can ask for it", asks.repo === true && String(asks.files[0]?.patch).includes("+two"), asks)
    const plain = path.join(parent, "plain")
    await fs.mkdir(plain)
    check("outside a repository there is nothing to compare with", (await turnFileDiffs(plain, ["a.txt"])).repo === false)
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined)

    // P5-4, P5-8, P5-10, P5-18, P3-14, P4-1: how a turn ends on screen.
    const tool = (status: ToolPart["status"], extra: Partial<ToolPart> = {}): ToolPart => ({
      type: "tool",
      id: "prt_r3",
      callID: "call_r3",
      name: "bash",
      status,
      input: {},
      time: { created: 1 },
      ...extra,
    })
    const stateOf = (part: AssistantPart) => (part.type === "tool" ? part.status : part.type)
    check(
      "a tool Stop cut off settles as done",
      stateOf(stepPart(tool("error", { error: "Command was aborted", metadata: { aborted: true } }), false)) === "completed",
    )
    check("a tool that failed on its own stays failed", stateOf(stepPart(tool("error", { error: "exit 1" }), false)) === "error")
    check("a finished turn's running tool settles", stateOf(stepPart(tool("running"), false)) === "completed")
    check("a live turn's running tool keeps running", stateOf(stepPart(tool("running"), true)) === "running")
    const thought = stepPart({ type: "reasoning", id: "prt_think", text: "hmm", time: { created: 1 } }, false)
    check("reasoning is drawn as nothing", thought.type === "reasoning" && thought.text === "")
    check("a stop that got nothing out keeps its stopped line", stoppedEmpty({ finish: "aborted", parts: [] }))
    check("a stop after text does not", !stoppedEmpty({ finish: "aborted", parts: [{ type: "text", id: "prt_t", text: "hi" }] }))
    check("nor a stop after a tool", !stoppedEmpty({ finish: "aborted", parts: [tool("completed")] }))
    const long = cardCut("x".repeat(700))
    check("a long failure is cut at 600 with an ellipsis", long?.text.length === 601 && long.text.endsWith("…") && long.clamped, long?.text.length)
    check("seven lines are cut as well", cardCut("1\n2\n3\n4\n5\n6\n7")?.clamped === true)
    check("six are not", cardCut("1\n2\n3\n4\n5\n6")?.clamped === false)
    check("text from 原始错误 on is dropped", cardCut("短句\n\n原始错误：boom")?.text === "短句")
    check("nothing to say is left to the fallback", cardCut("  ") === undefined)
    check("64px from the end still counts as the end", stickState(1000, 436, 500).atEnd && !stickState(1000, 436, 500).jump)
    check("65px away offers the jump", !stickState(1000, 435, 500).atEnd && stickState(1000, 435, 500).jump)
    check("nothing to scroll offers no jump", !stickState(400, 0, 500).jump)
    const said = (id: string) => ({ type: "text", id, text: id }) as AssistantPart
    const reply = (id: string, part: string) =>
      ({ id, sessionID: "s", role: "assistant", model, agent: "build", parts: [said(part)], time: { created: 1 } }) as Message
    const question = (id: string, steered = false) =>
      ({ id, sessionID: "s", role: "user", text: id, attachments: [], time: { created: 1 }, ...(steered ? { steered: true } : {}) }) as Message
    const thread = [question("q1"), reply("a1", "x"), question("q2"), reply("a2", "y"), question("s1", true), reply("a3", "z")]
    const latest = latestTurnParts(thread).map((part) => part.id)
    check("the pill counts the latest turn only, steers included", latest.join() === "y,z", latest)
    check("and a new question empties it", latestTurnParts([...thread, question("q3")]).length === 0)
  }

  section("Steering")
  {
    const store = backend.runtime.sessions
    const steerSession = await store.create({
      directory: project,
      model: { provider: "anthropic", model: "claude-opus-5" },
    })
    // A turn under way is one the runner holds a steering entry for; a prompt then joins it rather than starting one.
    const internals = backend.runtime.runner as unknown as {
      steering: Map<string, { waiting: string[]; written: Promise<void> }>
      pending: Map<string, unknown>
    }
    internals.steering.set(steerSession.id, { waiting: [], written: Promise.resolve() })
    const joinedID = await backend.runtime.runner.prompt({ sessionID: steerSession.id, text: "also check the tests" })
    const joined = (await store.messages(steerSession.id)).find((message) => message.id === joinedID)
    check(
      "a message sent into a running turn is saved marked as steered",
      joined?.role === "user" && joined.steered === true,
      joined,
    )
    internals.steering.delete(steerSession.id)
    internals.pending.delete(steerSession.id)
  }

  section("Composer text rules")
  {
    const js = ["const a = 1", "let b = a + 1", "function add(x, y) {", "  return x + y", "}", "console.log(add(a, b))"].join("\n")
    check("five lines of code are fenced as their language", detectCodeLanguage(js) === "js", detectCodeLanguage(js))
    check("JSON that parses is json", detectCodeLanguage('{\n  "a": 1,\n  "b": [1, 2],\n  "c": {\n    "d": true\n  }\n}') === "json")
    check("four lines are too few", detectCodeLanguage("const a = 1\nlet b = 2\nconst c = 3\nlet d = 4") === undefined)
    check("prose is not code", detectCodeLanguage("Dear team,\n\nthanks for the update.\nI will look tomorrow.\nBest,\nWyatt") === undefined)
    check("text already fenced is left alone", detectCodeLanguage("```\n" + js + "\n```") === undefined)
    const fenced = insertFence("see: tail", 5, 5, "js", "a()\n\n")
    check("the fence gets lines of its own", fenced.text === "see: \n```js\na()\n```\ntail", fenced.text)
    check("and the caret lands after it", fenced.caret === "see: \n```js\na()\n```\n".length, fenced.caret)

    const says = (id: string, text: string) => ({ id, sessionID: "s", role: "user", text, attachments: [], time: { created: 1 } }) as Message
    const walk = promptHistory([says("1", " one "), says("2", "one"), says("3", "two"), says("4", "  ")])
    check("history trims and drops repeats in a row", walk.join("|") === "one|two", walk)

    const removed = mentionBackspace("see @src/app.ts now", 16, ["src/app.ts"])
    check("backspace after a mention and its space takes the whole mention", removed?.text === "see now" && removed.caret === 4, removed)
    check("an @ inside a word is not a mention", mentionBackspace("mail@src/app.ts", 15, ["src/app.ts"]) === undefined)

    check("a slash on a later line opens the menu", slashAt("hello\n  /com", 12)?.query === "com")
    check("a slash inside a sentence does not", slashAt("and/or", 6) === undefined)
    check("a space after the name ends the search", slashAt("/deploy west", 12) === undefined)
    const lead = slashLead("\n  /compact now", new Set(["compact"]))
    check("the highlight finds a known command after blank lines", lead?.newlines === 1 && lead.indent === "  " && lead.token === "/compact", lead)
    check("but not an unknown one", slashLead("/nope", new Set(["compact"])) === undefined)

    check("a file under the project is named from its root", projectRelative("C:\\Work\\Proj", "c:/work/proj/src/a.ts") === "src/a.ts")
    check("a file outside it is not", projectRelative("C:\\Work\\Proj", "C:\\Work\\Projects\\a.ts") === undefined)
    check("dropped mentions are appended with one space before them", appendMentions("look at", ["a.ts", "b.ts"]) === "look at @a.ts @b.ts ")
  }

  section("The @ menu: folders and search")
  {
    await fs.mkdir(path.join(project, "node_modules", "pkg"), { recursive: true })
    await fs.writeFile(path.join(project, ".hidden"), "x")
    await fs.mkdir(path.join(project, "src", "deep"), { recursive: true })
    await fs.writeFile(path.join(project, "src", "deep", "app-helper.ts"), "export {}\n")

    const top = await call({ type: "file.listDir", directory: project })
    const names: string[] = top.entries.map((entry: { type: string; name: string }) => `${entry.type}:${entry.name}`)
    const firstFile = names.findIndex((name) => name.startsWith("file:"))
    const lastDir = names.map((name) => name.startsWith("dir:")).lastIndexOf(true)
    check("one level, folders before files", names.includes("dir:src") && names.includes("file:hello.ts") && lastDir < firstFile, names)
    check("dot entries and ignored folders are left out", !names.some((name) => name.includes(".hidden") || name.includes("node_modules")), names)
    check("nothing from a level below", !names.some((name) => name.includes("app.ts")), names)

    const inner = await call({ type: "file.listDir", directory: project, sub: "src" })
    const innerNames: string[] = inner.entries.map((entry: { type: string; name: string }) => `${entry.type}:${entry.name}`)
    check("a sub folder lists its own level", innerNames.includes("dir:deep") && innerNames.includes("file:app.ts"), innerNames)
    const escaped = await call({ type: "file.listDir", directory: project, sub: "../.." }).then(() => false, () => true)
    check("a folder outside the project is refused", escaped)
    const missing = await call({ type: "file.listDir", directory: project, sub: "no-such-folder" }).then(() => false, () => true)
    check("an unreadable folder is an error the menu can show", missing)

    const found = await call({ type: "file.search", directory: project, query: "app" })
    const rels: string[] = found.entries.map((entry: { rel: string }) => entry.rel)
    const helper = found.entries.find((entry: { rel: string }) => entry.rel === "src/deep/app-helper.ts")
    check("search reaches into sub folders", rels.includes("src/app.ts") && helper?.dir === "src/deep" && helper?.name === "app-helper.ts", found.entries)
    check("a shorter path ranks first", rels.indexOf("src/app.ts") < rels.indexOf("src/deep/app-helper.ts"), rels)
    const scoped = await call({ type: "file.search", directory: project, query: "app", sub: "src/deep" })
    check("search stays inside the folder being browsed", scoped.entries.length === 1 && scoped.entries[0].rel === "src/deep/app-helper.ts", scoped.entries)
    const capped = await call({ type: "file.search", directory: project, query: "a", limit: 1 })
    check("a capped search says it was cut short", capped.entries.length === 1 && capped.truncated === true, capped)

    await fs.rm(path.join(project, "node_modules"), { recursive: true, force: true })
    await fs.rm(path.join(project, ".hidden"), { force: true })
    await fs.rm(path.join(project, "src", "deep"), { recursive: true, force: true })
  }

  section("Resuming an interrupted turn")
  {
    const asked = { id: "u1", sessionID: "s", role: "user", text: "go", attachments: [], time: { created: 1 } } as Message
    const reply = (finish?: string) =>
      ({ id: "a1", sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts: [], time: { created: 2 }, ...(finish ? { finish } : {}) }) as Message
    check("no question, nothing to resume", interruptedTurn([]) === undefined)
    check("a question with no reply broke off", interruptedTurn([asked]) === "u1")
    check("a stopped reply broke off", interruptedTurn([asked, reply("aborted")]) === "u1")
    check("a failed reply broke off", interruptedTurn([asked, reply("error")]) === "u1")
    check("a reply cut short by a quit broke off", interruptedTurn([asked, reply()]) === "u1")
    check("a finished reply did not", interruptedTurn([asked, reply("end_turn")]) === undefined)
    check("nor a refused one", interruptedTurn([asked, reply("refusal")]) === undefined)

    // A runtime that fails the first request and answers every one after it.
    const bodies: unknown[] = []
    let failNext = true
    const flaky = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
        return
      }
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        bodies.push(raw ? JSON.parse(raw) : undefined)
        response.writeHead(200, { "content-type": "text/event-stream" })
        if (failNext) {
          failNext = false
          const failure = { error: { message: "request (22530 tokens) exceeds the available context size (8192 tokens), try increasing it" } }
          response.end(`event: error\n\ndata: ${JSON.stringify(failure)}\n\n`)
          return
        }
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "carried on" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve) => flaky.listen(8811, "127.0.0.1", resolve))
    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8811/v1" } } })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })
    const made = await call({ type: "session.create", directory: project })
    const resumeID: string = made.session.id
    await call({ type: "session.model", sessionID: resumeID, model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" } })

    const idleSince = (from: number) =>
      new Promise<boolean>((resolve) => {
        const started = Date.now()
        const poll = setInterval(() => {
          const done = events.slice(from).some((event) => event.type === "session.idle" && event.sessionID === resumeID)
          if (done || Date.now() - started > 60_000) {
            clearInterval(poll)
            resolve(done)
          }
        }, 50)
      })

    let mark = events.length
    await call({ type: "session.prompt", sessionID: resumeID, text: "build the thing" })
    check("the first turn ends", await idleSince(mark))
    const broken = await call({ type: "session.get", sessionID: resumeID })
    const question = broken.messages.find((message: Message) => message.role === "user")
    check("and ends failed", broken.messages.at(-1)?.finish === "error", broken.messages.at(-1)?.finish)

    mark = events.length
    const sentBefore = bodies.length
    const resumed = await call({ type: "session.resume", sessionID: resumeID })
    check("resume names the question it carries on", resumed.messageID === question?.id, resumed)
    check("and runs to the end", await idleSince(mark))
    const after = await call({ type: "session.get", sessionID: resumeID })
    const users = after.messages.filter((message: Message) => message.role === "user")
    check("no new message is written", users.length === 1, users.length)
    const last = after.messages.at(-1)
    const lastText = last?.parts?.map((part: { text?: string }) => part.text ?? "").join("")
    check("the carried-on reply finishes", last?.finish === "end_turn" && lastText === "carried on", last)
    const request = bodies[sentBefore] as { messages?: { role: string; content: unknown }[] } | undefined
    const tail = request?.messages?.at(-1)
    check(
      "the model is told to carry on, in the request only",
      tail?.role === "user" && String(tail.content).toLowerCase().includes("carry on"),
      tail,
    )
    const again = await call({ type: "session.resume", sessionID: resumeID }).then(
      () => "ran",
      (error: Error) => error.message,
    )
    check("a finished turn cannot be resumed", again !== "ran", again)

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await call({ type: "config.set", patch: { providerEndpoints: {} } })
    flaky.close()
  }

  section("Files tab requests (MiMo's tree, name search and preview reads)")
  {
    const failureOf = (error: unknown) => String((error as { message?: string } | undefined)?.message ?? error)
    const tree = path.join(root, "tree-project")
    await fs.mkdir(path.join(tree, ".github"), { recursive: true })
    await fs.mkdir(path.join(tree, "node_modules", "pkg"), { recursive: true })
    await fs.mkdir(path.join(tree, "vendor"), { recursive: true })
    await fs.mkdir(path.join(tree, "empty"), { recursive: true })
    await fs.mkdir(path.join(tree, "src", "deep"), { recursive: true })
    await fs.writeFile(path.join(tree, ".env"), "A=1\n")
    await fs.writeFile(path.join(tree, "src", "app.ts"), "export {}\n")
    await fs.writeFile(path.join(tree, "src", "deep", "apple.txt"), "fruit\n")
    await fs.writeFile(path.join(tree, "node_modules", "pkg", "app.js"), "x\n")

    const listed = await call({ type: "file.listDir", directory: tree, all: true })
    const names = listed.entries.map((entry) => entry.name)
    check("the tree shows dot entries and empty folders", names.includes(".github") && names.includes(".env") && names.includes("empty"), names)
    check("the tree leaves out only MiMo's ignored folders", !names.includes("node_modules") && names.includes("vendor"), names)
    const firstFile = listed.entries.findIndex((entry) => entry.type === "file")
    check("folders come before files", firstFile > 0 && listed.entries.slice(firstFile).every((entry) => entry.type === "file"), listed.entries)
    const atMenu = await call({ type: "file.listDir", directory: tree })
    check("the @ menu's listing still hides dot entries", !atMenu.entries.some((entry) => entry.name.startsWith(".")), atMenu.entries)
    check("an empty folder lists as nothing", (await call({ type: "file.listDir", directory: tree, sub: "empty", all: true })).entries.length === 0)

    const byName = await call({ type: "file.search", directory: tree, query: "app", nameOnly: true })
    const rels = byName.entries.map((hit) => hit.rel)
    check("name search finds files by their names", rels.includes("src/app.ts") && rels.includes("src/deep/apple.txt") && !byName.truncated, byName)
    check("and skips the ignored folders", !rels.some((rel) => rel.startsWith("node_modules")), rels)
    check("a hit carries its folder", byName.entries.find((hit) => hit.rel === "src/deep/apple.txt")?.dir === "src/deep", byName.entries)
    check("a folder's name alone is not a match", (await call({ type: "file.search", directory: tree, query: "deep", nameOnly: true })).entries.length === 0)
    await fs.mkdir(path.join(tree, "many"))
    for (let index = 0; index < 55; index++) await fs.writeFile(path.join(tree, "many", `note-${index}.md`), "")
    const cappedSearch = await call({ type: "file.search", directory: tree, query: "note-", nameOnly: true })
    check("name search stops at 50 and says so", cappedSearch.entries.length === 50 && cappedSearch.truncated, {
      count: cappedSearch.entries.length,
      truncated: cappedSearch.truncated,
    })

    await fs.writeFile(path.join(tree, "big.txt"), "x".repeat(512 * 1024 + 1))
    const big = await call({ type: "file.read", root: tree, rel: "big.txt", preview: true })
    check("a preview refuses text past 512 KiB and carries none of it", big.tooBig === true && big.content === "", { tooBig: big.tooBig, length: big.content.length })
    await fs.writeFile(path.join(tree, "nul.txt"), Buffer.concat([Buffer.from("a".repeat(5000)), Buffer.from([0])]))
    check("a NUL byte anywhere makes a preview binary", (await call({ type: "file.read", root: tree, rel: "nul.txt", preview: true })).kind === "binary")
    await fs.writeFile(path.join(tree, "clip.mp4"), Buffer.from([0, 0, 0, 24]))
    const clip = await call({ type: "file.read", root: tree, rel: "clip.mp4", preview: true })
    check("a video preview is named as one and carries no bytes", clip.video === true && !clip.data, clip)
    await fs.writeFile(path.join(tree, "pic.png"), Buffer.alloc(16))
    const pic = await call({ type: "file.read", root: tree, rel: "pic.png", preview: true })
    check("a preview picture carries its type but no bytes", pic.kind === "image" && pic.mime === "image/png" && !pic.data, pic)
    check("a plain read still carries a picture's bytes", Boolean((await call({ type: "file.read", root: tree, rel: "pic.png" })).data))

    // round 8 (X4): a save has to land in a folder the app works in.
    await call({ type: "project.add", directory: tree })
    const tooBigSave = await call({ type: "file.write", root: tree, rel: ".env", content: "x".repeat(512 * 1024 + 1) }).then(() => "saved", failureOf)
    check("a save past 512 KiB is refused as toobig", tooBigSave.includes("toobig"), tooBigSave)
    const binarySave = await call({ type: "file.write", root: tree, rel: "nul.txt", content: "text" }).then(() => "saved", failureOf)
    check("a save over a binary file is refused", binarySave.includes("binary"), binarySave)
    const defaultDir = await call({ type: "file.defaultDir" })
    check("with no project the files tab has the default project location", defaultDir.directory.length > 0, defaultDir)
  }

  section("Persistence")
  socket.close()
  await backend.close()

  const restarted = await startBackend(dataDirectory)
  const survivors = await restarted.runtime.sessions.list()
  check("sessions survive a restart", survivors.some((session) => session.id === sessionID), survivors.length)
  check("title survived", survivors.find((s) => s.id === sessionID)?.title === "Smoke test")

  // Deletion has to be real rather than a hidden row: a session reappearing
  // after a restart is the failure people actually notice.
  let deletedEvent: string | undefined
  const unsubscribe = restarted.runtime.bus.subscribe((event) => {
    if (event.type === "session.deleted") deletedEvent = event.sessionID
  })
  const doomed = await restarted.runtime.sessions.create({
    directory: project,
    model: { provider: "anthropic", model: "claude-opus-5" },
  })
  await restarted.runtime.sessions.delete(doomed.id)
  const afterDelete = await restarted.runtime.sessions.list()
  check(
    "a deleted session is gone from the list",
    !afterDelete.some((session) => session.id === doomed.id),
    afterDelete.length,
  )
  check("deleting broadcasts session.deleted", deletedEvent === doomed.id, deletedEvent)

  // Archiving is not deletion: the session has to survive a restart intact.
  const kept = await restarted.runtime.sessions.create({
    directory: project,
    model: { provider: "anthropic", model: "claude-opus-5" },
  })
  await restarted.runtime.sessions.update(kept.id, { archived: true })
  const archivedNow = await restarted.runtime.sessions.get(kept.id)
  check("archiving marks the session", archivedNow?.archived === true, archivedNow?.archived)
  check(
    "an archived session is still listed for settings to show",
    (await restarted.runtime.sessions.list()).some((entry) => entry.id === kept.id),
  )
  await restarted.runtime.sessions.update(kept.id, { archived: false })
  check("unarchiving puts it back", (await restarted.runtime.sessions.get(kept.id))?.archived === false)
  unsubscribe?.()
  await restarted.close()

  const reopened = await startBackend(dataDirectory)
  const afterRestart = await reopened.runtime.sessions.list()
  check(
    "a deleted session stays deleted across a restart",
    !afterRestart.some((session) => session.id === doomed.id),
  )

  await reopened.close()

  await fs.rm(root, { recursive: true, force: true })

  const hour = 3_600_000
  check(
    "a token with time left is left alone",
    !needsRefresh({ access: "a", expires: Date.now() + hour }),
  )
  check(
    "a token about to expire is renewed",
    needsRefresh({ access: "a", expires: Date.now() + 30_000 }),
  )
  check(
    "an unstated lifetime still ages out",
    needsRefresh({ access: "a", obtained: Date.now() - hour }),
  )
  check(
    "a freshly issued token with no stated lifetime is kept",
    !needsRefresh({ access: "a", obtained: Date.now() }),
  )
  check("a token with no timing at all is refreshed once", needsRefresh({ access: "a" }))

  // ----------------------------------------------------------------- git --
  // Review is only worth anything if it reads the real repository.
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-git-"))
  const before = await gitOps.status(repoRoot)
  check("a plain folder is not reported as a repository", before.installed && !before.repo, before)

  const after = await gitOps.init(repoRoot)
  check("creating a repository takes effect", after.repo, after)

  await fs.writeFile(path.join(repoRoot, "note.txt"), "hello world")
  const dirty = await gitOps.status(repoRoot)
  check("a new file shows as changed", dirty.changed.includes("note.txt"), dirty.changed)

  const patch = await gitOps.diff(repoRoot, "note.txt")
  check("an untracked file still produces a patch", patch.includes("+hello"), patch.slice(0, 80))

  /*
   * The review prints a letter beside every file, so status has to carry one.
   * The two porcelain columns used to be sliced off and thrown away, which is
   * why a listed file could never say whether it was new, edited or gone.
   */
  const runGit = promisify(execFile)
  const inRepo = (args: string[]) => runGit("git", args, { cwd: repoRoot, windowsHide: true })

  check(
    "an untracked file is reported as an addition",
    dirty.entries.find((entry) => entry.path === "note.txt")?.kind === "added",
    dirty.entries,
  )

  await inRepo(["add", "-A"])
  await inRepo(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "one"])

  await fs.writeFile(path.join(repoRoot, "note.txt"), "hello again")
  const touched = await gitOps.status(repoRoot)
  check(
    "an edited file is reported as modified",
    touched.entries.find((entry) => entry.path === "note.txt")?.kind === "modified",
    touched.entries,
  )
  check("the plain path list still agrees with it", touched.changed.includes("note.txt"), touched.changed)

  /* A change that is only staged still diffs: the review compares against HEAD, as MiMo's gitDiff does. */
  await inRepo(["add", "note.txt"])
  const stagedPatch = await gitOps.diff(repoRoot, "note.txt")
  check("a staged-only change still shows its diff", stagedPatch.includes("+hello again"), stagedPatch.slice(0, 200))
  await inRepo(["reset", "-q", "--", "note.txt"])
  check(
    "git's rename and copy letters read as renamed",
    gitOps.classify("R ") === "renamed" && gitOps.classify("C ") === "renamed" && gitOps.classify("??") === "added" && gitOps.classify(" M") === "modified",
  )
  const freshRepo = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-fresh-"))
  await gitOps.init(freshRepo)
  await fs.writeFile(path.join(freshRepo, "first.txt"), "first line\n")
  await runGit("git", ["add", "first.txt"], { cwd: freshRepo, windowsHide: true })
  check("a file staged before any commit diffs as new", (await gitOps.diff(freshRepo, "first.txt")).includes("+first line"))
  await fs.rm(freshRepo, { recursive: true, force: true })

  await fs.rm(path.join(repoRoot, "note.txt"))
  const removed = await gitOps.status(repoRoot)
  check(
    "a removed file is reported as deleted",
    removed.entries.find((entry) => entry.path === "note.txt")?.kind === "deleted",
    removed.entries,
  )
  await inRepo(["checkout", "--", "."])

  /*
   * Branch scope has to see work that is already committed - a review that
   * only ever looks at the working tree tells you a branch is empty the
   * moment its author commits anything.
   */
  await inRepo(["checkout", "-b", "feature"])
  await fs.writeFile(path.join(repoRoot, "feature.txt"), "on the branch")
  await inRepo(["add", "-A"])
  await inRepo(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "two"])

  const worktree = await gitOps.status(repoRoot)
  check("a committed change is not a working-tree change", !worktree.changed.includes("feature.txt"), worktree.changed)

  /*
   * The agent's opening context. Until this existed it began every session
   * blind: not knowing it was in a repository, which branch it was on, what
   * was already dirty, or how this project is built - all of which it would
   * otherwise spend its first turn discovering.
   */
  await fs.writeFile(path.join(repoRoot, "loose.txt"), "not committed")
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { build: "tsc", smoke: "node t.js" } }),
  )
  // round 5 (E10): the repository's state now travels with each prompt, out of the cached system prompt.
  const situated = (await repositoryState(repoRoot)) ?? ""
  check("the per-prompt repository note names the branch", situated.includes("Branch: feature"), situated.slice(-400))
  check(
    "and what was already dirty before the turn",
    situated.includes("loose.txt") && situated.includes("Already modified"),
    situated.slice(-400),
  )
  check("and the last commits", situated.includes("two"), situated.slice(-300))
  const situatedPrompt = await systemPrompt({ directory: repoRoot, agent: "build" })
  check(
    "the system prompt says how this project is built",
    situatedPrompt.includes("npm run <name>") && situatedPrompt.includes("build, smoke"),
    situatedPrompt.slice(-600),
  )
  check("and carries no repository state or date of its own", !situatedPrompt.includes("## Repository") && !situatedPrompt.includes("Today:"), situatedPrompt.slice(-400))
  await fs.rm(path.join(repoRoot, "loose.txt"))
  await fs.rm(path.join(repoRoot, "package.json"))

  /* A folder that is not a repository says nothing about one. */
  const noRepo = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-plain-"))
  const bare = await systemPrompt({ directory: noRepo, agent: "build" })
  check("a plain folder gets no repository note", (await repositoryState(noRepo)) === undefined)
  check("and no build section it cannot support", !bare.includes("## Building and testing"), bare.slice(-200))
  await fs.rm(noRepo, { recursive: true, force: true })

  const branchScope = await gitOps.status(repoRoot, "branch")
  check("branch scope sees it", branchScope.changed.includes("feature.txt"), branchScope.changed)
  check(
    "and calls it an addition",
    branchScope.entries.find((entry) => entry.path === "feature.txt")?.kind === "added",
    branchScope.entries,
  )
  check(
    "a committed file still diffs against the branch point",
    (await gitOps.diff(repoRoot, "feature.txt", 3, "branch")).includes("+on the branch"),
  )
  check(
    "and shows nothing against the working tree",
    (await gitOps.diff(repoRoot, "feature.txt")).trim() === "",
  )

  // Context is what "show all lines" asks for, and it reaches a command line.
  await fs.writeFile(path.join(repoRoot, "wide.txt"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))
  await inRepo(["add", "-A"])
  await inRepo(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "three"])
  await fs.writeFile(
    path.join(repoRoot, "wide.txt"),
    Array.from({ length: 40 }, (_, i) => (i === 20 ? "changed" : `line ${i}`)).join("\n"),
  )
  const tight = await gitOps.diff(repoRoot, "wide.txt")
  const whole = await gitOps.diff(repoRoot, "wide.txt", 100_000)
  check(
    "a wider context really shows more of the file",
    whole.split("\n").length > tight.split("\n").length,
    { tight: tight.split("\n").length, whole: whole.split("\n").length },
  )
  await inRepo(["checkout", "--", "."])
  await inRepo(["checkout", "master"]).catch(() => inRepo(["checkout", "main"]))

  await gitOps.revert(repoRoot, "note.txt")
  check("reverting removes the change", !(await gitOps.status(repoRoot)).changed.includes("note.txt"))

  // Opening a subdirectory of a repository is ordinary, and git answers in
  // paths relative to the root - so the review listed files it could not diff,
  // and "discard" reported success while doing nothing.
  const subProject = path.join(repoRoot, "app")
  await fs.mkdir(subProject)
  await fs.writeFile(path.join(subProject, "main.ts"), "export const a = 1")
  const fromSub = await gitOps.status(subProject)
  check("a subdirectory reports project-relative paths", fromSub.changed.includes("main.ts"), fromSub.changed)
  check(
    "a file in a subdirectory still diffs",
    (await gitOps.diff(subProject, "main.ts")).includes("+export const a = 1"),
  )
  await gitOps.revert(subProject, "main.ts")
  check("reverting from a subdirectory really removes it", !(await exists(path.join(subProject, "main.ts"))))

  await fs.writeFile(path.join(repoRoot, "sibling.txt"), "untouched")
  const escaped = await gitOps
    .revert(subProject, "../sibling.txt")
    .then(() => "allowed", (error: Error) => error.message)
  check("reverting outside the project is refused", escaped.startsWith("Refusing"), escaped)
  check("and the file outside is left alone", await exists(path.join(repoRoot, "sibling.txt")))

  await fs.rm(repoRoot, { recursive: true, force: true })

  // ------------------------------------------------ info card: git ------
  // The info card's line counts, commit and push, all against throwaway
  // repositories and a bare "origin" in the temp folder - never a real remote.
  const cardTemp = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-card-"))
  const cardRepo = path.join(cardTemp, "work")
  const cardOrigin = path.join(cardTemp, "origin.git")
  const cardOther = path.join(cardTemp, "other")
  const hooksOff = path.join(cardTemp, "no-hooks")
  await fs.mkdir(cardRepo)
  await fs.mkdir(hooksOff)
  const gitIn = (cwd: string, args: string[]) => runGit("git", args, { cwd, windowsHide: true })
  // Local settings only, so the machine's own identity, signing and hooks stay out of it.
  const quiet = async (cwd: string) => {
    await gitIn(cwd, ["config", "user.email", "t@example.com"])
    await gitIn(cwd, ["config", "user.name", "t"])
    await gitIn(cwd, ["config", "commit.gpgsign", "false"])
    await gitIn(cwd, ["config", "core.hooksPath", hooksOff])
  }

  check("a plain folder has no summary", !(await gitOps.summary(cardRepo)).repo)
  await gitIn(cardRepo, ["init"])
  await quiet(cardRepo)
  const unborn = await gitOps.commitState(cardRepo)
  check("before the first commit there is a branch but no HEAD", unborn.ok && !unborn.hasHead && !unborn.isDetached && Boolean(unborn.branch), unborn)
  await fs.writeFile(path.join(cardRepo, "base.txt"), "one\ntwo\nthree\n")
  await gitIn(cardRepo, ["add", "-A"])
  await gitIn(cardRepo, ["commit", "-m", "base"])
  const cardBranch = (await gitIn(cardRepo, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()

  await fs.writeFile(path.join(cardRepo, "base.txt"), "one\n2\nthree\n")
  await fs.writeFile(path.join(cardRepo, "fresh.txt"), "a\nb")
  const counted = await gitOps.summary(cardRepo)
  check(
    "the summary counts an edit and an untracked file in lines",
    counted.repo && counted.ok && counted.fileCount === 2 && counted.additions === 3 && counted.deletions === 1,
    counted,
  )
  check("and per file", counted.files.find((file) => file.path === "fresh.txt")?.additions === 2, counted.files)
  check("and names the branch", counted.branch === cardBranch, counted)

  const cardPending = await gitOps.commitState(cardRepo)
  check(
    "commit state sees changes, nothing staged and no remote",
    cardPending.ok && cardPending.hasChanges && !cardPending.hasStaged && !cardPending.hasOrigin && cardPending.changedPaths.length === 2,
    cardPending,
  )
  check("committing only the staged part of nothing says so", (await gitOps.commit(cardRepo, "x", false)).code === "nothing-to-commit")
  await gitIn(cardRepo, ["add", "base.txt"])
  const stagedState = await gitOps.commitState(cardRepo)
  check("staged lines are counted", stagedState.hasStaged && stagedState.stagedAdditions === 1 && stagedState.stagedDeletions === 1, stagedState)
  const committed = await gitOps.commit(cardRepo, "card: both files", true)
  const headHash = (await gitIn(cardRepo, ["rev-parse", "--short", "HEAD"])).stdout.trim()
  check("commit takes everything when asked and returns the short hash", committed.ok && committed.hash === headHash, committed)
  check("and leaves a clean tree", !(await gitOps.commitState(cardRepo)).hasChanges)
  check("an empty message is refused before git is asked", !(await gitOps.commit(cardRepo, "  ", true)).ok)
  check("push without a remote says so", (await gitOps.push(cardRepo)).code === "no-remote")

  await gitIn(cardTemp, ["init", "--bare", cardOrigin])
  await gitIn(cardRepo, ["remote", "add", "origin", cardOrigin])
  const unpublished = await gitOps.commitState(cardRepo)
  check("a new remote has no branch yet", unpublished.hasOrigin && !unpublished.hasOriginBranch && !unpublished.hasUpstream, unpublished)
  const published = await gitOps.push(cardRepo)
  check("the first push publishes the branch", published.ok, published)
  const tracking = await gitOps.commitState(cardRepo)
  check("and makes origin its upstream", tracking.hasUpstream && tracking.hasOriginBranch && tracking.ahead === 0, tracking)

  await fs.writeFile(path.join(cardRepo, "base.txt"), "one\n2\n3\n")
  await gitOps.commit(cardRepo, "card: again", true)
  check("a local commit is one ahead", (await gitOps.commitState(cardRepo)).ahead === 1)
  check("and pushes to the upstream", (await gitOps.push(cardRepo)).ok)
  const originHead = (await gitIn(cardOrigin, ["rev-parse", `refs/heads/${cardBranch}`])).stdout.trim()
  const localHead = (await gitIn(cardRepo, ["rev-parse", "HEAD"])).stdout.trim()
  check("origin now has it", originHead === localHead, { originHead, localHead })

  await gitIn(cardTemp, ["clone", cardOrigin, cardOther])
  await quiet(cardOther)
  await fs.writeFile(path.join(cardOther, "theirs.txt"), "theirs\n")
  await gitIn(cardOther, ["add", "-A"])
  await gitIn(cardOther, ["commit", "-m", "theirs"])
  await gitIn(cardOther, ["push", "origin", cardBranch])
  await fs.writeFile(path.join(cardRepo, "mine.txt"), "mine\n")
  await gitOps.commit(cardRepo, "card: mine", true)
  const behindPush = await gitOps.push(cardRepo)
  check("a push behind the remote is reported as rejected, not forced", !behindPush.ok && behindPush.code === "rejected", behindPush)
  check("and origin keeps their commit", (await gitIn(cardOrigin, ["rev-parse", `refs/heads/${cardBranch}`])).stdout.trim() !== (await gitIn(cardRepo, ["rev-parse", "HEAD"])).stdout.trim())
  await fs.rm(cardTemp, { recursive: true, force: true })

  check("an identity error is named", gitOps.commitFailure({ stderr: "*** Please tell me who you are." }).code === "ident-missing")
  check("an auth error is named", gitOps.pushFailure({ stderr: "fatal: Authentication failed for 'https://x'" }).code === "auth")
  check("no files is plain update", gitOps.fallbackCommitMessage([]) === "update")
  check("one file is named", gitOps.fallbackCommitMessage(["src/a/b.ts"]) === "update b.ts")
  check("one folder is named with a count", gitOps.fallbackCommitMessage(["src/a.ts", "src/b.ts"]) === "update src/ (2 files)")
  check("several folders are counted", gitOps.fallbackCommitMessage(["a.ts", "src/b.ts"]) === "update 2 files")
  check(
    "a model answer is cut to its first real line",
    gitOps.cleanCommitMessage('<think>hmm</think>\n\n"fix: keep the card open"\nbody') === "fix: keep the card open",
  )
  check("a long answer is capped", gitOps.cleanCommitMessage("x".repeat(400)).length === 200)
  const shown = gitOps.commitMessagePrompt(
    Array.from({ length: 60 }, (_, i) => `f${i}.ts`),
    [Array.from({ length: 300 }, (_, i) => `+line ${i}`).join("\n")],
  )
  check("the prompt lists 50 paths and 200 diff lines", shown.includes("f49.ts") && !shown.includes("f50.ts") && shown.includes("+line 199") && !shown.includes("+line 200"))

  // ------------------------------------------ info card: transcript reading --
  {
    const root = "C:/work/proj"
    const tool = (id: string, name: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}, at = 10): any => ({
      type: "tool", id, callID: id, name, status: "completed", input, metadata, time: { created: at, completed: at },
    })
    const turn = (id: string, parts: any[], at: number): any => ({
      id, sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts, time: { created: at },
    })
    const said: any[] = [
      { id: "u1", sessionID: "s", role: "user", text: "go", attachments: [{ path: `${root}/brief.pdf`, mime: "application/pdf", data: "" }], time: { created: 1 } },
      turn("a1", [
        tool("w1", "write", { path: "report.docx" }, { created: true }, 11),
        tool("w2", "write", { path: "report.pdf" }, { created: true }, 12),
        tool("w3", "write", { path: "build.py" }, { created: true }, 13),
        tool("w4", "write", { path: "renders/page_1.png" }, { created: true }, 14),
        tool("w5", "write", { path: "README.md" }, { created: false }, 15),
        tool("e1", "edit", { path: "src/app.ts" }, {}, 16),
        tool("r1", "read", { path: "src/app.ts" }, {}, 17),
        tool("r2", "read", { path: "docs/guide.md" }, {}, 18),
        tool("r3", "read", { path: `${root}/brief.pdf` }, {}, 19),
        tool("t1", "todowrite", {}, { todos: [
          { id: "1", content: "plan", status: "completed" },
          { id: "2", content: "build", status: "in_progress" },
          { id: "3", content: "ship", status: "pending", parentId: "2" },
        ] }, 20),
      ], 10),
    ]
    const made = sessionArtifacts(said, root)
    const role = (file: string) => made.find((entry) => entry.path === file)?.role
    check("a created document is a deliverable", role("report.docx") === "deliverable", made)
    check("a PDF made beside its document is intermediate", role("report.pdf") === "intermediate", made)
    check("a created script is intermediate", role("build.py") === "intermediate", made)
    check("a page render beside a document is intermediate", role("renders/page_1.png") === "intermediate", made)
    check("an overwritten file that existed is not an artifact", role("README.md") === undefined && role("src/app.ts") === undefined, made)
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `n${i}.md`, at: i, role: "deliverable" as const, kind: "docx" as const }))
    const grouped = artifactGroups(many)
    check("ten deliverables are shown and the rest fold under More", grouped.shown.length === 10 && grouped.more.length === 2)

    const refs = sessionReferences(said, root)
    check("an attachment is an upload", refs.uploads.length === 1 && refs.uploads[0] === "brief.pdf", refs)
    check("project files leave out what was written and what was uploaded", refs.project.join() === "docs/guide.md", refs)

    const idle = infoTasks(undefined, said, false)
    check("a saved todowrite plan still reads, in MiMo's statuses", idle.map((task) => task.status).join() === "done,stalled,open", idle)
    check("a child is drawn under its parent", idle[2]?.depth === 1, idle)
    check("in progress during the turn that wrote it stays in progress", infoTasks(undefined, said, true)[1]?.status === "in_progress")
    const week = 7 * 24 * 60 * 60 * 1000
    const now = 30 * week
    const registry: TaskItem[] = [
      { id: "T1", summary: "plan", status: "done", created: 1, updated: now - 1000, ended: now - 1000 },
      { id: "T2", summary: "build", status: "in_progress", created: 1, updated: 5 },
      { id: "T2.1", summary: "ship", status: "blocked", parentID: "T2", created: 1, updated: 5 },
      { id: "T3", summary: "long gone", status: "abandoned", created: 1, updated: 1, ended: now - week - 1 },
    ]
    const drawn = infoTasks(registry, said, false, now)
    check(
      "the card draws the conversation's task registry over any saved plan, nested, with finished tasks gone after a week",
      drawn.map((task) => `${task.id}:${task.status}:${task.depth}`).join() === "T1:done:0,T2:stalled:0,T2.1:blocked:1",
      drawn,
    )

    // MiMo's list leaves abandoned work out, counts only what it lists, and indents by dotted id or parent.
    const planned = [
      turn("a2", [
        tool("t2", "todowrite", {}, { todos: [
          { id: "1", content: "plan", status: "completed" },
          { id: "1.1", content: "sketch", status: "pending" },
          { id: "2", content: "dropped", status: "cancelled" },
          { id: "3", content: "given up", status: "abandoned" },
          { id: "4", content: "orphan", status: "pending", parentId: "3" },
          { id: "1.2.1", content: "deep", status: "pending", parentId: "1" },
        ] }, 30),
      ], 29),
    ]
    const plan = infoTasks(undefined, planned, false)
    const depthOfTask = (id: string) => plan.find((task) => task.id === id)?.depth
    check("cancelled and abandoned tasks are not listed", plan.map((task) => task.id).join() === "1,1.2.1,1.1,4", plan)
    check("the task count is done over what is listed", `${plan.filter((task) => task.status === "done").length}/${plan.length}` === "1/4", plan)
    check("a task indents by the deeper of its dotted id and its parent", depthOfTask("1.2.1") === 2 && depthOfTask("1.1") === 1 && depthOfTask("1") === 0, plan)
    check("a task whose parent was abandoned stands at the top", depthOfTask("4") === 0, plan)
    const dropped: TaskItem[] = [
      { id: "T1", summary: "plan", status: "done", created: 1, updated: now - 10, ended: now - 10 },
      { id: "T2", summary: "dropped", status: "abandoned", created: 1, updated: now - 10, ended: now - 10 },
      { id: "T2.1", summary: "left over", status: "blocked", parentID: "T2", created: 1, updated: 5 },
    ]
    const kept = infoTasks(dropped, said, false, now)
    check(
      "a registry task abandoned this week is not listed or counted, and its child keeps its dotted depth",
      kept.map((task) => `${task.id}:${task.depth}`).join() === "T1:0,T2.1:1" && `${kept.filter((task) => task.status === "done").length}/${kept.length}` === "1/2",
      kept,
    )
  }

  // ------------------------------------------------- chatgpt adapter ------
  // The Codex wire format had no coverage at all: no subscription to call, so
  // nothing exercised the SSE parsing, the tool pairing or the usage figures.
  // A stand-in backend covers all of it without one.

  const SSE = [
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_text.delta", delta: "Hello" },
    { type: "response.output_text.delta", delta: " world" },
    {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
    },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          output_tokens_details: { reasoning_tokens: 30 },
          input_tokens_details: { cached_tokens: 100 },
        },
      },
    },
  ]

  let sentBody: any = {}
  let sentHeaders: Record<string, string> = {}
  const codex = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      sentBody = JSON.parse(raw || "{}")
      sentHeaders = request.headers as Record<string, string>
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      // Split one event across writes so the buffering is exercised too.
      const text = SSE.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
      response.write(text.slice(0, 40))
      response.write(text.slice(40))
      response.end()
    })
  })
  await new Promise<void>((resolve) => codex.listen(0, "127.0.0.1", resolve))
  const codexPort = (codex.address() as { port: number }).port

  const seen: TurnEvent[] = []
  const outcome = await ChatGPTSubscription.stream(
    {
      apiKey: "access-token",
      accountId: "acct_7",
      model: { provider: "chatgpt", model: "gpt-5.6-sol" },
      system: "be useful",
      history: [
        {
          id: "msg_1",
          sessionID: "ses_1",
          role: "user",
          text: "hi",
          attachments: [],
          time: { created: 1 },
        } as any,
      ],
      tools: TOOLS,
      effort: "high",
      showReasoning: true,
      signal: new AbortController().signal,
      baseURL: `http://127.0.0.1:${codexPort}`,
    },
    (event) => seen.push(event),
  )

  check("subscription auth travels as a bearer token", sentHeaders.authorization === "Bearer access-token")
  check("the client identifies itself", String(sentHeaders["user-agent"] ?? "").startsWith("mcode/"), sentHeaders["user-agent"])
  check("the workspace id is sent, without which the backend refuses", sentHeaders["chatgpt-account-id"] === "acct_7")
  check("the request uses the Responses input shape", Array.isArray(sentBody.input) && sentBody.input[0]?.type === "message")
  check("nothing is retained server-side", sentBody.store === false)

  const text = seen.filter((e) => e.type === "text.delta").map((e: any) => e.text).join("")
  check("text deltas are streamed through", text === "Hello world", text)
  check("reasoning is streamed separately", seen.some((e) => e.type === "reasoning.delta"))
  check("a tool call is reported", outcome.toolCalls.length === 1 && outcome.toolCalls[0].name === "read", outcome.toolCalls)
  check("tool arguments are parsed", outcome.toolCalls[0]?.input.path === "a.ts", outcome.toolCalls[0]?.input)
  check("a tool call ends the turn for the loop", outcome.stop === "tool_use", outcome.stop)
  check("reasoning tokens are recorded", outcome.usage.reasoning === 30, outcome.usage.reasoning)
  check("cached input is recorded", outcome.usage.cacheRead === 100, outcome.usage.cacheRead)
  check("a subscription turn costs nothing", outcome.usage.cost === 0)


  // An aborted turn leaves a tool part with no result. Sending its call without
  // a matching output is rejected by the backend, which would poison every
  // later request in that session - so the pair has to be dropped whole.
  const interrupted = [
    {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      text: "go",
      attachments: [],
      time: { created: 1 },
    },
    {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      model: { provider: "chatgpt", model: "gpt-5.6-sol" },
      agent: "build",
      time: { created: 2 },
      parts: [
        {
          type: "tool",
          id: "p1",
          callID: "call_done",
          name: "read",
          status: "completed",
          input: {},
          output: "ok",
          time: { created: 2 },
        },
        {
          type: "tool",
          id: "p2",
          callID: "call_stuck",
          name: "bash",
          status: "running",
          input: {},
          time: { created: 2 },
        },
      ],
    },
  ]

  await ChatGPTSubscription.stream(
    {
      apiKey: "k",
      model: { provider: "chatgpt", model: "gpt-5.6-sol" },
      system: "s",
      history: interrupted as any,
      tools: TOOLS,
      effort: "high",
      showReasoning: false,
      signal: new AbortController().signal,
      baseURL: `http://127.0.0.1:${codexPort}`,
    },
    () => {},
  )

  const items = sentBody.input as { type: string; call_id?: string; output?: string }[]
  const calls = items.filter((item) => item.type === "function_call").map((item) => item.call_id)
  const outputs = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id)
  check("a finished tool is replayed as a pair", calls.includes("call_done") && outputs.includes("call_done"))
  // MiMo answers a call that never finished as interrupted rather than dropping it.
  check(
    "an unfinished tool is replayed with an interrupted result",
    calls.includes("call_stuck") && items.some((item) => item.type === "function_call_output" && item.call_id === "call_stuck" && item.output === "[Tool execution was interrupted]"),
    items,
  )
  check("every replayed call has its output", calls.every((id) => outputs.includes(id!)), { calls, outputs })

  codex.close()

  // ------------------------------------------- chatgpt failures ------------
  // The same two silences as the OpenAI-compatible path: a refusal whose reason
  // was replaced with a fixed sentence, and a dropped connection reported as a
  // finished turn.
  {
    let failureBody = ""
    const broken = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.end(failureBody)
    })
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve))
    const brokenPort = (broken.address() as { port: number }).port

    const askCodex = () =>
      ChatGPTSubscription.stream(
        {
          apiKey: "access-token",
          accountId: "acct_7",
          model: { provider: "chatgpt", model: "gpt-5.6-sol" },
          system: "",
          history: [],
          tools: [],
          effort: "medium",
          showReasoning: true,
          signal: new AbortController().signal,
          baseURL: `http://127.0.0.1:${brokenPort}`,
        },
        () => {},
      ).then(
        (result) => `finished: ${result.stop}`,
        (failure: Error) => failure.message,
      )

    failureBody = `data: ${JSON.stringify({
      type: "response.failed",
      response: { error: { message: "Your ChatGPT plan does not include this model." } },
    })}\n\n`
    const refused = await askCodex()
    check(
      "a failed response says what the provider said",
      refused.includes("plan does not include this model"),
      refused,
    )

    failureBody = ""
    const cut = await askCodex()
    check("a dropped connection is not a finished turn", !cut.startsWith("finished:"), cut)

    broken.close()
  }

  // ------------------------------------------------------------ workspace --
  // The hero used to state "main branch" unconditionally, for directories that
  // were not repositories and for ones that had been deleted.

  const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-ws-"))
  const repo = path.join(wsRoot, "repo")
  const plain = path.join(wsRoot, "plain")
  await fs.mkdir(repo)
  await fs.mkdir(plain)
  await fs.mkdir(path.join(repo, ".git"))
  await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n")

  const repoInfo = await workspaceInfo(repo)
  check("a repository reports its actual branch", repoInfo.branch === "feature/x", repoInfo.branch)

  const plainInfo = await workspaceInfo(plain)
  check("a plain directory claims no branch", plainInfo.exists && plainInfo.branch === undefined, plainInfo)

  const goneInfo = await workspaceInfo(path.join(wsRoot, "absent"))
  check("a missing directory is reported missing", !goneInfo.exists && !goneInfo.modified, goneInfo)

  await fs.writeFile(path.join(repo, ".git", "HEAD"), "9f1c2ab3d4e5f60718293a4b5c6d7e8f90123456\n")
  const detached = await workspaceInfo(repo)
  check("a detached HEAD shows a short sha", detached.branch === "9f1c2ab", detached.branch)

  await fs.rm(wsRoot, { recursive: true, force: true })

  // ---------------------------------------------------------------- oauth --
  // The token exchange itself needs a real login, but everything leading up to
  // it - the challenge, the loopback listener, the state check - does not.

  const pending = begin(CHATGPT)
  const authorize = new URL(pending.url)
  check(
    "authorize URL targets the vendor endpoint",
    authorize.origin + authorize.pathname === "https://auth.openai.com/oauth/authorize",
    authorize.href,
  )
  check(
    "PKCE challenge is S256 and derived from the verifier",
    authorize.searchParams.get("code_challenge_method") === "S256" &&
      createHash("sha256").update(pending.verifier).digest("base64url") ===
        authorize.searchParams.get("code_challenge"),
  )
  check(
    "authorize URL carries the public client and loopback redirect",
    authorize.searchParams.get("client_id") === CHATGPT.clientId &&
      authorize.searchParams.get("redirect_uri") === `http://localhost:${CHATGPT.port}/auth/callback`,
  )
  check(
    "each login gets a fresh verifier and state",
    begin(CHATGPT).verifier !== pending.verifier && begin(CHATGPT).state !== pending.state,
  )

  // Abandoning an attempt must settle it. While close() left listen() pending,
  // its timeout fired minutes later and cancelled whatever had replaced it.
  const abandoned = new CallbackServer()
  const abandonedOutcome = abandoned.listen(begin(CHATGPT), 10_000).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  abandoned.close()
  check(
    "closing an attempt settles it instead of leaving it armed",
    (await abandonedOutcome) === "auth.cancelled",
    await abandonedOutcome,
  )

  const listener = new CallbackServer()
  const awaited = listener.listen(pending, 10_000)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await fetch(`${pending.redirectURI}?code=test-code&state=${encodeURIComponent(pending.state)}`, {
    headers: { connection: "close" },
  })
  check("loopback callback yields the code", (await awaited) === "test-code")

  const guarded = new CallbackServer()
  const forgedOutcome = guarded.listen(begin(CHATGPT), 10_000).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  await fetch(`http://localhost:${CHATGPT.port}/auth/callback?code=x&state=forged`, {
    headers: { connection: "close" },
  })
  const forgedResult = await forgedOutcome
  check("a forged state is refused", forgedResult === "auth.state", forgedResult)

  // The device flow, against a stand-in for the vendor. Worth faking: the whole
  // point of it is the polling, which no amount of URL inspection would cover.
  let polls = 0
  let exchanged: Record<string, string> = {}
  const vendor = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(body))
    }

    if (url.pathname === "/usercode") {
      json(200, { user_code: "1F3B-PY78V", device_auth_id: "dev_1", interval: 0 })
      return
    }
    if (url.pathname === "/devicetoken") {
      polls += 1
      // 403 is how the endpoint says "not approved yet"; it must not end the loop.
      if (polls < 3) {
        json(403, { error: "authorization_pending" })
        return
      }
      json(200, { authorization_code: "granted", code_verifier: "verifier-from-server" })
      return
    }
    if (url.pathname === "/deadcode") {
      // Anything that is not 403/404 is terminal - an expired or revoked code.
      json(400, { error: "expired_token" })
      return
    }
    if (url.pathname === "/token") {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        exchanged = Object.fromEntries(new URLSearchParams(body))
        json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 })
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve))
  const vendorPort = (vendor.address() as { port: number }).port
  const origin = `http://127.0.0.1:${vendorPort}`

  const fake: OAuthProvider = {
    ...CHATGPT,
    tokenURL: `${origin}/token`,
    device: {
      startURL: `${origin}/usercode`,
      pollURL: `${origin}/devicetoken`,
      verificationURL: "https://auth.openai.com/codex/device",
      redirectURI: "https://auth.openai.com/deviceauth/callback",
    },
  }

  const device = await beginDevice(fake)
  check("device start returns the code the user types", device.userCode === "1F3B-PY78V", device.userCode)
  check("device start keeps the verification page", device.verificationURL.endsWith("/codex/device"))

  const deviceTokens = await pollDevice(device, new AbortController().signal)
  check("polling waits for approval instead of giving up", polls === 3, polls)
  check("device flow ends with an access token", deviceTokens.access === "at", deviceTokens.access)
  check(
    "device exchange uses the verifier the server issued",
    exchanged.code_verifier === "verifier-from-server" && exchanged.code === "granted",
    exchanged,
  )

  // The Codex backend answers with models[]/slug, not the OpenAI data[]/id.
  const catalogServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", context_window: 272000 },
          { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", context_window: 272000 },
          { missing: "no slug" },
        ],
      }),
    )
  })
  await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve))
  const catalogPort = (catalogServer.address() as { port: number }).port
  const discovered = await discoverSubscriptionModels(`http://127.0.0.1:${catalogPort}`, "tok", "acct")
  check("subscription models come from the backend, not a baked-in list", discovered.length === 2, discovered.length)
  check(
    "slug and display name are mapped through",
    discovered[0].id === "gpt-5.6-sol" && discovered[0].name === "GPT-5.6-Sol" && discovered[0].contextWindow === 272000,
    discovered[0],
  )
  check("a subscription reports no per-token cost", discovered.every((m) => m.input === 0 && m.output === 0))
  catalogServer.close()

  const expired: OAuthProvider = { ...fake, device: { ...fake.device, pollURL: `${origin}/deadcode` } }
  const expiredOutcome = await pollDevice(await beginDevice(expired), new AbortController().signal).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  check(
    "an expired device code fails instead of polling forever",
    expiredOutcome === "auth.device:400",
    expiredOutcome,
  )

  const abort = new AbortController()
  abort.abort()
  const cancelled = await pollDevice(await beginDevice(fake), abort.signal).then(
    () => "resolved",
    (error: Error) => error.message,
  )
  check("cancelling stops the poll", cancelled === "auth.cancelled", cancelled)
  vendor.close()

  const idToken = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_42" } })).toString(
      "base64url",
    ),
    "sig",
  ].join(".")
  const claims = decodeClaims(idToken)
  check("account id is read from the nested id_token claim", claims && accountId(claims) === "acct_42")

  // ---------------------------------------------------------------- artifacts page and export
  section("Artifacts page and conversation export (round 3 AR)")
  {
    const MIN = 60_000
    const base = new Date(2026, 8, 15, 12, 0, 0).getTime()
    check("under a minute is just now", artifactAge(base - 59_000, base).unit === "just")
    check("minutes are floored", JSON.stringify(artifactAge(base - 5 * MIN - 59_000, base)) === '{"unit":"m","n":5}')
    check("hours below a day", JSON.stringify(artifactAge(base - 23 * 60 * MIN, base)) === '{"unit":"h","n":23}')
    check("days below a week", JSON.stringify(artifactAge(base - 6 * 1440 * MIN, base)) === '{"unit":"d","n":6}')
    const old = artifactAge(new Date(2026, 0, 5, 9).getTime(), base)
    check("a week or more is an unpadded Y/M/D", old.unit === "date" && `${old.y}/${old.mo}/${old.day}` === "2026/1/5", old)
    check("a clock behind the file still reads just now", artifactAge(base + 5000, base).unit === "just")

    check("kind colours are MiMo's", badgeOf("a/b.docx").fg === "#2b6cb0" && badgeOf("s.pptx").fg === "#c43e1c" && badgeOf("t.xlsx").fg === "#21a366" && badgeOf("r.pdf").fg === "#d93831")
    check("text, web, image and file kinds", badgeOf("n.md").kind === "txt" && badgeOf("p.html").fg === "#2f6fed" && badgeOf("i.png").fg === "#0e9488" && badgeOf("x.bin").fg === "#8c8c86")
    check("legacy Office names share the new kinds", badgeOf("old.doc").kind === "docx" && badgeOf("old.xls").kind === "xlsx" && badgeOf("old.ppt").kind === "pptx")
    check("tabs bucket documents, pages and the rest", artifactCategory("a.csv") === "doc" && artifactCategory("b.htm") === "app" && artifactCategory("c.png") === "other")
    check("the page size is MiMo's 50", ARTIFACT_PAGE === 50)
    check("relative artifact paths join the project", artifactAbsolute("D:\\p\\", "out/a.md") === "D:\\p/out/a.md" && artifactAbsolute("/p", "/tmp/a.md") === "/tmp/a.md")

    const labels = { untitled: "未命名对话", user: "**我：**", assistant: "**MCode:**", done: "(已完成)" }
    const at = { created: 1 }
    const said = [
      { id: "u1", sessionID: "s", role: "user" as const, text: "写一份报告", attachments: [], time: at },
      {
        id: "a1", sessionID: "s", role: "assistant" as const, model: { provider: "p", id: "m" }, agent: "build" as const,
        parts: [
          { type: "reasoning" as const, id: "r", text: "thinking", time: at },
          { type: "text" as const, id: "t1", text: "好的。" },
          { type: "text" as const, id: "t2", text: "已完成报告。" },
        ],
        finish: "end_turn" as const, time: at,
      },
      { id: "a2", sessionID: "s", role: "assistant" as const, model: { provider: "p", id: "m" }, agent: "build" as const, parts: [], finish: "end_turn" as const, time: at },
      { id: "a3", sessionID: "s", role: "assistant" as const, model: { provider: "p", id: "m" }, agent: "build" as const, parts: [], finish: "aborted" as const, time: at },
    ] as unknown as Parameters<typeof conversationMarkdown>[1]
    const md = conversationMarkdown("季度报告", said, labels)
    check(
      "Markdown is the title, then one prefixed paragraph per message",
      md === "# 季度报告\n\n**我：** 写一份报告\n\n**MCode:** 好的。\n\n已完成报告。\n\n**MCode:** (已完成)",
      md,
    )
    check("an untitled conversation gets MiMo's heading", conversationMarkdown("  ", [], labels) === "# 未命名对话\n\n")
    const long = "a".repeat(90)
    check("the file name keeps its length", exportFileName(long) === `${long}.md`)
    check("reserved characters become hyphens and the name is trimmed", exportFileName(' a/b:c*d?"e<f>g|h ') === "a-b-c-d--e-f-g-h.md")
    check("an empty name falls back to conversation", exportFileName("  ") === "conversation.md")
  }

  // ---------------------------------------------------------------- tooltips
  section("Tooltips (MiMo's Radix values)")
  check("tip constants are MiMo's", TIP_GAP === 6 && TIP_EDGE === 8 && TIP_DELAY === 200 && TIP_WARM === 300, [
    TIP_GAP,
    TIP_EDGE,
    TIP_DELAY,
    TIP_WARM,
  ])
  check("a first tip waits the full delay", openDelay(10_000, 0) === 200)
  check("a tip inside the warm window opens at once", openDelay(10_000, 10_000 - 299) === 0)
  check("the warm window ends at 300ms", openDelay(10_000, 10_000 - 300) === 200)
  check("a shortcut follows the label after one space", tipText({ label: "返回", hint: "Ctrl+[" }) === "返回 Ctrl+[")
  check("a tip with no shortcut is only its label", tipText({ label: "更多" }) === "更多")

  const tipBox = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  })
  const tipView = { width: 1000, height: 800 }
  const tipSelf = { width: 60, height: 26 }
  const centred = fitTip(tipBox(400, 400, 28, 28), tipSelf, "top", tipView)
  check(
    "top is centred on the control, 6 above it",
    centred.side === "top" && centred.left === 400 + (28 - 60) / 2 && centred.top === 400 - 26 - 6,
    centred,
  )
  const flipped = fitTip(tipBox(400, 10, 28, 28), tipSelf, "top", tipView)
  check("no room above flips below", flipped.side === "bottom" && flipped.top === 10 + 28 + 6, flipped)
  const shifted = fitTip(tipBox(2, 400, 20, 20), tipSelf, "top", tipView)
  check("the cross axis is shifted inside the 8px padding", shifted.side === "top" && shifted.left === 8, shifted)
  const right = fitTip(tipBox(975, 400, 20, 20), tipSelf, "right", tipView)
  check("no room to the right flips left", right.side === "left" && right.left === 975 - 60 - 6, right)
  const cramped = fitTip(tipBox(400, 30, 28, 740), { width: 60, height: 40 }, "top", tipView)
  check("with room on neither side, the side overflowing less wins", cramped.side === "top", cramped)
  const limited = fitTip(tipBox(-50, 400, 20, 20), tipSelf, "top", tipView)
  check("the shift never detaches the tip from its control", limited.left === -30, limited)

  section("round 3 settings: shortcuts page, chords and relative time")
  const keyEvent = (init: Partial<KeyboardEvent>) =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, key: "", code: "", ...init }) as KeyboardEvent
  check(
    "a shifted bracket records by its physical key",
    chordOf(keyEvent({ ctrlKey: true, shiftKey: true, key: "{", code: "BracketLeft" })) === "Ctrl+Shift+[",
  )
  check("Ctrl+Shift+/ records as the slash", chordOf(keyEvent({ ctrlKey: true, shiftKey: true, key: "?", code: "Slash" })) === "Ctrl+Shift+/")
  check("a composing key records nothing", chordOf(keyEvent({ ctrlKey: true, isComposing: true, key: "a", code: "KeyA" })) === "")
  check("a bare modifier records nothing", chordOf(keyEvent({ ctrlKey: true, key: "Control", code: "ControlLeft" })) === "")
  check("Shift plus a key is bindable, as in MiMo", isBindable("Shift+A"))
  check("a bare F-key is not bindable", !isBindable("F5"))
  check("a bare letter is not bindable", !isBindable("A"))
  check("Windows writes Tab as its glyph", formatChord("Ctrl+Shift+Tab", "win32") === "Ctrl+Shift+⇥")
  check("Linux writes Meta as Super", formatChord("Meta+Alt+K", "linux") === "Alt+Super+K")
  check("macOS writes glyphs with Ctrl as the command key", formatChord("Ctrl+Shift+[", "darwin") === "⇧⌘[")

  section("round 4 leftovers: stored chords in the old printed form (KS6)")
  check("an old shifted bracket goes back to its physical key", normalizeChord("Ctrl+Shift+{") === "Ctrl+Shift+[")
  check(
    "a shifted slash and a shifted digit follow",
    normalizeChord("Ctrl+Shift+?") === "Ctrl+Shift+/" && normalizeChord("Alt+Shift+!") === "Alt+Shift+1",
  )
  check("the plus key itself is the equals key", normalizeChord("Ctrl+Shift++") === "Ctrl+Shift+=")
  check(
    "a chord already in the physical spelling is left alone",
    normalizeChord("Ctrl+Shift+[") === "Ctrl+Shift+[" && normalizeChord("Ctrl+Alt+↑") === "Ctrl+Alt+↑" && normalizeChord("Ctrl+=") === "Ctrl+=",
  )
  check("a deleted binding stays empty", normalizeChord("") === "")
  check(
    "an old chord now equals what the recorder writes for the same keys",
    normalizeChord("Ctrl+Shift+{") === chordOf(keyEvent({ ctrlKey: true, shiftKey: true, key: "{", code: "BracketLeft" })),
  )
  {
    const chordData = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-chords-"))
    const chordStorage = new SubagentStorage(path.join(chordData, "storage"))
    await chordStorage.write("config", {
      keybinds: { "view.server": "Ctrl+Shift+{", "tab.close": "", "app.search": "Ctrl+Shift+?", "session.new": "Ctrl+K" },
      migrations: ["theme-mcode-2", "keybind-ids-r3"],
    })
    const chordConfig = new SubagentConfig(chordStorage, new Bus(), path.join(chordData, "credentials.json"))
    await chordConfig.load()
    const binds = chordConfig.get().keybinds
    check(
      "loading the config rewrites old printed chords",
      binds["view.server"] === "Ctrl+Shift+[" && binds["app.search"] === "Ctrl+Shift+/" && binds["session.new"] === "Ctrl+K" && binds["tab.close"] === "",
      binds,
    )
    const stored = await chordStorage.read<{ keybinds: Record<string, string>; migrations: string[] }>("config")
    check(
      "the rewrite is saved and recorded, so it runs once",
      stored?.keybinds["view.server"] === "Ctrl+Shift+[" && (stored?.migrations ?? []).includes("keybind-chords-r4"),
      stored,
    )
    await chordConfig.set({ keybinds: { "view.server": "Ctrl+Shift+{" } })
    const again = new SubagentConfig(chordStorage, new Bus(), path.join(chordData, "credentials.json"))
    await again.load()
    check("a chord saved after the migration is not rewritten again on the next load", again.get().keybinds["view.server"] === "Ctrl+Shift+{")
    await fs.rm(chordData, { recursive: true, force: true })
  }

  section("round 5: chords MiMo lacks are gone, saved bindings keep working (R26)")
  {
    const retired = retireKeybinds({
      "agent.cycle": "Ctrl+Shift+Y",
      "app.attachFile": "Ctrl+U",
      "session.prevUnread": "Alt+Shift+↑",
      "app.mcp": "",
      "project.3": "Ctrl+Alt+Q",
      "session.new": "Ctrl+Alt+N",
      "app.back": "",
    })
    check(
      "a chord of the user's own on a command that lost its default stays",
      retired["agent.cycle"] === "Ctrl+Shift+Y",
      retired,
    )
    check(
      "a binding that restated or cleared a dropped default goes",
      !("app.attachFile" in retired) && !("session.prevUnread" in retired) && !("app.mcp" in retired),
      retired,
    )
    check("the numbered project slots go with their bindings", !("project.3" in retired), retired)
    check("bindings of MiMo's own commands are untouched", retired["session.new"] === "Ctrl+Alt+N" && retired["app.back"] === "", retired)
    const appSource = await fs.readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8")
    const stillDefault = Object.entries(RETIRED_DEFAULTS).filter(([, chord]) => appSource.includes(`hint: "${chord}"`))
    check("no command in App.vue still carries a dropped default", stillDefault.length === 0, stillDefault)
    check("nor the numbered project slots", !appSource.includes("id: `project.${"))

    const retireData = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-retire-"))
    const retireStorage = new SubagentStorage(path.join(retireData, "storage"))
    await retireStorage.write("config", {
      keybinds: { "agent.cycle": "Ctrl+Shift+Y", "workspace.new": "Ctrl+Shift+W" },
      migrations: ["theme-mcode-2", "keybind-ids-r3", "keybind-chords-r4"],
    })
    const retireConfig = new SubagentConfig(retireStorage, new Bus(), path.join(retireData, "credentials.json"))
    await retireConfig.load()
    const loaded = retireConfig.get().keybinds
    check("loading the config applies it once", loaded["agent.cycle"] === "Ctrl+Shift+Y" && !("workspace.new" in loaded), loaded)
    await fs.rm(retireData, { recursive: true, force: true })
  }
  const pageCommands = [
    { id: "session.archive", title: "Archive this session", hint: "Ctrl+Alt+A" },
    { id: "tab.close", title: "Close tab", hint: "Ctrl+W" },
    { id: "session.new", title: "New session", hint: "Ctrl+N" },
    { id: "tab.goto.3", title: "Go to tab 3", hint: "Ctrl+3" },
    { id: "theme.dark", title: "Theme: Dark" },
  ]
  const shownRows = pageRows(pageCommands, (key, params) => (params ? `${key}:${params.n}` : key))
  check(
    "the page follows MiMo's order and leaves off commands MiMo's list lacks",
    shownRows.map((row) => row.id).join(",") === "session.archive,session.new,tab.close,tab.goto.3",
    shownRows,
  )
  check("a MiMo row takes MiMo's label and description", shownRows[0].title === "key.label.conv-archive" && shownRows[0].desc === "key.desc.conv-archive")
  check("new task carries no description that would be untrue", shownRows[1].desc === "")
  check("a stand-in command keeps its own title and no description", shownRows[2].title === "Close tab" && shownRows[2].desc === "")
  check("go to chat carries its number", shownRows[3].title === "key.label.goto-chat:3")
  check("no page row is left without a command list", PAGE_ROWS.every((row) => row.commands.length > 0))
  check("just now under a minute", ago(Date.now() - 59_000) === t("time.justNow"))
  check("minutes are floored", ago(Date.now() - 119_000) === t("time.minutesAgo", { n: 1 }))
  check("days up to 29", ago(Date.now() - 29 * 86_400_000 - 1000) === t("time.daysAgo", { n: 29 }))
  check("30 days on is a date, not a relative phrase", !/ago|前/.test(ago(Date.now() - 30 * 86_400_000 - 1000)))

  section("round 3 settings: MCP secrets and the model form")
  const storedMcp = { type: "local" as const, command: ["node"], environment: { TOKEN: "old", KEEP: "k" }, headers: { A: "1" } }
  const mergedMcp = mergeMcpSecrets(
    storedMcp,
    { type: "local", command: ["node"], environment: { TOKEN: "", KEEP: "", NEW: "n" } },
    { env: ["TOKEN", "KEEP"] },
  )
  check(
    "a blank saved env row keeps the stored value; a new row is written",
    JSON.stringify(mergedMcp.environment) === JSON.stringify({ TOKEN: "old", KEEP: "k", NEW: "n" }),
    mergedMcp,
  )
  const clearedMcp = mergeMcpSecrets(storedMcp, { type: "local", command: ["node"], environment: { TOKEN: "" } })
  check("a blank row not marked kept is written blank", clearedMcp.environment?.TOKEN === "", clearedMcp)
  const droppedMcp = mergeMcpSecrets(storedMcp, { type: "remote", url: "https://x", headers: { B: "" } }, { headers: ["B"] })
  check("a kept header with nothing stored is dropped", droppedMcp.headers === undefined, droppedMcp)
  check("limits take digits only", limitOf("32768").value === 32768 && !limitOf("32K").ok && limitOf("").ok)
  check("the 128K pill writes 131072 tokens", LIMIT_PRESETS.context.find((entry) => entry.label === "128K")?.value === 131072)
  check("an endpoint needs http(s) and a host", validEndpoint("https://api.example.com/v1") && !validEndpoint("ftp://x") && !validEndpoint("http://"))

  // ---------------------------------------------------------------- image preview
  section("Image preview (MiMo's keys and file tools)")
  check("C and F do nothing for a picture without a file", imagePreviewKey("c", false) === undefined && imagePreviewKey("F", false) === undefined)
  check("C copies and F reveals a picture with a file", imagePreviewKey("c", true) === "copy" && imagePreviewKey("C", true) === "copy" && imagePreviewKey("f", true) === "reveal" && imagePreviewKey("F", true) === "reveal")
  check(
    "the older keys keep their actions",
    imagePreviewKey("Escape", false) === "close" && imagePreviewKey("=", false) === "zoomIn" && imagePreviewKey("_", false) === "zoomOut" &&
      imagePreviewKey("0", false) === "reset" && imagePreviewKey("R", false) === "rotate" && imagePreviewKey("d", false) === "download" &&
      imagePreviewKey("ArrowLeft", false) === "previous" && imagePreviewKey("ArrowRight", false) === "next" && imagePreviewKey("x", true) === undefined,
  )
  check("copy and reveal follow download only with a path", imagePreviewFileTools(true).join() === "download,copy,reveal" && imagePreviewFileTools(false).join() === "download")
  openImagePreview("data:image/png;base64,AA==", { name: "a.png", path: "/tmp/a.png" })
  check("the path travels with the opened picture", imagePreview.value?.path === "/tmp/a.png" && imagePreview.value?.name === "a.png")
  openImagePreview("data:image/png;base64,AA==", { name: "b.png" })
  check("a picture opened without a path has none", imagePreview.value?.path === undefined)
  imagePreview.value = undefined
  // ---------------------------------------------------------------- terminal
  section("Terminal (MiMo's bottom panel and terminal tab)")
  check("the first tab is the bare title", nextTerminalNumber([]) === 0)
  check("a bare title counts as 1, so the next is 2", nextTerminalNumber([0]) === 2)
  check("closing the bare tab frees 1 for the next", nextTerminalNumber([2]) === 1)
  check("the lowest free number is taken", nextTerminalNumber([0, 3]) === 2 && nextTerminalNumber([0, 2]) === 3)
  const restored: number[] = []
  for (let i = 0; i < 3; i += 1) restored.push(nextTerminalNumber(restored))
  check("restored shells are numbered in order", restored.join(",") === "0,2,3", restored)
  check("labels read as MiMo's", terminalLabel(0, "终端") === "终端" && terminalLabel(2, "终端") === "终端 2")

  check("height clamps to 120..640", clampPanelHeight(50) === 120 && clampPanelHeight(900) === 640 && clampPanelHeight(300.4) === 300)
  check("no stored height is 240", storedPanelHeight(null) === 240 && storedPanelHeight("abc") === 240)
  check("a stored height is clamped", storedPanelHeight("1000") === 640 && storedPanelHeight("200") === 200)

  const light = terminalPalette("#ffffff")
  check(
    "light terminal colours are MiMo's",
    light.foreground === "#1f1f1f" && light.cursor === "#1f1f1f" && light.selectionBackground === "#d6e4ff" &&
      light.yellow === "#7a6100" && light.white === "#5f6368" && light.brightWhite === "#202124" && light.background === "#ffffff",
    light,
  )
  const dark = terminalPalette("#161616")
  check(
    "dark terminal colours are MiMo's over xterm's defaults",
    dark.foreground === "#ececec" && dark.selectionBackground === "#33415b" && dark.red === "#cc0000" &&
      dark.brightWhite === "#eeeeec" && dark.black === "#2e3436" && dark.background === "#161616",
    dark,
  )

  check("the same folder, spelled differently, is no mismatch", !shouldRespawn("D:\\a\\b", "d:/a/b/", false) && !showMismatch("D:\\a\\b", "d:/a/b/", true))
  check("an unused terminal elsewhere is started again", shouldRespawn("/a", "/b", false) && !showMismatch("/a", "/b", false))
  check("a used terminal elsewhere shows the notice instead", !shouldRespawn("/a", "/b", true) && showMismatch("/a", "/b", true))
  check("no folder yet means nothing to decide", !shouldRespawn(undefined, "/b", false) && !showMismatch("/a", undefined, true))

  const key = (over: Partial<Parameters<typeof isPasteKey>[0]>) => ({
    type: "keydown",
    key: "v",
    code: "KeyV",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  })
  check("Ctrl+V pastes", isPasteKey(key({ ctrlKey: true }), false))
  check("Ctrl+Shift+V and Ctrl+Alt+V are not the plain paste", !isPasteKey(key({ ctrlKey: true, shiftKey: true }), false) && !isPasteKey(key({ ctrlKey: true, altKey: true }), false))
  check("Ctrl+C and a key-up reach the shell", !isPasteKey(key({ ctrlKey: true, key: "c", code: "KeyC" }), false) && !isPasteKey(key({ ctrlKey: true, type: "keyup" }), false))
  check("a Mac pastes on Cmd+V, not Ctrl+V", isPasteKey(key({ metaKey: true }), true) && !isPasteKey(key({ ctrlKey: true }), true))

  check("typing counts as use", typedInput("ls\r") && typedInput("\x1b[A"))
  check(
    "focus, device-attribute and cursor reports do not",
    !typedInput("") && !typedInput("\x1b[I") && !typedInput("\x1b[O\x1b[I") && !typedInput("\x1b[?1;2c") && !typedInput("\x1b[12;40R"),
  )

  {
    // A real shell: "used" is held by the backend, survives the exit, and reaches both list and attach.
    // Its own folder: the shared project root is removed by the time this runs.
    const termDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-term-"))
    const termBus = new Bus()
    const printed: string[] = []
    termBus.subscribe((event) => {
      if (event.type === "shell.data") printed.push(event.data)
    })
    const shells = new Shells(termBus)
    const shellID = shells.open("ses_smoke_terminal", termDir, undefined, { cols: 80, rows: 24 })
    shells.write(shellID, "\x1b[I")
    const untouched = shells.list("ses_smoke_terminal")[0]
    await new Promise((resolve) => setTimeout(resolve, 50))
    check("a shell only focused is not used", untouched?.shellID === shellID && untouched.used === false, untouched ?? printed.join(""))
    shells.write(shellID, "exit\r")
    check("a shell typed into is used", shells.list("ses_smoke_terminal")[0]?.used === true && shells.attach(shellID)?.used === true)
    for (let i = 0; i < 40 && shells.attach(shellID)?.alive; i += 1) await new Promise((resolve) => setTimeout(resolve, 250))
    const ended = shells.attach(shellID)
    check("used survives the shell's exit", ended?.alive === false && ended.used === true, ended)
    await shells.closeAll()
    check("a closed shell is gone from the list", shells.list("ses_smoke_terminal").length === 0)
    await fs.rm(termDir, { recursive: true, force: true }).catch(() => undefined)
  }
  // ------------------------------------------------------- files and diff tabs
  section("Files tab and diff tab logic (MiMo's tables, MCode's renderer)")
  check(
    "extensions take MiMo's colour groups",
    fileCategory("a.ts") === "code" && fileCategory("x.HTML") === "web" && fileCategory(".env") === "data" &&
      fileCategory("a.tar.gz") === "archive" && fileCategory("Makefile") === "default" && fileCategory("a.constructor") === "default",
  )
  const treeListing = {
    "": [
      { name: "src", type: "dir" as const },
      { name: "a.md", type: "file" as const },
    ],
    src: [{ name: "b.ts", type: "file" as const }],
  }
  const closedRows = treeRows(treeListing, new Set())
  const openRows = treeRows(treeListing, new Set(["src"]))
  check("a closed folder hides its children", closedRows.map((row) => row.path).join(",") === "src,a.md", closedRows)
  check("an open folder lists them a level in", openRows.map((row) => `${row.path}@${row.depth}`).join(",") === "src@0,src/b.ts@1,a.md@0", openRows)
  check("MiMo's indent: 10, 14 a level, a file 16 further", rowIndent({ depth: 0, directory: true }) === 10 && rowIndent({ depth: 1, directory: false }) === 40)
  check(
    "the crumb names the project and then the file's parts; no root reads /",
    crumbsFor("D:/p", "Proj", "src/b.ts").join("|") === "Proj|src|b.ts" && crumbsFor(undefined, "").join("|") === "/",
  )
  check(
    "a save's refusal becomes MiMo's words",
    saveFailureKey("toobig") === "rp.files.errTooBig" && saveFailureKey("Error: binary") === "rp.files.errBinary" &&
      saveFailureKey("ENOENT: no such file") === "rp.files.errNoEnt" && saveFailureKey("EACCES") === "rp.files.errCannotWrite",
  )
  check(
    "a tool's path compares project-relative",
    relativeTo("D:\\proj", "D:\\Proj\\src\\b.ts") === "src/b.ts" && relativeTo("/home/p", "/home/p/x.ts") === "x.ts" && relativeTo("/home/p", "./y.ts") === "y.ts",
  )
  const toolStep = (name: string, status: string, input: Record<string, unknown>, diff?: string) => ({
    type: "tool",
    id: `${name}-${status}`,
    callID: name,
    name,
    status,
    input,
    metadata: diff ? { diff } : {},
    time: { created: 0 },
  })
  const editTurns = [
    { role: "user", id: "u", sessionID: "s", text: "", attachments: [], time: { created: 0 } },
    {
      role: "assistant",
      id: "a",
      sessionID: "s",
      parts: [
        toolStep("edit", "completed", { path: "src/b.ts" }),
        toolStep("write", "running", { path: "src/b.ts" }),
        toolStep("patch", "completed", {}, "--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-x\n+y\n"),
        toolStep("read", "completed", { path: "src/b.ts" }),
      ],
    },
    { role: "assistant", id: "b", sessionID: "s", reverted: true, parts: [] },
  ] as unknown as Message[]
  const tally = editCounts(editTurns, "D:/proj", "src/b.ts")
  check("finished edits are counted, and those on the open file", tally.total === 2 && tally.onFile === 1 && tally.reverted === 1, tally)
  check("a patch's recorded diff names its file", editCounts(editTurns, "D:/proj", "a.md").onFile === 1)

  const longPatch = Array.from({ length: 1300 }, (_, index) => `+line ${index}`).join("\n")
  const cappedPatch = capDiff(longPatch)
  check(
    "a patch past 1200 lines keeps its start and counts the rest",
    cappedPatch.truncated && cappedPatch.text.split("\n").length === 1200 && cappedPatch.omitted === 100,
    { omitted: cappedPatch.omitted },
  )
  check("a short patch is left whole", !capDiff("+a\n-b").truncated)
  check("the layout remembers only split or unified", normalizeLayout("split") === "split" && normalizeLayout("nonsense") === "unified" && normalizeLayout(null) === "unified")
  const twoFiles = parseDiffFiles(
    [
      "diff --git a/src/one.ts b/src/one.ts",
      "index 1111111..2222222 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "--- looks like a header",
      "+new",
      "++ also added",
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "",
    ].join("\n"),
  )
  check(
    "a patch splits per file, a removed '---' line kept inside its hunk",
    twoFiles.length === 2 && twoFiles[0]?.name === "src/one.ts" && twoFiles[0]?.added === 2 && twoFiles[0]?.deleted === 2,
    twoFiles.map((file) => [file.name, file.added, file.deleted]),
  )
  check("a new file is marked added with its own counts", twoFiles[1]?.status === "added" && twoFiles[1]?.name === "added.txt" && twoFiles[1]?.added === 2)
  const firstHunk = twoFiles[0]?.hunks[0]?.lines ?? []
  check("lines carry both numbers", firstHunk[0]?.old === 1 && firstHunk[0]?.new === 1 && firstHunk[3]?.new === 2, firstHunk)
  check("a bare edit-tool patch is one file", parseDiffFiles("--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n").length === 1)
  const boxRows = reviewRows("--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.md b/y.md\nindex 1..2 100644\n--- a/y.md\n+++ b/y.md\n@@ -3 +3 @@\n-c\n+d\n")
  check(
    "the review box draws a second file's headers as neither removed nor added rows",
    boxRows.map((row) => row.kind).join(",") === "hunk,del,add,hunk,del,add" &&
      boxRows.every((row) => !row.text.startsWith("-- a/") && !row.text.startsWith("++ b/") && !row.text.startsWith("iff --git")) &&
      boxRows[4]?.old === 3 && boxRows[5]?.new === 3,
    boxRows,
  )
  const sidePairs = splitRows(firstHunk)
  check(
    "side by side pairs removals with the additions after them",
    sidePairs.length === 3 && sidePairs[1]?.left?.text === "old" && sidePairs[1]?.right?.text === "new" &&
      sidePairs[2]?.left?.text === "-- looks like a header" && sidePairs[2]?.right?.text === "+ also added",
    sidePairs,
  )
  check("a path splits into its folder and its name", splitPath("a/b/c.ts").dir === "a/b/" && splitPath("c.ts").dir === "" && splitPath("c.ts").base === "c.ts")

  // ---------------------------------------------------------------- voice bubble and media
  section("Voice bubble and preview zoom (MiMo's numbers)")
  check("the voice bubble is 198 wide until its length is known", audioBubbleWidth(0) === 198 && audioBubbleWidth(Number.NaN) === 198)
  check("the voice bubble grows 3.2px a second between 178 and 590", audioBubbleWidth(1) === 181 && audioBubbleWidth(10) === 210 && audioBubbleWidth(1000) === 590, [
    audioBubbleWidth(1),
    audioBubbleWidth(10),
    audioBubbleWidth(1000),
  ])
  check("a clip's length reads m:ss, then h:mm:ss", audioClock(0) === "0:00" && audioClock(65.9) === "1:05" && audioClock(3725) === "1:02:05", [
    audioClock(65.9),
    audioClock(3725),
  ])
  const previewTo = { left: 200, top: 100, width: 400, height: 200 }
  check(
    "the preview zooms out of the thumbnail's centre at its width ratio",
    originTransform({ left: 0, top: 0, width: 100, height: 50 }, previewTo) === "translate(-350.0px, -175.0px) scale(0.2500)",
    originTransform({ left: 0, top: 0, width: 100, height: 50 }, previewTo),
  )
  check(
    "without a thumbnail the preview scales from 94%",
    originTransform(undefined, previewTo) === "scale(0.94)" && originTransform({ left: 5, top: 5, width: 0, height: 0 }, previewTo) === "scale(0.94)",
  )
  section("Desktop chrome (MiMo's main-process rules)")
  check("the minimum window is 720 by 640", WINDOW_MIN.width === 720 && WINDOW_MIN.height === 640, WINDOW_MIN)
  const fullHD = firstRunSize({ width: 1920, height: 1040 })
  check("a 1920x1040 work area opens at 80% wide, the preferred 880 high", fullHD.width === 1536 && fullHD.height === 880, fullHD)
  const wide = firstRunSize({ width: 2560, height: 1400 })
  check("a large work area is capped at 1920 by 1120", wide.width === 1920 && wide.height === 1120, wide)
  const laptop = firstRunSize({ width: 1280, height: 700 })
  check("a work area under the preferred size is used whole", laptop.width === 1280 && laptop.height === 700, laptop)
  const tiny = firstRunSize({ width: 600, height: 500 })
  check("never below the minimum", tiny.width === 720 && tiny.height === 640, tiny)

  const zoomSteps = [nextZoom(1, "in"), nextZoom(1.1, "in"), nextZoom(1.095, "in"), nextZoom(1, "out")]
  check("zoom moves in whole ten-point steps", zoomSteps.join(",") === "1.1,1.2,1.2,0.9", zoomSteps)
  check(
    "zoom stays within 25% and 300%, and resets to 100%",
    nextZoom(0.3, "out") === 0.25 && nextZoom(0.25, "out") === 0.25 && nextZoom(2.95, "in") === 3 && nextZoom(1.7, "reset") === 1,
  )

  check("a notification is titled project · conversation", noticeTitle({ project: "proj", title: "Fix it" }) === "proj · Fix it")
  check("either half alone, or the app name", noticeTitle({ title: "Only" }) === "Only" && noticeTitle({}) === "MCode")
  const longTitle = noticeTitle({ project: "a-long-project-name", title: "and a long conversation title too" })
  check("a title over 40 is cut to 39 and an ellipsis", longTitle.length === 40 && longTitle.endsWith("…"), longTitle)
  const noticeRaw = readTaskNotice({ kind: "confirm", silent: "yes", sessionID: 4 })
  check("an IPC notice is read field by field", noticeRaw.kind === "confirm" && noticeRaw.silent === false && noticeRaw.sessionID === undefined, noticeRaw)
  check("an unknown kind is a finished task", readTaskNotice({ kind: "error" }).kind === "done")
  const front = { destroyed: false, minimized: false, visible: true, focused: true }
  check("no notification while the window is in front", !wantsNotice(front))
  check(
    "a notification while minimised, hidden or in the background",
    wantsNotice({ ...front, minimized: true }) && wantsNotice({ ...front, visible: false }) && wantsNotice({ ...front, focused: false }),
  )
  check("none for a destroyed window", !wantsNotice({ ...front, destroyed: true, focused: false }))

  const flags = (canCopy: boolean, canCut: boolean, canPaste: boolean, canSelectAll: boolean) => ({ canCopy, canCut, canPaste, canSelectAll })
  const plainSelection = textMenuItems({ isEditable: false, selectionText: "hello", editFlags: flags(true, false, false, true) })
  check("selected text offers copy and select all", plainSelection.join(",") === "copy,selectAll", plainSelection)
  const emptyField = textMenuItems({ isEditable: true, selectionText: "", editFlags: flags(false, false, true, false) })
  check("an empty field hides cut and copy rather than greying them", emptyField.join(",") === "paste,selectAll", emptyField)
  const filledField = textMenuItems({ isEditable: true, selectionText: "hello", editFlags: flags(true, true, true, true) })
  check("a field with a selection reads cut, copy, paste, select all, in MiMo's order", filledField.join(",") === "cut,copy,paste,selectAll", filledField)
  const nothing = textMenuItems({ isEditable: false, selectionText: "", editFlags: flags(false, false, false, false) })
  check("plain text or a link with nothing selected gets no menu", nothing.length === 0, nothing)
  const picture = textMenuItems({ mediaType: "image", srcURL: "https://example.com/a.png", selectionText: "", editFlags: flags(true, false, false, true) })
  check("an image leads with its two rows and copies no text", picture.join(",") === "copyImage,copyImageUrl", picture)

  const armed = quitPress(undefined, 1000)
  check("a first Cmd+Q only arms", !armed.quit && armed.armedAt === 1000, armed)
  check("a second within two seconds quits", quitPress(1000, 2500).quit)
  const late = quitPress(1000, 3500)
  check("a later press arms again", !late.quit && late.armedAt === 3500, late)
  check("the badge count is a whole non-negative number", badgeCount(-1) === 0 && badgeCount(2.7) === 2 && badgeCount("3") === 3)

  section("Reply scores and video cards (MiMo's ABC block and media cards)")
  {
    const A = abcPlay
    check("a tune's time is its whole notes at a quarter-note tempo", A.tuneSeconds({ tempo: 120, totalDuration: 2 }) === 4 && A.tuneSeconds({ tempo: 0, totalDuration: 2 }) === undefined)
    check("MiMo renders the tune and three seconds, at most ten minutes", A.renderSeconds(4) === 7 && A.renderSeconds(599) === 600 && A.renderSeconds(undefined) === 600)
    check(
      "a press on the bar is its share of the width, held between 0 and 1",
      A.progressAt(150, 100, 200) === 0.25 && A.progressAt(50, 100, 200) === 0 && A.progressAt(400, 100, 200) === 1 && A.progressAt(1, 0, 0) === undefined,
    )
    const tune = { lines: [{ staff: [{ voices: [[{ el_type: "note" }, { el_type: "note", rest: { type: "rest" } }, { el_type: "bar" }, { el_type: "note" }]] }] }] }
    check("only sounding notes count", A.countNotes(tune) === 2, A.countNotes(tune))
    check(
      "MiMo's refusals: no music, no notes, prose that parsed with warnings",
      A.scoreProblem({ lines: [] }, "x") === "no-music" &&
        A.scoreProblem({ lines: [{ staff: [] }] }, "K:C") === "no-notes" &&
        A.scoreProblem({ ...tune, warnings: ["w"] }, "hello there") === "prose" &&
        A.scoreProblem({ ...tune, warnings: ["w"] }, "X:1\nK:C") === undefined &&
        A.scoreProblem(tune, "CDE") === undefined,
    )
    check(".abc files are scores", A.isAbcFile("tunes/reel.ABC") && A.isAbcFile("a.abc?v=1") && !A.isAbcFile("a.abcd") && !A.isAbcFile(undefined))
    const notes = A.scoreNotes(
      {
        tempo: 120,
        tracks: [
          [
            { cmd: "program", channel: 0, instrument: 0 },
            { cmd: "note", pitch: 69, start: 0.25, duration: 0.25, gap: 0.05, volume: 127, instrument: 0 },
            { cmd: "note", pitch: 38, start: 0, duration: 0.25, volume: 100, instrument: 128 },
            { cmd: "note", pitch: 60, start: 10, duration: 1, volume: 80, instrument: 0 },
          ],
        ],
      },
      7,
    )
    check(
      "abcjs's notes in seconds and hertz, with percussion and notes past the end left out",
      notes.length === 1 && notes[0].time === 0.5 && Math.abs(notes[0].length - 0.4) < 1e-9 && notes[0].frequency === 440 && notes[0].gain === 1,
      notes,
    )

    /* Round 5: MiMo's FluidSynth path - the ABC and MIDI fix-ups, the render length, and the soundfont's delivery. */
    const duet = ["X:1", "T:Duet", "V:1 clef=treble", "%%MIDI program 40", "V:2 clef=bass", "% the bass", "%%MIDI program 42", "M:4/4", "K:C", "[V:1] CDEF|", "[V:2] C,D,E,F,|"].join("\n")
    const duetMoved = A.withVoicePrograms(duet)
    check(
      "a header voice's %%MIDI program moves after K:, right under its voice",
      duetMoved === ["X:1", "T:Duet", "% the bass", "M:4/4", "K:C", "V:1 clef=treble", "%%MIDI program 40", "V:2 clef=bass", "%%MIDI program 42", "[V:1] CDEF|", "[V:2] C,D,E,F,|"].join("\n"),
      duetMoved,
    )
    const inlineWins = A.withVoicePrograms(["X:1", "V:A", "%%MIDI program 1", "K:G", "[V:A]", "%%MIDI program 73", "GABc|"].join("\n"))
    check("a program under an inline [V:] wins over the header's and leaves the body", inlineWins === ["X:1", "K:G", "V:A", "%%MIDI program 73", "[V:A]", "GABc|"].join("\n"), inlineWins)
    const afterNotes = ["X:1", "V:1", "K:C", "[V:1]", "CDE|", "%%MIDI program 5"].join("\n")
    check(
      "a program after notes belongs to no voice; no K:, no header voice or no program leaves the tune as it is",
      A.withVoicePrograms(afterNotes) === afterNotes && A.withVoicePrograms("V:1\n%%MIDI program 3\nCDE") === "V:1\n%%MIDI program 3\nCDE" && A.withVoicePrograms("X:1\nK:C\n%%MIDI program 3\nCDE") === "X:1\nK:C\n%%MIDI program 3\nCDE",
    )

    const smf = (...tracks: number[][]) =>
      new Uint8Array([
        ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, 0, 96],
        ...tracks.flatMap((events) => [0x4d, 0x54, 0x72, 0x6b, 0, 0, (events.length >> 8) & 255, events.length & 255, ...events]),
      ])
    const END = [0x00, 0xff, 0x2f, 0x00]
    const onTwo = [0x00, 0xff, 0x03, 0x02, 0x41, 0x42, 0x00, 0xc0, 40, 0x00, 0x92, 60, 90, 0x60, 62, 90, 0x60, 0x82, 60, 0, ...END]
    const bothChannels = [0x00, 0xc0, 1, 0x00, 0x91, 60, 90, 0x00, 0x92, 64, 90, ...END]
    const silentThree = [0x00, 0xc0, 5, 0x00, 0x93, 60, 0, 0x00, 0x92, 60, 80, ...END]
    const programOne = [0x00, 0xc1, 7, 0x00, 0x92, 60, 80, ...END]
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index])
    const single = smf(onTwo)
    const singleWant = single.slice()
    singleWant[22 + onTwo.indexOf(0xc0)] = 0xc2
    check("a track sounding only on channel 2 gets its channel-0 program change, and the input is not touched", same(A.patchTrackPrograms(single), singleWant) && single[22 + onTwo.indexOf(0xc0)] === 0xc0)
    const mixed = smf(bothChannels, silentThree)
    const mixedWant = mixed.slice()
    mixedWant[22 + bothChannels.length + 8 + silentThree.indexOf(0xc0)] = 0xc2
    check("two sounding channels are left alone, and a velocity-0 note-on does not count as sounding", same(A.patchTrackPrograms(mixed), mixedWant))
    check(
      "a program on another channel, a track on channel 0 and bytes that are not MIDI come back unchanged",
      same(A.patchTrackPrograms(smf(programOne)), smf(programOne)) &&
        same(A.patchTrackPrograms(smf([0x00, 0xc0, 3, 0x00, 0x90, 60, 90, ...END])), smf([0x00, 0xc0, 3, 0x00, 0x90, 60, 90, ...END])) &&
        same(A.patchTrackPrograms(new Uint8Array([1, 2, 3])), new Uint8Array([1, 2, 3])),
    )
    check(
      "the render is the tune and three seconds in 44.1 kHz frames, never past ten minutes, in MiMo's 4096-frame blocks with an 8 ms yield",
      A.renderFrames(A.renderSeconds(4)) === 7 * 44_100 &&
        A.renderFrames(A.renderSeconds(900)) === 600 * 44_100 &&
        A.renderFrames(A.renderSeconds(undefined)) === 26_460_000 &&
        A.renderFrames(1e9) === 26_460_000 &&
        A.renderFrames(Number.NaN) === 26_460_000 &&
        A.ABC_SAMPLE_RATE === 44_100 &&
        A.ABC_RENDER_BLOCK === 4096 &&
        A.ABC_RENDER_YIELD_MS === 8,
    )

    section("The score soundfont and FluidSynth delivery (round 5)")
    {
    check(
      "the build script and the main process pin the same soundfont",
      soundfontScript.SOUNDFONT_FILE === SOUNDFONT.file && soundfontScript.SOUNDFONT_SIZE === SOUNDFONT.size && soundfontScript.SOUNDFONT_SHA256 === SOUNDFONT.sha256 &&
        SOUNDFONT.size === 39_900_972 && SOUNDFONT.sha256 === "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3",
    )
    check(
      "a file of the wrong size or hash is not the soundfont",
      soundfontProblem({ size: SOUNDFONT.size - 1, sha256: SOUNDFONT.sha256 }) === "size" &&
        soundfontProblem({ size: SOUNDFONT.size, sha256: "0".repeat(64) }) === "hash" &&
        soundfontProblem({ size: SOUNDFONT.size }) === "hash" &&
        soundfontProblem({ size: SOUNDFONT.size, sha256: SOUNDFONT.sha256.toUpperCase() }) === undefined,
    )

    const sfDir = path.join(root, "soundfont")
    await fs.mkdir(sfDir, { recursive: true })
    const good = Buffer.from("a stand-in soundfont, verified like the real one")
    const expect = { size: good.length, sha256: createHash("sha256").update(good).digest("hex") }
    const sfFile = path.join(sfDir, "font.sf3")
    const missing = await readSoundfont(sfFile, expect)
    await fs.writeFile(sfFile, Buffer.concat([good, Buffer.from("!")]))
    const tooLong = await readSoundfont(sfFile, expect)
    await fs.writeFile(sfFile, Buffer.from(good.toString().toUpperCase()))
    const wrongHash = await readSoundfont(sfFile, expect)
    await fs.writeFile(sfFile, good)
    const fine = await readSoundfont(sfFile, expect)
    check(
      "the main process refuses a missing, resized or altered soundfont and hands over the exact bytes of the right one",
      !missing.ok && missing.reason === "missing" && !tooLong.ok && tooLong.reason === "size" && !wrongHash.ok && wrongHash.reason === "hash" &&
        fine.ok && Buffer.from(fine.bytes).equals(good),
      { missing, tooLong, wrongHash, fine: fine.ok },
    )
    await fs.writeFile(sfFile, Buffer.from(good.toString().toUpperCase()))
    await fs.utimes(sfFile, new Date(), new Date(Date.now() + 60_000))
    const swapped = await readSoundfont(sfFile, expect)
    check("a verified file changed on disk afterwards is checked again and refused", !swapped.ok && swapped.reason === "hash", swapped)

    const target = path.join(sfDir, "resources", "font.sf3")
    const cache = path.join(sfDir, "cache")
    await fs.mkdir(cache, { recursive: true })
    const quiet = { expected: expect, cacheDir: cache, download: false }
    let noCache = ""
    await soundfontScript.ensureSoundfont(target, quiet).catch((error: Error) => (noCache = error.message))
    await fs.writeFile(path.join(cache, "font.sf3"), Buffer.from(good.toString().toUpperCase()))
    let badCache = ""
    await soundfontScript.ensureSoundfont(target, quiet).catch((error: Error) => (badCache = error.message))
    const targetAfterBadCache = await fs.stat(target).then(() => true, () => false)
    await fs.writeFile(path.join(cache, "font.sf3"), good)
    const fromCache = await soundfontScript.ensureSoundfont(target, quiet)
    const placed = await soundfontScript.soundfontFileProblem(target, expect)
    await fs.writeFile(target, Buffer.concat([good, Buffer.from("!")]))
    await fs.rm(path.join(cache, "font.sf3"))
    let damaged = ""
    await soundfontScript.ensureSoundfont(target, quiet).catch((error: Error) => (damaged = error.message))
    const damagedKept = await fs.stat(target).then(() => true, () => false)
    check(
      "the build step places the soundfont only from a verified copy, refuses a bad cache and removes a damaged one, and fails without it",
      noCache !== "" && badCache !== "" && !targetAfterBadCache && fromCache === "cache" && placed === undefined && damaged !== "" && !damagedKept,
      { noCache, badCache, targetAfterBadCache, fromCache, placed, damaged, damagedKept },
    )

    const html = await fs.readFile(path.join(process.cwd(), "src/renderer/index.html"), "utf8")
    const policy = /content="(default-src[^"]*)"/.exec(html)?.[1] ?? ""
    const directive = (name: string) => (new RegExp(`(?:^|;)\\s*${name} ([^;]*)`).exec(policy)?.[1] ?? "").trim().split(/\s+/)
    const scriptSrc = directive("script-src")
    const connectSrc = directive("connect-src")
    check(
      "script-src allows WebAssembly and nothing like eval",
      scriptSrc.includes("'self'") && scriptSrc.includes("'wasm-unsafe-eval'") && !scriptSrc.includes("'unsafe-eval'") && !scriptSrc.some((source) => /^https?:/.test(source)),
      scriptSrc,
    )
    check(
      "no host is allowed for the soundfont: connect-src reaches no web host, and nothing in the policy names a soundfont server",
      connectSrc.length > 0 && !connectSrc.some((source) => /^https?:(?!\/\/\*\.localhost)/.test(source)) && !/osuosl|musescore|xiaomimimo|jsdelivr|unpkg|\.sf[23]/i.test(policy),
      connectSrc,
    )
    const fluid = await fs.readFile(path.join(process.cwd(), "src/renderer/src/lib/abc-fluidsynth.ts"), "utf8")
    const viteConfig = await fs.readFile(path.join(process.cwd(), "electron.vite.config.ts"), "utf8")
    const builder = await fs.readFile(path.join(process.cwd(), "electron-builder.yml"), "utf8")
    const ignore = await fs.readFile(path.join(process.cwd(), ".gitignore"), "utf8")
    const glue = /FLUIDSYNTH_GLUE = "\.\/vendor\/([^"]+)"/.exec(fluid)?.[1] ?? ""
    const rendererFiles: string[] = []
    const walkRenderer = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) await walkRenderer(full)
        else if (/\.(ts|vue)$/.test(entry.name)) rendererFiles.push(await fs.readFile(full, "utf8"))
      }
    }
    await walkRenderer(path.join(process.cwd(), "src/renderer/src"))
    check(
      "the window takes the soundfont over IPC and loads FluidSynth as its own file, never through an import or a web address",
      fluid.includes("window.mcode.soundfont()") && !/(?<![A-Za-z.])fetch\(/.test(fluid) && glue === "libfluidsynth-2.4.6-with-libsndfile.js" &&
        viteConfig.includes(`"${glue}"`) && !rendererFiles.some((text) => /import[^;\n]*libfluidsynth/.test(text) || /https?:\/\/[^"'`\s]*\.sf[23]\b/.test(text)),
      glue,
    )
    check(
      "the package keeps FluidSynth outside the asar and ships the soundfont beside it, which git never holds",
      /asarUnpack:[\s\S]*"out\/renderer\/vendor\/\*\*"/.test(builder) && /from: resources\/soundfont\s+to: soundfont/.test(builder) && /^resources\/soundfont\/$/m.test(ignore),
    )

    /*
     * The 第三方许可 dialog: every notice the redistributed pieces oblige MCode to
     * pass on. The entry list is read out of the module's source rather than
     * imported, because its texts are `?raw` imports the bundler resolves.
     */
    const thirdParty = await fs.readFile(path.join(process.cwd(), "src/renderer/src/lib/third-party.ts"), "utf8")
    const entryIds = [...thirdParty.matchAll(/^ {4}id: "([^"]+)"/gm)].map((found) => found[1])
    const textImports = [...thirdParty.matchAll(/import\("([^"]+)\?raw"\)/g)].map((found) => found[1])
    const licenseFile = (specifier: string) =>
      specifier.startsWith("@resources/")
        ? path.join(process.cwd(), "resources", specifier.slice("@resources/".length))
        : path.join(process.cwd(), "node_modules", specifier)
    const licenseTexts = await Promise.all(textImports.map((specifier) => fs.readFile(licenseFile(specifier), "utf8").catch(() => "")))
    const licenseText = (specifier: string) => licenseTexts[textImports.indexOf(specifier)] ?? ""
    const shippedNames = await fs.readdir(path.join(process.cwd(), "resources/licenses"))
    check(
      "the dialog lists every component MCode redistributes, each with a licence text that is a real file",
      JSON.stringify(entryIds) === JSON.stringify(["fluidsynth", "codecs", "js-synthesizer", "abcjs", "musescore-general", "node", "python", "python-packages", "ripgrep"]) &&
        textImports.length === entryIds.length && licenseTexts.every((text) => text.length > 500) &&
        shippedNames.every((name) => textImports.includes(`@resources/licenses/${name}`)),
      { entryIds, missing: textImports.filter((specifier, index) => licenseTexts[index].length <= 500), shippedNames },
    )
    const lgpl = licenseText("js-synthesizer/externals/LICENSE.fluidsynth.txt")
    check(
      "FluidSynth's entry carries the LGPL-2.1 text, the replaceable-file note and its source address, and that licence ships beside the glue",
      lgpl.includes("GNU LESSER GENERAL PUBLIC LICENSE") && lgpl.includes("Version 2.1") && viteConfig.includes('"LICENSE.fluidsynth.txt"') &&
        /unmodified/.test(thirdParty) && /You may replace that file/.test(thirdParty) && thirdParty.includes("https://github.com/jet2jet/fluidsynth-emscripten") &&
        licenseText("js-synthesizer/LICENSE").includes("Copyright (C) 2018 jet") && licenseText("abcjs/LICENSE.md").includes("Paul Rosen"),
    )
    const soundfontLicense = licenseText("@resources/licenses/musescore-general.txt")
    // The soundfont's licence asks for these by name; none may be summarised away.
    const acknowledgements = [
      "FluidR3 (original version) by Frank Wen Copyright (c) 2000-02",
      "Mono conversion (FluidR3Mono) by Michael Cowgill Copyright (c) 2014-17",
      "Adaptation for MuseScore_General.sf2 by S. Christian Collins Copyright (c) 2018-19",
      "Temple Blocks instrument provided by Ethan Winer Copyright (c) 2002",
      "Drumline Cymbals provided by Michael Schorsch Copyright (c) 2016",
      "Copyright (c) 2000-2002, 2008 Frank Wen",
      "Mono version:  Copyright (c) 2014-16 Michael Cowgill",
    ]
    check(
      "the soundfont's licence keeps every acknowledgement and copyright notice it requires, and the MIT grant",
      acknowledgements.every((line) => soundfontLicense.includes(line)) &&
        /The acknowledgements and copyright notices above must be included in any\s+derivative work\./.test(soundfontLicense) &&
        soundfontLicense.includes("Permission is hereby granted, free of charge") && !/to be added|to be included here/i.test(soundfontLicense),
      acknowledgements.filter((line) => !soundfontLicense.includes(line)),
    )
    const codecs = licenseText("@resources/licenses/xiph-codecs.txt")
    // Each library's own upstream copyright line: libogg's is not libvorbis's, and FLAC's is not Xiph's alone.
    const codecNotices = [
      "Copyright (c) 2002, Xiph.org Foundation",
      "Copyright (c) 2002-2020 Xiph.org Foundation",
      "Copyright (C) 2000-2009  Josh Coalson",
      "Copyright (C) 2011-2025  Xiph.Org Foundation",
      "Copyright 2001-2023 Xiph.Org, Skype Limited, Octasic,",
    ]
    check(
      "each codec notice is its own upstream text, with the four disclaimers and Opus's patent addresses",
      codecNotices.every((line) => codecs.includes(line)) && (codecs.match(/THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS/g) ?? []).length === 4 &&
        codecs.includes("https://datatracker.ietf.org/ipr/1524/"),
      codecNotices.filter((line) => !codecs.includes(line)),
    )
    check(
      "the codec versions claimed are the ones the shipped build reports of itself, and libogg's is called unknown rather than guessed",
      ["libvorbis 1.3.7", "libFLAC 1.3.2", "libopus 1.3.1"].every((version) => codecs.includes(version) && thirdParty.includes(version)) &&
        /libogg[^\n]*version unknown/i.test(codecs) && /libogg version unknown/.test(thirdParty) && !/libogg 1\./.test(codecs) && !/libogg 1\./.test(thirdParty),
    )
    }

    section("Reply scores and video cards (continued)")
    let now = 0
    let endedCount = 0
    const sources: { offset: number; stopped: boolean; end: () => void }[] = []
    const player = A.playbackController(
      {
        duration: 10,
        now: () => now,
        createSource: (offset, onEnd) => {
          const entry = { offset, stopped: false, end: onEnd }
          sources.push(entry)
          return { stop: () => (entry.stopped = true), detach: () => (entry.end = () => undefined) }
        },
      },
      () => (endedCount += 1),
    )
    player.start()
    now = 3
    player.pause()
    const paused = player.position()
    player.resume()
    now = 5
    const running = player.position()
    player.seekTo(8)
    const seeked = sources[sources.length - 1].offset
    sources[sources.length - 1].end()
    check(
      "pause keeps the place, resume starts there, a seek restarts at the new place, the end resets",
      paused === 3 && sources[1]?.offset === 3 && running === 5 && seeked === 8 && sources[1].stopped && player.position() === 0 && endedCount === 1 && !player.isRunning(),
      { paused, running, seeked, endedCount },
    )
    let firstStopped = false
    const first = () => (firstStopped = true)
    const second = () => undefined
    A.claimScoreAudio(first)
    A.claimScoreAudio(second)
    A.releaseScoreAudio(second)
    check("starting a second score stops the first", firstStopped)

    const P = mediaPlatform
    const bili = P.parsePlatformLink("https://www.bilibili.com/video/BV1GJ411x7h7/?spm=1。")
    check(
      "a bilibili BV link is a card, the sentence's full stop trimmed",
      bili?.platform === "bilibili" && bili.videoId === "BV1GJ411x7h7" && bili.url === "https://www.bilibili.com/video/BV1GJ411x7h7/?spm=1" && !("play" in bili) && !("embedUrl" in bili),
      bili,
    )
    check(
      "an av link and a b23.tv short link are bilibili too",
      JSON.stringify(P.parseBilibili("https://m.bilibili.com/video/av170001")?.id) === '{"aid":170001}' &&
        JSON.stringify(P.parseBilibili("https://b23.tv/xyz")?.id) === '{"short":"https://b23.tv/xyz"}' &&
        P.parseBilibili("https://b23.tv/") === undefined,
    )
    const yt = P.parsePlatformLink("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x")
    check("a YouTube Music link is a YouTube card for its video", yt?.platform === "youtube" && yt.videoId === "dQw4w9WgXcQ", yt)
    check(
      "youtu.be and shorts give the same id",
      P.parsePlatformLink("https://youtu.be/dQw4w9WgXcQ")?.videoId === "dQw4w9WgXcQ" && P.parsePlatformLink("https://www.youtube.com/shorts/dQw4w9WgXcQ")?.videoId === "dQw4w9WgXcQ",
    )
    const externals = [
      "https://v.douyin.com/abc/",
      "https://www.kuaishou.com/short-video/3x",
      "https://www.iqiyi.com/v_19rr.html",
      "https://v.qq.com/x/page/a.html",
      "https://v.youku.com/v_show/id_X.html",
      "https://www.mgtv.com/b/1/2.html",
      "https://www.ixigua.com/7012345",
      "https://www.yangshipin.cn/program/12345678",
      "https://www.miguvideo.com/p/detail/123456",
      "https://weibo.com/tv/show/1034:4",
      "https://www.tiktok.com/@a/video/7123",
      "https://www.netflix.com/watch/80100172",
    ].map((url) => P.parsePlatformLink(url))
    check(
      "the twelve other platforms are recognised",
      externals.map((link) => link?.platform).join(",") === "douyin,kuaishou,iqiyi,tencent,youku,mangotv,xigua,yangshipin,migu,weibo,tiktok,netflix",
      externals,
    )
    check("fourteen platforms, each with MiMo's badge colours", P.MEDIA_PLATFORMS.length === 14 && P.MEDIA_PLATFORMS.every((name) => /^#/.test(P.PLATFORM_COLOURS[name].bg)) && P.PLATFORM_COLOURS.bilibili.bg === "#fb7299")
    check(
      "a lookalike host is no platform",
      ["https://bilibili.com.example.net/video/BV1GJ411x7h7", "https://youtube.com@example.net/watch?v=dQw4w9WgXcQ", "https://myyoutube.com/watch?v=dQw4w9WgXcQ"].every((url) => P.parsePlatformLink(url) === undefined),
    )
    check(
      "links in code are left out, and a link written twice is one card",
      P.platformLinksIn("`https://youtu.be/dQw4w9WgXcQ` https://youtu.be/aaaaaaaaaaa https://youtu.be/aaaaaaaaaaa, https://b23.tv/x").join(" ") === "https://youtu.be/aaaaaaaaaaa https://b23.tv/x",
    )

    const page = P.pageMeta(
      '<html><head><title>Plain &amp; title</title><meta property="og:title" content="A &quot;clip&quot;"><meta property="og:image" content="http://img.example/a.jpg"><meta name="author" content="Someone"><meta property="og:video:duration" content="61.4"><meta property="og:video:width" content="720"><meta property="og:video:height" content="1280"></head></html>',
    )
    check("a page's Open Graph tags make its card", page.title === 'A "clip"' && page.titleFromOg && page.image === "http://img.example/a.jpg" && page.author === "Someone" && page.durationSec === 61 && page.vertical === true, page)
    check("a page without og:title falls back to its title element", P.pageMeta("<title>Only &lt;this&gt;</title>").title === "Only <this>" && !P.pageMeta("<title>x</title>").titleFromOg)
    check(
      "covers are https only",
      P.coverAddress("http://img.example/a.jpg") === "https://img.example/a.jpg" && P.coverAddress("//i0.hdslb.com/x.jpg") === "https://i0.hdslb.com/x.jpg" && P.coverAddress("javascript:alert(1)") === "" && P.coverAddress(3) === "",
    )
    const view = { code: 0, data: { bvid: "BV1GJ411x7h7", cid: 123, title: "T", pic: "http://i0.hdslb.com/c.jpg", duration: 212, owner: { name: "Up" }, dimension: { width: 1080, height: 1920 } } }
    const bilibiliCard = P.bilibiliMeta(view, "https://b23.tv/x")
    check(
      "bilibili's view answer gives the card: title, author, cover, length, orientation",
      bilibiliCard?.title === "T" && bilibiliCard.aspect === "9:16" && bilibiliCard.coverUrl === "mcode-media://proxy/?u=https%3A%2F%2Fi0.hdslb.com%2Fc.jpg" && bilibiliCard.durationSec === 212 && bilibiliCard.author === "Up",
      bilibiliCard,
    )
    check("no bilibili card without a cid, or on an error code", P.bilibiliMeta({ ...view, data: { ...view.data, cid: 0 } }, "u") === undefined && P.bilibiliMeta({ ...view, code: -404 }, "u") === undefined)
    const oembed = P.oembedMeta({ title: "Song", author_name: "Band", thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg", width: 200, height: 113 })
    check("YouTube's oEmbed gives title, author and cover", oembed.title === "Song" && oembed.author === "Band" && oembed.image === "https://i.ytimg.com/vi/x/hqdefault.jpg" && oembed.vertical === false, oembed)
    const front = P.coverflowSlot(0)
    const side = P.coverflowSlot(-2)
    const hidden = P.coverflowSlot(5)
    check(
      "the coverflow: the front cover flat, the second to the left 206px out and turned 58deg, past four hidden",
      front.zIndex === 100 && side.transform === "translateX(-206px) translateZ(-180px) rotateY(58deg) scale(0.92)" && side.zIndex === 98 && hidden.opacity === 0 && hidden.pointerEvents === "none",
      { front, side, hidden },
    )
    check("stepping stops at the ends", P.stepIndex(0, -1, 3) === 0 && P.stepIndex(2, 1, 3) === 2 && P.stepIndex(1, 1, 3) === 2)
    check(
      "a card is kept a day, a miss ten minutes",
      P.cacheState({ value: {}, storedAt: 0 }, 86_400_000) === "hit" && P.cacheState({ value: null, storedAt: 0 }, 600_001) === "stale" && P.cacheState(undefined, 0) === "miss",
    )
    const used = new Map([
      ["a", { lastUsedAt: 3 }],
      ["b", { lastUsedAt: 1 }],
      ["c", { lastUsedAt: 2 }],
    ])
    check("the least recently used cards go first", P.evictions(used, 1).join(",") === "b,c")

    /* MiMo's cover proxy, against a stand-in network: what it sends, where a redirect may lead, what it will not pass on. */
    const fetched: { url: string; referer?: string; agent?: string; redirect?: string }[] = []
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const picture = () => new Response(png, { headers: { "content-type": "image/png" } })
    const hopTo = (location: string) => () => new Response(null, { status: 302, headers: { location } })
    const network: Record<string, () => Response> = {
      "https://i0.hdslb.com/ok.png": picture,
      "https://i0.hdslb.com/hop.png": hopTo("https://i1.hdslb.com/ok.png"),
      "https://i1.hdslb.com/ok.png": picture,
      "https://i0.hdslb.com/away.png": hopTo("https://evil.example/x.png"),
      "https://i0.hdslb.com/loop.png": hopTo("https://i0.hdslb.com/loop.png"),
      "https://i0.hdslb.com/page.html": () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      "https://i0.hdslb.com/vector.svg": () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      "https://i0.hdslb.com/declared.png": () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(P.COVER_LIMIT + 1) } }),
      "https://i0.hdslb.com/endless.png": () =>
        new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(1024 * 1024)) }), { headers: { "content-type": "image/png" } }),
    }
    const stand = async (url: string, init: RequestInit): Promise<Response> => {
      const headers = (init.headers ?? {}) as Record<string, string>
      fetched.push({ url, referer: headers.referer, agent: headers["user-agent"], redirect: init.redirect })
      if (url === "https://i0.hdslb.com/slow.png") {
        return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
      }
      const answer = network[url]
      if (!answer) throw new Error(`no network for ${url}`)
      return answer()
    }
    // The proxy address is built by hand: coverProxyAddress would turn an http cover into https before the proxy saw it.
    const cover = (address: string, method = "GET", timeout?: number) => serveCover(`mcode-media://proxy/?u=${encodeURIComponent(address)}`, method, stand, timeout)
    const statusOf = async (address: string, method?: string, timeout?: number) => (await cover(address, method, timeout)).status

    fetched.length = 0
    const good = await cover("https://i0.hdslb.com/ok.png")
    const goodBytes = new Uint8Array(await good.arrayBuffer())
    check(
      "a cover is fetched with its platform's referer and MiMo's agent, redirects held back, and passed on as a sandboxed picture",
      good.status === 200 && good.headers.get("content-type") === "image/png" && goodBytes.length === png.length && good.headers.get("cache-control") === "public, max-age=86400" &&
        good.headers.get("content-security-policy") === "sandbox" && fetched.length === 1 && fetched[0].referer === "https://www.bilibili.com/" && /Chrome\/126\.0/.test(fetched[0].agent ?? "") && fetched[0].redirect === "manual",
      { status: good.status, fetched },
    )
    fetched.length = 0
    const hopped = await statusOf("https://i0.hdslb.com/hop.png")
    check("a redirect to another cover host is followed", hopped === 200 && fetched.map((entry) => entry.url).join(" ") === "https://i0.hdslb.com/hop.png https://i1.hdslb.com/ok.png", { hopped, fetched })
    fetched.length = 0
    const away = await statusOf("https://i0.hdslb.com/away.png")
    check("a redirect off the host list is refused and never fetched", away === 502 && !fetched.some((entry) => entry.url.includes("evil.example")), { away, fetched })
    fetched.length = 0
    const looped = await statusOf("https://i0.hdslb.com/loop.png")
    check("a cover that keeps redirecting is refused after three", looped === 502 && fetched.length === 4, { looped, count: fetched.length })
    check(
      "a page, an SVG, a picture declared past the cap and one that never ends are all refused",
      (await statusOf("https://i0.hdslb.com/page.html")) === 502 && (await statusOf("https://i0.hdslb.com/vector.svg")) === 502 &&
        (await statusOf("https://i0.hdslb.com/declared.png")) === 502 && (await statusOf("https://i0.hdslb.com/endless.png")) === 502,
    )
    fetched.length = 0
    const refusals = [
      await statusOf("http://i0.hdslb.com/ok.png"),
      await statusOf("https://i0.hdslb.com.evil.example/ok.png"),
      await statusOf("https://evil.example/ok.png"),
      await statusOf("https://i0.hdslb.com/ok.png", "POST"),
      (await serveCover("mcode-media://proxy/", "GET", stand)).status,
    ]
    check("http, lookalike and off-list hosts, other methods and a bare proxy address are refused without a fetch", refusals.join(",") === "403,403,403,405,400" && fetched.length === 0, { refusals, fetched })
    const slow = await cover("https://i0.hdslb.com/slow.png", "GET", 50)
    check("a cover that does not answer in time is refused", slow.status === 502 && (await slow.arrayBuffer()).byteLength === 0)
  }

  section("Notices and scrollbars (MiMo)")
  check("a notice's detail folds into its one line", toastTitle("Saved", "C:/x.txt") === "Saved · C:/x.txt" && toastTitle("Saved") === "Saved")
  const folded = notify("Round3 folded", "a reason")
  const foldedEntry = toasts.value.find((entry) => entry.id === folded)
  check("a notice carries no second text", Boolean(foldedEntry) && foldedEntry?.title === "Round3 folded · a reason" && !("body" in (foldedEntry ?? {})), foldedEntry)
  dismiss(folded)
  check("the zoom notice at 100% says it is restored", zoomNotice(100, "win32") === translate("zoom.restored"))
  const zoomed = zoomNotice(129.6, "win32")
  check("the zoom notice names the whole percent and Ctrl+0", zoomed.includes("130") && zoomed.includes("Ctrl+0") && !zoomed.includes("{"), zoomed)
  check("on macOS it names ⌘0", zoomNotice(80, "darwin").includes("⌘0"))
  check("a scrollbar stays coloured 500ms after the last scroll", SCROLLBAR_LINGER === 500, SCROLLBAR_LINGER)

  await subagentChecks(root)
  await sessionChatChecks(root, project)
  await projectListChecks()
  await deliveredToolChecks(root)
  await mcpChecks(project)
  await skillChecks(root)
  taskChecks()
  await commandTemplateChecks(root)
  await historyMemoryCronChecks(root, project)
  await automationChecks(root, project)
  await roundSixVisualChecks()
  // round 5: the turn loop, providers, context and prompt, in their own file; its provider answers title requests apart.
  delete process.env.MCODE_GENERATE_TITLES
  await roundFiveChecks(check, section)
  await roundSixChecks(check, section)
  await roundSevenChecks(check, section)
  await roundEightSecurityChecks(check, section)
  await roundEightAccessChecks(check, section)
  wordingChecks(check, section)
  await roundEightChecks(check, section)
  await roundNineProviderChecks(check, section)
  await roundNineWindowsChecks(check, section)
  await roundNineMcpChecks(check, section)
  await roundNineSettingsChecks(check, section)
  await roundTenAgentChecks(check, section)
  await failureChecks(check, section)
  await roundSevenTimingChecks()
  await storageChecks(check, section)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * Round 7 (timing): what the app does before it can do anything, and what it
 * still does after a turn has ended.
 *
 * Read out of the sources, and for the shell's weight out of the build, which
 * is what makes these a guard rather than a stopwatch: an awaited backend put
 * back in front of the window, a reveal loop returning, or the terminal drifting
 * back into the entry chunk fails here, in the same run as everything else. The
 * window measurements themselves live in the round-7 probe beside them.
 */
async function roundSevenTimingChecks() {
  section("Round 7: startup, streaming cadence and the shell's weight")
  const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

  // ----------------------------------------------------------------- T1
  const page = await read("src/renderer/index.html")
  const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? ""
  const mountAt = page.indexOf('<div id="app">')
  const markAt = page.indexOf('class="startup-mark"')
  check(
    "the startup mark is inside the mount point, so mounting replaces it with no seam",
    mountAt !== -1 && markAt > mountAt && markAt < page.indexOf("</body>"),
    { mountAt, markAt },
  )
  check(
    "its CSS is inline in the head, so it is painted as the HTML is parsed rather than after the bundle runs",
    styleBlock.includes(".startup-mark") && page.indexOf("<style>") < page.indexOf("</head>"),
  )
  check("a placeholder with nothing to say stays out of the reading", /class="startup-mark"[^>]*aria-hidden="true"/.test(page))
  /*
   * The markup and its own CSS, not the whole file: the content policy above
   * them is commented at length, and that prose names both `<img>` and the
   * reference by name.
   */
  const body = page.slice(page.indexOf("<body>"))
  check(
    "the mark costs no request: it is drawn in the page, and the only address in its CSS is the data URI it is masked by",
    !/<img\b/.test(body) && !/url\((?!"data:)/.test(styleBlock),
    { images: body.match(/<img[^>]{0,24}/g), addresses: styleBlock.match(/url\((?!"data:)[^)]{0,16}/g) },
  )
  /*
   * Not a search for the reference's name - the comments here explain what it
   * does, as they do everywhere else. What must not be borrowed is the artwork:
   * so the mark is one path of MCode's own, drawn in the page and masked by
   * that very same shape, under MCode's own names.
   */
  const svgPath = /<path\s+d="([^"]+)"/.exec(body)?.[1] ?? ""
  const maskPath = (/%3cpath%20d='([^']+)'/.exec(styleBlock)?.[1] ?? "").replace(/%20/g, " ")
  check(
    "and it is MCode's own mark: one path, drawn in the page and masked by the same shape",
    svgPath !== "" && maskPath === svgPath && !/startup-loader|startup-mimo/.test(page),
    { svgPath: svgPath.slice(0, 44), maskPath: maskPath.slice(0, 44) },
  )
  const guard = (start: string) => {
    const at = styleBlock.indexOf(start)
    return at === -1 ? "" : styleBlock.slice(at, at + 400)
  }
  const systemOff = guard("@media (prefers-reduced-motion: reduce)")
  const settingOff = guard(':root[data-motion="on"]')
  check(
    "reduced motion keeps the mark and stops both the fade-in and the sweep - the machine's preference",
    systemOff.includes("startup-mark-glyph") && systemOff.includes("startup-mark-sweep") && systemOff.includes("opacity: 1") &&
      (systemOff.match(/animation: none/g) ?? []).length >= 2,
    systemOff.slice(0, 100),
  )
  check(
    "...and MCode's own reduce-motion setting, once the app has written data-motion",
    settingOff.includes("startup-mark-glyph") && settingOff.includes("startup-mark-sweep") &&
      (settingOff.match(/animation: none/g) ?? []).length >= 2,
    settingOff.slice(0, 100),
  )

  // -------------------------------------------------------------- T2, T6
  const main = await read("src/main/index.ts")
  check(
    "the window is no longer created behind an awaited backend",
    !/await startBackend\(/.test(main) && /const starting = startBackend\(/.test(main),
  )
  check(
    "the backend is warmed without being waited for, and bootstrap is the one channel that waits for it",
    /ipcMain\.handle\("mcode:bootstrap"[\s\S]{0,240}await starting/.test(main) && /starting\.catch\(/.test(main),
  )
  check("the window is still created inside whenReady", /app\.whenReady\(\)[\s\S]*\n  createWindow\(\)/.test(main))
  check(
    "a wedged first load shows a window after three seconds rather than after the 30s startup timeout",
    SHOW_FALLBACK_MS === 3_000 && SHOW_FALLBACK_MS < STARTUP_TIMEOUT,
    { SHOW_FALLBACK_MS, STARTUP_TIMEOUT },
  )
  check(
    "the same show is bound to ready-to-show, to did-finish-load and to the fallback timer",
    /window\.once\("ready-to-show", showWindowOnce\)/.test(main) &&
      /window\.webContents\.once\("did-finish-load", showWindowOnce\)/.test(main) &&
      /setTimeout\(\(\) => showWindowOnce\(\), SHOW_FALLBACK_MS\)/.test(main),
  )
  check("and however many of the three arrive, the window is shown once", /if \(shownOnce\) return/.test(main))

  // ----------------------------------------------------------------- T4
  const textPart = await read("src/renderer/src/components/parts/TextPart.vue")
  const stream = await read("src/renderer/src/components/MessageStream.vue")
  const revealGone = await fs.stat(path.join(process.cwd(), "src/renderer/src/lib/stream-reveal.ts")).then(() => false, () => true)
  check("the per-character reveal is gone from the tree", revealGone)
  check(
    "no reveal timer is left in the reply renderer: no frame loop, no fade tail, no stall guard",
    !/requestAnimationFrame|useStreamReveal|fadeTail|sm-fade/.test(textPart),
  )
  check(
    "a live answer is drawn from the text the store holds, as the reference appends each delta as it lands",
    /renderReply\(props\.part\.text,/.test(textPart),
  )
  check("a turn's end no longer waits for a reveal to drain", !/playingOut|revealing/.test(stream))
  check(
    "what is animated instead is the block, which is the only thing the reference animates",
    /\.text\.streaming > \.md-block \{[\s\S]{0,80}animation: stream-block-in/.test(textPart) && /@keyframes stream-block-in/.test(textPart),
  )
  check(
    "and no comment credits the reference with a per-character pacing it does not have",
    !/MiMo's streaming reveal|MiMo paces|MiMo's fade on the live block/.test(textPart),
  )

  // ----------------------------------------------------------------- T5
  const appVue = await read("src/renderer/src/App.vue")
  check(
    "the terminal drawer is fetched on first use rather than built into the always-loaded shell",
    /defineAsyncComponent\(\(\) => import\("\.\/components\/TerminalDrawer\.vue"\)\)/.test(appVue) &&
      !/^import TerminalDrawer from/m.test(appVue),
  )
  const assetDir = path.join(process.cwd(), "out/renderer/assets")
  const built = await fs.readdir(assetDir).catch(() => undefined)
  if (!built) {
    console.log("  --   out/renderer holds no build, so the entry chunk itself is untested here (npm run build first)")
  } else {
    const builtPage = await read("out/renderer/index.html")
    const entryName = /<script[^>]*src="[./]*assets\/(index-[^"]+\.js)"/.exec(builtPage)?.[1] ?? ""
    const entry = entryName ? await read(`out/renderer/assets/${entryName}`) : ""
    const others = await Promise.all(
      built.filter((name) => name.endsWith(".js") && name !== entryName).map((name) => read(`out/renderer/assets/${name}`)),
    )
    check(
      "the built entry chunk carries no terminal, and the terminal sits in a chunk of its own",
      entryName !== "" && !entry.includes("xterm-viewport") && others.some((text) => text.includes("xterm-viewport")),
      { entryName, entryBytes: Buffer.byteLength(entry) },
    )
  }
}

/**
 * round 6 (visual): the drawn workspace against MiMo's own numbers.
 *
 * These are read out of the stylesheets rather than measured in a window, which
 * is what makes them a guard rather than a screenshot: a breakpoint, a blur or a
 * corner put back by hand fails here, in the same run as everything else. The
 * window measurements live in the round-6 probe beside them.
 */
async function roundSixVisualChecks() {
  section("Round 6: the drawn workspace (MiMo's measurements)")
  const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")
  /*
   * One top-level CSS rule's body. Every rule read here is written at the start
   * of a line with indented declarations, so the first `\n}` closes it - no
   * brace matching, which a comment carrying a brace would defeat.
   */
  const rule = (source: string, selector: string) => {
    const at = source.indexOf(`\n${selector} {\n`)
    return at === -1 ? "" : source.slice(at, source.indexOf("\n}", at + 1))
  }

  // V1: one flush plane, not two rounded cards on a darker frame.
  const app = await read("src/renderer/src/App.vue")
  const body = rule(app, ".body")
  check("the workspace row has no inset and no gutter", Boolean(body) && !body.includes("margin:") && !body.includes("gap:"), body)
  const plane = rule(app, ".body > .main")
  check(
    "the conversation plane is flush, divided by a hairline instead of rounded off",
    plane.includes("border-inline-start: 1px solid") && !plane.includes("border-radius"),
    plane,
  )
  check("nothing still addresses the side panel as a floating card", !app.includes("panel-host"), "")

  // V6: MiMo warms the light theme on Windows and Linux, and only there.
  const tint = app.slice(app.indexOf('.app[data-platform="win32"] .side-panel-toggle'))
  check(
    "Windows and Linux get MiMo's warm light column and warm lines",
    tint.includes("--surface-base: #f8f7f5") && tint.includes("--border-weak: #f0ebe5") && tint.includes('.app[data-platform="linux"]'),
    "",
  )
  check(
    "the warm tint is light-only, so dark is untouched",
    tint.includes(':root[data-theme="light"] .app[data-platform="win32"]') && tint.includes("@media (prefers-color-scheme: light)"),
    "",
  )

  // V2 / V9: 2000px is the only breakpoint MiMo has.
  const stream = await read("src/renderer/src/components/MessageStream.vue")
  const composer = await read("src/renderer/src/components/Composer.vue")
  const hero = await read("src/renderer/src/components/HomeHero.vue")
  for (const [what, source] of [["transcript", stream], ["composer", composer], ["home hero", hero]] as const) {
    check(`the ${what} widens at 2000px and at no other width`, source.includes("@media (min-width: 2000px)") && !source.includes("1536px"), what)
  }
  check(
    "the reading column is 764 on 28, and 996 past 2000px - MiMo's thread, not its home layout",
    rule(stream, ".inner").includes("max-width: 764px") &&
      rule(stream, ".inner").includes("padding: 12px 28px 16px") &&
      stream.includes("@media (min-width: 2000px) {\n  .inner {\n    max-width: 996px;") &&
      !stream.includes("max-width: 800px"),
    rule(stream, ".inner"),
  )
  check(
    "the composer column is 712, and 944 past 2000px - the inside of MiMo's 1000 wrapper",
    composer.includes("max-width: 712px") && composer.includes("@media (min-width: 2000px) {\n  .shell {\n    max-width: 944px;"),
    "",
  )

  // V4: MiMo blurs the search overlay and nothing else.
  const base = await read("src/renderer/src/styles/base.css")
  const overlay = rule(base, ".overlay")
  check("the shared dialog scrim does not blur", Boolean(overlay) && !overlay.includes("backdrop-filter"), overlay)
  const search = await read("src/renderer/src/components/SearchOverlay.vue")
  check("the search overlay still blurs at 8px, as MiMo's does", search.includes("backdrop-filter: blur(8px)"), "")

  // V3: MiMo's menu panel and its pill rows.
  const menu = await read("src/renderer/src/components/ContextMenu.vue")
  const panel = rule(menu, ".menu")
  check(
    "the menu panel is a 12px corner on a 1px line, 200 at its narrowest, 5 of padding",
    panel.includes("border-radius: 12px") && panel.includes("border: 1px solid var(--border-weak)") && panel.includes("min-width: 200px") && panel.includes("--pad: 5px"),
    panel,
  )
  check(
    "the menu pops open over .18s",
    panel.includes("animation: menu-pop 0.18s cubic-bezier(0.16, 1, 0.3, 1)") && menu.includes("@keyframes menu-pop"),
    "",
  )
  const row = rule(menu, ".item")
  check(
    "a menu row is a 14px pill, 6 by 10 on an 8px corner with 9 to its glyph",
    row.includes("border-radius: 8px") && row.includes("padding: 6px 10px") && row.includes("font-size: calc(14px") && row.includes("gap: 9px"),
    row,
  )
  check("a menu divider is inset rather than full-bleed", rule(menu, ".rule").includes("margin: 4px 6px"), rule(menu, ".rule"))

  // V7: one focus-ring blue, MiMo's --color-blue, not its link blue.
  const ringFiles = [
    "PermissionDialog.vue",
    "QuestionDock.vue",
    "parts/DiagramBlock.vue",
    "parts/LocalMedia.vue",
    "parts/MediaCoverflow.vue",
    "parts/MediaStrip.vue",
    "parts/QuestionForm.vue",
    "parts/SubagentActivity.vue",
    "parts/SvgFileCard.vue",
    "parts/TextPart.vue",
    "right/RpSubagents.vue",
  ]
  const rings = await Promise.all(ringFiles.map((name) => read(`src/renderer/src/components/${name}`)))
  const stray = ringFiles.filter((_, index) =>
    /outline: 2px solid (?:#3295fb|var\(--text-interactive\)|var\(--border-selected\)|var\(--border-focus)/.test(rings[index]),
  )
  check("every focus ring is the one interactive blue", stray.length === 0, stray)

  // V12: a token nothing read.
  const tokens = await read("src/renderer/src/styles/tokens.css")
  check("the dead --sidebar-width token is gone", !tokens.includes("--sidebar-width"), "")
}

/** commands: MiMo's template rules - shell placeholders, `@file`, folders and model tiers. */
async function commandTemplateChecks(root: string) {
  section("Command templates (shell, @file, folders, models)")
  check("shell placeholders are found in order, repeats kept", shellPlaceholders("a !`one` b !`two` c !`one`").join("|") === "one|two|one")
  check("outputs replace placeholders in order, and a $ in an output is text", substituteShell("x !`a` y !`b`", ["$&", "$1"]) === "x $& y $1")
  check(
    "@file: an email is not a file, a closing full stop is not part of one, a repeat counts once",
    fileReferences("see @notes.md. and @src/a.ts, mail me@example.com, again @notes.md and `@code`").join("|") === "notes.md|src/a.ts",
    fileReferences("see @notes.md. and @src/a.ts, mail me@example.com, again @notes.md and `@code`"),
  )

  const base = path.join(root, "commands-case")
  const home = path.join(base, "home")
  const storage = path.join(base, "storage")
  const outer = path.join(base, "outer")
  const repo = path.join(outer, "repo")
  const nested = path.join(repo, "packages", "app")
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }
  const doc = (body: string, front = "") => `---\ndescription: probe\n${front}---\n${body}\n`
  await fs.mkdir(path.join(repo, ".git"), { recursive: true })
  await fs.mkdir(nested, { recursive: true })
  await write(path.join(storage, "commands", "global-only.md"), doc("from the global folder"))
  await write(path.join(storage, "commands", "shared.md"), doc("global shared"))
  await write(path.join(repo, ".mcode", "commands", "shared.md"), doc("repo shared"))
  await write(path.join(nested, ".mcode", "command", "shared.md"), doc("nested shared"))
  await write(path.join(nested, ".mcode", "commands", "deploy", "web.md"), doc("deploy web"))
  await write(path.join(nested, ".claude", "commands", "from-claude.md"), doc("claude command"))
  await write(path.join(nested, ".claude", "commands", "global-only.md"), doc("claude loses to the global folder"))
  await write(path.join(outer, ".mcode", "commands", "above.md"), doc("above the repository"))
  await write(path.join(home, ".mcode", "commands", "shared.md"), doc("home shared"))
  await write(path.join(repo, ".mcode", "commands", "pair.md"), doc("repo pair"))
  await write(path.join(nested, ".mcode", "commands", "pair.md"), doc("nested pair"))
  await write(path.join(nested, ".mcode", "commands", "tier.md"), doc("tier", "model: ultra\n"))
  await write(path.join(nested, ".mcode", "commands", "literal.md"), doc("literal", "model: probe/stub/v2\n"))
  await write(path.join(nested, ".mcode", "commands", "group.md"), doc("group", "model: my-group\n"))
  await write(path.join(nested, ".mcode", "commands", "writes.md"), doc('made !`node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'1\');console.log(\'written\')"`'))
  // node prints the words the shell handed it, the same in any shell.
  const words = `node -e "console.log(process.argv.slice(1).join('|'))"`
  await write(path.join(nested, ".mcode", "commands", "echo.md"), doc(`A !\`${words} $1 $2\` B !\`${words} $ARGUMENTS\``))
  await write(path.join(nested, ".mcode", "commands", "slow.md"), doc('slow !`node -e "setTimeout(function(){console.log(42)},2000)"`'))
  await write(path.join(nested, ".mcode", "commands", "big.md"), doc('big !`node -e "process.stdout.write(String.fromCharCode(120).repeat(300000))"`'))
  await write(path.join(nested, ".mcode", "commands", "noisy.md"), doc('noisy [!`node -e "process.stdout.write(String.fromCharCode(111));process.stderr.write(String.fromCharCode(101));process.exit(3)"`]'))
  await write(path.join(nested, ".mcode", "commands", "missing.md"), doc("before [!`echo never`] after"))
  await write(path.join(nested, ".mcode", "commands", "files.md"), doc(`Read @notes.md and @src/a.ts. Skip @missing.txt, @src and me@example.com. !\`node -e "console.log('@later.md')"\``))
  await write(path.join(repo, "notes.md"), "notes\n")
  await write(path.join(repo, "src", "a.ts"), "export {}\n")
  await write(path.join(repo, "later.md"), "later\n")

  const defaultModel = { provider: "probe", model: "stub" }
  const deps = (shell = "") => ({
    config: { get: () => ({ model: defaultModel, shell, commands: { configured: { template: "from the config document" } } }) },
    mcp: { prompts: async () => ({ remote: { client: "srv", name: "remote", description: "mcp" } }), getPrompt: async () => "!`echo from-mcp`" },
    storage: { directory: storage },
    home,
  })
  const listed = await listCommands(deps() as never, nested)
  const named = (name: string) => listed.find((entry) => entry.name === name)
  check("listing never runs a placeholder", !(await fs.stat(path.join(nested, "ran.txt")).catch(() => undefined)) && Boolean(named("writes")))
  check("the global folder, the walk up to the repository root and .claude folders are all read", Boolean(named("global-only") && named("from-claude") && named("deploy/web") && named("configured")), listed.map((entry) => entry.name))
  check("the walk stops at the repository root", !named("above"))
  check("of two project folders the outer one wins a name, as MiMo merges them nearest first", named("pair")?.template === "repo pair", named("pair")?.template)
  check("the home .mcode wins over the project and global folders", named("shared")?.template === "home shared", named("shared")?.template)
  check("a .claude command loses a name to the global folder", named("global-only")?.template === "from the global folder", named("global-only")?.template)
  check("model: a tier name is the default model, provider/model splits on the first slash, another group maps to nothing", JSON.stringify(named("tier")?.model) === JSON.stringify(defaultModel) && named("literal")?.model?.model === "stub/v2" && named("group")?.model === undefined, [named("tier")?.model, named("literal")?.model, named("group")?.model])

  const expand = (name: string, args = "", shell = "") => expandCommand(deps(shell) as never, { directory: nested, name, arguments: args })
  const writes = await expand("writes")
  check("sending runs the placeholder, in the conversation's folder, and its output replaces it", writes.prompt === "made written" && Boolean(await fs.stat(path.join(nested, "ran.txt")).catch(() => undefined)), writes.prompt)
  const echoed = await expand("echo", 'one "x y"')
  check(
    "arguments are substituted before the shell runs, unescaped: $2 loses its quotes and splits, $ARGUMENTS keeps them",
    /^A one\|x\|y\r?\n B one\|x y$/.test(echoed.prompt),
    echoed.prompt,
  )
  const started = Date.now()
  const slow = await expand("slow")
  check("no timeout: a command that takes two seconds is still waited for", slow.prompt === "slow 42" && Date.now() - started >= 1900, { prompt: slow.prompt, ms: Date.now() - started })
  const big = await expand("big")
  check("no output cap: 300000 characters of output all go in", big.prompt.length === "big ".length + 300000, big.prompt.length)
  const noisy = await expand("noisy")
  check("stdout only: stderr is dropped and a failing exit code is ignored", noisy.prompt === "noisy [o]", noisy.prompt)
  const missing = await expand("missing", "", path.join(base, "no-such-shell", "bash.exe"))
  check("a shell that cannot start leaves the empty string", missing.prompt === "before [] after", missing.prompt)
  const files = await expand("files")
  check(
    "@file: existing files from the repository root, including one a placeholder printed; no folders, no missing files, no emails",
    files.files.map((file) => file.name).join("|") === "notes.md|src/a.ts|later.md" && files.files[0]!.path === path.join(repo, "notes.md"),
    files.files,
  )
  const refused = await expand("remote").then(() => "", (err: Error) => err.message)
  check("an MCP prompt is not a command whose placeholders run", refused.includes("/remote"), refused)
  check("the window's own fill-in of a template never runs anything", expandTemplate("a !`echo no` $1", "b") === "a !`echo no` b")
}

/** tasks: MiMo's task registry, as pure changes to a list. */
function taskChecks() {
  section("Tasks (registry)")
  let list: TaskItem[] = []
  const main = { owner: "main", subagent: false, now: 1000 }
  const act = (input: Record<string, unknown>, who = main) => {
    const applied = applyTask(list, input, who)
    list = applied.tasks
    return applied.result
  }
  const refused = (input: Record<string, unknown>) => {
    try {
      act(input)
      return ""
    } catch (err) {
      return (err as Error).message
    }
  }
  act({ action: "create", summary: "Alpha" })
  act({ action: "create", summary: "Beta" })
  act({ action: "create", summary: "Alpha one", parent_id: "T1" })
  const second = act({ action: "create", summary: "Alpha two", parent_id: "T1" })
  check("ids are T1, T2 at the top and T1.1, T1.2 under a task", list.map((task) => task.id).join() === "T1,T2,T1.1,T1.2" && second.output === "Created T1.2 (open): Alpha two", list.map((task) => task.id))
  check("the next id is one past the highest used at that level", nextTaskID("T1", ["T1.1", "T1.3", "T1.3.1"]) === "T1.4" && nextTaskID(undefined, ["T1", "T3", "T3.1"]) === "T4")
  act({ action: "start", id: "T1" })
  check("start marks a task in progress for whoever starts it", list[0]?.status === "in_progress" && list[0].owner === "main")
  check("starting one already in progress changes nothing", act({ action: "start", id: "T1" }).output.includes("already"))
  act({ action: "start", id: "T1" }, { owner: "general-1", subagent: true, now: 1100 })
  check("a subagent starting a task someone else holds leaves it with its holder", list[0]?.owner === "main")
  act({ action: "block", id: "T2", event_summary: "waiting on a reply" })
  check("block marks a task blocked and keeps the note", list[1]?.status === "blocked" && list[1].note === "waiting on a reply")
  act({ action: "unblock", id: "T2" })
  check("unblock puts it back to open", list[1]?.status === "open")
  act({ action: "done", id: "T1.1" }, { ...main, now: 2000 })
  act({ action: "abandon", id: "T1.2" }, { ...main, now: 2000 })
  check("done and abandon end a task", list[2]?.status === "done" && list[2].ended === 2000 && list[3]?.status === "abandoned")
  check("a finished task is not started again", act({ action: "start", id: "T1.1" }).output.includes("left as it is") && list[2]?.status === "done")
  act({ action: "rename", id: "T2", summary: "Beta, renamed" })
  check("rename changes the summary", list[1]?.summary === "Beta, renamed")
  check("list shows open, in-progress and blocked tasks unless asked for more", act({ action: "list" }).output === "T1 in_progress - Alpha\nT2 open - Beta, renamed")
  check("include_terminal adds done and abandoned ones, and status filters", act({ action: "list", include_terminal: true }).output.split("\n").length === 4 && act({ action: "list", status: "open" }).output === "T2 open - Beta, renamed")
  check("finished tasks drop out after a week unless archived ones are asked for", listedTasks(list, { includeTerminal: true }, 2000 + TASK_ARCHIVE_MS).length === 2 && listedTasks(list, { includeTerminal: true, includeArchived: true }, 2000 + TASK_ARCHIVE_MS).length === 4)
  check("get shows a task in full, and an unknown one says so without failing", JSON.parse(act({ action: "get", id: "T2" }).output).summary === "Beta, renamed" && act({ action: "get", id: "T7" }).output.includes("no task T7"))
  check("changing a task that does not exist is refused", refused({ action: "done", id: "T7" }).includes("no task T7") && refused({ action: "launch" }).includes("Unknown action"))
  check("the task tool replaces todowrite, and its permission row goes with it", Boolean(findTool("task")) && !findTool("todowrite") && !(PERMISSION_KINDS as readonly string[]).includes("todowrite"))
}

/** skills: where they are found, what their frontmatter may say, and how they reach the slash list. */
async function skillChecks(root: string) {
  section("Skills (discovery and frontmatter)")
  const read = parseFrontmatter(
    [
      "---",
      "name: demo",
      'description: "Makes: things"',
      "aliases: [one, 'two', \"three\"]",
      "tags:",
      "  - a",
      "  - b",
      "disable-model-invocation: true",
      "long: first part",
      "  second part",
      "folded: >-",
      "  line one",
      "  line two",
      "literal: |",
      "  keep",
      "  lines",
      "metadata:",
      "  author: me",
      "  version: 1.0.0",
      "---",
      "Body here",
    ].join("\n"),
  )
  check("frontmatter reads quoted, listed, flagged and multi-line values", !read.error && read.data.description === "Makes: things" && JSON.stringify(read.data.aliases) === '["one","two","three"]' && JSON.stringify(read.data.tags) === '["a","b"]' && read.data["disable-model-invocation"] === true, read)
  check("a plain value carried over lines folds, `>-` folds and `|` keeps its lines", read.data.long === "first part second part" && read.data.folded === "line one line two" && read.data.literal === "keep\nlines\n", read.data)
  check("a one-level map is read and the body follows the block", (read.data.metadata as Record<string, unknown>)?.author === "me" && read.body === "Body here", read)
  check("frontmatter that is not key: value is an error, not a half-read", Boolean(parseFrontmatter("---\nname: x\nthis is not yaml\n---\nbody").error))
  check("a file with no frontmatter is all body", parseFrontmatter("# Title\n").body === "# Title\n")

  const base = path.join(root, "skills-case")
  const builtin = path.join(base, "builtin")
  const storage = path.join(base, "storage")
  const outer = path.join(base, "outer")
  const repo = path.join(outer, "repo")
  const nested = path.join(repo, "packages", "app")
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }
  const skill = (name: string, description: string | undefined, extra = "", body = `Body of ${name}.`) =>
    `---\nname: ${name}\n${description === undefined ? "" : `description: ${description}\n`}${extra}---\n${body}\n`
  await write(path.join(builtin, "alpha", "SKILL.md"), skill("alpha", "shipped alpha"))
  await write(path.join(builtin, "shipped", "SKILL.md"), skill("shipped", "only shipped"))
  await write(path.join(storage, "skills", "alpha", "SKILL.md"), skill("alpha", "user alpha"))
  await write(path.join(storage, "skill", "beta", "SKILL.md"), skill("beta", "global beta", "aliases:\n  - bee\n"))
  await fs.mkdir(path.join(repo, ".git"), { recursive: true })
  await write(path.join(repo, ".mcode", "skills", "gamma", "SKILL.md"), skill("gamma", "repo gamma"))
  await write(path.join(nested, ".mcode", "skill", "gamma", "SKILL.md"), skill("gamma", "nested gamma"))
  await write(path.join(nested, ".mcode", "skills", "hidden", "SKILL.md"), skill("hidden", "user only", "disable-model-invocation: true\n"))
  await write(path.join(nested, ".mcode", "skills", "folder-x", "SKILL.md"), skill("renamed", "mismatched"))
  await write(path.join(nested, ".mcode", "skills", "nodesc", "SKILL.md"), skill("nodesc", undefined))
  await write(path.join(nested, ".claude", "skills", "claude-one", "SKILL.md"), skill("claude-one", "from claude"))
  await write(path.join(nested, ".agents", "skills", "agents-one", "SKILL.md"), skill("agents-one", "from agents"))
  await write(path.join(outer, ".mcode", "skills", "above", "SKILL.md"), skill("above", "above the repository"))

  const found = await discoverSkills({ directory: nested, storageDirectory: storage, builtinRoot: builtin })
  const named = (name: string) => found.skills.find((entry) => entry.name === name)
  check("shipped, global and project skills are all found", Boolean(named("shipped") && named("beta") && named("gamma")), found.skills.map((entry) => entry.name))
  check("a user skill replaces a shipped one of the same name", named("alpha")?.description === "user alpha" && named("alpha")?.builtin === false, named("alpha"))
  check("a shipped skill is marked built-in", named("shipped")?.builtin === true)
  check("the nearer project folder wins a name", named("gamma")?.description === "nested gamma", named("gamma"))
  check("aliases are read as a list", JSON.stringify(named("beta")?.aliases) === '["bee"]', named("beta"))
  check("disable-model-invocation is read", named("hidden")?.disableModelInvocation === true)
  check(".claude and .agents folders are not read, as MiMo's desktop turns them off", !named("claude-one") && !named("agents-one"))
  check("the walk stops at the repository root", !named("above"))
  check("a skill with no description is skipped and reported", !named("nodesc") && found.problems.some((problem) => problem.path.includes("nodesc") && /description/.test(problem.message)), found.problems)
  check("a name that does not match its folder is reported but still loads", Boolean(named("renamed")) && found.problems.some((problem) => problem.path.includes("folder-x")), found.problems)
  check("the body is the content, frontmatter removed", named("gamma")?.content.trim() === "Body of gamma.", named("gamma")?.content)
  check("a found skill's folder is not outside the project", isSkillPath(path.join(named("gamma")!.directory, "scripts", "x.py")) && !isSkillPath(path.join(base, "elsewhere")))

  process.env.MCODE_BUILTIN_SKILLS = builtin
  try {
    const commands = await listCommands(
      { config: { get: () => ({}) }, mcp: { prompts: async () => ({}), getPrompt: async () => "" }, storage: { directory: storage } },
      nested,
    )
    const slash = (name: string) => commands.find((entry) => entry.name === name)
    check("a skill's command template is its body only", slash("gamma")?.template.trim() === "Body of gamma." && !slash("gamma")?.template.includes("Base directory"), slash("gamma"))
    check("a shipped skill's command is marked built-in and a user one is not", slash("shipped")?.builtin === true && !slash("gamma")?.builtin, [slash("shipped"), slash("gamma")])
    check("a user-only skill is still in the slash list", slash("hidden")?.source === "skill")
  } finally {
    delete process.env.MCODE_BUILTIN_SKILLS
  }

  section("Skills (tools, prompt and /name)")
  const skills = found.skills
  const toolContext = { skills: async () => skills } as never
  for (let at = 0; at < 12; at++) await write(path.join(named("gamma")!.directory, "scripts", `s${String(at).padStart(2, "0")}.py`), "print(1)\n")
  const loaded = await SkillTool.execute({ name: "gamma" }, toolContext)
  check("skill loads a skill's instructions with its folder", loaded.output.includes("Body of gamma.") && loaded.output.includes("loaded_skill") && loaded.output.includes("file:"), loaded.output)
  check("skill lists at most ten of its files, never SKILL.md itself", (loaded.output.match(/<file>/g) ?? []).length === SKILL_FILE_SAMPLE && !/<file>[^<]*SKILL\.md</.test(loaded.output))
  check("a load is titled by the skill", loaded.title === "gamma")
  const refusal = await SkillTool.execute({ name: "hidden" }, toolContext).then(() => "", (err: Error) => err.message)
  check("skill refuses a user-only skill and says to type /name", refusal.includes("/hidden"), refusal)
  const unknown = await SkillTool.execute({ name: "nope" }, toolContext).then(() => "", (err: Error) => err.message)
  check("an unknown name lists the skills that can be loaded, without the user-only ones", unknown.includes("gamma") && !unknown.includes("hidden"), unknown)
  check("MiMo's search figures: three results, 0.85 loads, BM25 1.5 / 0.75 / 0.5, weights 0.55 and 0.35", SEARCH.maxResults === 3 && SEARCH.autoLoad === 0.85 && SEARCH.k1 === 1.5 && SEARCH.lengthWeight === 0.75 && SEARCH.smoothing === 0.5 && SEARCH.scoreWeight === 0.55 && SEARCH.coverageWeight === 0.35)
  check("search words drop a plural s and read Chinese in pairs", searchTokens("documents 表格处理").join() === "document,表格,格处,处理", searchTokens("documents 表格处理"))
  const byAlias = await SkillSearchTool.execute({ query: "I need the bee skill" }, toolContext)
  check("a query naming an alias loads that skill outright", byAlias.metadata?.loaded === "beta" && byAlias.output.includes("Body of beta."), byAlias.metadata)
  const none = await SkillSearchTool.execute({ query: "zzzz qqqq" }, toolContext)
  check("a query matching nothing says no_match", JSON.parse(none.output).status === "no_match")
  check("search never returns a user-only skill", !searchSkills("user only hidden", skills.filter((entry) => !entry.disableModelInvocation)).some((entry) => entry.name === "hidden") && (await SkillSearchTool.execute({ query: "hidden user only" }, toolContext)).metadata?.loaded !== "hidden")
  check("search keeps at most three results", searchSkills("skill", skills.map((entry) => ({ ...entry, description: "skill skill" }))).length <= 3)

  const once = skillReminders("/gamma please, and `/beta` in code\n```\n/alpha\n```", skills)
  check("/name in a message loads that skill, but not a name inside code", once.length === 1 && once[0]!.includes("Body of gamma."), once)
  check("a user-only skill loads when the user types its name", skillReminders("run /hidden now", skills).some((entry) => entry.includes("Body of hidden.")))
  const many = skillReminders("/alpha /beta /gamma /shipped go", skills)
  check("up to three load, and naming several adds a note that names the one left out", many.length === 4 && many.filter((entry) => entry.includes("loaded_skill")).length === 3 && many[3]!.includes("shipped"), many.length)
  check("a path is not a skill", skillReminders("see src/gamma and C:/gamma", skills).length === 0)
  const sent = withSkillReminders([{ role: "user", text: "hi", reminders: ["R1"] }, { role: "assistant" }])
  check("the model reads a message's reminders after its words; the transcript keeps the words", sent[0]!.text === "hi\n\nR1" && sent[1]!.role === "assistant")

  const prompt = await systemPrompt({ directory: nested, agent: "build", skills })
  check("the prompt lists the skills the model may load, with where each lives", prompt.includes("<name>gamma</name>") && prompt.includes("nested gamma") && prompt.includes("<location>file:") && !prompt.includes("<name>hidden</name>"))
  check("with none to list, the prompt says so", (await systemPrompt({ directory: nested, agent: "build", skills: [] })).includes("No skills are available"))
  const skillAt = TOOLS.findIndex((tool) => tool.name === "skill_search")
  check(
    "skill and skill_search are offered, appended, and change nothing",
    TOOLS[skillAt - 1]?.name === "update_session" &&
      TOOLS[skillAt + 1]?.name === "skill" &&
      // Only tools added since (history, memory, cron, scheduled tasks, plan_exit, multiedit and speak) come after them.
      TOOLS.slice(skillAt + 2).every((tool) => ["history", "memory", "cron", "automation_update", "plan_exit", "multiedit", "speak"].includes(tool.name)) &&
      reachOf("skill") === "reads" &&
      reachOf("skill_search") === "reads",
    TOOLS.map((tool) => tool.name),
  )
  check("plan keeps both skill tools", toolsFor("plan").some((tool) => tool.name === "skill") && toolsFor("plan").some((tool) => tool.name === "skill_search"))
  const skillPart = (name: string, input: Record<string, unknown>): ToolPart => ({ type: "tool", id: name, callID: name, name, status: "completed", input, time: { created: 1 } })
  check("MiMo's step words and titles for a load and a search", skillToolVerb("skill", "completed") === translate("toolLabel.done.skill") && skillToolVerb("skill_search", "running") === translate("toolLabel.running.skill_search") && skillStepTitle(skillPart("skill", { name: "gamma" })) === "gamma" && skillStepTitle(skillPart("skill_search", { query: "make a deck" })) === "make a deck")

  section("Skills (built-in, and the office document hint)")
  const shippedRoot = builtinSkillsRoot()
  const shipped = await discoverSkills({ directory: nested, storageDirectory: path.join(base, "no-storage") })
  const shippedSkills = shipped.skills.filter((entry) => entry.builtin)
  const shippedNames = shippedSkills.map((entry) => entry.name)
  check("the app ships its own skills, Word, Excel, PowerPoint and PDF among them", Boolean(shippedRoot) && ["docx", "xlsx", "pptx", "pdf"].every((name) => shippedNames.includes(name)) && shippedNames.length >= 10, shippedNames)
  check("every shipped skill loads without a problem", !shipped.problems.some((problem) => shippedRoot && problem.path.startsWith(shippedRoot)), shipped.problems)
  const mentionedFiles = shippedSkills.flatMap((entry) =>
    [...entry.content.matchAll(/(?<![\w/.-])((?:scripts|references|assets)\/[\w./-]+\w)/g)].map((match) => path.join(entry.directory, match[1]!)),
  )
  const absentFiles = (await Promise.all(mentionedFiles.map((file) => fs.access(file).then(() => "", () => file)))).filter(Boolean)
  check("every script a shipped skill tells the model to run is shipped with it", mentionedFiles.length >= 6 && absentFiles.length === 0, absentFiles)
  const hinted = skillReminders("please look", shippedSkills, [
    { path: "C:/in/report.DOCX", mime: "" },
    { path: "numbers.csv", mime: "text/plain" },
    { path: "scan", mime: "application/pdf" },
    { path: "notes.txt", mime: "text/plain" },
  ])
  check(
    "attaching Word, a CSV and a PDF points the model at those skills' SKILL.md, and at nothing else",
    hinted.length === 1 && /- docx: .*SKILL\.md/.test(hinted[0]!) && /- xlsx: /.test(hinted[0]!) && /- pdf: /.test(hinted[0]!) && !/- pptx: /.test(hinted[0]!),
    hinted,
  )
  check("with no office document attached, no hint", skillReminders("hello", shippedSkills, [{ path: "a.png", mime: "image/png" }]).length === 0)
  const hintThenSkill = skillReminders("/pdf now", shippedSkills, [{ path: "a.pptx", mime: "" }])
  check("the hint comes before a skill the message loads", hintThenSkill.length === 2 && hintThenSkill[0]!.includes("- pptx:") && hintThenSkill[1]!.includes("loaded_skill"), hintThenSkill.length)
}

/**
 * subagents: the task tool through the real runner, store, permissions and
 * provider adapter, with the provider played by a local server.
 *
 * The fake tells a subagent's request from its parent's by the note a subagent
 * is given, and reads its orders from the subagent's prompt: `ANSWER:x` replies
 * x, `SLOW` streams until it is stopped, `PERM` runs a command that has to be
 * approved. A parent asks for whatever calls `parentCalls` holds, then replies.
 */
/*
 * MiMo's project list: filled once from the folders conversations live in,
 * then kept on its own - a folder can be a project with no conversation, and
 * removing one keeps its conversations.
 */
async function projectListChecks() {
  section("Pull-request row (MiMo's GitHub lookup, stubbed: no network)")
  {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    check("scp remote parses", same(githubRepository("git@github.com:octo/hello.git"), { owner: "octo", repo: "hello" }))
    check("https remote parses, credentials ignored", same(githubRepository("https://user:secret@github.com/octo/hello.git"), { owner: "octo", repo: "hello" }))
    check("ssh URL remote parses", same(githubRepository("ssh://git@github.com/octo/hello"), { owner: "octo", repo: "hello" }))
    check("a trailing slash is fine", same(githubRepository("https://github.com/octo/hello/"), { owner: "octo", repo: "hello" }))
    check("GitLab is not GitHub", githubRepository("git@gitlab.com:octo/hello.git") === null)
    check("a look-alike host is not GitHub", githubRepository("https://github.com.evil.example/octo/hello") === null)
    check("http (not https) is refused", githubRepository("http://github.com/octo/hello") === null)
    check("three path parts are not a repository", githubRepository("https://github.com/octo/hello/tree") === null)
    check("odd characters are refused", githubRepository("https://github.com/octo/hel%20lo") === null && githubRepository("git@github.com:octo/..") === null)
    check("empty and junk are refused", githubRepository("") === null && githubRepository("not a url") === null)

    const repo = { owner: "octo", repo: "hello" }
    const item = (over: Record<string, unknown>) => ({ number: 7, title: "Fix it", html_url: "https://github.com/octo/hello/pull/7", state: "open", draft: false, merged_at: null, ...over })
    check("an empty list is none", same(pullRequestFrom([], repo), { ok: true, kind: "none" }))
    check("open maps to open", same(pullRequestFrom([item({})], repo), { ok: true, kind: "open", number: 7, title: "Fix it", url: "https://github.com/octo/hello/pull/7" }))
    check("draft wins over open", (pullRequestFrom([item({ draft: true })], repo) as { kind: string }).kind === "draft")
    check("closed with merged_at is merged", (pullRequestFrom([item({ state: "closed", merged_at: "2026-01-01T00:00:00Z" })], repo) as { kind: string }).kind === "merged")
    check("closed without merged_at is closed", (pullRequestFrom([item({ state: "closed" })], repo) as { kind: string }).kind === "closed")
    check("a page on another repository is refused", same(pullRequestFrom([item({ html_url: "https://github.com/evil/hello/pull/7" })], repo), { ok: false, code: "bad-response" }))
    check("a page whose number differs is refused", same(pullRequestFrom([item({ html_url: "https://github.com/octo/hello/pull/8" })], repo), { ok: false, code: "bad-response" }))
    check("a non-list body is refused", same(pullRequestFrom({ message: "x" }, repo), { ok: false, code: "bad-response" }))

    const asked: { url: string; headers: Record<string, string> }[] = []
    const answering = (status: number, body: unknown): FetchLike => async (url, init) => {
      asked.push({ url, headers: init.headers })
      return { ok: status >= 200 && status < 300, status, json: async () => body }
    }
    const open = await askGithub("git@github.com:octo/hello.git", "feature/x", answering(200, [item({})]))
    check("askGithub maps the stubbed answer", (open as { kind?: string }).kind === "open", open)
    const first = asked[0]
    check(
      "the request names the branch under the owner, with MiMo's query and no credentials",
      !!first &&
        first.url === "https://api.github.com/repos/octo/hello/pulls?state=all&head=octo%3Afeature%2Fx&per_page=10" &&
        first.headers.Accept === "application/vnd.github+json" &&
        !Object.keys(first.headers).some((name) => name.toLowerCase() === "authorization"),
      first,
    )
    check("403 is rate-limited", same(await askGithub("git@github.com:octo/hello.git", "main", answering(403, {})), { ok: false, code: "rate-limited" }))
    check("404 is unauthorized", same(await askGithub("git@github.com:octo/hello.git", "main", answering(404, {})), { ok: false, code: "unauthorized" }))
    const throwing: FetchLike = async () => {
      throw new Error("offline")
    }
    check("a thrown fetch is network", same(await askGithub("git@github.com:octo/hello.git", "main", throwing), { ok: false, code: "network" }))
    let fetched = 0
    const counting: FetchLike = async () => {
      fetched++
      return { ok: true, status: 200, json: async () => [] }
    }
    check("a GitLab remote is never fetched", same(await askGithub("git@gitlab.com:octo/hello.git", "main", counting), { ok: false, code: "unsupported-remote" }) && fetched === 0)

    const gitWith = (answers: Record<string, string | Error>): GitRunner => async (_directory, args) => {
      const answer = answers[args.join(" ")]
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error("unexpected")
      return answer
    }
    const repoGit = (remotes: string, branch = "main") =>
      gitWith({ "rev-parse --is-inside-work-tree": "true\n", "symbolic-ref --quiet --short HEAD": branch ? `${branch}\n` : new Error("detached"), "remote -v": remotes })
    const originOnly = "origin\tgit@github.com:fork/hello.git (fetch)\norigin\tgit@github.com:fork/hello.git (push)\n"
    check("hasGithubRemote sees a GitHub origin", hasGithubRemote(originOnly) && !hasGithubRemote("origin\thttps://gitlab.com/a/b.git (fetch)\n") && !hasGithubRemote(""))
    fetched = 0
    check("outside a repository nothing is fetched", same(await pullRequestState("x", { git: gitWith({}), fetch: counting }), { ok: false, code: "not-a-repo" }) && fetched === 0)
    check("a detached HEAD is detached", same(await pullRequestState("x", { git: repoGit(originOnly, ""), fetch: counting }), { ok: false, code: "detached" }) && fetched === 0)
    check("no origin is no-remote", same(await pullRequestState("x", { git: repoGit(""), fetch: counting }), { ok: false, code: "no-remote" }) && fetched === 0)
    check(
      "a non-GitHub origin is unsupported, unfetched",
      same(await pullRequestState("x", { git: repoGit("origin\thttps://gitlab.com/a/b.git (fetch)\n"), fetch: counting }), { ok: false, code: "unsupported-remote" }) && fetched === 0,
    )
    asked.length = 0
    const forked = `${originOnly}upstream\thttps://github.com/octo/hello.git (fetch)\n`
    const upstreamHit: FetchLike = async (url, init) => {
      asked.push({ url, headers: init.headers })
      const body = url.includes("/repos/octo/hello/") ? [item({})] : []
      return { ok: true, status: 200, json: async () => body }
    }
    const fork = await pullRequestState("x", { git: repoGit(forked, "topic"), fetch: upstreamHit })
    check("a fork asks upstream first, with origin's owner as head", (fork as { kind?: string }).kind === "open" && asked.length === 1 && (asked[0]?.url.includes("head=fork%3Atopic") ?? false), asked)
    check("none from every repository is none", same(await pullRequestState("x", { git: repoGit(originOnly), fetch: answering(200, []) }), { ok: true, kind: "none" }))
  }

  section("Project list")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-projects-"))
  const data = path.join(root, "data")
  const folder = (name: string) => path.join(root, name)
  for (const name of ["older", "newer", "archived", "closed", "fresh", "made"]) await fs.mkdir(folder(name), { recursive: true })
  const model = { provider: "anthropic", model: "claude-opus-5" }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 15))
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const ask = async <T extends keyof ResponseMap>(runtime: Parameters<typeof handle>[0], request: Parameters<typeof handle>[1] & { type: T }) =>
    (await handle(runtime, request)) as ResponseMap[T]

  // A profile written before the list existed: conversations, a name, a pin, a removed folder, a dragged order.
  const first = await startBackend(data)
  const older = await first.runtime.sessions.create({ directory: folder("older"), model })
  await tick()
  const newer = await first.runtime.sessions.create({ directory: folder("newer"), model })
  await tick()
  const archived = await first.runtime.sessions.create({ directory: folder("archived"), model })
  await first.runtime.sessions.update(archived.id, { archived: true })
  await first.runtime.sessions.create({ directory: folder("closed"), model })
  await ask(first.runtime, { type: "session.create", scratch: true })
  const legacy: Partial<AppConfig> = {
    ...first.runtime.config.get(),
    projectNames: { [folder("older")]: "Old one" },
    projectIcons: { [folder("older")]: "data:image/png;base64,AA==" },
    projectColors: { [folder("newer")]: "120" },
    pinnedProjects: [folder("older")],
    closedProjects: [folder("closed")],
    projectOrder: [folder("older"), folder("newer")],
  }
  delete legacy.projects
  legacy.migrations = (legacy.migrations ?? []).filter((name) => name !== PROJECT_LIST_MIGRATION)
  await first.runtime.storage.write("config", legacy)
  await first.close()

  const second = await startBackend(data)
  const runtime = second.runtime
  const migrated = runtime.config.get()
  check(
    "migration makes every folder with live conversations a project, newest first",
    same(migrated.projects, [folder("newer"), folder("older")]),
    migrated.projects,
  )
  check(
    "migration leaves names, icons, colours, pins, removed folders and the dragged order as they were",
    migrated.projectNames[folder("older")] === "Old one" &&
      migrated.projectIcons[folder("older")] === "data:image/png;base64,AA==" &&
      migrated.projectColors[folder("newer")] === "120" &&
      same(migrated.pinnedProjects, [folder("older")]) &&
      same(migrated.closedProjects, [folder("closed")]) &&
      same(migrated.projectOrder, [folder("older"), folder("newer")]),
    migrated,
  )
  check("migration is recorded so it runs once", (migrated.migrations ?? []).includes(PROJECT_LIST_MIGRATION), migrated.migrations)

  // Adding a folder lists it and makes no conversation.
  const before = (await runtime.sessions.list()).length
  const added = await ask(runtime, { type: "project.add", directory: folder("fresh") })
  check(
    "adding a folder puts it first on the list with no conversation made",
    added.existed === false && added.config.projects[0] === folder("fresh") && (await runtime.sessions.list()).length === before,
    { projects: added.config.projects, existed: added.existed },
  )
  const again = await ask(runtime, { type: "project.add", directory: folder("fresh") })
  check("adding a listed folder again says it existed and changes nothing", again.existed === true && same(again.config.projects, added.config.projects), again.config.projects)
  const sessions = await runtime.sessions.list()
  const recency = projectsByRecency(again.config, sessions)
  check("an empty project that was never picked sits after projects with activity", recency[recency.length - 1] === folder("fresh"), recency)
  const picked = await ask(runtime, { type: "project.add", directory: folder("fresh"), used: true })
  check("a folder added as the pick heads the recency order", projectsByRecency(picked.config, sessions)[0] === folder("fresh"), projectsByRecency(picked.config, sessions))

  // Removing: off the list, hidden, unpinned, out of the order; its conversations stay.
  const removed = await ask(runtime, { type: "project.remove", directories: [folder("older")] })
  check(
    "removing takes the folder off the list, hides it, unpins it and drops it from the dragged order",
    !removed.config.projects.includes(folder("older")) &&
      removed.config.closedProjects.includes(folder("older")) &&
      !removed.config.pinnedProjects.includes(folder("older")) &&
      !removed.config.projectOrder.includes(folder("older")),
    removed.config,
  )
  check("removing a project keeps its conversations", Boolean(await runtime.sessions.get(older.id)))
  await ask(runtime, { type: "session.create", directory: folder("older") })
  check("a conversation in a removed folder does not list it again", !listedProjects(runtime.config.get()).includes(folder("older")), runtime.config.get().projects)
  const back = await ask(runtime, { type: "project.add", directory: folder("older") })
  check("adding a removed folder brings it back", back.existed === false && back.config.projects[0] === folder("older") && !back.config.closedProjects.includes(folder("older")), back.config.projects)

  // A conversation in a folder the list does not know makes it a project, listed before the session exists.
  const order: string[] = []
  const unsubscribe = runtime.bus.subscribe((event) => {
    if (event.type === "config.updated" && event.config.projects.includes(folder("made"))) order.push("config")
    if (event.type === "session.updated" && event.session.directory === folder("made")) order.push("session")
  })
  const made = await ask(runtime, { type: "session.create", directory: folder("made") })
  unsubscribe?.()
  check("a conversation in an unknown folder adds its project", runtime.config.get().projects.includes(folder("made")) && made.session.directory === folder("made"), runtime.config.get().projects)
  check("the project is announced before its first conversation", order[0] === "config", order)
  const listedBefore = runtime.config.get().projects
  await ask(runtime, { type: "session.create", scratch: true })
  check("a task with no project adds nothing", same(runtime.config.get().projects, listedBefore), runtime.config.get().projects)

  // A write that only takes a folder out of the removed set, as older callers make, lists it again.
  await runtime.config.set({ closedProjects: [...runtime.config.get().closedProjects, folder("newer")] })
  check("putting a folder in the removed set takes it off the list", !runtime.config.get().projects.includes(folder("newer")), runtime.config.get().projects)
  await runtime.config.set({ closedProjects: runtime.config.get().closedProjects.filter((entry) => entry !== folder("newer")) })
  check("taking a folder out of the removed set lists it first", runtime.config.get().projects[0] === folder("newer"), runtime.config.get().projects)

  // The list and the dragged order survive a restart, and the migration does not run again.
  await runtime.config.set({ projectOrder: [folder("made"), folder("fresh")] })
  const kept = runtime.config.get()
  await second.close()
  const third = await startBackend(data)
  const reloaded = third.runtime.config.get()
  check(
    "the project list and its dragged order survive a restart",
    same(reloaded.projects, kept.projects) && same(reloaded.projectOrder, [folder("made"), folder("fresh")]),
    { before: kept.projects, after: reloaded.projects, order: reloaded.projectOrder },
  )
  await third.close()
  await fs.rm(root, { recursive: true, force: true })

  // Pure pieces.
  check(
    "reconciling keeps the list and the removed set apart",
    same(reconciledProjects({ projects: ["a", "b"], closedProjects: ["c"] }, { projects: ["a", "b"], closedProjects: ["c", "b"] }), ["a"]) &&
      same(reconciledProjects({ projects: ["a"], closedProjects: ["c"] }, { projects: ["a"], closedProjects: [] }), ["c", "a"]),
  )
  check(
    "recency ties keep the stored order",
    same(projectsByRecency({ projects: ["x", "y", "z"], closedProjects: ["y"], projectUsed: {} }, []), ["x", "z"]),
  )
}

async function deliveredToolChecks(root: string) {
  section("Round 4: pdf_locate, present_files and the desktop settings tools")
  const project = path.join(root, "delivered")
  await fs.mkdir(path.join(project, "out"), { recursive: true })
  await fs.writeFile(path.join(project, "out", "report.pdf"), "%PDF-1.4\n")
  await fs.writeFile(path.join(project, "page.html"), "<h1>hi</h1>")
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-delivered-outside-"))
  await fs.writeFile(path.join(outside, "elsewhere.pdf"), "x")
  const context = (callID: string) =>
    ({
      sessionID: "ses_delivered",
      messageID: "msg_delivered",
      callID,
      directory: project,
      signal: new AbortController().signal,
      progress: () => {},
      snapshot: async () => {},
    }) as never
  const names = ["pdf_locate", "present_files", "get_desktop_settings", "set_desktop_setting"]

  // The registry: appended after the task tool, no permission bucket, nothing to record in undo.
  // Read from task rather than from the end: tools appended after these (session chat's) leave the prefix as it was.
  const taskAt = TOOLS.findIndex((tool) => tool.name === "actor")
  check("the four window tools are appended after actor, keeping the cached prefix", taskAt >= 0 && TOOLS.slice(taskAt, taskAt + 5).map((tool) => tool.name).join(",") === ["actor", ...names].join(","), TOOLS.map((tool) => tool.name))
  check("none of them asks for permission, as MiMo asks none", names.every((name) => findTool(name)?.permission === undefined))
  check("none of them counts as touching the project", names.every((name) => reachOf(name) === "reads"))

  // pdf_locate: MiMo's parameters, a confirmation, and the target for the preview.
  const locateTool = findTool("pdf_locate")!
  const locate = await locateTool.execute({ file: "out/report.pdf", snippet: "x".repeat(80), page: 3 }, context("l1"))
  check(
    "pdf_locate resolves the file against the project and names the page it sent the preview to",
    locate.metadata?.path === path.join(project, "out", "report.pdf") && locate.metadata?.page === 3 && locate.output.includes('"report.pdf"') && locate.output.includes("page 3"),
    locate,
  )
  check("its title is the passage's first 60 characters", locate.title === "x".repeat(60), locate.title)
  const unpaged = await locateTool.execute({ file: path.join(project, "gone.pdf"), snippet: "a" }, context("l2"))
  check("a PDF that is not there is no failure (the preview ignores it) and no page is made up", unpaged.metadata?.page === undefined && !unpaged.output.includes("page"), unpaged)
  check("pdf_locate without a snippet is refused before it runs", argumentProblems(locateTool.parameters, { file: "a.pdf" }).some((problem) => problem.includes("snippet")))
  check("a page that is not a number is refused", argumentProblems(locateTool.parameters, { file: "a.pdf", snippet: "b", page: "3" }).length === 1)

  // present_files: existing files inside the project, in order, each once; the rest skipped with a reason.
  const presentTool = findTool("present_files")!
  const presented = await presentTool.execute(
    {
      files: ["out/report.pdf", "page.html", "missing.docx", path.join(outside, "elsewhere.pdf"), "out", "https://example.com/a", "./out/report.pdf"],
      cwd: project,
      explanation: "probe",
    },
    context("p1"),
  )
  const shown = (presented.metadata?.files ?? []) as PresentedFile[]
  const skipped = (presented.metadata?.skipped ?? []) as PresentSkip[]
  check(
    "present_files keeps the existing files and addresses, in the order given, each once",
    shown.map((file) => ("path" in file ? path.basename(file.path) : file.url)).join(",") === "report.pdf,page.html,https://example.com/a",
    shown,
  )
  check("it records each file's absolute path and size", "path" in shown[0] && shown[0].path === path.join(project, "out", "report.pdf") && shown[0].size === 9, shown[0])
  check("a missing file, one outside the project and a folder are skipped, each with its reason", skipped.map((skip) => skip.reason).join(",") === "missing,outside,directory", skipped)
  check("the model reads what was shown and what was skipped", presented.output.startsWith("Showed 3 files") && presented.output.includes('Skipped "missing.docx"'), presented.output)
  const relative = await presentTool.execute({ files: ["report.pdf"], cwd: "out", explanation: "x" }, context("p2"))
  check("a relative cwd is taken from the project folder", ((relative.metadata?.files ?? []) as PresentedFile[]).length === 1, relative.metadata)
  const empty = await presentTool.execute({ files: [], cwd: project, explanation: "x" }, context("p3"))
  check("nothing to present completes with no files", empty.output.startsWith("No files") && ((empty.metadata?.files ?? []) as PresentedFile[]).length === 0)
  check("present_files needs files, cwd and explanation, as MiMo's does", argumentProblems(presentTool.parameters, { files: ["a"] }).length === 2)
  const linked = path.join(project, "link")
  // The link points only at `outside`, a fresh temp folder holding one file made above - never the repo or a real project.
  const madeLink = await fs.symlink(outside, linked, "junction").then(() => true, () => false)
  if (madeLink) {
    try {
      const through = await presentTool.execute({ files: ["link/elsewhere.pdf"], cwd: project, explanation: "x" }, context("p4"))
      check("a link inside the project that leads out is judged by where it leads", ((through.metadata?.skipped ?? []) as PresentSkip[])[0]?.reason === "outside", through.metadata)
    } finally {
      /*
       * Only the link entry is removed, never what it points at: unlink, or a
       * non-recursive rmdir, both delete a junction itself. Then it is checked
       * gone, and the run stops here if not, before any recursive delete below
       * could walk through it.
       */
      await fs.unlink(linked).catch(() => fs.rmdir(linked)).catch(() => undefined)
      const left = await fs.lstat(linked).then(() => true, () => false)
      if (left) throw new Error(`smoke could not remove the junction ${linked}; stopping before any recursive delete`)
    }
    check("removing the link left what it pointed at alone", await exists(path.join(outside, "elsewhere.pdf")))
  }

  // The window's side: the cards' entries, sizes, kinds, the relative path the main process opens, the step row.
  const part = (status: string, files: unknown, callID = "c") => ({ type: "tool", id: callID, callID, name: "present_files", status, input: {}, metadata: { files }, time: { created: 1, completed: 2 } })
  const items = deliveredFiles([part("completed", shown, "a"), part("running", shown, "b"), part("completed", [shown[0]], "d")] as never)
  check("the cards list a turn's completed present_files entries once each", items.map((item) => item.name).join(",") === "report.pdf,page.html,https://example.com/a", items)
  check("the cards are MiMo's office, web and plain cards", items.map(deliveredCard).join(",") === "office,html,url", items.map(deliveredCard))
  check("sizes read as MiMo writes them", sizeLabel(512) === "512 B" && sizeLabel(1536) === "1.5 KB" && sizeLabel(5 * 1024 * 1024) === "5.0 MB")
  check("a delivered file opens with an app by its path under the project", relativeInside("C:\\p\\", "C:/P/out/a.pdf") === "out/a.pdf" && relativeInside("C:\\p", "D:/q/a.pdf") === "")

  section("round 5: media previews keep to the project, the pull request row, document change notices (D1, D10, D11)")
  check(
    "a delivered picture, video or sound is previewed, anything else keeps its card",
    deliveredCard({ kind: "file", path: "C:/p/shot.png", name: "shot.png", size: 1 }) === "media" &&
      deliveredCard({ kind: "file", path: "C:/p/clip.MP4", name: "clip.MP4", size: 1 }) === "media" &&
      deliveredCard({ kind: "file", path: "C:/p/notes.txt", name: "notes.txt", size: 1 }) === "file",
  )
  check(
    "a path in the project is read, as the absolute path under it",
    projectPath("C:\\p\\out\\a.png", "C:\\p") === "C:/p/out/a.png" && projectPath("out/a.png", "C:\\p\\") === "C:/p/out/a.png" && projectPath("./a.mp3", "/home/me/p") === "/home/me/p/a.mp3",
    [projectPath("C:\\p\\out\\a.png", "C:\\p"), projectPath("out/a.png", "C:\\p\\"), projectPath("./a.mp3", "/home/me/p")],
  )
  check(
    "a path outside it, climbing out of it, from home or with a scheme is not",
    [
      projectPath("D:/q/a.png", "C:/p"),
      projectPath("C:/p2/a.png", "C:/p"),
      projectPath("../a.png", "C:/p"),
      projectPath("C:/p/../secret.png", "C:/p"),
      projectPath("~/a.png", "/home/me/p"),
      projectPath("file:///C:/p/a.png", "C:/p"),
      projectPath("a.png", undefined),
    ].every((value) => value === undefined),
  )
  check(
    "the pull request row: hidden off GitHub, then loading, none, unavailable or found",
    prRowState(false, { ok: true, kind: "none" }) === "hidden" &&
      prRowState(true, undefined) === "loading" &&
      prRowState(true, { ok: true, kind: "none" }) === "none" &&
      prRowState(true, { ok: false, code: "network" }) === "unavailable" &&
      prRowState(true, { ok: false, code: "detached" }) === "unavailable" &&
      prRowState(true, { ok: true, kind: "open", number: 3, title: "t", url: "https://github.com/a/b/pull/3" }) === "found",
  )
  {
    let notices = addFileNotice([], { path: "C:/p/a.docx", source: "user", note: "cell B2", time: 1 })
    notices = addFileNotice(notices, { path: "C:/p/b.xlsx", source: "external", time: 2 })
    notices = addFileNotice(notices, { path: "C:/p/a.docx", source: "restore", time: 3 })
    check(
      "changes to one file merge into one notice that counts them and keeps the latest",
      notices.length === 2 && notices[0].count === 2 && notices[0].source === "restore" && notices[0].note === undefined && notices[1].count === 1,
      notices,
    )
    const told = withAnnotations("go on", undefined, notices)
    check(
      "the model reads the changes before the message, and a message with none is unchanged",
      told.startsWith("<document-changes>") && told.endsWith("go on") && told.includes("C:/p/a.docx (2 changes") && withAnnotations("go on", undefined, []) === "go on",
      told,
    )
    check("no notices, no block", fileNoticesBlock(undefined) === "" && fileNoticesBlock([]) === "")
  }
  check("the step rows speak MiMo's verbs", deliveredToolVerb("present_files", "completed") !== "toolLabel.done.present_files" && deliveredToolVerb("pdf_locate", "running") !== "toolLabel.running.pdf_locate")
  check(
    "the step titles are the passage, the file names and the change",
    deliveredStepTitle({ name: "pdf_locate", input: { snippet: "y".repeat(90) } } as never) === "y".repeat(60) &&
      deliveredStepTitle({ name: "present_files", input: { files: ["C:\\p\\a.pdf", "b/c.html"] } } as never) === "a.pdf, c.html" &&
      deliveredStepTitle({ name: "set_desktop_setting", input: { key: "theme", value: "dark" } } as never) === "theme → dark",
  )
  check("a locate step wears the read icon", deliveredToolIcon("pdf_locate") === "read")
  const artifacts = sessionArtifacts(
    [{ id: "m1", role: "assistant", sessionID: "s", parts: [part("completed", [{ path: path.join(project, "notes.txt"), name: "notes.txt", size: 1 }])], time: { created: 1 } }] as never,
    project,
  )
  check("a presented file is a deliverable in the info card, whatever its kind", artifacts.length === 1 && artifacts[0].role === "deliverable", artifacts)

  // 下载副本: into Downloads, numbered when the name is taken, never over a file.
  const taken = new Set([path.join("D", "a.pdf"), path.join("D", "a (1).pdf")])
  check("a copy takes the first free name", freeCopyName("D", "a.pdf", (file) => taken.has(file)) === path.join("D", "a (2).pdf"))
  const downloads = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-downloads-"))
  const first = await saveCopy(path.join(project, "out", "report.pdf"), downloads)
  const second = await saveCopy(path.join(project, "out", "report.pdf"), downloads)
  check(
    "saving a copy twice keeps both",
    first.ok && second.ok && path.basename(first.savedPath) === "report.pdf" && path.basename(second.savedPath) === "report (1).pdf",
    { first, second },
  )
  const gone = await saveCopy(path.join(project, "gone.pdf"), downloads)
  const folder = await saveCopy(project, downloads)
  check("a missing file or a folder is not copied", !gone.ok && !folder.ok, { gone, folder })

  // The desktop settings tools, on a config of their own.
  const data = path.join(root, "delivered-data")
  const settings = new SubagentConfig(new SubagentStorage(path.join(data, "storage")), new Bus(), path.join(data, "credentials.json"))
  await settings.load()
  const getTool = findTool("get_desktop_settings")!
  const setTool = findTool("set_desktop_setting")!
  bindDesktopSettings(undefined)
  const unavailable = await getTool.execute({}, context("s0")).then(() => "ran", (error: Error) => error.name)
  check("before the backend binds a config the tools say they are unavailable", unavailable === "ToolError", unavailable)
  bindDesktopSettings(settings)
  const snapshot = JSON.parse((await getTool.execute({}, context("s1"))).output)
  check(
    "get_desktop_settings answers MiMo's keys, with what each accepts",
    snapshot.language === "system" && snapshot.ui_font_size === 14 && snapshot.code_font_size === 12 && snapshot.diff_style === "colored" && typeof snapshot.adjustable_keys?.theme === "string",
    snapshot,
  )
  const set = (key: string, value: string) => setTool.execute({ key, value }, context(`s-${key}-${value}`))
  const dark = await set("theme", "Dark")
  check("set_desktop_setting changes the theme through the config patch", settings.get().theme === "dark" && dark.output.startsWith("Changed theme to dark") && dark.metadata?.applied === true, dark)
  const big = await set("ui_font_size", "30")
  const small = await set("code_font_size", "7.6")
  check("font sizes past a bound take the bound", settings.get().uiFontSize === 24 && settings.get().codeFontSize === 9, { big: big.output, small: small.output })
  const word = await set("ui_font_size", "large")
  check("a font size that is not a number is rejected and nothing changes", word.output.startsWith("Not changed") && settings.get().uiFontSize === 24 && word.metadata?.applied === false, word.output)
  await set("diff_style", "plus-minus")
  const signs = settings.get().diffMarks
  await set("diff_style", "colored")
  check("diff_style maps plus-minus and colored onto MCode's marks", signs === "signs" && settings.get().diffMarks === "color")
  await set("language", "en-US")
  const english = settings.get().language
  const ambiguous = await set("language", "zh")
  await set("language", "system")
  check("a regional tag reaches its language, an ambiguous one is refused, system follows the machine", english === "en" && ambiguous.output.startsWith("Not changed") && settings.get().language === "", { english, ambiguous: ambiguous.output })
  const blue = await set("theme", "blue")
  const model = await set("model", "gpt")
  check("a bad theme is rejected with the values it accepts", blue.output.includes("light | dark | system") && settings.get().theme === "dark", blue.output)
  check("a key the tool does not cover is rejected and points to Settings", model.output.startsWith("Not changed") && model.output.includes("Settings"), model.output)
  const reread = new SubagentConfig(new SubagentStorage(path.join(data, "storage")), new Bus(), path.join(data, "credentials.json"))
  await reread.load()
  check("a change is saved, as the settings page saves it", reread.get().theme === "dark" && reread.get().uiFontSize === 24)
  check("the tool's languages are the interface's", LANGUAGE_IDS.join(",") === INTERFACE_LANGUAGES.map((entry) => entry.id).join(","))
  bindDesktopSettings(undefined)
  // Plain temp folders this section made; the one link inside `project` was removed and checked gone above.
  await fs.rm(outside, { recursive: true, force: true })
  await fs.rm(downloads, { recursive: true, force: true })
  await fs.rm(project, { recursive: true, force: true })
  await fs.rm(data, { recursive: true, force: true })
}

async function subagentChecks(root: string) {
  section("Subagents (task tool)")
  /*
   * A project of its own: every turn photographs its project under one git lock, and the shared
   * project has gathered hundreds of files by now, so a Stop check timed on a subagent starting
   * could lose ten seconds to the photograph instead of measuring the runner.
   */
  const project = path.join(root, "subagent-project")
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "README.md"), "# subagents\n")

  // Pure pieces first.
  check("a numbered general subagent takes its own tone", subagentTone("general-1") === 0 && subagentTone("general-6") === 5)
  check("any other name hashes onto one of six tones", [..."abcdefgh"].every((c) => subagentTone(`explore-${c}`) >= 0 && subagentTone(`explore-${c}`) < 6))
  check("the answer comes back out of the call's output", subagentAnswer(subagentOutput("ses_1", "  the answer\n")) === "the answer")
  check("actor is recorded through its subagent's own calls", reachOf("actor") === "reads")
  const partOf = (status: ToolPart["status"], extra: Partial<ToolPart> = {}): ToolPart => ({
    type: "tool",
    id: `p-${Math.random()}`,
    callID: `c-${Math.random()}`,
    name: "actor",
    status,
    input: { description: "Look around", prompt: "x", subagent_type: "explore" },
    time: { created: 1000, started: 1000, completed: status === "running" ? undefined : 5000 },
    ...extra,
  })
  check("a working or finished task call is a pill", isPill(partOf("running")) && isPill(partOf("completed")))
  check("a failed task call is an ordinary row", !isPill(partOf("error")))
  check("a task call Stop cut off stays a row even once settled as done", !isPill(partOf("completed", { metadata: { aborted: true } })))
  check("pills read 开始工作 until every one is done", pillStatus([partOf("completed"), partOf("running")]) === "started" && pillStatus([partOf("completed")]) === "completed")
  const aborted = partOf("error", { metadata: { aborted: true }, error: "The subagent was stopped before it finished." })
  const skipped = partOf("error", { metadata: { recoverable: true } })
  const listed = subagentItems(
    [
      {
        id: "a1",
        sessionID: "s",
        role: "assistant",
        model: { provider: "p", model: "m" },
        agent: "build",
        parts: [partOf("completed", { output: subagentOutput("x", "done") }), partOf("running"), aborted, skipped],
        time: { created: 1 },
      },
    ],
    [],
  )
  check("the tab lists working subagents first and leaves out calls that started nothing", listed.length === 3 && listed[0]?.status === "running", listed.map((item) => item.status))
  check("a stopped subagent reads as cancelled", listed.some((item) => item.status === "rejected"))
  check("a finished subagent's summary is its answer", listed.find((item) => item.status === "completed")?.summary === "done")
  check("the seconds column counts from the start", subagentTime({ ...listed[0]!, startedAt: 1000 }, 13_500).n === 12)
  check("an ended subagent reads minutes ago, in the app's one relative-time family", subagentTime({ ...listed[1]!, endedAt: 0 }, 5 * 60_000).key === "time.minutesAgo")
  check("the completed group shows ten at first", COMPLETED_CAP === 10)
  check(
    "a subagent's request joins its parent's dock",
    confirmQueue("parent", [{ id: "r1", sessionID: "child", messageID: "m", callID: "c", kind: "bash", title: "", subject: "ls", time: 1 }], [], (id) =>
      id === "child" || id === "parent",
    ).length === 1,
  )

  // MiMo's actor actions: the pure pieces.
  check("a call that names no action is a run, as the tool always was", actorAction({ description: "x" }) === "run" && actorAction({ action: "spawn" }) === "spawn" && actorAction({ action: "later" }) === "run")
  const spawned = partOf("completed", { input: { action: "spawn", description: "Look around", prompt: "x", subagent_type: "explore" }, output: "actor_id: explore-1" })
  const statusRow = partOf("completed", { input: { action: "status", actor_id: "explore-1" }, output: JSON.stringify({ status: "running" }), title: "Look around" })
  check("a spawn is a pill and a status call is a row", isPill(spawned) && !isPill(statusRow))
  check("a spawn reads 开始工作 once it has gone through; only a run that answered reads 已完成", pillStatus([spawned]) === "started" && pillStatus([partOf("completed")]) === "completed")
  const notice = (status: SubagentNoticeStatus, summary?: string): SubagentNotice => ({ subagentID: "explore-1", sessionID: "c1", description: "Look around", status, ...(summary ? { summary } : {}) })
  check("notices drawn together share their word, and read 已结束 when they disagree", noticeStatus([notice("stalled"), notice("stalled")]) === "stalled" && noticeStatus([notice("completed"), notice("failed")]) === "ended")
  check(
    "a status row takes MiMo's own verb and names the subagent; a spawn row keeps the task tool's",
    subagentStepVerb(statusRow, "completed") !== "toolLabel.subagentAction.status.completed" &&
      subagentStepVerb(statusRow, "completed") !== subagentStepVerb(spawned, "completed") &&
      subagentStepTitle(statusRow) === "Look around" &&
      subagentStepTitle({ ...statusRow, title: undefined }) === "explore-1",
  )
  check("MiMo's timings: a stall after six quiet minutes, abandoned after ten, a scan every 45s, ten minutes of waiting", SUBAGENT_TIMERS.stallMs === 360_000 && SUBAGENT_TIMERS.abandonMs === 600_000 && SUBAGENT_TIMERS.scanMs === 45_000 && SUBAGENT_TIMERS.waitMs === 600_000)
  check("quiet past the stall mark is a stall; past the abandon mark it is not reported", !isStalled(360_000, SUBAGENT_TIMERS) && isStalled(360_001, SUBAGENT_TIMERS) && !isStalled(600_001, SUBAGENT_TIMERS))
  const told = noticeText([{ notice: notice("completed", "first line"), result: "first line\nand the rest" }])
  check("the model is told which subagent finished and the whole of its answer", told.includes("actor_id: explore-1") && told.includes("and the rest") && told.startsWith("<actor-notification>"))
  const record = (subagent: SubagentSession["subagent"]): SubagentSession => ({
    id: "c1",
    title: "Look around",
    directory: "x",
    model: { provider: "p", model: "m" },
    agent: "plan",
    parentID: "s",
    parentCallID: spawned.callID,
    subagent,
    created: 1,
    updated: 1,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  })
  const spawnReply = { id: "a2", sessionID: "s", role: "assistant" as const, model: { provider: "p", model: "m" }, agent: "build" as const, parts: [spawned], time: { created: 2 } }
  const working = record({ type: "explore", id: "explore-1", background: true, status: "running" })
  check("a spawned subagent is at work in the tab while its record says so", subagentItems([spawnReply], [working])[0]?.status === "running")
  const noticed = subagentItems([spawnReply, { id: "u3", sessionID: "s", role: "user", text: "", attachments: [], notices: [notice("completed", "found it")], time: { created: 9000 } }], [working])
  check("its notice settles it in the tab, with the notice's summary", noticed[0]?.status === "completed" && noticed[0].summary === "found it" && noticed[0].endedAt === 9000, noticed)
  const stalledItem = subagentItems([spawnReply, { id: "u4", sessionID: "s", role: "user", text: "", attachments: [], notices: [notice("stalled")], time: { created: 9000 } }], [working])
  check("a stall leaves it among those at work, as MiMo's tab does", stalledItem[0]?.status === "running")
  const cancelledRecord = record({ type: "explore", id: "explore-1", background: true, status: "idle", outcome: "cancelled", ended: 7000 })
  check("with no notice, its own record says how it ended", subagentItems([spawnReply], [cancelledRecord])[0]?.status === "rejected")

  // The runner over a fake provider.
  let parentCalls: Record<string, unknown>[] = []
  // A scripted conversation: each request of the parent takes the next step, whatever came back.
  let parentSteps: Record<string, unknown>[][] = []
  const childTools: string[][] = []
  const childSystems: string[] = []
  const childSpans: { prompt: string; start: number; end: number }[] = []
  const parentBodies: string[] = []
  let callCount = 0
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", async () => {
      const asked = JSON.parse(body || "{}") as { messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] }
      const system = JSON.stringify(asked.messages?.find((message) => message.role === "system")?.content ?? "")
      const answered = (asked.messages ?? []).some((message) => message.role === "tool")
      response.writeHead(200, { "content-type": "text/event-stream" })
      let closed = false
      response.on("close", () => (closed = true))
      const say = async (text: string, pause = 0) => {
        if (pause) await new Promise((resolve) => setTimeout(resolve, pause))
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
        response.write("data: [DONE]\n\n")
        response.end()
      }
      const call = (calls: { name: string; input: Record<string, unknown> }[]) => {
        calls.forEach((entry, index) => {
          const frame = { choices: [{ delta: { tool_calls: [{ index, id: `call_sub_${++callCount}`, type: "function", function: { name: entry.name, arguments: JSON.stringify(entry.input) } }] } }] }
          response.write(`data: ${JSON.stringify(frame)}\n\n`)
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
        response.write("data: [DONE]\n\n")
        response.end()
      }

      if (!system.includes("Working as a subagent")) {
        parentBodies.push(body)
        const step = parentSteps.shift()
        // A step names its tool with `__tool`; any other is an actor call.
        if (step) return call(step.map(({ __tool, ...input }) => ({ name: typeof __tool === "string" ? __tool : "actor", input })))
        if (answered || !parentCalls.length) return say("parent done")
        return call(parentCalls.map((input) => ({ name: "actor", input })))
      }

      childTools.push((asked.tools ?? []).map((tool) => tool.function?.name ?? ""))
      childSystems.push(system)
      const prompt = JSON.stringify((asked.messages ?? []).filter((message) => message.role === "user"))
      if (prompt.includes("SLOW")) {
        for (let at = 0; at < 100 && !closed; at++) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "." } }] })}\n\n`)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        if (!closed) await say("slow done")
        return
      }
      if (prompt.includes("PERM")) {
        if (answered) return say("perm done")
        // Not a read-only command, which would run without asking at all.
        return call([{ name: "bash", input: { command: "node -e \"console.log('subagent')\"", description: "Say something" } }])
      }
      // STRUCT returns its result through StructuredOutput; STRUCTLATE only once reminded; STRUCTNEVER never does.
      if (prompt.includes("STRUCT")) {
        if (answered) return say("struct done")
        const offered = (asked.tools ?? []).some((tool) => tool.function?.name === "StructuredOutput")
        const reminded = prompt.includes("You have not returned your result yet")
        if (prompt.includes("STRUCTNEVER") || (prompt.includes("STRUCTLATE") && !reminded) || !offered) return say("an answer in prose")
        return call([{ name: "StructuredOutput", input: { verdict: "ok", count: 3 } }])
      }
      // TASKCHILD files a task under its parent's T1, then answers.
      if (prompt.includes("TASKCHILD")) {
        if (answered) return say("child tasked")
        return call([{ name: "task", input: { action: "create", summary: "Child part", parent_id: "T1" } }])
      }
      // HEADER and HEADERFAIL open their final message with MiMo's status header.
      if (prompt.includes("HEADERFAIL")) return say("**Status**: failed\n**Summary**: could not finish\n\ndetails")
      if (prompt.includes("HEADER")) return say("**Status**: partial\n**Summary**: half done\n\nbody")
      // QUIET writes nothing for a while, which the watchdog reads as a stall.
      if (prompt.includes("QUIET")) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        if (!closed) await say("quiet done")
        return
      }
      // The latest message holds the orders, so a follow-up sent to a subagent is answered on its own terms.
      const latest = JSON.stringify((asked.messages ?? []).filter((message) => message.role === "user").at(-1) ?? {})
      const found = /ANSWER:([a-z-]+)/.exec(latest)
      const span = { prompt: found?.[1] ?? "", start: Date.now(), end: 0 }
      childSpans.push(span)
      const pause = Number(/PAUSE(\d+)/.exec(latest)?.[1] ?? (latest.includes("DELAY") ? 400 : 5))
      await new Promise((resolve) => setTimeout(resolve, pause))
      span.end = Date.now()
      if (closed) return
      return say(found?.[1] ?? "no orders")
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port

  const data = path.join(root, "subagent-data")
  const storage = new SubagentStorage(path.join(data, "storage"))
  const bus = new Bus()
  const config = new SubagentConfig(storage, bus, path.join(data, "credentials.json"))
  // A stored config, so a subagent's request asks at the default level rather than a first install's 帮我审批.
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", name: "M" }] }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SubagentStore(storage, bus)
  const runner = new SubagentRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }

  const settled = (sessionID: string, quiet = 300) =>
    new Promise<void>((resolve) => {
      const deadline = Date.now() + 20_000
      const look = () => {
        if (runner.busySessions().includes(sessionID) && Date.now() < deadline) return void setTimeout(look, 25)
        setTimeout(() => (runner.busySessions().includes(sessionID) && Date.now() < deadline ? look() : resolve()), quiet)
      }
      setTimeout(look, 25)
    })
  const until = async (test: () => boolean | Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }
  const taskParts = async (sessionID: string) =>
    (await store.messages(sessionID)).flatMap((message) =>
      message.role === "assistant" ? message.parts.filter((part): part is ToolPart => part.type === "tool" && part.name === "actor") : [],
    )
  const childrenOf = async (sessionID: string) => (await store.list()).filter((session) => session.parentID === sessionID)

  // One subagent: its own conversation, and its answer as the call's result.
  parentCalls = [{ description: "Find the answer", prompt: "ANSWER:forty-two", subagent_type: "explore" }]
  const one = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: one.id, text: "delegate this" })
  await settled(one.id)
  const [onePart] = await taskParts(one.id)
  const [oneChild] = await childrenOf(one.id)
  check("a task call starts a subagent linked to its message and call", Boolean(oneChild) && oneChild?.parentCallID === onePart?.callID && oneChild?.parentMessageID !== undefined, oneChild)
  check("it is named by kind and number, and titled by the description", oneChild?.subagent?.id === "explore-1" && oneChild?.title === "Find the answer", oneChild?.subagent)
  check("an explore subagent works as Plan", oneChild?.agent === "plan", oneChild?.agent)
  const childMessages = oneChild ? await store.messages(oneChild.id) : []
  check("the subagent keeps its own history", childMessages[0]?.role === "user" && childMessages[0].text === "ANSWER:forty-two" && childMessages.some((message) => message.role === "assistant"))
  check("its final message returns as the call's result", onePart?.status === "completed" && subagentAnswer(onePart.output) === "forty-two", onePart?.output)
  check("the parent's model reads the result and replies", (await store.messages(one.id)).some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text === "parent done")))
  check("a subagent is offered no actor tool of its own", childTools.length > 0 && childTools.every((names) => !names.includes("actor")), childTools)
  check("no subagent is left running", !oneChild || !runner.busySessions().includes(oneChild.id))
  const hits = await searchMessages(await store.list(), (id) => store.messages(id), "forty-two")
  check("search leaves a subagent's conversation out", !hits.some((hit) => hit.sessionID === oneChild?.id), hits)

  // Two in one reply run side by side.
  parentCalls = [
    { description: "First", prompt: "ANSWER:one DELAY", subagent_type: "general" },
    { description: "Second", prompt: "ANSWER:two DELAY", subagent_type: "general" },
  ]
  childSpans.length = 0
  const two = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: two.id, text: "two at once" })
  await settled(two.id)
  const [first, second] = childSpans
  check("two task calls in one reply run at the same time", Boolean(first && second) && first!.start < second!.end && second!.start < first!.end, childSpans)
  const twoParts = await taskParts(two.id)
  check("each returns its own answer", twoParts.map((part) => subagentAnswer(part.output)).sort().join(",") === "one,two", twoParts.map((part) => part.output))
  const twoNames = (await childrenOf(two.id)).map((session) => session.subagent?.id).sort()
  check("parallel subagents get different numbers", twoNames.join(",") === "general-1,general-2", twoNames)

  // Stop on the parent stops the subagent.
  parentCalls = [{ description: "Take a while", prompt: "SLOW", subagent_type: "explore" }]
  const three = await store.create({ directory: project, model })
  const requestsBefore = childTools.length
  await runner.prompt({ sessionID: three.id, text: "slow work" })
  const startedChild = await until(async () => (await childrenOf(three.id)).some((session) => runner.busySessions().includes(session.id)))
  check("the subagent is listed as running while it works", startedChild, startedChild ? undefined : {
    parts: await taskParts(three.id),
    children: (await childrenOf(three.id)).map((session) => ({ id: session.id, subagent: session.subagent })),
    outstanding: permissions.outstanding(),
    busy: runner.busySessions(),
    childRequests: childTools.length - requestsBefore,
  })
  // Stopped once its reply is streaming, so there is a reply to mark stopped.
  await until(() => childTools.length > requestsBefore)
  await new Promise((resolve) => setTimeout(resolve, 150))
  runner.abort(three.id)
  await settled(three.id)
  const [threeChild] = await childrenOf(three.id)
  const [threePart] = await taskParts(three.id)
  check("Stop on the parent stops its subagent", Boolean(threeChild) && !runner.busySessions().includes(threeChild!.id))
  const threeLast = threeChild ? (await store.messages(threeChild.id)).filter((message) => message.role === "assistant").at(-1) : undefined
  check("the subagent's turn is recorded as stopped", threeLast?.role === "assistant" && threeLast.finish === "aborted", threeLast)
  check("the task call settles as stopped", threePart?.status === "error" && threePart.metadata?.aborted === true, threePart)

  // A subagent's permission reaches the queue.
  parentCalls = [{ description: "Run a command", prompt: "PERM", subagent_type: "general" }]
  const four = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: four.id, text: "needs approval" })
  const asked = await until(() => permissions.outstanding().length > 0)
  const request = permissions.outstanding()[0]
  const asker = request ? await store.get(request.sessionID) : undefined
  check("a subagent's permission request reaches the queue", asked && asker?.parentID === four.id, request)
  if (request) permissions.respond(request.id, "once")
  await settled(four.id)
  const [fourPart] = await taskParts(four.id)
  check("once answered, the subagent finishes and its result returns", fourPart?.status === "completed" && subagentAnswer(fourPart.output) === "perm done", fourPart?.output)

  // A command marked subtask.
  parentBodies.length = 0
  const five = await store.create({ directory: project, model })
  await runner.subtask({ sessionID: five.id, text: "/review src", description: "Review", prompt: "ANSWER:reviewed", type: "general" })
  await settled(five.id)
  const fiveMessages = await store.messages(five.id)
  const [fivePart] = await taskParts(five.id)
  check("a subtask command keeps the line as typed", fiveMessages[0]?.role === "user" && fiveMessages[0].text === "/review src")
  check("its subagent works first and its answer returns", fivePart?.status === "completed" && subagentAnswer(fivePart.output) === "reviewed", fivePart)
  check(
    "then the conversation's model is asked to pass it on",
    parentBodies.some((body) => body.includes("A subagent has just carried out the command")) &&
      fiveMessages.some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text === "parent done")),
  )

  section("Subagents (background actions)")
  const noticesIn = async (sessionID: string) => (await store.messages(sessionID)).flatMap((message) => (message.role === "user" ? (message.notices ?? []) : []))
  const actionPart = async (sessionID: string, action: string) => (await taskParts(sessionID)).find((part) => part.input?.action === action)
  const firstChild = async (sessionID: string) => (await childrenOf(sessionID))[0]
  const reportOf = (part?: ToolPart): Record<string, unknown> => {
    try {
      return JSON.parse(part?.output ?? "{}") as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const saidDone = (messages: Awaited<ReturnType<typeof store.messages>>) =>
    messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text === "parent done"))
  parentCalls = []

  // spawn, status, wait.
  parentBodies.length = 0
  parentSteps = [
    [{ action: "spawn", description: "Look in the background", prompt: "ANSWER:background PAUSE600", subagent_type: "explore" }],
    [{ action: "status", actor_id: "explore-1" }],
    [{ action: "wait", actor_id: "explore-1" }],
  ]
  const six = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: six.id, text: "spawn, look, wait" })
  await settled(six.id)
  await until(async () => (await noticesIn(six.id)).length > 0, 5000)
  const sixSpawn = await actionPart(six.id, "spawn")
  const sixStatus = await actionPart(six.id, "status")
  const sixWait = await actionPart(six.id, "wait")
  const sixChild = await firstChild(six.id)
  check(
    "spawn answers at once with the subagent's id, before the subagent is done",
    sixSpawn?.status === "completed" && /actor_id: explore-1/.test(sixSpawn.output ?? "") && (sixSpawn.time.completed ?? Infinity) < (sixChild?.subagent?.ended ?? 0),
    { spawn: sixSpawn?.output, record: sixChild?.subagent },
  )
  check("status sees it still at work, by its description", reportOf(sixStatus).status === "running" && reportOf(sixStatus).description === "Look in the background", sixStatus?.output)
  check("wait holds until it is idle and hands back its result", reportOf(sixWait).status === "idle" && reportOf(sixWait).lastOutcome === "success" && reportOf(sixWait).result === "background", sixWait?.output)
  check("its record says it ran in the background and succeeded", sixChild?.subagent?.background === true && sixChild.subagent.status === "idle" && sixChild.subagent.outcome === "success", sixChild?.subagent)
  const sixNotices = await noticesIn(six.id)
  check("the conversation is told it completed, its answer as the summary", sixNotices.some((entry) => entry.status === "completed" && entry.subagentID === "explore-1" && entry.summary === "background"), sixNotices)
  check("the conversation's model reads the notice", parentBodies.some((body) => body.includes("<actor-notification>") && body.includes("actor_id: explore-1")))

  // A background subagent that finishes after the conversation's turn has ended.
  parentBodies.length = 0
  parentSteps = [[{ action: "spawn", description: "Finish later", prompt: "ANSWER:later PAUSE800", subagent_type: "general" }]]
  const seven = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: seven.id, text: "start something and stop" })
  const parentFirst = await until(async () => {
    const child = await firstChild(seven.id)
    return Boolean(child) && !runner.busySessions().includes(seven.id) && runner.busySessions().includes(child!.id)
  })
  check("the conversation's turn ends while its background subagent works on", parentFirst)
  await until(async () => (await noticesIn(seven.id)).length > 0)
  await settled(seven.id)
  const sevenMessages = await store.messages(seven.id)
  const noticeAt = sevenMessages.findIndex((message) => message.role === "user" && Boolean(message.notices?.length))
  const noticeMessage = sevenMessages[noticeAt]
  check("its outcome arrives as a message of its own after the turn", noticeAt > 0 && noticeMessage?.role === "user" && !noticeMessage.steered && noticeMessage.notices?.[0]?.status === "completed", noticeMessage)
  check("and wakes the conversation for a turn that reads it", saidDone(sevenMessages.slice(noticeAt + 1)) && parentBodies.some((body) => body.includes("later")))

  // Stop leaves a background subagent working; deleting the conversation stops it.
  parentSteps = [
    [{ action: "spawn", description: "Keep going", prompt: "SLOW", subagent_type: "explore" }],
    [{ action: "wait", actor_id: "explore-1", timeout_ms: 10_000 }],
  ]
  const eight = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: eight.id, text: "spawn and wait" })
  await until(() => parentSteps.length === 0)
  await new Promise((resolve) => setTimeout(resolve, 300))
  runner.abort(eight.id)
  await settled(eight.id)
  const eightChild = await firstChild(eight.id)
  const eightWait = await actionPart(eight.id, "wait")
  check("Stop ends the wait but leaves the background subagent working, as MiMo does", eightWait?.status === "error" && Boolean(eightChild) && runner.busySessions().includes(eightChild!.id), eightWait?.error)
  const beforeDrop = (await noticesIn(eight.id)).length
  await runner.dropSubagents(eight.id)
  check("deleting the conversation stops it, and nobody is told", Boolean(eightChild) && !runner.busySessions().includes(eightChild!.id) && (await noticesIn(eight.id)).length === beforeDrop)

  // cancel.
  parentSteps = [
    [{ action: "spawn", description: "Cancel me", prompt: "SLOW", subagent_type: "explore" }],
    [{ action: "cancel", actor_id: "explore-1" }],
    [{ action: "cancel", actor_id: "explore-1" }],
  ]
  const nine = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: nine.id, text: "spawn and cancel" })
  await settled(nine.id)
  await until(async () => (await noticesIn(nine.id)).some((entry) => entry.status === "cancelled"), 5000)
  const cancels = (await taskParts(nine.id)).filter((part) => part.input?.action === "cancel")
  const nineChild = await firstChild(nine.id)
  check("cancel stops a running subagent", reportOf(cancels[0]).status === "cancelled" && Boolean(nineChild) && !runner.busySessions().includes(nineChild!.id) && nineChild!.subagent?.outcome === "cancelled", { output: cancels[0]?.output, record: nineChild?.subagent })
  check("cancelling one that is idle changes nothing", reportOf(cancels[1]).status === "idle", cancels[1]?.output)
  check("the conversation is told it was cancelled", (await noticesIn(nine.id)).some((entry) => entry.status === "cancelled"))

  // send, to a subagent that has finished.
  parentSteps = [
    [{ action: "run", description: "Answer twice", prompt: "ANSWER:first", subagent_type: "general" }],
    [{ action: "send", to_actor_id: "general-1", content: "ANSWER:second" }],
  ]
  const ten = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: ten.id, text: "run, then send" })
  await settled(ten.id)
  await until(async () => (await noticesIn(ten.id)).some((entry) => entry.summary === "second"), 5000)
  await settled(ten.id)
  const tenRun = await actionPart(ten.id, "run")
  const tenSend = await actionPart(ten.id, "send")
  const tenChild = await firstChild(ten.id)
  const tenChildMessages = tenChild ? await store.messages(tenChild.id) : []
  const tenAnswers = tenChildMessages.flatMap((message) => (message.role === "assistant" ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []))
  check("run hands back the subagent's answer", subagentAnswer(tenRun?.output) === "first", tenRun?.output)
  check("send queues a follow-up for a finished subagent", reportOf(tenSend).queued === true && reportOf(tenSend).actor_id === "general-1", tenSend?.output)
  check("the follow-up joins the subagent's own history, marked as its parent's", tenChildMessages.some((message) => message.role === "user" && message.inbox?.from === "main" && message.text === "ANSWER:second"))
  check("the subagent answers it in another turn, keeping the one before", tenAnswers.join(",") === "first,second" && tenChild?.subagent?.turns === 2 && tenChild.subagent.outcome === "success", { tenAnswers, record: tenChild?.subagent })
  check("the conversation hears when that turn ends", (await noticesIn(ten.id)).some((entry) => entry.status === "completed" && entry.summary === "second"))

  // The stall watchdog, on shortened timings.
  const timings = { ...runner.subagentTimers }
  Object.assign(runner.subagentTimers, { stallMs: 300, abandonMs: 5000, scanMs: 50 })
  parentSteps = [[{ action: "spawn", description: "Go quiet", prompt: "QUIET", subagent_type: "explore" }]]
  const eleven = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: eleven.id, text: "spawn a quiet one" })
  const stalled = await until(async () => (await noticesIn(eleven.id)).some((entry) => entry.status === "stalled"), 5000)
  const elevenChild = await firstChild(eleven.id)
  const stillWorking = Boolean(elevenChild) && runner.busySessions().includes(elevenChild!.id)
  await until(async () => (await noticesIn(eleven.id)).some((entry) => entry.status === "completed"), 8000)
  await settled(eleven.id)
  const elevenNotices = await noticesIn(eleven.id)
  check(
    "the watchdog reports a subagent that has gone quiet, once, and leaves it working",
    stalled && stillWorking && elevenNotices.filter((entry) => entry.status === "stalled").length === 1 && typeof elevenNotices.find((entry) => entry.status === "stalled")?.quietSeconds === "number",
    elevenNotices,
  )
  check("its outcome still arrives when it finishes", elevenNotices.some((entry) => entry.status === "completed" && entry.summary === "quiet done"))
  Object.assign(runner.subagentTimers, timings)

  // models, and a model named for a subagent.
  parentSteps = [
    [{ action: "models" }],
    [{ action: "models", vision: true }],
    [{ action: "spawn", description: "Unknown model", prompt: "ANSWER:x", subagent_type: "explore", model: "nowhere/none" }],
    [{ action: "run", description: "Chosen model", prompt: "ANSWER:chosen", subagent_type: "explore", model: "fake/m" }],
  ]
  const twelve = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: twelve.id, text: "models" })
  await settled(twelve.id)
  const twelveParts = await taskParts(twelve.id)
  const [modelList, visionListed] = twelveParts.filter((part) => part.input?.action === "models")
  check("models lists what a subagent can be given", Boolean(modelList?.output?.includes("fake/m")), modelList?.output)
  check("with vision, only models that read images", visionListed?.output === "No connected model reads images.", visionListed?.output)
  const unknownModel = twelveParts.find((part) => part.input?.model === "nowhere/none")
  check("a model nobody has connected is refused", unknownModel?.status === "error" && /models action/.test(unknownModel.error ?? ""), unknownModel?.error)
  const chosen = (await childrenOf(twelve.id)).find((session) => session.title === "Chosen model")
  check("a subagent runs on the model it was given", chosen?.model.provider === "fake" && chosen.model.model === "m", chosen?.model)

  section("Subagents (actor: saved calls, status header, structured output)")
  const oldTool = (id: string, input: Record<string, unknown>): ToolPart => ({ type: "tool", id, callID: id, name: "task", status: "completed", input, time: { created: 1 } })
  const oldReply = {
    id: "old",
    sessionID: "s",
    role: "assistant" as const,
    model,
    agent: "build" as const,
    time: { created: 1 },
    parts: [
      oldTool("o1", { description: "Old one", prompt: "x", subagent_type: "explore" }),
      oldTool("o2", { action: "send", subagent_id: "general-1", message: "more" }),
      oldTool("o3", { action: "status", subagent_id: "explore-1" }),
      oldTool("o4", { action: "create", summary: "A task" }),
    ],
  }
  const readOld = readLegacyMessage(oldReply)
  const readPart = (at: number) => readOld.parts[at] as ToolPart
  check(
    "a saved task call that started a subagent reads as an actor call, its fields under the new names",
    readPart(0).name === "actor" && readPart(1).name === "actor" && readPart(1).input?.to_actor_id === "general-1" && readPart(1).input?.content === "more" && readPart(2).input?.actor_id === "explore-1",
    readOld.parts,
  )
  check("a task registry call is left as it is, and the saved copy is untouched", readPart(3).name === "task" && oldReply.parts[0]!.name === "task" && oldReply.parts[1]!.input?.subagent_id === "general-1")
  check("a saved subagent call is drawn as the pill it was", isPill(readPart(0)))
  check("a message with nothing old in it comes back as the same object", readLegacyMessage(spawnReply) === spawnReply)
  check("an answer saved in the old tags is still read", subagentAnswer("subagent_id: x\n\n<subagent_result>\nold answer\n</subagent_result>") === "old answer")
  check(
    "MiMo's status header is read, and its summary stands for the answer",
    statusHeader("**Status**: partial\n**Summary**: half done\n\nbody")?.status === "partial" && answerSummary("**Status**: success\n**Summary**: all good\nmore") === "all good" && !statusHeader("plain answer"),
  )

  const schema = { type: "object", properties: { verdict: { type: "string" }, count: { type: "number" } }, required: ["verdict"] }
  const childReminders = async (sessionID: string) => {
    const child = await firstChild(sessionID)
    return child ? (await store.messages(child.id)).filter((message) => message.role === "user" && message.text === STRUCTURED_REMINDER).length : -1
  }
  parentSteps = [[{ action: "run", description: "Structured", prompt: "STRUCT now", subagent_type: "explore", output_schema: schema, command: "/probe-check" }]]
  const thirteen = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: thirteen.id, text: "structured" })
  await settled(thirteen.id)
  const [structuredPart] = await taskParts(thirteen.id)
  const structuredChild = await firstChild(thirteen.id)
  const structured = (() => {
    try {
      return JSON.parse(subagentAnswer(structuredPart?.output)) as Record<string, unknown>
    } catch {
      return undefined
    }
  })()
  check("output_schema: the subagent hands back one object through StructuredOutput, and that object is the result", structured?.verdict === "ok" && structured.count === 3, structuredPart?.output)
  check("its record keeps the schema and the command that started it", Boolean(structuredChild?.subagent?.outputSchema) && structuredChild?.subagent?.command === "/probe-check", structuredChild?.subagent)
  check("only a subagent asked for structured output is offered the tool", childTools.some((names) => names.includes("StructuredOutput")) && childTools.some((names) => !names.includes("StructuredOutput")))

  parentSteps = [[{ action: "run", description: "Late", prompt: "STRUCTLATE", subagent_type: "explore", output_schema: schema }]]
  const fourteen = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: fourteen.id, text: "structured late" })
  await settled(fourteen.id)
  const [latePart] = await taskParts(fourteen.id)
  check("a subagent that answers in prose is reminded, and its later structured result counts", latePart?.status === "completed" && subagentAnswer(latePart.output).includes('"verdict": "ok"') && (await childReminders(fourteen.id)) === 1, latePart?.output)

  parentSteps = [[{ action: "run", description: "Never", prompt: "STRUCTNEVER", subagent_type: "explore", output_schema: schema }]]
  const fifteen = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: fifteen.id, text: "structured never" })
  await settled(fifteen.id)
  const [neverPart] = await taskParts(fifteen.id)
  check("after MiMo's two reminders without a result, the call fails and says why", neverPart?.status === "error" && /StructuredOutput/.test(neverPart.error ?? "") && (await childReminders(fifteen.id)) === 2, { error: neverPart?.error, reminders: await childReminders(fifteen.id) })

  childSystems.length = 0
  parentSteps = [[{ action: "run", description: "Header", prompt: "HEADER", subagent_type: "general" }], [{ action: "run", description: "No header", prompt: "ANSWER:plain", subagent_type: "explore" }]]
  const sixteen = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: sixteen.id, text: "header" })
  await settled(sixteen.id)
  const headerPart = (await taskParts(sixteen.id)).find((part) => part.input?.prompt === "HEADER")
  check("a general subagent is asked to open with the status header; an explore one is not", childSystems.some((text) => text.includes("**Status**: success, partial, failed or blocked")) && childSystems.some((text) => !text.includes("**Status**:")), childSystems.length)
  check("the header's status reaches the actor result", Boolean(headerPart?.output?.includes('<actor_result status="partial" summary="half done">')), headerPart?.output)

  parentSteps = [[{ action: "spawn", description: "Header failed", prompt: "HEADERFAIL", subagent_type: "general" }]]
  const seventeen = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: seventeen.id, text: "header failed" })
  await until(async () => (await noticesIn(seventeen.id)).length > 0, 5000)
  await settled(seventeen.id)
  const headerNotice = (await noticesIn(seventeen.id))[0]
  check("a background subagent whose header says failed is reported failed, with its summary", headerNotice?.status === "failed" && headerNotice.summary === "could not finish", headerNotice)

  section("Tasks (the registry through the runner)")
  parentSteps = [
    [{ __tool: "task", action: "create", summary: "Parent work" }],
    [
      { action: "run", description: "Bound", prompt: "TASKCHILD", subagent_type: "general", task_id: "T1" },
      { action: "run", description: "Unbound", prompt: "ANSWER:x", subagent_type: "explore", task_id: "T9" },
      { action: "run", description: "Malformed", prompt: "ANSWER:y", subagent_type: "explore", task_id: "task one" },
    ],
  ]
  const eighteen = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: eighteen.id, text: "tasks" })
  await settled(eighteen.id)
  const registered = (await store.get(eighteen.id))?.tasks ?? []
  // Round 10 (T10-16): the subagent started for T1 takes it and starts it, as MiMo's actor does.
  check("a task created in a conversation is kept on its record, taken by the subagent started for it", registered.some((task) => task.id === "T1" && task.summary === "Parent work" && task.owner === "general-1" && task.status === "in_progress"), registered)
  check("a subagent's task goes into its parent's registry, under the parent's task, held by the subagent", registered.some((task) => task.id === "T1.1" && task.parentID === "T1" && task.owner === "general-1"), registered)
  const children = await childrenOf(eighteen.id)
  check("task_id naming a task binds the subagent to it", children.find((session) => session.title === "Bound")?.subagent?.taskID === "T1", children.map((session) => session.subagent))
  const runs = await taskParts(eighteen.id)
  const unbound = runs.find((part) => part.input?.task_id === "T9")
  const malformed = runs.find((part) => part.input?.task_id === "task one")
  check(
    "a task_id the registry does not hold, or that is no task id, is dropped and the call says so",
    /no task T9/.test(unbound?.output ?? "") && /not a task id/.test(malformed?.output ?? "") && !children.find((session) => session.title === "Unbound")?.subagent?.taskID,
    [unbound?.output, malformed?.output],
  )
  check("a subagent keeps the task tool", childTools.some((names) => names.includes("task")))
  const taskRow = (await store.messages(eighteen.id)).flatMap((message) => (message.role === "assistant" ? message.parts : [])).find((part) => part.type === "tool" && part.name === "task")
  check("the transcript keeps the task call, but no step is drawn for it, as MiMo draws none", Boolean(taskRow) && buildRows([taskRow!]).length === 0)

  section("Skills (through the runner)")
  parentSteps = []
  parentCalls = []
  parentBodies.length = 0
  const nineteen = await store.create({ directory: project, model })
  await runner.prompt({ sessionID: nineteen.id, text: "/pdf read this", attachments: [{ path: path.join(project, "brief.pdf"), mime: "application/pdf", data: "" }] })
  await settled(nineteen.id)
  const skillMessage = (await store.messages(nineteen.id)).find((message) => message.role === "user")
  const carriedReminders = skillMessage?.role === "user" ? (skillMessage.reminders ?? []) : []
  check(
    "a message attaching a PDF and naming /pdf keeps its words, and carries the hint and the loaded skill",
    skillMessage?.role === "user" && skillMessage.text === "/pdf read this" && carriedReminders.length === 2 && carriedReminders[0]!.includes("- pdf:") && carriedReminders[1]!.includes('loaded_skill name="pdf"'),
    carriedReminders.map((entry) => entry.slice(0, 60)),
  )
  check("the model reads both after the message", parentBodies.some((body) => body.includes("/pdf read this") && body.includes("- pdf:") && body.includes('loaded_skill name=\\"pdf\\"')))
  check("the system prompt lists the shipped skills", parentBodies.some((body) => body.includes("<name>docx</name>")))

  await new Promise<void>((resolve) => provider.close(() => resolve()))
}

async function sessionChatChecks(root: string, project: string) {
  section("Session chat (contacts, talk_to_session, create_session, update_session)")

  // Pure pieces first.
  const asked = (id: string, text: string, inbox?: ChatUserMessage["inbox"]): ChatMessage => ({
    id,
    sessionID: "s",
    role: "user",
    text,
    attachments: [],
    ...(inbox ? { inbox } : {}),
    time: { created: 1 },
  })
  const replied = (id: string, extra: Record<string, unknown>): ChatMessage =>
    ({ id, sessionID: "s", role: "assistant", model: { provider: "p", model: "m" }, agent: "build", parts: [], time: { created: 2 }, ...extra }) as ChatMessage
  const headed = withChatHeaders([asked("u1", "hello", { from: "Alpha", sessionID: "ses_a", direction: "request" }), asked("u2", "follow up", { from: "main" })])
  check("a message from another session reaches the model with its header, and the transcript keeps the words", headed[0]?.role === "user" && headed[0].text.startsWith("【跨会话消息｜来自会话「Alpha」") && headed[0].text.endsWith("hello"))
  check("a subagent's follow-up gets no session chat header", headed[1]?.role === "user" && headed[1].text === "follow up")
  const replyHeader = withChatHeaders([asked("u3", "the answer", { from: "Beta", sessionID: "ses_b", direction: "reply" })])[0]
  check("a reply says it is a reply", replyHeader?.role === "user" && replyHeader.text.startsWith("【跨会话消息｜会话「Beta」") && replyHeader.text.includes("的回复】"))
  const textPart = (text: string) => ({ type: "text", id: `p${text}`, text })
  check("the reply is the last answer after the message", (() => {
    const outcome = replyIn([asked("u1", "q"), replied("a1", { parts: [textPart("first")] }), replied("a2", { parts: [textPart("final")] })], "u1")
    return outcome.ok && outcome.reply === "final"
  })())
  check("a failed turn says why", (() => {
    const outcome = replyIn([asked("u1", "q"), replied("a1", { error: "boom", finish: "error" })], "u1")
    return !outcome.ok && outcome.error.includes("boom")
  })())
  check("a stopped turn with nothing written says it was stopped", (() => {
    const outcome = replyIn([asked("u1", "q"), replied("a1", { finish: "aborted" })], "u1")
    return !outcome.ok && outcome.error.includes("stopped")
  })())
  check("chains stop at MiMo's five hops", CHAT_HOPS === 5)

  const link = (extra: Partial<ChatLink>): ChatLink => ({ peerID: "ses_p", peerTitle: "Peer", direction: "outbound", kind: "request", phase: "running", queueAhead: 0, ...extra })
  check("waiting reads MiMo's words", chatLinkText(link({})) === t("side.chatLink.waiting", { peer: "Peer" }))
  check("handling a message reads MiMo's words", chatLinkText(link({ direction: "inbound" })) === t("side.chatLink.handlingRequest", { peer: "Peer" }))
  check("handling a reply reads MiMo's words", chatLinkText(link({ direction: "inbound", kind: "reply" })) === t("side.chatLink.handlingReply", { peer: "Peer" }))
  check(
    "a queued message adds its position, counting the one running",
    chatLinkText(link({ phase: "queued", queueAhead: 1 })) === `${t("side.chatLink.waiting", { peer: "Peer" })} · ${t("side.chatLink.queued", { position: "2" })}`,
  )
  check("running links come before queued ones", sortedChatLinks([link({ phase: "queued", queueAhead: 1, peerTitle: "Q" }), link({ peerTitle: "R" })]).map((entry) => entry.peerTitle).join() === "R,Q")
  const jumped: string[] = []
  const card = convoCard({ title: "T", directory: project, updated: 0 }, undefined, [link({}), link({ peerID: null, direction: "inbound" })], (id) => jumped.push(id))
  const cardLinks = card.lines.filter((line) => typeof line === "object")
  const first = cardLinks[0]
  if (typeof first === "object") first.action?.()
  check("the card lists a line per link; one whose peer exists jumps to it", cardLinks.length === 2 && jumped.join() === "ses_p" && typeof cardLinks[1] === "object" && !cardLinks[1].action)
  check(
    "the four tools are appended after every tool that came before them, keeping the cached prefix",
    (() => {
      const at = TOOLS.findIndex((tool) => tool.name === "contacts")
      return (
        TOOLS.slice(at, at + 4).map((tool) => tool.name).join() === "contacts,talk_to_session,create_session,update_session" &&
        // notebook_edit sits between the window tools and them.
        TOOLS[at - 1]?.name === "notebook_edit" &&
        TOOLS[at - 2]?.name === "set_desktop_setting" &&
        // Only tools added since (the skill tools, then history, memory, cron, scheduled tasks, plan_exit, multiedit and speak) come after them.
        TOOLS.slice(at + 4).every((tool) => ["skill_search", "skill", "history", "memory", "cron", "automation_update", "plan_exit", "multiedit", "speak"].includes(tool.name))
      )
    })(),
    TOOLS.map((tool) => tool.name),
  )
  /*
   * plan: MiMo's session-chat extension registers its tools for every agent,
   * and its plan agent denies none of them, so planning reaches the other
   * conversations too - what a turn started there does is that conversation's
   * own business, under its own mode.
   */
  check(
    "Plan keeps all four, as MiMo's plan agent does",
    ["contacts", "talk_to_session", "create_session", "update_session"].every((name) => toolsFor("plan").some((tool) => tool.name === name)),
    toolsFor("plan").map((tool) => tool.name),
  )
  check("none of the four is recorded as touching project files", ["contacts", "talk_to_session", "create_session", "update_session"].every((name) => reachOf(name) === "reads"))

  // The runner over a fake provider. create_session gets a folder of its own: earlier sections move the shared project.
  const workspace = path.join(root, "session-chat-workspace")
  await fs.mkdir(workspace, { recursive: true })
  let callCount = 0
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", async () => {
      const sent = JSON.parse(body || "{}") as { messages?: { role: string; content?: unknown }[] }
      const messages = sent.messages ?? []
      const lastUserAt = messages.map((message) => message.role).lastIndexOf("user")
      const lastUser = JSON.stringify(messages[lastUserAt]?.content ?? "")
      const answered = messages.slice(lastUserAt + 1).some((message) => message.role === "tool")
      response.writeHead(200, { "content-type": "text/event-stream" })
      let closed = false
      response.on("close", () => (closed = true))
      const frame = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`)
      const end = (reason: string) => {
        frame({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
        response.write("data: [DONE]\n\n")
        response.end()
      }
      const say = (text: string) => {
        frame({ choices: [{ delta: { content: text } }] })
        end("stop")
      }
      const slow = async (text: string) => {
        for (let at = 0; at < 30 && !closed; at++) {
          frame({ choices: [{ delta: { content: "." } }] })
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        if (!closed) say(text)
      }
      const call = (name: string, input: Record<string, unknown>) => {
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_chat_${++callCount}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }] })
        end("tool_calls")
      }

      if (lastUser.includes("对本会话所发消息的回复】")) return say("got reply")
      const chain = /CHAIN:(\d+)/.exec(lastUser)
      if (chain) {
        const at = Number(chain[1])
        if (answered) return say(`chain ${at} done`)
        return call("talk_to_session", { contact: `chain-${at + 1}`, message: `CHAIN:${at + 1}` })
      }
      if (lastUser.includes("【跨会话消息｜来自会话")) {
        if (lastUser.includes("SLOW")) return slow("slow pong")
        return say(`pong:${/PING[\w-]*/.exec(lastUser)?.[0] ?? ""}`)
      }
      if (answered) return say("caller done")
      if (lastUser.includes("USER-SLOW")) return slow("user slow done")
      if (lastUser.includes("CONTACTS")) return call("contacts", { explanation: "who is there" })
      const order = /(TALK-SYNC|TALK-SLOW|TALK-ASYNC|SELF|UPDATE):([A-Za-z0-9_-]+)/.exec(lastUser)
      if (order?.[1] === "TALK-SYNC") return call("talk_to_session", { contact: order[2], message: "PING" })
      if (order?.[1] === "TALK-SLOW") return call("talk_to_session", { contact: order[2], message: "SLOW PING" })
      if (order?.[1] === "TALK-ASYNC") return call("talk_to_session", { contact: order[2], message: "PING-ASYNC", mode: "async" })
      if (order?.[1] === "SELF") return call("talk_to_session", { contact: order[2], message: "PING" })
      if (order?.[1] === "UPDATE") return call("update_session", { contact_id: order[2], name: "Gamma two", purpose: "", task_status: "blocked" })
      if (lastUser.includes("CREATE-BAD")) return call("create_session", { name: "Bad", purpose: "Nothing", workspace: "relative/folder" })
      if (lastUser.includes("CREATE")) return call("create_session", { name: "Gamma", purpose: "Keeps the docs", workspace, task: "Write the guide" })
      return say("nothing to do")
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port

  const data = path.join(root, "session-chat-data")
  const storage = new SubagentStorage(path.join(data, "storage"))
  const bus = new Bus()
  const config = new SubagentConfig(storage, bus, path.join(data, "credentials.json"))
  // A stored config, so these checks run at the default level rather than a first install's 帮我审批.
  await storage.write("config", {})
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1` }], directory: project })
  await config.setApiKey("fake", "k")
  const permissions = new Permissions(bus, config)
  const store = new SubagentStore(storage, bus)
  const runner = new SubagentRunner(store, bus, config, permissions, { accessToken: async () => undefined } as never, storage)
  const model = { provider: "fake", model: "m" }
  const announced: Record<string, ChatLink[]>[] = []
  bus.subscribe((event) => {
    if (event.type === "session.chatLinks") announced.push(event.links)
  })

  const until = async (test: () => boolean | Promise<boolean>, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }
  // Nothing running and nothing in flight, for a moment.
  const quiet = async () => {
    const calm = () => runner.busySessions().length === 0 && Object.keys(runner.chat.links()).length === 0
    await until(async () => {
      if (!calm()) return false
      await new Promise((resolve) => setTimeout(resolve, 250))
      return calm()
    }, 20_000)
  }
  const partsOf = async (sessionID: string, name: string) =>
    (await store.messages(sessionID)).flatMap((message) =>
      message.role === "assistant" ? message.parts.filter((part): part is ToolPart => part.type === "tool" && part.name === name) : [],
    )
  // Everything the session's replies said, as one string: a streamed reply is one part holding every delta.
  const texts = async (sessionID: string) =>
    (await store.messages(sessionID))
      .flatMap((message) => (message.role === "assistant" ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []))
      .join("\n")

  const alpha = await store.create({ directory: project, model, title: "Alpha" })
  const beta = await store.create({ directory: project, model, title: "Beta" })

  // Contacts: the others, not itself.
  await runner.prompt({ sessionID: alpha.id, text: "CONTACTS" })
  await quiet()
  const [contacts] = await partsOf(alpha.id, "contacts")
  check("contacts lists the other sessions and leaves the caller out", contacts?.status === "completed" && (contacts.output ?? "").includes(`「Beta」 id=${beta.id} 空闲`) && !(contacts.output ?? "").includes(`id=${alpha.id}`), contacts?.output)

  // A waiting call: a real turn in the target, and its reply as the result.
  await runner.prompt({ sessionID: alpha.id, text: "TALK-SYNC:Beta" })
  await quiet()
  const [talked] = await partsOf(alpha.id, "talk_to_session")
  check("a waiting call returns the target's reply", talked?.status === "completed" && talked.output === "「Beta」的回复：\npong:PING", talked?.output)
  const betaAsked = (await store.messages(beta.id)).find((message) => message.role === "user")
  check(
    "the target's transcript has the words, marked as from the caller through the inbox field",
    betaAsked?.role === "user" && betaAsked.text === "PING" && betaAsked.inbox?.from === "Alpha" && betaAsked.inbox.sessionID === alpha.id && betaAsked.inbox.direction === "request",
    betaAsked,
  )
  check("the caller's model reads the result and carries on", (await texts(alpha.id)).includes("caller done"))
  check("links were announced while it ran, and are empty after", announced.some((links) => links[alpha.id]?.[0]?.direction === "outbound" && links[beta.id]?.[0]?.direction === "inbound") && Object.keys(runner.chat.links()).length === 0)

  // A busy target: queued, switched to async, and the reply comes back as a message that runs a turn.
  await runner.prompt({ sessionID: beta.id, text: "USER-SLOW" })
  await runner.prompt({ sessionID: alpha.id, text: "TALK-SYNC:Beta" })
  await until(async () => (await partsOf(alpha.id, "talk_to_session")).length === 2 && (await partsOf(alpha.id, "talk_to_session"))[1]?.status === "completed")
  const queuedPart = (await partsOf(alpha.id, "talk_to_session"))[1]
  const whileQueued = runner.chat.links()
  check("a call to a busy session is queued and returns at once", (queuedPart?.output ?? "").includes("busy, so the message was queued"), queuedPart?.output)
  check(
    "while it waits both sides show a queued link, first in line",
    whileQueued[beta.id]?.[0]?.phase === "queued" && whileQueued[beta.id]?.[0]?.queueAhead === 0 && whileQueued[alpha.id]?.[0]?.direction === "outbound" && whileQueued[alpha.id]?.[0]?.phase === "queued",
    whileQueued,
  )
  await quiet()
  const replyMessage = (await store.messages(alpha.id)).find((message) => message.role === "user" && message.inbox?.direction === "reply")
  check("the reply arrives in the caller marked as a reply from the target", replyMessage?.role === "user" && replyMessage.text === "pong:PING" && replyMessage.inbox?.from === "Beta", replyMessage)
  check("and runs a turn there", (await texts(alpha.id)).includes("got reply"))
  const betaSaid = await texts(beta.id)
  check("the busy target finished its own turn first", betaSaid.indexOf("user slow done") >= 0 && betaSaid.indexOf("user slow done") < betaSaid.lastIndexOf("pong:PING"), betaSaid)

  // A session cannot message itself.
  await runner.prompt({ sessionID: alpha.id, text: "SELF:Alpha" })
  await quiet()
  const selfPart = (await partsOf(alpha.id, "talk_to_session")).at(-1)
  // Round 10 (T10-49): a refusal is the call's result, as MiMo returns it, and in Chinese (T10-55).
  check("calling yourself is refused", selfPart?.status === "completed" && (selfPart.output ?? "").startsWith("未送达：不能给当前会话自己发消息"), selfPart)

  // create_session and update_session.
  await runner.prompt({ sessionID: alpha.id, text: "CREATE" })
  await quiet()
  const gamma = (await store.list()).find((session) => session.title === "Gamma")
  check(
    "create_session makes a conversation in the workspace with its record",
    gamma?.directory === workspace && gamma.chat?.purpose === "Keeps the docs" && gamma.chat.task === "Write the guide" && gamma.chat.taskStatus === "working",
    { gamma, part: (await partsOf(alpha.id, "create_session"))[0] },
  )
  check("the new conversation starts nothing until messaged", Boolean(gamma) && (await store.messages(gamma!.id)).length === 0)
  await runner.prompt({ sessionID: alpha.id, text: "CREATE-BAD" })
  await quiet()
  const badCreate = (await partsOf(alpha.id, "create_session")).at(-1)
  check("a workspace that is not an absolute folder is refused", badCreate?.status === "completed" && (badCreate.output ?? "").includes("绝对路径") && badCreate.metadata?.refused === true, badCreate)
  if (gamma) {
    await runner.prompt({ sessionID: alpha.id, text: `UPDATE:${gamma.id}` })
    await quiet()
    const changed = await store.get(gamma.id)
    check("update_session renames, clears an empty purpose and sets the status", changed?.title === "Gamma two" && changed.chat?.purpose === undefined && changed.chat?.task === "Write the guide" && changed.chat?.taskStatus === "blocked", changed)
  }

  // The hop limit: chain-1 calls chain-2 calls ... and the sixth call is refused.
  const chain: string[] = []
  for (let at = 1; at <= 7; at++) chain.push((await store.create({ directory: project, model, title: `chain-${at}` })).id)
  await runner.prompt({ sessionID: chain[0]!, text: "CHAIN:1" })
  await quiet()
  const refusedHop = (await partsOf(chain[5]!, "talk_to_session"))[0]
  check("a chain of calls is refused at the sixth hop", refusedHop?.status === "completed" && (refusedHop.output ?? "").includes("5 跳上限"), refusedHop)
  check("the session past the limit was never messaged", (await store.messages(chain[6]!)).length === 0)
  check("the replies unwind back to the start", (await texts(chain[0]!)).includes("chain 1 done"))

  // Stop while waiting: the call settles as stopped and nothing is delivered later.
  const delta = await store.create({ directory: project, model, title: "Delta" })
  await runner.prompt({ sessionID: alpha.id, text: "TALK-SLOW:Delta" })
  await until(() => runner.busySessions().includes(delta.id))
  await new Promise((resolve) => setTimeout(resolve, 100))
  runner.abort(alpha.id)
  await quiet()
  const stoppedPart = (await partsOf(alpha.id, "talk_to_session")).at(-1)
  check("Stop settles a waiting call cleanly", stoppedPart?.status === "error" && stoppedPart.error === "在收到回复之前已停止。" && stoppedPart.metadata?.aborted === true, stoppedPart)
  check("the target still finishes its turn", (await texts(delta.id)).includes("slow pong"))
  check("no reply is delivered to a call that was stopped", !(await store.messages(alpha.id)).some((message) => message.role === "user" && message.inbox?.from === "Delta"))

  // A queued target deleted: the caller hears that it is gone.
  const epsilon = await store.create({ directory: project, model, title: "Epsilon" })
  await runner.prompt({ sessionID: epsilon.id, text: "USER-SLOW" })
  await runner.prompt({ sessionID: alpha.id, text: "TALK-ASYNC:Epsilon" })
  await until(() => runner.chat.links()[epsilon.id]?.length === 1)
  runner.abort(epsilon.id)
  await store.delete(epsilon.id)
  await quiet()
  const gone = (await store.messages(alpha.id)).find((message) => message.role === "user" && message.inbox?.from === "Epsilon")
  check("deleting a target tells the caller it is gone", gone?.role === "user" && gone.text.includes("目标会话已不存在"), gone)

  await new Promise<void>((resolve) => provider.close(() => resolve()))
}

/** Round 5 (E45-E49): MCP tool names, the folder a server starts in, messages a server sends first, results, Stop and timeouts, remote transports, sampling. */
async function mcpChecks(project: string) {
  section("MCP servers (round 5)")
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (test: () => boolean, ms: number) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return true
      await sleep(25)
    }
    return test()
  }
  const listen = (server: ReturnType<typeof createServer>) =>
    new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)))
  const readBody = (request: import("node:http").IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => resolve(body))
    })

  // A Streamable HTTP server that answers a call as an event stream with a ping of its own first.
  const httpSeen: { session?: string; pingAnswered: boolean } = { pingAnswered: false }
  const streamable = createServer(async (request, response) => {
    if (request.method !== "POST") return void response.writeHead(405).end()
    const message = JSON.parse(await readBody(request))
    if (!message.method) {
      if (message.id === "p1" && message.result) httpSeen.pingAnswered = true
      return void response.writeHead(202).end()
    }
    if (message.id === undefined) return void response.writeHead(202).end()
    const reply = (result: unknown) => {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" })
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    }
    if (message.method === "initialize") reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } })
    else if (message.method === "tools/list") reply({ tools: [{ name: "echo", inputSchema: { type: "object" } }] })
    else if (message.method === "tools/call") {
      httpSeen.session = String(request.headers["mcp-session-id"] ?? "")
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "ping" })}\n\n`)
      await sleep(100)
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `http:${message.params.arguments.text}` }] } })}\n\n`)
    } else reply({})
  })
  // An HTTP+SSE-only server: a POST to its address is refused, its event stream names where to post.
  let legacyStream: ServerResponse | undefined
  const legacy = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("event: endpoint\ndata: /messages?session=1\n\n")
      legacyStream = response
      return
    }
    if (!request.url?.startsWith("/messages")) return void response.writeHead(405).end()
    const message = JSON.parse(await readBody(request))
    response.writeHead(202).end()
    if (message.id === undefined || !message.method) return
    const push = (result: unknown) => legacyStream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`)
    if (message.method === "initialize") push({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1" } })
    else if (message.method === "tools/list") push({ tools: [{ name: "echo", inputSchema: { type: "object" } }] })
    else if (message.method === "tools/call") push({ content: [{ type: "text", text: `legacy:${message.params.arguments.text}` }] })
    else push({})
  })
  const httpPort = await listen(streamable)
  const legacyPort = await listen(legacy)

  const fixture = path.join(process.cwd(), "scripts/fixtures/mcp-rich-server.cjs")
  const workFolder = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-mcp-cwd-"))
  let servers: Record<string, McpServerConfig> = {
    "my.server": { type: "local", command: ["node", fixture] },
    quick: { type: "local", command: ["node", fixture], timeout: 400 },
    web: { type: "remote", url: `http://127.0.0.1:${httpPort}/mcp`, oauth: false },
    old: { type: "remote", url: `http://127.0.0.1:${legacyPort}/sse`, oauth: false },
  }
  const stubConfig = {
    get: () => ({ mcpServers: servers, directory: workFolder }) as unknown as AppConfig,
    set: async (patch: Partial<AppConfig>) => {
      if (patch.mcpServers) servers = patch.mcpServers
      return stubConfig.get()
    },
  }
  const mcpBus = new Bus()
  const counts: number[] = []
  mcpBus.subscribe((event) => {
    if (event.type === "mcp.status") counts.push(event.servers.find((entry) => entry.name === "my.server")?.tools ?? -1)
  })
  const mcp = new McpServers(mcpBus, stubConfig as never)
  const sampled: { server: string; sessionID?: string }[] = []
  mcp.useSampling(async (input) => {
    sampled.push({ server: input.server, sessionID: input.sessionID })
    return { role: "assistant", content: { type: "text", text: "sampled" }, model: "fake/m", stopReason: "endTurn" }
  })
  await mcp.start()
  const mcpContext = (callID: string, signal = new AbortController().signal) =>
    ({ sessionID: "ses_mcp", messageID: "msg_mcp", callID, directory: project, permissions: { ask: async () => {} }, signal, progress: () => {}, snapshot: async () => {} }) as never
  const named = (name: string) => mcp.tools().find((tool) => tool.name === name)
  // A tool that is not there is a failed check, not a crash that hides every check after it.
  const run = async (name: string, input: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const tool = named(name)
    if (!tool) return `ERROR no tool named ${name}`
    return tool.execute(input, mcpContext(`m-${name}`, signal)).then(
      (result) => result.output,
      (error: Error) => `ERROR ${error.message}`,
    )
  }
  check("every configured server connects, both remote transports included", mcp.list().every((entry) => entry.status === "connected"), mcp.list())

  // E45
  check(
    "an MCP tool is named server_tool with everything outside [a-zA-Z0-9_-] as _",
    Boolean(named("my_server_echo")) && Boolean(named("my_server_ask-model")) && mcp.tools().every((tool) => /^[a-zA-Z0-9_-]+$/.test(tool.name)),
    mcp.tools().map((tool) => tool.name),
  )
  const echoSchema = named("my_server_echo")?.parameters
  check(
    "its schema is made a closed object",
    echoSchema?.type === "object" && echoSchema.additionalProperties === false && JSON.stringify(echoSchema.properties) === JSON.stringify({ text: { type: "string" } }),
    echoSchema,
  )
  check("a server with no schema gets empty properties", JSON.stringify(mcpToolSchema(undefined)) === JSON.stringify({ type: "object", properties: {}, additionalProperties: false }))

  // E46
  const where = await run("my_server_where")
  check("a local server starts in the project folder", path.resolve(where).toLowerCase() === path.resolve(workFolder).toLowerCase(), { where, workFolder })

  // E47
  const countsBefore = counts.length
  await run("my_server_grow")
  const grew = await waitFor(() => Boolean(named("my_server_extra")), 3000)
  check("tools/list_changed refetches a server's tools and says so", grew && counts.slice(countsBefore).includes(10), counts.slice(countsBefore))
  check("a server request reusing a waiting call's id is answered, not taken for the call's reply", (await run("my_server_collide")) === "pong:{}")
  check("Streamable HTTP: a call answered as an event stream, with the session sent back", (await run("web_echo", { text: "hi" })) === "http:hi" && httpSeen.session === "sess-1", httpSeen)
  check("and the server's own ping inside that stream is answered", await waitFor(() => httpSeen.pingAnswered, 2000))
  check("a server that only speaks HTTP+SSE is reached through the fallback", (await run("old_echo", { text: "hi" })) === "legacy:hi")

  // E48
  const shape = await run("my_server_shape")
  check(
    "a result keeps text and resource text, lists a link and appends structured content",
    shape === ["alpha", "resource body", "doc: https://example.com/doc"].join("\n\n") + '\n\nStructured content:\n{"answer":42}',
    shape,
  )
  /* L2: a server's picture is handed to the model rather than named in a line saying it was left out. */
  const shapeResult = await named("my_server_shape")!.execute({}, mcpContext("m-shape-media"))
  check(
    "a server's picture rides on the result as an attachment, and no line says it was left out",
    shapeResult.attachments?.length === 1 &&
      shapeResult.attachments[0].mime === "image/png" &&
      shapeResult.attachments[0].data.length > 0 &&
      !shapeResult.output.includes("left out"),
    shapeResult.attachments?.map((file) => ({ path: file.path, mime: file.mime, bytes: file.data.length })),
  )
  check("structured content the text already carries is not repeated", mcpToolOutput({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } }).output === '{"a":1}')
  check("structured content alone is the whole output", mcpToolOutput({ content: [], structuredContent: { a: 1 } }).output === '{"a":1}')
  const stopper = new AbortController()
  const slow = run("my_server_slow", {}, stopper.signal)
  await sleep(150)
  const stoppedAt = Date.now()
  stopper.abort()
  const slowResult = await slow
  check("Stop settles an MCP call at once", slowResult === "ERROR The MCP call was stopped" && Date.now() - stoppedAt < 500, slowResult)
  const parsed = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  const cancelledIDs = parsed(await run("my_server_cancelled"))
  check("and the server is told to cancel it", Array.isArray(cancelledIDs) && cancelledIDs.length === 1, cancelledIDs)
  const quickStart = Date.now()
  const timedOut = await run("quick_slow")
  check("a server's own timeout bounds its calls", timedOut === "ERROR tools/call timed out" && Date.now() - quickStart < 2000, { timedOut, ms: Date.now() - quickStart })

  // E49
  const asked = (parsed(await run("my_server_ask-model")) ?? {}) as { content?: { text?: string } }
  check(
    "a sampling request is answered, in the conversation whose call reached the server",
    asked.content?.text === "sampled" && sampled[0]?.server === "my.server" && sampled[0]?.sessionID === "ses_mcp",
    { asked, sampled },
  )

  mcp.close()
  legacyStream?.end()
  streamable.closeAllConnections()
  legacy.closeAllConnections()
  await new Promise<void>((resolve) => streamable.close(() => resolve()))
  await new Promise<void>((resolve) => legacy.close(() => resolve()))

  // The sampler itself: per-server policy, the question, and the model's answer over a fake provider.
  const model = createServer(async (request, response) => {
    await readBody(request)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "from the model" } }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  const modelPort = await listen(model)
  const policies: Record<string, McpServerConfig> = { off: { type: "local", sampling: "deny" }, open: { type: "local", sampling: "allow" }, asks: { type: "local" } }
  const samplingConfig = {
    get: () => ({ mcpServers: policies, model: { provider: "fake", model: "m" }, permissions: { ...PERMISSION_DEFAULTS } }),
    definition: (id: string) => (id === "fake" ? { id: "fake", kind: "openai", baseURL: `http://127.0.0.1:${modelPort}/v1` } : undefined),
    usable: () => true,
    apiKey: () => "k",
  }
  const samplingGate = new Permissions(new Bus(), samplingConfig as never)
  const sampler = createSampler({ config: samplingConfig as never, auth: {} as never, permissions: samplingGate })
  const params = { messages: [{ role: "user", content: { type: "text", text: "hello" } }], maxTokens: 20 }
  const signal = new AbortController().signal
  const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error)
  const off = await refusal(sampler({ server: "off", params, sessionID: "s", signal }))
  check("a server set to deny is refused with MiMo's code -1", off instanceof McpRequestError && off.code === -1, off)
  const nowhere = await refusal(sampler({ server: "asks", params, signal }))
  check("asking with no conversation to ask in is refused, not left waiting", nowhere instanceof McpRequestError && nowhere.code === -1, nowhere)
  const waiting = refusal(sampler({ server: "asks", params, sessionID: "s-sample", signal }))
  await sleep(30)
  const card = samplingGate.outstanding()[0]
  check("unset, a server's sampling asks in that conversation", card?.sessionID === "s-sample" && card.subject === "asks" && card.title === "mcp_sampling", card)
  if (card) samplingGate.respond(card.id, "reject")
  const declined = await waiting
  check("a refusal is answered with code -1", declined instanceof McpRequestError && declined.code === -1, declined)
  const answer = await sampler({ server: "open", params, signal })
  check(
    "a server set to allow gets the model's answer",
    (answer.content as { text?: string }).text === "from the model" && answer.model === "fake/m" && answer.role === "assistant" && answer.stopReason === "endTurn",
    answer,
  )
  const malformed = samplingRequest("x", { messages: [], maxTokens: 5 })
  check("a request with no messages is invalid params", malformed instanceof McpRequestError && malformed.code === -32602)
  check("the policy is ask when unset", samplingPolicy(undefined) === "ask" && samplingPolicy({ type: "local", sampling: "allow" }) === "allow")
  const kept = mergeMcpSecrets({ type: "local", command: ["x"], timeout: 5, sampling: "deny" }, { type: "local", command: ["y"] })
  check("saving from the form keeps a hand-written timeout and sampling policy", kept.timeout === 5 && kept.sampling === "deny", kept)
  model.closeAllConnections()
  await new Promise<void>((resolve) => model.close(() => resolve()))
  await fs.rm(workFolder, { recursive: true, force: true }).catch(() => {})
}

/* history, memory, cron: MiMo's three tools, the index behind the first two and the scheduler behind the third. */
async function historyMemoryCronChecks(root: string, project: string) {
  section("History, memory and scheduled prompts (MiMo's history, memory and cron tools)")

  // Pure pieces: queries, media, pages.
  check("a history query needs every word, each quoted", ftsQuery("foo.bar baz", "AND") === '"foo" AND "bar" AND "baz"', ftsQuery("foo.bar baz", "AND"))
  check("a memory query takes any word, punctuation dropped", ftsQuery("T5.3 closure", "OR") === '"T5" OR "3" OR "closure"')
  check("a query of punctuation alone searches nothing", ftsQuery("--- ::", "AND") === undefined)
  const inline = `see data:image/png;base64,${"A".repeat(400)} here`
  check("inline media is indexed as a marker, not its letters", withoutInlineMedia(inline) === "see [media image/png] here", withoutInlineMedia(inline))
  const pair = "a".repeat(3999) + "😀" + "b".repeat(5000)
  const firstPage = pageOf(pair)
  check("a page defaults to 4000 and stops short of splitting a surrogate pair", firstPage.text.length === 3999 && firstPage.next_offset === 3999 && firstPage.has_more && firstPage.total_length === 9001, firstPage.next_offset)
  check("a one-unit page on a pair takes the whole character", pageOf(pair, 3999, 1).text === "😀")
  const refuses = (work: () => unknown, pattern: RegExp) => {
    try {
      work()
      return false
    } catch (failure) {
      return pattern.test(String(failure))
    }
  }
  check("an offset inside a pair is refused", refuses(() => pageOf(pair, 4000), /surrogate/))
  check("a page longer than 8000 is refused", refuses(() => pageOf(pair, 0, 8001), /8000/))
  check("a page is cut to 16000 bytes", Buffer.byteLength(pageOf("你".repeat(8000), 0, 8000).text) <= 16000)
  check("a summary stops at 1000 characters and says so", summaryOf("x".repeat(1500)).startsWith(`${"x".repeat(1000)}\n[cut short`))
  check(
    "a part id carries its conversation and message, and nothing else passes for one",
    JSON.stringify(parsePartID("ses_0a/msg_0b/prt_0c")) === JSON.stringify({ sessionID: "ses_0a", messageID: "msg_0b", key: "prt_0c" }) && parsePartID("../x/y") === undefined,
  )

  // Cron expressions, in UTC. 2026-01-01 is a Thursday.
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 30)
  check("a daily time is its next match", nextCronRun("30 14 * * *", t0) === Date.UTC(2026, 0, 1, 14, 30))
  check("a step from a start runs to the end of the field", JSON.stringify(parseCron("5/20 * * * *")?.minute) === "[5,25,45]")
  check("with day of month and day of week both set, either matches", nextCronRun("0 9 15 * 1", t0) === Date.UTC(2026, 0, 5, 9, 0), new Date(nextCronRun("0 9 15 * 1", t0) ?? 0).toISOString())
  check("an impossible date never matches", nextCronRun("0 0 30 2 *", t0) === undefined)
  check("malformed expressions are refused", ["* * * *", "60 * * * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"].every((expression) => parseCron(expression) === undefined))
  const late = recurringFireAt("0 * * * *", t0, "abcd1234") ?? 0
  check("a recurring job is at most half its period late, and never over 30 minutes", late >= Date.UTC(2026, 0, 1, 1, 0) && late <= Date.UTC(2026, 0, 1, 1, 30), new Date(late).toISOString())
  const early = oneShotFireAt("30 14 1 1 *", t0, "abcd1234") ?? 0
  check("a one-shot on the half hour is up to 90 seconds early", early <= Date.UTC(2026, 0, 1, 14, 30) && early >= Date.UTC(2026, 0, 1, 14, 30) - 90_000)
  check("a loop's delay is clamped to 60-3600 seconds", clampLoopDelay(10) === 60 && clampLoopDelay(5000) === 3600 && clampLoopDelay(300) === 300)
  check("a flat cron call and a JSON-string operation are both understood", cronOperation({ cron: "* * * * *", prompt: "p" })?.action === "schedule" && cronOperation({ operation: '{"action":"list"}' })?.action === "list")

  // Memory layout.
  const data = path.join(root, "hmc-data")
  const memoryRoot = path.join(data, "memory")
  const files = memoryFiles(memoryRoot, project, "ses_0abc")
  check("project memory is filed by a stable hash of the folder", files.project === path.join(memoryRoot, "projects", projectMemoryID(project), "MEMORY.md") && projectMemoryID(project) === projectMemoryID(path.join(project, ".")))
  check(
    "a memory file reads as its scope, id and type",
    JSON.stringify(memoryLocation(memoryRoot, files.notes)) === JSON.stringify({ scope: "sessions", scope_id: "ses_0abc", type: "free", key: "notes" }) &&
      memoryLocation(memoryRoot, files.global)?.scope === "global" &&
      memoryType("MEMORY-api") === "memory" &&
      memoryType("tasks/T1/progress") === "progress" &&
      memoryLocation(memoryRoot, path.join(root, "x.md")) === undefined,
  )

  // The history index over a real store.
  const storage = new SubagentStorage(path.join(data, "storage"))
  const bus = new Bus()
  const store = new SubagentStore(storage, bus)
  const model = { provider: "fake", model: "m" }
  const otherProject = path.join(root, "hmc-other")
  await fs.mkdir(otherProject, { recursive: true })
  const alpha = await store.create({ directory: project, model, title: "History alpha" })
  const beta = await store.create({ directory: otherProject, model, title: "History beta" })
  const asked = (session: HistorySession, id: string, text: string, created: number): HistoryMessage => ({ id, sessionID: session.id, role: "user", text, attachments: [], time: { created } })
  const answered = (session: HistorySession, id: string, parts: unknown[], created: number) =>
    ({ id, sessionID: session.id, role: "assistant", model, agent: "build", parts, time: { created } }) as HistoryMessage
  await store.saveMessage(asked(alpha, "msg_0001a", "please find the quokkafile in the repo", 1000), true)
  await store.saveMessage(
    answered(
      alpha,
      "msg_0001b",
      [
        { type: "text", id: "prt_0001", text: "The quokkafile lives under src." },
        { type: "tool", id: "prt_0002", callID: "c1", name: "grep", status: "completed", input: { pattern: "wombatsearch" }, output: "src/zoo.ts:1 wombatsearch", time: { created: 1100 } },
        { type: "tool", id: "prt_0003", callID: "c2", name: "bash", status: "running", input: { command: "echo platypusrun" }, time: { created: 1200 } },
      ],
      1001,
    ),
    true,
  )
  await store.saveMessage(asked(beta, "msg_0002a", "the quokkafile elsewhere", 2000), true)

  const indexPath = path.join(data, "index", "search.db")
  let database = IndexDatabase.open(indexPath)
  check("a missing index file is created", database.openedAs === "created")
  let index = new HistoryIndex(database, store, storage, bus)
  await index.start()
  const hits = (query: string, extra: Record<string, unknown> = {}) => index.search({ query, ...extra })
  check("the first start indexes what is already stored", hits("quokkafile").length === 3, hits("quokkafile"))
  check("scope project keeps to the project", hits("quokkafile", { directory: project }).length === 2 && hits("quokkafile", { directory: project }).every((hit) => hit.session_id === alpha.id))
  check("a finished tool call is found by its input and output, and filtered by tool name", hits("wombatsearch", { toolName: "grep" }).length === 1 && hits("wombatsearch", { toolName: "bash" }).length === 0)
  check("a running tool call is not indexed until it settles", hits("platypusrun").length === 0)
  check("every word must appear", hits("quokkafile elsewhere").length === 1)
  check("a hit marks its words in the snippet and scores above zero", Boolean(hits("wombatsearch")[0]?.snippet.includes("<<wombatsearch>>")) && (hits("wombatsearch")[0]?.score ?? 0) > 0, hits("wombatsearch")[0])

  await store.saveMessage(asked(alpha, "msg_0001c", "now about the echidnaplan", 3000), true)
  check("a silent save is searchable straight away", hits("echidnaplan").length === 1)
  await store.deleteMessage(alpha.id, "msg_0001c")
  check("a deleted message leaves the index", hits("echidnaplan").length === 0)
  await store.update(beta.id, { directory: project })
  check("a conversation moved to another project is searched there", hits("quokkafile", { directory: project }).length === 3)
  await store.update(beta.id, { directory: otherProject })
  const many = await store.create({ directory: project, model, title: "History many" })
  for (let at = 0; at < 60; at++) await store.saveMessage(asked(many, `msg_01${String(at).padStart(3, "0")}`, `needlework ${"filler ".repeat(200)} #${at}`, 4000 + at), true)
  check("search gives 10 by default and never more than 50", hits("needlework").length === 10 && hits("needlework", { limit: 500 }).length === 50)

  // The tools, bound the way the backend binds them.
  let memory = new MemoryIndex(database, memoryRoot)
  bindHistory({ database, index, memory, store, storage, memoryRoot } as HistoryService)
  const context = (sessionID: string, extra: Record<string, unknown> = {}) =>
    ({ sessionID, messageID: "m", callID: "c", directory: project, signal: new AbortController().signal, progress: () => {}, snapshot: async () => {}, ...extra }) as unknown as HistoryToolContext
  const searched = await HistoryTool.execute({ operation: "search", query: "needlework", limit: 50 }, context(alpha.id))
  check("fifty hits come back within 19.5 KB, each with its part id", Buffer.byteLength(searched.output) <= HISTORY_BUDGET && searched.metadata?.count === 50 && searched.output.split("part_id=").length > 40, Buffer.byteLength(searched.output))
  const crowded = await HistoryTool.execute({ operation: "around", message_id: "msg_01059", before: 50, after: 0 }, context(alpha.id))
  check(
    "around over fifty long messages stays within 19.5 KB, keeps the anchor and says it was cut",
    Buffer.byteLength(crowded.output) <= HISTORY_BUDGET && crowded.metadata?.truncated === true && crowded.output.includes(">>> message_id=msg_01059") && crowded.metadata?.count === 51,
    [Buffer.byteLength(crowded.output), crowded.metadata],
  )
  const wide = await HistoryTool.execute({ operation: "search", query: "quokkafile", scope: "global" }, context(alpha.id))
  check("scope global reaches other projects", wide.metadata?.count === 3, wide.output)
  const near = await HistoryTool.execute({ operation: "around", message_id: "msg_0001b", before: 1, after: 0 }, context(alpha.id))
  check("around centres on the message with the neighbours asked for", near.output.includes(">>> message_id=msg_0001b") && near.output.includes("--- message_id=msg_0001a") && near.metadata?.count === 2, near.output)
  await store.saveMessage(answered(alpha, "msg_0001d", [{ type: "text", id: "prt_0009", text: pair }], 5000), true)
  const long = partID(alpha.id, "msg_0001d", "prt_0009")
  const got = await HistoryTool.execute({ operation: "get", part_id: long }, context(alpha.id))
  check("get pages a part out of the store, 4000 at a time", got.output.startsWith("offset=0 next_offset=3999 total_length=9001 has_more=true"), got.output.slice(0, 90))
  const rest = await HistoryTool.execute({ operation: "get", part_id: long, offset: 3999, length: 8000 }, context(alpha.id))
  check("and goes on from next_offset to the end", rest.output.startsWith("offset=3999 next_offset=9001 total_length=9001 has_more=false"), rest.output.slice(0, 90))
  const split = await HistoryTool.execute({ operation: "get", part_id: long, offset: 4000 }, context(alpha.id))
  check("an offset inside a character is refused in words", split.output.includes("surrogate"))
  check("a limit over 50 is refused", await HistoryTool.execute({ operation: "search", query: "x", limit: 51 }, context(alpha.id)).then(() => false, (failure) => failure instanceof ToolError))
  const explorer = await store.create({ directory: project, model, title: "explore-1", parentID: alpha.id, subagent: { type: "explore", id: "explore-1" } })
  check("an explore subagent is refused history and memory", (await HistoryTool.execute({ operation: "search", query: "x" }, context(explorer.id)).then(() => false, () => true)) && (await MemoryTool.execute({ query: "x" }, context(explorer.id)).then(() => false, () => true)))

  // Rebuilt from the store: a change the index never saw, a deleted file, a damaged one, another schema.
  const treeHash = async (directory: string) => {
    const hash = createHash("sha1")
    const walk = async (at: string) => {
      for (const entry of (await fs.readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(at, entry.name)
        if (entry.isDirectory()) await walk(full)
        else hash.update(full).update(await fs.readFile(full))
      }
    }
    await walk(directory)
    return hash.digest("hex")
  }
  index.close()
  database.close()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await storage.write(`session/${alpha.id}/message/msg_0001a`, asked(alpha, "msg_0001a", "please find the lyrebirdnote in the repo", 1000))
  database = IndexDatabase.open(indexPath)
  index = new HistoryIndex(database, store, storage, bus)
  await index.start()
  check("a message changed while the app was closed is indexed again at start", hits("lyrebirdnote").length === 1 && hits("quokkafile").length === 2, hits("quokkafile").length)
  index.close()
  database.close()
  await fs.rm(indexPath, { force: true })
  await fs.rm(`${indexPath}-wal`, { force: true })
  await fs.rm(`${indexPath}-shm`, { force: true })
  const storeBefore = await treeHash(path.join(data, "storage"))
  database = IndexDatabase.open(indexPath)
  index = new HistoryIndex(database, store, storage, bus)
  await index.start()
  check("a deleted index is rebuilt from the store", database.openedAs === "created" && hits("lyrebirdnote").length === 1 && hits("needlework", { limit: 50 }).length === 50 && hits("wombatsearch").length === 1)
  check("rebuilding never writes to the store", (await treeHash(path.join(data, "storage"))) === storeBefore)
  index.close()
  database.close()
  for (const suffix of ["-wal", "-shm"]) await fs.rm(indexPath + suffix, { force: true })
  await fs.writeFile(indexPath, "this is not a database, only words")
  database = IndexDatabase.open(indexPath)
  index = new HistoryIndex(database, store, storage, bus)
  await index.start()
  check("a damaged index file is replaced and rebuilt", database.openedAs === "recreated" && hits("lyrebirdnote").length === 1)
  database.db.exec("PRAGMA user_version = 99")
  index.close()
  database.close()
  database = IndexDatabase.open(indexPath)
  check("an index from another schema is started over", database.openedAs === "recreated")
  index = new HistoryIndex(database, store, storage, bus)
  await index.start()

  // Memory: BM25 with MiMo's floor, kept level with the files.
  memory = new MemoryIndex(database, memoryRoot)
  bindHistory({ database, index, memory, store, storage, memoryRoot } as HistoryService)
  await fs.mkdir(path.dirname(files.project), { recursive: true })
  await fs.writeFile(files.project, "# Project memory\n## Rules\n- the zebracorn configuration stays pinned; zebracorn is the codename\n")
  for (let at = 0; at < 6; at++) {
    const notes = path.join(memoryRoot, "sessions", `ses_0mem${at}`, "notes.md")
    await fs.mkdir(path.dirname(notes), { recursive: true })
    await fs.writeFile(notes, `## [turn ${at}]\nconfiguration note ${at} ${"ordinary words ".repeat(20)}\n`)
  }
  await fs.mkdir(path.dirname(files.global), { recursive: true })
  await fs.writeFile(files.global, "# Global memory\nPrefers tabs.\n")
  const pinned = await memory.search({ query: "zebracorn configuration" })
  check("any word matches, and results under 15% of the best are dropped", pinned.length === 1 && pinned[0]?.path === files.project, pinned.map((hit) => [path.basename(path.dirname(hit.path)), hit.score]))
  const common = await memory.search({ query: "configuration" })
  check("the best result is always kept, with those close to it", common.length === 7, common.map((hit) => hit.score))
  check("limit, scope, scope id and type narrow the search", (await memory.search({ query: "configuration", limit: 2 })).length === 2 && (await memory.search({ query: "tabs", scope: "global" })).length === 1 && (await memory.search({ query: "configuration", scope: "sessions", scope_id: "ses_0mem3" })).length === 1 && (await memory.search({ query: "configuration", type: "memory" }))[0]?.path === files.project)
  await fs.rm(path.join(memoryRoot, "sessions", "ses_0mem0"), { recursive: true, force: true })
  await fs.writeFile(files.global, "# Global memory\nPrefers kookaburra spacing.\n")
  check("a deleted file leaves and a changed one is read again before searching", (await memory.search({ query: "configuration" })).length === 6 && (await memory.search({ query: "kookaburra" })).length === 1)
  const recalled = await MemoryTool.execute({ query: "zebracorn" }, context(alpha.id))
  check("the memory tool names the file, its scope and score", recalled.output.includes(`### ${files.project}`) && recalled.output.includes("Scope: projects/") && recalled.metadata?.count === 1, recalled.output)
  check("and says what to try when nothing matches", (await MemoryTool.execute({ query: "nonexistentword" }, context(alpha.id))).metadata?.count === 0)
  const told = await systemPrompt({ directory: project, agent: "build", memory: files })
  check("a conversation is told its three memory files", told.includes("## Memory") && told.includes(files.project) && told.includes(files.global) && told.includes(files.notes))
  check("and a prompt without them says nothing of memory", !(await systemPrompt({ directory: project, agent: "build" })).includes("## Memory"))
  const asking = { allowsOutside: () => false, ask: async () => { throw new Error("asked") } }
  check("memory files are reached without asking; other outside files still ask", (await resolveToolPath(context(alpha.id, { permissions: asking }), files.notes)) === files.notes && (await resolveToolPath(context(alpha.id, { permissions: asking }), path.join(root, "elsewhere.txt")).then(() => false, () => true)))

  // The durable task file.
  const cronDir = path.join(root, "hmc-cron")
  await writeCronTasks(cronDir, [{ id: "a1", cron: "* * * * *", prompt: "p", createdAt: 1, durable: true }, { id: "bad", cron: "nope", prompt: "p", createdAt: 1 }])
  const written = JSON.parse(await fs.readFile(cronFile(cronDir), "utf8")) as { tasks: Record<string, unknown>[] }
  check("durable tasks go to .mcode/scheduled_tasks.json without the malformed one or the runtime flag", cronFile(cronDir) === path.join(cronDir, ".mcode", "scheduled_tasks.json") && written.tasks.length === 1 && written.tasks[0]?.durable === undefined, written)
  await fs.writeFile(cronFile(cronDir), `﻿${JSON.stringify(written)}`)
  check("and read back, byte-order mark and all", (await readCronTasks(cronDir)).length === 1)
  await fs.writeFile(cronFile(cronDir), "{ not json")
  check("an unreadable file reads as no tasks", (await readCronTasks(cronDir)).length === 0)

  // The scheduler on a fake clock.
  let clock = Date.UTC(2026, 0, 1, 0, 0, 10)
  const fired: { sessionID: string; text: string }[] = []
  const busy = new Set<string>()
  const schedDir = path.join(root, "hmc-sched")
  await fs.mkdir(schedDir, { recursive: true })
  const host = {
    now: () => clock,
    fire: async (sessionID: string, text: string) => {
      fired.push({ sessionID, text })
    },
    busy: (sessionID: string) => busy.has(sessionID),
    session: (sessionID: string) => store.get(sessionID),
    // cron: a durable task whose conversation is gone is adopted by a new one in the project.
    create: (directory: string) => store.create({ directory, model, title: "Scheduled tasks" }),
    directories: async () => [schedDir],
  }
  const scheduler = new CronScheduler(host)
  await scheduler.start({ interval: false })
  const every = await scheduler.add({ ownerID: alpha.id, directory: schedDir, cron: "*/5 * * * *", prompt: "every five", recurring: true, durable: false })
  await scheduler.tick()
  check("nothing fires before its time", fired.length === 0)
  const due = scheduler.dueAt(every.id) ?? 0
  check("a */5 job's run is at the next five-minute mark, up to 15 seconds early", due <= Date.UTC(2026, 0, 1, 0, 5) && due >= Date.UTC(2026, 0, 1, 0, 5) - 15_000, new Date(due).toISOString())
  clock = Date.UTC(2026, 0, 1, 0, 5, 1)
  busy.add(alpha.id)
  await scheduler.tick()
  check("a due job waits while its conversation is busy", fired.length === 0)
  busy.delete(alpha.id)
  await scheduler.tick()
  check("and fires into that conversation once it is idle, marked as scheduled", fired.length === 1 && fired[0]?.sessionID === alpha.id && fired[0]?.text === `[Scheduled cron ${every.id} · 2026-01-01T00:05:01Z] every five`, fired)
  check("the window can tell a fired prompt from one someone typed", isScheduledPrompt(fired[0]?.text ?? "") && !isScheduledPrompt("[Scheduled cron abc] typed by hand") && !isScheduledPrompt("every five"))
  await scheduler.tick()
  check("one match fires once, and the next run is the following match", fired.length === 1 && (scheduler.dueAt(every.id) ?? 0) >= Date.UTC(2026, 0, 1, 0, 10) - 15_000)
  await scheduler.remove(every.id)
  const once = await scheduler.add({ ownerID: alpha.id, directory: schedDir, cron: "7 0 * * *", prompt: "once durable", recurring: false, durable: true })
  check("a durable job is written to the project's file", (await readCronTasks(schedDir)).some((task) => task.id === once.id && task.createdBySessionId === alpha.id))
  const lockFile = path.join(schedDir, ".mcode", ".cron-lock")
  check("and the scheduler holds that project's lock", (JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid: number }).pid === process.pid)
  clock = Date.UTC(2026, 0, 1, 0, 7, 0)
  await scheduler.tick()
  check("a one-shot fires once and leaves the file", Boolean(fired.at(-1)?.text.includes("once durable")) && !(await readCronTasks(schedDir)).some((task) => task.id === once.id))
  const aging = await scheduler.add({ ownerID: alpha.id, directory: schedDir, cron: "0 * * * *", prompt: "aging", recurring: true, durable: false })
  clock += 8 * 24 * 60 * 60 * 1000
  await scheduler.tick()
  check("a recurring job older than a week runs once more and ends", Boolean(fired.at(-1)?.text.includes("aging")) && !(await scheduler.list({})).some((task) => task.id === aging.id))
  const gone = await store.create({ directory: project, model, title: "gone soon" })
  const orphan = await scheduler.add({ ownerID: gone.id, directory: schedDir, cron: "* * * * *", prompt: "orphan", recurring: true, durable: false })
  await store.delete(gone.id)
  clock += 2 * 60 * 1000
  const beforeOrphan = fired.length
  await scheduler.tick()
  check("a job whose conversation was deleted is dropped without firing", fired.length === beforeOrphan && !(await scheduler.list({})).some((task) => task.id === orphan.id))

  const missedDir = path.join(root, "hmc-missed")
  await writeCronTasks(missedDir, [{ id: "miss0001", cron: "0 12 * * *", prompt: "missed while closed", createdAt: Date.UTC(2025, 11, 30), createdBySessionId: alpha.id }])
  const restarted = new CronScheduler({ ...host, directories: async () => [missedDir] })
  const beforeMissed = fired.length
  await restarted.start({ interval: false })
  check("a one-shot missed while the app was closed fires at start and is removed", fired.length === beforeMissed + 1 && Boolean(fired.at(-1)?.text.includes("missed while closed")) && (await readCronTasks(missedDir)).length === 0)
  await restarted.stop()

  const lockedDir = path.join(root, "hmc-locked")
  await writeCronTasks(lockedDir, [{ id: "lock0001", cron: "* * * * *", prompt: "not mine", createdAt: clock - 60 * 60 * 1000, createdBySessionId: alpha.id, recurring: true }])
  await fs.writeFile(path.join(lockedDir, ".mcode", ".cron-lock"), JSON.stringify({ pid: process.ppid, startedAt: 1 }))
  const other = new CronScheduler({ ...host, directories: async () => [lockedDir] })
  await other.start({ interval: false })
  const beforeLocked = fired.length
  await other.tick()
  check("a project locked by another running copy of the app is left to it", fired.length === beforeLocked)
  await other.stop()

  const armed = scheduler.armLoop({ ownerID: alpha.id, directory: schedDir, prompt: "watch deploy", delaySeconds: 10 })
  check("a loop's delay is clamped and its run lands on a whole minute", armed?.clampedSeconds === 60 && armed.wasClamped && armed.scheduledFor % 60_000 === 0 && armed.scheduledFor > clock, armed)
  const rearmed = scheduler.armLoop({ ownerID: alpha.id, directory: schedDir, prompt: "watch deploy", delaySeconds: 300 })
  check("arming the same loop again replaces its run", rearmed?.superseded === 1 && (await scheduler.list({ kind: "loop" })).length === 1)
  scheduler.turnEnded(alpha.id)
  check("a loop re-armed in the turn keeps its count at zero", scheduler.loopsOf(alpha.id)[0]?.strikes === 0)
  clock = (rearmed?.scheduledFor ?? 0) + 1000
  await scheduler.tick()
  check("the loop's run fires", Boolean(fired.at(-1)?.text.startsWith("[Scheduled loop")) && Boolean(fired.at(-1)?.text.endsWith("watch deploy")))
  scheduler.turnEnded(alpha.id)
  const kept = scheduler.loopsOf(alpha.id)[0]
  check("a turn that does not re-arm gets one more run, 20 minutes on", kept?.strikes === 1 && kept.lastScheduledFor >= clock + (KEEPALIVE_DELAY_SECONDS - 60) * 1000, kept)
  clock = (kept?.lastScheduledFor ?? 0) + 1000
  await scheduler.tick()
  scheduler.turnEnded(alpha.id)
  check("and the loop ends when that run is not re-armed either", scheduler.loopsOf(alpha.id).length === 0 && (await scheduler.list({ kind: "loop" })).length === 0)
  await scheduler.stop()
  check("stopping releases the lock", !(await exists(lockFile)))

  // The runner over a fake provider: what subagents are offered, a scheduled prompt's turn, and history from the model.
  const seenTools: Record<string, string[]> = {}
  let sawRunNote = false
  let callCount = 0
  const provider = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const sent = JSON.parse(body || "{}") as { messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] }
      const messages = sent.messages ?? []
      const lastUserAt = messages.map((message) => message.role).lastIndexOf("user")
      const lastUser = JSON.stringify(messages[lastUserAt]?.content ?? "")
      const replied = messages.slice(lastUserAt + 1).some((message) => message.role === "tool")
      for (const marker of ["EXPLORE-CHILD", "GENERAL-CHILD", "TOP-LEVEL"]) if (lastUser.includes(marker)) seenTools[marker] = (sent.tools ?? []).map((tool) => tool.function?.name ?? "")
      if (lastUser.includes("[Scheduled task run]") && lastUser.includes("AUTOMATION-SAYS-HI")) sawRunNote = true
      response.writeHead(200, { "content-type": "text/event-stream" })
      const frame = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
      const end = (reason: string) => {
        frame({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
        response.write("data: [DONE]\n\n")
        response.end()
      }
      const say = (text: string) => {
        frame({ choices: [{ delta: { content: text } }] })
        end("stop")
      }
      const call = (name: string, input: Record<string, unknown>) => {
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_hmc_${++callCount}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }] })
        end("tool_calls")
      }
      if (replied) return say("done")
      if (lastUser.includes("SPAWN-EXPLORE")) return call("actor", { action: "run", description: "look around", prompt: "EXPLORE-CHILD", subagent_type: "explore" })
      if (lastUser.includes("SPAWN-GENERAL")) return call("actor", { action: "run", description: "do work", prompt: "GENERAL-CHILD", subagent_type: "general" })
      if (lastUser.includes("SCHEDULE-IT")) return call("cron", { operation: { action: "schedule", cron: "*/5 * * * *", prompt: "CRON-WRITES" } })
      if (lastUser.includes("CRON-WRITES")) return call("write", { file_path: "from-cron.txt", content: "x" })
      if (lastUser.includes("HISTORY-IT")) return call("history", { operation: "search", query: "quokkafile", scope: "global" })
      return say("nothing to do")
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()))
  const port = (provider.address() as { port: number }).port
  const runnerData = path.join(root, "hmc-runner")
  const runnerStorage = new SubagentStorage(path.join(runnerData, "storage"))
  const runnerBus = new Bus()
  const config = new SubagentConfig(runnerStorage, runnerBus, path.join(runnerData, "credentials.json"))
  await config.load()
  await config.set({ customProviders: [{ id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${port}/v1` }], directory: project })
  await config.setApiKey("fake", "k")
  // The ask level, not the first-install approve-for-me one: the check below is that a scheduled turn still asks.
  await config.set({ accessLevel: "ask" })
  const permissions = new Permissions(runnerBus, config)
  const runnerStore = new SubagentStore(runnerStorage, runnerBus)
  const runner = new SubagentRunner(runnerStore, runnerBus, config, permissions, { accessToken: async () => undefined } as never, runnerStorage)
  const runnerIndex = new HistoryIndex(database, runnerStore, runnerStorage, runnerBus)
  bindHistory({ database, index: runnerIndex, memory, store: runnerStore, storage: runnerStorage, memoryRoot } as HistoryService)
  let runnerClock = Date.UTC(2026, 3, 1, 8, 1, 0)
  const live = new CronScheduler({
    now: () => runnerClock,
    fire: async (sessionID, text) => {
      await runner.prompt({ sessionID, text })
    },
    busy: (sessionID) => runner.isRunning(sessionID),
    session: (sessionID) => runnerStore.get(sessionID),
    directories: async () => [project],
  })
  await live.start({ interval: false })
  bindScheduler(live)
  const asks: string[] = []
  runnerBus.subscribe((event) => {
    if (event.type === "permission.requested") asks.push(event.request.sessionID)
    if (event.type === "session.idle") live.turnEnded(event.sessionID)
  })
  const until = async (test: () => boolean | Promise<boolean>, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await test()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }
  const quiet = () => until(async () => runner.busySessions().length === 0, 20_000)
  const parent = await runnerStore.create({ directory: project, model, title: "Runner parent" })

  await runner.prompt({ sessionID: parent.id, text: "TOP-LEVEL" })
  await quiet()
  check("a conversation is offered history, memory and cron", ["history", "memory", "cron"].every((name) => seenTools["TOP-LEVEL"]?.includes(name)), seenTools["TOP-LEVEL"])
  await runner.prompt({ sessionID: parent.id, text: "SPAWN-EXPLORE" })
  await quiet()
  await runner.prompt({ sessionID: parent.id, text: "SPAWN-GENERAL" })
  await quiet()
  check("an explore subagent is offered none of the three", Boolean(seenTools["EXPLORE-CHILD"]) && !["history", "memory", "cron"].some((name) => seenTools["EXPLORE-CHILD"]?.includes(name)), seenTools["EXPLORE-CHILD"])
  check("a general subagent keeps them, as MiMo's general agent does", ["history", "memory", "cron"].every((name) => seenTools["GENERAL-CHILD"]?.includes(name)), seenTools["GENERAL-CHILD"])
  check(
    "automation_update is offered to a conversation and to no subagent",
    Boolean(seenTools["TOP-LEVEL"]?.includes("automation_update")) && !seenTools["GENERAL-CHILD"]?.includes("automation_update") && !seenTools["EXPLORE-CHILD"]?.includes("automation_update"),
  )
  const child = (await runnerStore.list()).find((session) => session.parentID === parent.id && session.subagent?.type === "general")
  if (child) {
    const scheduledByChild = await CronTool.execute({ operation: { action: "schedule", cron: "0 0 1 1 *", prompt: "child job" } }, context(child.id))
    check("a general subagent's job belongs to the conversation it works for", (await live.list({ ownerID: parent.id })).some((task) => task.id === scheduledByChild.metadata?.id))
    await live.remove(String(scheduledByChild.metadata?.id))
  }

  await runner.prompt({ sessionID: parent.id, text: "HISTORY-IT" })
  await quiet()
  const historyPart = (await runnerStore.messages(parent.id)).flatMap((message) => (message.role === "assistant" ? message.parts : [])).find((part): part is ToolPart => part.type === "tool" && part.name === "history")
  check("the model's history call runs and returns summaries", historyPart?.status === "completed" && (historyPart.output ?? "").includes("part_id="), historyPart?.output)

  // Scheduling asks nothing, as in MiMo (the user removed round eight's X10 question on 2026-09-17).
  const asksBeforeSchedule = asks.length
  await runner.prompt({ sessionID: parent.id, text: "SCHEDULE-IT" })
  await quiet()
  const jobs = await live.list({ ownerID: parent.id })
  check("the model's schedule call adds a job for this conversation", jobs.length === 1 && jobs[0]?.prompt === "CRON-WRITES", jobs)
  check("...without anyone being asked about it", !asks.slice(asksBeforeSchedule).includes(parent.id), asks.slice(asksBeforeSchedule))
  runnerClock = (live.dueAt(jobs[0]?.id ?? "") ?? Date.UTC(2026, 3, 1, 8, 5)) + 1000
  await live.tick()
  const firedTurn = await until(async () => (await runnerStore.messages(parent.id)).some((message) => message.role === "user" && message.text.startsWith(`[Scheduled cron ${jobs[0]?.id}`)))
  check("when it comes due it starts a turn in that conversation", firedTurn)
  check("and that turn's write still asks for permission", await until(() => asks.includes(parent.id)), asks)
  runner.abort(parent.id)
  await quiet()

  // automation: a scheduled task's run through the real runner.
  const automationEvents: { type: string; phase?: string; notify?: boolean }[] = []
  let automationClock = Date.UTC(2026, 3, 1, 8, 0)
  const automations = new AutomationService({
    file: path.join(runnerData, "automations.json"),
    now: () => automationClock,
    sessions: runnerStore,
    prompt: (input) => runner.prompt(input),
    busy: (sessionID) => runner.isRunning(sessionID),
    models: () => [{ provider: "fake", id: "m", name: "Fake M" }],
    agent: () => "build",
    effort: () => undefined,
    scratch: async () => project,
    publish: (event) => runnerBus.publish(event),
  })
  await automations.start({ interval: false })
  runnerBus.subscribe((event) => {
    if (event.type === "automation.run") automationEvents.push(event)
    if (event.type === "session.idle") void automations.turnEnded(event.sessionID)
  })
  // A folder of its own: earlier sections move the shared project, and a run whose project is gone is skipped.
  const automationProject = path.join(root, "hmc-automation-project")
  await fs.mkdir(automationProject, { recursive: true })
  const automationHome = await runnerStore.create({ directory: automationProject, model, title: "Automation home" })
  const made = JSON.parse(await automations.handle({ mode: "create", title: "Morning note", prompt: "AUTOMATION-SAYS-HI", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0" }, { sessionID: automationHome.id })) as { automation: { id: string } }
  const automationDue = automations.dueAt(made.automation.id)
  automationClock = (automationDue ?? 0) + 1000
  const tickFailure = await automations.tick().then(
    () => undefined,
    (failure) => String(failure),
  )
  await until(async () => (await runnerStore.list()).some((session) => session.title === "Morning note"))
  await quiet()
  const runConversation = (await runnerStore.list()).find((session) => session.title === "Morning note")
  const runAsk = runConversation ? (await runnerStore.messages(runConversation.id)).find((message) => message.role === "user") : undefined
  check(
    "a due task opens a conversation named for it and runs its prompt there, marked as the task's",
    runAsk?.role === "user" && runAsk.text === "AUTOMATION-SAYS-HI" && runAsk.inbox?.automationID === made.automation.id && runConversation?.directory === automationProject,
    { runAsk, made, automationDue, automationClock, tickFailure, titles: (await runnerStore.list()).map((session) => session.title), automationEvents },
  )
  check("the model reads the run note, which the transcript does not keep", sawRunNote && !runAsk?.text.includes("[Scheduled task run]"))
  check("the run's end is announced under MiMo's rule for all-runs", await until(() => automationEvents.some((event) => event.phase === "finished" && event.notify === true)), automationEvents)
  await automations.stop()

  await live.stop()
  bindScheduler(undefined)
  runnerIndex.close()
  index.close()
  database.close()
  bindHistory(undefined)
  await new Promise<void>((resolve) => provider.close(() => resolve()))
}

/* automation: MiMo desktop's scheduled tasks - the recurrence rules, the tool's modes and the runs, on a fake clock. */
async function automationChecks(root: string, project: string) {
  section("Scheduled tasks (MiMo's automation_update)")

  // Recurrence rules, on this machine's wall clock.
  const valid = [
    "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
    "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15",
    "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
    "RRULE:FREQ=HOURLY;BYMINUTE=30",
    "DTSTART:20260101T0800\nRRULE:FREQ=DAILY;COUNT=2",
  ]
  check("MiMo's subset of rules is accepted", valid.every((rule) => parseRRule(rule) !== undefined), valid.filter((rule) => !parseRRule(rule)))
  const refused = [
    "FREQ=DAILY;BYHOUR=9",
    "RRULE:FREQ=MINUTELY",
    "RRULE:FREQ=WEEKLY;BYHOUR=9",
    "RRULE:FREQ=MONTHLY",
    "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
    "RRULE:FREQ=DAILY;COUNT=3",
    "DTSTART:20260101T0800\nRRULE:FREQ=DAILY;COUNT=3;UNTIL=20260301",
    "RRULE:FREQ=DAILY;BYSECOND=5",
    "RRULE:FREQ=DAILY;FREQ=DAILY",
    "RRULE:FREQ=WEEKLY;BYDAY=XX",
    "RRULE:FREQ=DAILY\nRRULE:FREQ=HOURLY",
  ]
  check("and everything outside it is refused", refused.every((rule) => parseRRule(rule) === undefined), refused.filter((rule) => parseRRule(rule)))
  const friday = new Date(2026, 0, 2, 10, 0).getTime()
  const next = (rule: string, after = friday) => nextOccurrence(parseRRule(rule)!, after)
  check("every day at 09:00, after 10:00, is tomorrow at 09:00", next("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0") === new Date(2026, 0, 3, 9, 0).getTime())
  check("weekdays after a Friday morning is Monday", next("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0") === new Date(2026, 0, 5, 9, 0).getTime())
  // Round 10 (T10-51): without DTSTART an interval counts from 1970, as MiMo counts it. 2026-01-04 is day 20457, the first multiple of three after Friday the 2nd.
  check("an interval without DTSTART counts from 1970", next("RRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0") === new Date(2026, 0, 4, 9, 0).getTime())
  check("hourly at half past is the next half hour", next("RRULE:FREQ=HOURLY;BYMINUTE=30") === new Date(2026, 0, 2, 10, 30).getTime())
  check("COUNT stops after that many runs", next("DTSTART:20260101T0800\nRRULE:FREQ=DAILY;COUNT=2") === undefined && next("DTSTART:20260101T0800\nRRULE:FREQ=DAILY;COUNT=3") === new Date(2026, 0, 3, 8, 0).getTime())
  check("UNTIL stops at its date", next("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20260102T2359") === undefined)
  check(
    "schedules read the way MiMo names them",
    scheduleLabel("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=5") === "Every day 9:05" &&
      scheduleLabel("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0") === "Weekdays 9:00" &&
      scheduleLabel("RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0") === "Monday (time: 9:00)" &&
      scheduleLabel("RRULE:FREQ=HOURLY;BYMINUTE=0") === "Hourly" &&
      scheduleLabel("RRULE:FREQ=DAILY;INTERVAL=2") === "Every 2 days" &&
      scheduleLabel("RRULE:FREQ=MONTHLY;BYMONTHDAY=1", "First of the month") === "First of the month",
  )
  check(
    "MiMo's notification rule: all runs; failed or skipped only; replies in an existing conversation only",
    notifies("all-runs", "new-task", "succeeded", false) &&
      !notifies("failed-runs", "new-task", "succeeded", true) &&
      notifies("failed-runs", "existing-task", "skipped", false) &&
      !notifies("important-updates", "new-task", "succeeded", true) &&
      notifies("important-updates", "existing-task", "succeeded", true) &&
      !notifies("important-updates", "existing-task", "succeeded", false),
  )
  const noted = withAutomationNotes([
    { id: "u1", sessionID: "s", role: "user", text: "remind me", attachments: [], inbox: { from: "Morning", automationID: "auto-1" }, time: { created: 1 } },
    { id: "u2", sessionID: "s", role: "user", text: "plain", attachments: [], time: { created: 2 } },
  ])
  check("a run's message carries the run note in the request, other messages do not", noted[0]?.role === "user" && noted[0].text === `${AUTOMATION_RUN_NOTE}\n\nremind me` && noted[1]?.role === "user" && noted[1].text === "plain")

  // The service on a fake clock.
  const data = path.join(root, "automation-data")
  const storage = new SubagentStorage(path.join(data, "storage"))
  const bus = new Bus()
  const store = new SubagentStore(storage, bus)
  const model = { provider: "fake", model: "m" }
  const home = await store.create({ directory: project, model, title: "Automation home" })
  const child = await store.create({ directory: project, model, title: "general-1", parentID: home.id, subagent: { type: "general", id: "general-1" } })
  let clock = new Date(2026, 0, 2, 10, 0).getTime()
  const prompts: { sessionID: string; text: string; inbox: unknown }[] = []
  const events: { type: string; sessionID?: string; phase?: string; notify?: boolean }[] = []
  const busy = new Set<string>()
  const file = path.join(data, "automations.json")
  const deps = {
    file,
    now: () => clock,
    sessions: store,
    prompt: async (input: { sessionID: string; text: string; inbox: unknown }) => {
      prompts.push(input)
    },
    busy: (sessionID: string) => busy.has(sessionID),
    models: () => [
      { provider: "fake", id: "m", name: "Fake M" },
      { provider: "fake", id: "big", name: "Fake Big" },
    ],
    agent: () => "build" as const,
    effort: () => "high" as const,
    scratch: async () => path.join(root, "automation-scratch"),
    publish: (event: { type: string }) => {
      events.push(event)
    },
  }
  const service = new AutomationService(deps)
  await service.start({ interval: false })
  const call = async (input: Record<string, unknown>, sessionID = home.id) => JSON.parse(await service.handle(input, { sessionID })) as Record<string, any>
  const fails = (input: Record<string, unknown>, pattern: RegExp, sessionID = home.id) =>
    service.handle(input, { sessionID }).then(
      () => false,
      (failure) => failure instanceof ToolError && pattern.test(failure.message),
    )
  check("a subagent cannot manage scheduled tasks", await fails({ mode: "list" }, /subagent/, child.id))
  check("create names what it is missing", await fails({ mode: "create", title: "x" }, /prompt, rrule/))
  check("a rule outside the subset is refused with the format", await fails({ mode: "create", title: "x", prompt: "p", rrule: "FREQ=DAILY" }, /RRULE:FREQ=DAILY;BYHOUR=9/))
  const created = await call({ mode: "create", title: "Daily digest", prompt: "Summarise the day", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0", operationId: "op-1" })
  check(
    "create keeps the task with MiMo's defaults: active, a new conversation per run, every run notified, this conversation's model and project, the app's reasoning",
    created.ok === true &&
      created.automation.id === "auto-1" &&
      created.automation.status === "active" &&
      created.automation.runMode === "new-task" &&
      created.automation.notification === "all-runs" &&
      created.automation.model.id === "fake/m" &&
      created.automation.model.name === "Fake M" &&
      // Round 10 (T10-53): a model that offers no reasoning level is given none.
      created.automation.reasoning === undefined &&
      created.automation.project === path.basename(project) &&
      created.automation.schedule === "Every day 9:00",
    created,
  )
  check("its first run is the next 09:00", service.dueAt("auto-1") === new Date(2026, 0, 3, 9, 0).getTime())
  check("the same operationId answers a retry exactly as before", (await service.handle({ mode: "create", title: "Daily digest", prompt: "Summarise the day", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0", operationId: "op-1" }, { sessionID: home.id })) === JSON.stringify(created))
  check("and refuses a different change", await fails({ mode: "create", title: "Other", prompt: "p", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0", operationId: "op-1" }, /operationId/))
  const again = await call({ mode: "create", title: "Daily digest", prompt: "Summarise the day", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })
  check("the same task asked for again is kept once", again.deduplicated === true && again.created === false && (await call({ mode: "list" })).automations.length === 1)
  check("a model nobody connected is refused", await fails({ mode: "create", title: "x", prompt: "p", rrule: "RRULE:FREQ=DAILY", model: "nope" }, /No connected model/))
  const moved = await call({ mode: "update", id: "auto-1", runMode: "existing-task", model: "big" })
  check(
    "moving a task into an existing conversation targets this one and notifies only important updates",
    moved.automation.runMode === "existing-task" && moved.automation.targetThreadId === home.id && moved.automation.notification === "important-updates" && moved.automation.model.id === "fake/big",
    moved,
  )
  const paused = await call({ mode: "pause", id: "auto-1" })
  check("pause stops its runs", paused.automation.status === "paused" && service.dueAt("auto-1") === undefined)
  await call({ mode: "resume", id: "auto-1" })
  check("resume plans the next one", service.dueAt("auto-1") === new Date(2026, 0, 3, 9, 0).getTime())
  check("view shows one task and an unknown id is refused", (await call({ mode: "view", id: "auto-1" })).automation.title === "Daily digest" && (await fails({ mode: "view", id: "auto-9" }, /no scheduled task/i)))

  // Runs: in the existing conversation, waiting while it is busy; a new conversation; a missing target skipped.
  clock = new Date(2026, 0, 3, 9, 0, 1).getTime()
  busy.add(home.id)
  await service.tick()
  check("a run waits while its conversation is busy", prompts.length === 0 && (service.dueAt("auto-1") ?? Infinity) <= clock)
  busy.delete(home.id)
  await service.tick()
  check(
    "then runs its prompt there, marked as the task's, and plans the next day",
    prompts.length === 1 && prompts[0]?.sessionID === home.id && prompts[0]?.text === "Summarise the day" && JSON.stringify(prompts[0]?.inbox) === JSON.stringify({ from: "Daily digest", automationID: "auto-1" }) && service.dueAt("auto-1") === new Date(2026, 0, 4, 9, 0).getTime(),
    prompts,
  )
  check("its start is announced", events.some((event) => event.type === "automation.run" && event.phase === "started" && event.sessionID === home.id))
  await store.saveMessage({ id: "msg_0a01", sessionID: home.id, role: "assistant", model, agent: "build", parts: [{ type: "text", id: "prt_0a01", text: "Here is the digest." }], finish: "end_turn", time: { created: clock } })
  await service.turnEnded(home.id)
  check("a reply in an existing conversation is an important update", events.at(-1)?.phase === "finished" && events.at(-1)?.notify === true, events.at(-1))
  await call({ mode: "update", id: "auto-1", runMode: "new-task", project: "none" })
  clock = new Date(2026, 0, 4, 9, 0, 1).getTime()
  await service.tick()
  const opened = (await store.list()).find((session) => session.title === "Daily digest")
  check(
    "a new-task run opens a conversation named for the task with its model, in a folder of its own when it has no project",
    Boolean(opened) && opened?.model.model === "big" && opened?.scratch === true && opened?.directory === path.join(root, "automation-scratch") && prompts.at(-1)?.sessionID === opened?.id,
    opened,
  )
  // Round 10 (T10-22): the target has to be a conversation in the side column; one deleted later is a skipped run.
  const doomed = await store.create({ directory: project, model, title: "Soon gone" })
  await call({ mode: "update", id: "auto-1", runMode: "existing-task", targetThreadId: doomed.id })
  await store.delete(doomed.id)
  const before = prompts.length
  clock = new Date(2026, 0, 5, 9, 0, 1).getTime()
  await service.tick()
  check("a run whose conversation is gone is skipped and the schedule moves on", prompts.length === before && service.dueAt("auto-1") === new Date(2026, 0, 6, 9, 0).getTime())

  // Kept in the data folder; a run missed while closed happens once at start.
  await service.stop()
  const saved = JSON.parse(await fs.readFile(file, "utf8")) as { automations: { id: string; lastFiredAt?: number }[] }
  check("tasks are kept in automations.json with their last run", saved.automations.length === 1 && saved.automations[0]?.lastFiredAt === new Date(2026, 0, 5, 9, 0, 1).getTime())
  clock = new Date(2026, 0, 9, 12, 0).getTime()
  const reopened = new AutomationService(deps)
  await reopened.start({ interval: false })
  check("after a restart the next run is counted from the last one, so a missed run is due at once", (reopened.dueAt("auto-1") ?? Infinity) <= clock && reopened.list()[0]?.targetThreadId === doomed.id)
  check("delete removes the task", (await JSON.parse(await reopened.handle({ mode: "delete", id: "auto-1" }, { sessionID: home.id }))).ok === true && reopened.list().length === 0)
  await reopened.stop()
}

async function exists(file: string) {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
