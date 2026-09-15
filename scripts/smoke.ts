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
import { isSummary, selectForSummary } from "../src/server/session/summary"
import { OpenAICompatible, toMessages } from "../src/server/provider/openai"
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
import { chimeOf, longTask } from "../src/shared/chime"
import { findInMessages, searchMessages, snippetAround } from "../src/server/search"
import type { ClientFrame, Request, ServerEvent, ServerFrame } from "../src/shared/protocol"
import { PERMISSION_KINDS } from "../src/shared/protocol"
import { TOOLS, findTool, toolsFor } from "../src/server/tool/registry"
import { systemPrompt } from "../src/server/session/prompt"
import { agentsState, deleteAgents, ensureAgents, setAgentsEnabled } from "../src/server/global-agents"
import { applyVoiceResult, editCue, isClearCommand, splitSendWord } from "../src/renderer/src/lib/voice"
import { clampEffort, effortFamily, effortLabelKey, modelFamily } from "../src/renderer/src/lib/model"
import { rovingStep } from "../src/renderer/src/lib/composer-menu"
import { builtinSuggestions } from "../src/renderer/src/lib/home-suggestions"
import { applyVoiceResult, splitSendWord } from "../src/renderer/src/lib/voice"
import { chordOf, formatChord, isBindable } from "../src/renderer/src/lib/keys"
import { normalizeChord } from "../src/shared/chord"
import { PAGE_ROWS, pageRows } from "../src/renderer/src/lib/shortcut-page"
import { LIMIT_PRESETS, limitOf, validEndpoint } from "../src/renderer/src/lib/custom-model"
import { mergeMcpSecrets } from "../src/server/mcp-save"
import { ago, t } from "../src/renderer/src/lib/i18n"
import { VOICE_EDIT_MAX, VOICE_EDIT_PROMPT, handle, parseVoiceEdit, voiceDraftOf, voiceEditMessages } from "../src/server/handlers"
import { PROJECT_LIST_MIGRATION, customModelOf } from "../src/server/config"
import { listedProjects, projectsByRecency, reconciledProjects } from "../src/shared/projects"
import type { AppConfig, ResponseMap } from "../src/shared/protocol"
import { closeHidesToTray } from "../src/shared/protocol"
import { addressToURL, safeURL } from "../src/shared/web-address"
import {
  APP_CHORDS,
  barMode,
  loadErrorKind,
  localServerOf,
  pageKeyAction,
  pageMenuGroups,
  routeWindowOpen,
  stepZoom,
  type PageKeyInput,
} from "../src/shared/browser-page"
import { ToolError } from "../src/server/tool/types"
import { argumentProblems, refusedArgumentsNote } from "../src/server/tool/validate"
import { RETRY_MAX_RETRIES, isRetryable, retryDelay } from "../src/server/session/retry"
import type { PermissionRecord } from "../src/shared/protocol"
import type { ServerResponse } from "node:http"
import { PermissionDenied, Permissions } from "../src/server/permission"
import { QUESTION_DISMISSED, QuestionTool, Questions } from "../src/server/tool/question"
import {
  accessOf,
  composerAnswers,
  confirmQueue,
  guideShown,
  mergeCustom,
  nextStop,
  questionOutcome,
  toggleChoice,
} from "../src/renderer/src/lib/confirm-queue"
import type { PermissionRequest, QuestionRequest } from "../src/shared/protocol"
import { parseUnifiedDiff, reverseSection } from "../src/shared/unified-diff"
import { annotationsBlock } from "../src/shared/annotations"
import { revertTurnFiles } from "../src/server/session/turn-revert"
import { branchTitle } from "../src/server/session/store"
import { failureCode, failureDetail } from "../src/server/session/error-map"
import { turnFileDiffs } from "../src/server/session/turn-diff"
import { cardCut, latestTurnParts, stepPart, stickState, stoppedEmpty } from "../src/renderer/src/components/parts/turn-end"
import type { AssistantPart, ToolPart } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { unifiedDiff } from "../src/server/diff"
import { globToRegExp } from "../src/server/tool/search"
import { discoverSubscriptionModels } from "../src/server/provider/discover"
import { workspaceInfo } from "../src/server/workspace"
import * as gitOps from "../src/server/git"
import { sessionArtifacts, sessionReferences } from "../src/shared/session-files"
import { artifactGroups, infoTasks } from "../src/renderer/src/lib/session-info"
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
import { arbitratePanel, boundChord, sideFits, toolHints } from "../src/renderer/src/lib/right-tools"
import { crumbsFor, editCounts, fileCategory, relativeTo, rowIndent, saveFailureKey, treeRows } from "../src/renderer/src/lib/files-tab"
import { capDiff, normalizeLayout, parseDiffFiles, reviewRows, splitPath, splitRows } from "../src/renderer/src/lib/diff-view"
import { forgetSuggestions, parseSuggestions } from "../src/server/home-suggest"
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
import { fadeOpacity, pruneStamps, revealStep } from "../src/renderer/src/lib/stream-reveal"
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
import { SUBAGENT_TIMERS, isStalled, noticeText, subagentAnswer, subagentOutput, subagentTone, taskAction } from "../src/shared/subagent"
import { COMPLETED_CAP, isPill, noticeStatus, pillStatus, subagentItems, subagentTime } from "../src/renderer/src/lib/subagents"
import { stepTitle as subagentStepTitle, stepVerb as subagentStepVerb } from "../src/renderer/src/lib/tool-meta"
import type { SessionInfo as SubagentSession, SubagentNotice, SubagentNoticeStatus } from "../src/shared/protocol"
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-smoke-"))
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
  const backend = await startBackend(dataDirectory)
  check("backend picked a port", backend.port > 0, backend.port)

  const socket = new WebSocket(`ws://127.0.0.1:${backend.port}`)
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
  check("config.get returns defaults", config.config.model.model === "claude-opus-5", config.config.model)

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
   * "Move out of project" from a conversation's menu: it leaves for a fresh
   * folder of its own and is marked as having no project; moving it into a
   * project again clears that mark, and a session that does not exist is
   * refused before any folder is made.
   */
  const leaving = await call({ type: "session.create", directory: project })
  const left = await call({ type: "session.moveOut", sessionID: leaving.session.id })
  const leftStat = await fs.stat(left.session.directory).catch(() => undefined)
  check(
    "moving a conversation out of its project gives it a folder of its own",
    left.session.id === leaving.session.id &&
      left.session.scratch === true &&
      path.dirname(left.session.directory) === process.env.MCODE_SCRATCH_ROOT &&
      leftStat?.isDirectory() === true,
    left.session,
  )
  const returned = await call({ type: "session.move", sessionID: leaving.session.id, directory: project })
  check(
    "moving it into a project again drops the no-project mark",
    returned.session.scratch === undefined && returned.session.directory === project,
    returned.session,
  )
  const foldersBefore = (await fs.readdir(process.env.MCODE_SCRATCH_ROOT!)).length
  const moveOutRefused = await call({ type: "session.moveOut", sessionID: "ses_missing" }).then(
    () => false,
    () => true,
  )
  const foldersAfter = (await fs.readdir(process.env.MCODE_SCRATCH_ROOT!)).length
  check("moving out a session that does not exist is refused and makes no folder", moveOutRefused && foldersAfter === foldersBefore, {
    moveOutRefused,
    foldersBefore,
    foldersAfter,
  })
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
    "an unknown chime plays the default and off stays off",
    chimeOf("bogus") === "settle" && chimeOf(undefined) === "settle" && chimeOf("off") === "off" && chimeOf("zen") === "zen",
  )

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
  gate.useReviewer(async ({ command }) => {
    reviewed.push(command)
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
  check("and one it takes too long over", (await waited(askAbout("bash", "git push origin main"))) === "waiting" && raised.includes("permission.requested"), raised)
  verdict = "approve"
  raised.length = 0
  reviewed.length = 0
  check("a delete is never put to the model", (await waited(askAbout("bash", "git push origin main && rm -rf dist"))) === "waiting" && raised.includes("permission.requested") && reviewed.length === 0, { raised, reviewed })
  check("nor is a hard reset", (await waited(askAbout("bash", "git reset --hard HEAD~1"))) === "waiting" && reviewed.length === 0, reviewed)

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

  const read = await findTool("read")!.execute({ path: "hello.ts" }, context("c1"))
  check("read numbers lines", read.output.includes("1\texport const greeting"), read.output.slice(0, 60))

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
    .execute({ path: path.join(outsideRoot, "nested", "note.txt") }, context("c-esc3"))
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
  check("glob finds nested files", glob.output.includes("src/app.ts") && glob.output.includes("hello.ts"), glob.output)

  const grep = await findTool("grep")!.execute({ pattern: "TODO" }, context("c3"))
  check("grep reports file:line", grep.output.includes("src/app.ts:1"), grep.output)

  const list = await findTool("list")!.execute({}, context("c4"))
  check("list renders a tree", list.output.includes("src/") && list.output.includes("hello.ts"), list.output)

  const todo = await findTool("todowrite")!.execute(
    { todos: [{ id: "1", content: "Write the thing", status: "in_progress" }] },
    context("c5"),
  )
  check("todowrite summarizes progress", todo.output === "0/1 complete.", todo.output)

  /*
   * Traversal must never proceed silently, however it is spelled. It is no
   * longer a flat refusal - it raises the same prompt as any other path outside
   * the project - but nothing reaches disk until the user has said yes.
   */
  const traversal = findTool("read")!
    .execute({ path: "../../../etc/passwd" }, context("c6"))
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

  // -------------------------------------------------------------- permission
  section("Permissions")
  // edit is not auto-approved, so this must park until answered.
  const editPromise = findTool("edit")!.execute(
    { path: "hello.ts", oldString: "const count = 1", newString: "const count = 2" },
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
    .execute({ path: "denied.ts", content: "nope" }, context("c9"))
    .then(() => "allowed")
    .catch((err: Error) => err.message)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const second = permissions.outstanding()
  permissions.respond(second[0].id, "reject")
  const denyResult = await denyPromise
  check("rejection stops the tool", String(denyResult).includes("Permission denied"), denyResult)
  check("rejected write created no file", !(await exists(path.join(project, "denied.ts"))))

  // "always" should suppress the next prompt in the same bucket.
  const firstWrite = findTool("write")!.execute({ path: "a.txt", content: "one" }, context("c10"))
  await new Promise((resolve) => setTimeout(resolve, 60))
  const third = permissions.outstanding()
  permissions.respond(third[0].id, "always")
  await firstWrite
  await findTool("write")!.execute({ path: "b.txt", content: "two" }, context("c11"))
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
      accessOf({ accessLevel: "auto" }) === "auto" && accessOf({ permissions: { ...PERMISSION_DEFAULTS } }) === "ask" && accessOf({ permissions: allAllowed }) === "full",
    )

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
  }

  section("Tool arguments")
  {
    const readSchema = findTool("read")!.parameters
    check("arguments that fit have no problems", argumentProblems(readSchema, { path: "a.ts", limit: 20 }).length === 0)
    const missing = argumentProblems(readSchema, {})
    check("a missing required field is named", missing.length === 1 && missing[0] === "path is required", missing)
    const wrong = argumentProblems(readSchema, { path: 5 })
    check("a wrong type is named with what arrived", wrong[0] === "path should be string, got integer", wrong)
    const todos = argumentProblems(findTool("todowrite")!.parameters, {
      todos: [{ id: "1", content: "x", status: "doing" }],
    })
    check("a nested enum is checked", todos.length === 1 && todos[0]!.startsWith("todos[0].status should be one of"), todos)
    check(
      "a schema construct the checker does not know is let through",
      argumentProblems({ type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } }, { value: true }).length === 0,
    )
    const note = refusedArgumentsNote("read", wrong)
    check("the note says nothing ran and what to send", note.includes("was not run") && note.includes("path should be string"), note)
  }

  section("Provider retries")
  {
    check("a dropped connection is retried", isRetryable(new TypeError("fetch failed")))
    check("a 503 from an OpenAI-compatible provider is retried", isRetryable(new Error("The provider returned 503. This is usually transient.")))
    check("a rate limit is retried", isRetryable(new Error("Rate limited by the provider. Wait a moment and try again.")))
    check("a refused key is not retried", !isRetryable(new Error("Authentication failed - check the API key in Settings.")))
    check(
      "a prompt too long for the model is not retried",
      !isRetryable(new Error("request (22530 tokens) exceeds the available context size (8192 tokens), try increasing it")),
    )
    const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" })
    check("a reset hidden in the cause is retried", isRetryable(new TypeError("request failed", { cause })))
    const dropped = new TypeError("fetch failed")
    check("the first wait is two seconds", retryDelay(dropped, 1, 0) === 2000, retryDelay(dropped, 1, 0))
    check("with at most a quarter more at random", retryDelay(dropped, 1, 1) === 2500, retryDelay(dropped, 1, 1))
    check("it doubles", retryDelay(dropped, 3, 0) === 8000, retryDelay(dropped, 3, 0))
    check("and stops at thirty seconds", retryDelay(dropped, 5, 1) === 30000, retryDelay(dropped, 5, 1))
    check("five attempts, then it gives up", retryDelay(dropped, RETRY_MAX_RETRIES + 1, 0) === undefined)
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
    const reverted = await revertTurnFiles(root, [turnMessage])
    check("a turn revert restores, removes and skips outside", reverted.restored === 1 && reverted.removed === 1 && reverted.outside === 1 && reverted.failed === 0, reverted)
    check("the edited file is back to the turn's start", (await fs.readFile(path.join(root, "kept.txt"), "utf8")) === "one\n2\nthree\n")
    check("the created file is gone", !(await exists(path.join(root, "made.txt"))))
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
  check("unfinished tool is dropped entirely", !useIDs.includes("toolu_never"), useIDs)
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

  section("Model curation")
  {
    const models = [{ id: "alpha" }, { id: "beta" }]
    const fake = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: models }))
    })
    await new Promise<void>((resolve) => fake.listen(8794, "127.0.0.1", resolve))

    const config = backend.runtime.config
    await config.set({
      // Curated before this provider existed, which is the whole problem.
      enabledModels: ["anthropic/claude-opus-5"],
      providerEndpoints: { lmstudio: "http://127.0.0.1:8794/v1" },
    })

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })
    const afterConnect = config.get().enabledModels ?? []
    check(
      "connecting adds the provider's models to a curated list",
      afterConnect.includes("lmstudio/alpha") && afterConnect.includes("lmstudio/beta"),
      afterConnect,
    )
    check("and leaves the existing curation alone", afterConnect.includes("anthropic/claude-opus-5"), afterConnect)

    // Switching one off has to stick: only a provider with nothing enabled is
    // treated as a state nobody chose.
    await config.set({ enabledModels: afterConnect.filter((key) => key !== "lmstudio/beta") })
    await call({ type: "provider.discover", provider: "lmstudio" })
    const afterRefresh = config.get().enabledModels ?? []
    check("refreshing respects a model that was switched off", !afterRefresh.includes("lmstudio/beta"), afterRefresh)

    // With none of its models enabled, refreshing repairs it.
    await config.set({ enabledModels: ["anthropic/claude-opus-5"] })
    await call({ type: "provider.discover", provider: "lmstudio" })
    const repaired = config.get().enabledModels ?? []
    check(
      "refreshing repairs a provider with nothing enabled",
      repaired.includes("lmstudio/alpha") && repaired.includes("lmstudio/beta"),
      repaired,
    )

    // Left as it was found: the next section asserts on this provider too.
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    await config.set({ enabledModels: [], providerEndpoints: {} })
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
      const at = Date.now()
      const conversation = [
        { id: "u1", sessionID: "s", role: "user" as const, text: "start", attachments: [], time: { created: at } },
        {
          id: "a1",
          sessionID: "s",
          role: "assistant" as const,
          model: { provider: "p", model: "m" },
          agent: "build" as const,
          parts: [{ id: "t1", type: "text" as const, text: "x".repeat(100_000) }],
          time: { created: at },
        },
      ]
      let picked: ReturnType<typeof selectForSummary>
      let thrown: unknown
      try {
        picked = selectForSummary(conversation)
      } catch (failure) {
        thrown = failure
      }
      check("a last message larger than the kept end does not break the split", !thrown, String(thrown))
      check("and the summary covers everything, marked at the last message", picked?.mark.id === "a1" && picked.recent === "", picked?.mark.id)

      /*
       * What counts as a summary. The two real failures were one sentence of
       * the task carrying on; a model that translates the template's
       * headings still writes sections, and refusing it would leave the turn
       * on the provider's 400.
       */
      check(
        "a continuation of the task is not a summary",
        !isSummary("我再核查 `GameCategory` 枚举值是否与前端 'PC'/'主机' 匹配。"),
      )
      check(
        "a summary with translated headings is one",
        isSummary("## 目标\n- 审计两个新功能\n\n## 工作状态\n- 已完成构建\n\n## 下一步\n1. 修复枚举"),
      )
      check("the template as written is one", isSummary("## Objective\n- audit\n\n## Next Move\n1. (none)"))
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
    // Curated before this provider existed, which is what makes the next
    // assertion about its models being offered mean anything.
    await config.set({ enabledModels: ["anthropic/claude-opus-5"] })
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

    const curated = config.get().enabledModels ?? []
    check(
      "its models join a curated picker rather than being hidden by it",
      curated.includes("mygateway/big") && curated.includes("mygateway/small"),
      curated,
    )
    check("and the existing curation is left alone", curated.includes("anthropic/claude-opus-5"), curated)

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
    await config.set({ enabledModels: [] })
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
    replies.push(toolCall("call_badargs", "read", '{"path": 5}'))
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
    replies.push(toolCall("call_cutoff", "read", '{"path": "hel'))
    from = events.length
    await call({ type: "session.prompt", sessionID: stepsID, text: "read again" })
    await idle(from)
    found = await toolPart("call_cutoff")
    check("arguments cut off mid-object are refused the same way", found.part?.metadata?.recoverable === true && String(found.part?.error).includes("not valid JSON"), found.part)

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
    replies.push(toolCall("call_perm", "write", '{"path": "steps-denied.md", "content": "no"}'))
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
    replies.push(toolCall("call_perm_bare", "write", '{"path": "steps-bare.md", "content": "no"}'))
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
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: verdict } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
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
    check("the model was asked with no tools", Array.isArray(seen?.tools) ? seen.tools.length === 0 : seen?.tools === undefined, seen?.tools)
    const sent = JSON.stringify(seen?.messages ?? [])
    check("and was shown the command and what it is flagged as", sent.includes("sudo apt install x") && sent.includes("Flagged as: elevate"), sent.slice(0, 400))
    check("and told to answer in one word", sent.includes("APPROVE or REJECT"), sent.slice(0, 400))
    check(
      "and nothing was asked of the user",
      !events.slice(before).some((event) => event.type === "permission.requested" && event.request.sessionID === judgedID),
      events.slice(before).map((event) => event.type),
    )

    verdict = "REJECT"
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
    check("plan cannot write", !planning.includes("write") && !planning.includes("edit"), planning)
    check("plan has no shell either", !planning.includes("bash"), planning)
    check("plan can still read and search", ["read", "glob", "grep", "list"].every((name) => planning.includes(name)), planning)

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
    check("build is not", !buildPrompt.includes("plan mode"))

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
    /*
     * The two refusals the panel rests on. A file:// in the address bar would
     * turn a browser panel into a reader for every file the user owns.
     */
    check("a file path is refused", safeURL("file:///C:/Windows/win.ini") === undefined)
    check("and so is anything else with a scheme", safeURL("mcode://settings") === undefined)
    check("http survives", safeURL("http://example.com/") === "http://example.com/")

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
    check("Ctrl+Shift+period, typed as >", pageKeyAction(press(">", "Period", { control: true, shift: true })).kind === "forward")
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
    check("App.vue's handler tables were found", plainKeys.length > 15 && shiftedKeys.length > 12 && altKeys.length > 6, { plainKeys, shiftedKeys, altKeys })
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

    const openai = toMessages("sys", [withImage]) as any[]
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

  section("Home suggestions")
  {
    const rows = parseSuggestions(
      'Here you go:\n```json\n[{"title":"Fix the login bug","query":"Find why login fails","icon":"bug"},{"title":"Add tests","query":"Cover run()","icon":"rocket"},{"title":"Fix the login bug","query":"again"},{"title":"No request"},{"title":"Write docs","query":"Document the API","icon":"doc"},{"title":"Fourth","query":"one too many"}]\n```',
    )
    check("three rows are read out of a fenced answer", rows.map((row) => row.title).join("|") === "Fix the login bug|Add tests|Write docs", rows)
    check("an icon outside the set becomes idea", rows[1]?.icon === "idea", rows[1])
    check("prose is no rows", parseSuggestions("Sorry, I can't help with that.").length === 0)
    check("a broken array is no rows", parseSuggestions('[{"title": "x",').length === 0)

    forgetSuggestions()
    const asked: string[] = []
    const answer = JSON.stringify([
      { title: "整理 hello.ts", query: "把 hello.ts 里的常量整理成一个对象导出", icon: "code" },
      { title: "补测试", query: "为 src/app.ts 的 run 写单元测试", icon: "test" },
      { title: "写说明", query: "根据 AGENTS.md 写一份 README", icon: "doc" },
    ])
    const stub = createServer((request, response) => {
      if ((request.url ?? "").includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }] }))
        return
      }
      let raw = ""
      request.on("data", (chunk) => (raw += chunk))
      request.on("end", () => {
        asked.push(raw)
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve) => stub.listen(8812, "127.0.0.1", resolve))
    const modelBefore = (await call({ type: "config.get" })).config.model
    await call({ type: "config.set", patch: { providerEndpoints: { lmstudio: "http://127.0.0.1:8812/v1" } } })
    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "local" })
    await call({ type: "config.set", patch: { model: { provider: "lmstudio", model: "qwen/qwen3.8-27b" } } })

    const first = await call({ type: "home.suggest", directory: project, language: "zh-CN" })
    check("the model's three tasks come back", first.generated === true && first.suggestions.length === 3 && first.suggestions[1]?.icon === "test", first)
    check("the project listing and the language reach the model", asked.length === 1 && asked[0].includes("hello.ts") && asked[0].includes("zh-CN"), asked.length)
    const second = await call({ type: "home.suggest", directory: project, language: "zh-CN" })
    check("a second ask for the project is answered from memory", asked.length === 1 && second.suggestions.length === 3, asked.length)

    await call({ type: "provider.auth", provider: "lmstudio", apiKey: "" })
    const unusable = await call({ type: "home.suggest", directory: path.join(root, "another-project"), language: "en" })
    check("with no usable model the area stays empty", unusable.generated === false && unusable.suggestions.length === 0, unusable)

    await call({ type: "config.set", patch: { model: modelBefore, providerEndpoints: {} } })
    stub.close()
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
    const big = await call({ type: "file.read", path: path.join(tree, "big.txt"), preview: true })
    check("a preview refuses text past 512 KiB and carries none of it", big.tooBig === true && big.content === "", { tooBig: big.tooBig, length: big.content.length })
    await fs.writeFile(path.join(tree, "nul.txt"), Buffer.concat([Buffer.from("a".repeat(5000)), Buffer.from([0])]))
    check("a NUL byte anywhere makes a preview binary", (await call({ type: "file.read", path: path.join(tree, "nul.txt"), preview: true })).kind === "binary")
    await fs.writeFile(path.join(tree, "clip.mp4"), Buffer.from([0, 0, 0, 24]))
    const clip = await call({ type: "file.read", path: path.join(tree, "clip.mp4"), preview: true })
    check("a video preview is named as one and carries no bytes", clip.video === true && !clip.data, clip)
    await fs.writeFile(path.join(tree, "pic.png"), Buffer.alloc(16))
    const pic = await call({ type: "file.read", path: path.join(tree, "pic.png"), preview: true })
    check("a preview picture carries its type but no bytes", pic.kind === "image" && pic.mime === "image/png" && !pic.data, pic)
    check("a plain read still carries a picture's bytes", Boolean((await call({ type: "file.read", path: path.join(tree, "pic.png") })).data))

    const tooBigSave = await call({ type: "file.write", path: path.join(tree, ".env"), content: "x".repeat(512 * 1024 + 1) }).then(() => "saved", failureOf)
    check("a save past 512 KiB is refused as toobig", tooBigSave.includes("toobig"), tooBigSave)
    const binarySave = await call({ type: "file.write", path: path.join(tree, "nul.txt"), content: "text" }).then(() => "saved", failureOf)
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
  const situated = await systemPrompt({ directory: repoRoot, agent: "build" })
  check("the prompt names the branch", situated.includes("Branch: feature"), situated.slice(-400))
  check(
    "and what was already dirty before the turn",
    situated.includes("loose.txt") && situated.includes("Already modified"),
    situated.slice(-400),
  )
  check("and the last commits", situated.includes("two"), situated.slice(-300))
  check(
    "and how this project is built",
    situated.includes("npm run <name>") && situated.includes("build, smoke"),
    situated.slice(-600),
  )
  await fs.rm(path.join(repoRoot, "loose.txt"))
  await fs.rm(path.join(repoRoot, "package.json"))

  /* A folder that is not a repository says nothing about one. */
  const noRepo = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-plain-"))
  const bare = await systemPrompt({ directory: noRepo, agent: "build" })
  check("a plain folder gets no repository section", !bare.includes("## Repository"), bare.slice(-200))
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

    const idle = infoTasks(said, false)
    check("todowrite statuses read as MiMo's", idle.map((task) => task.status).join() === "done,stalled,open", idle)
    check("a child is drawn under its parent", idle[2]?.depth === 1, idle)
    check("in progress during the turn that wrote it stays in progress", infoTasks(said, true)[1]?.status === "in_progress")
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

  const items = sentBody.input as { type: string; call_id?: string }[]
  const calls = items.filter((item) => item.type === "function_call").map((item) => item.call_id)
  const outputs = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id)
  check("a finished tool is replayed as a pair", calls.includes("call_done") && outputs.includes("call_done"))
  check("an unfinished tool is dropped entirely", !calls.includes("call_stuck") && !outputs.includes("call_stuck"), calls)
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

  // ---------------------------------------------------------------- reply reveal and media
  section("Reply reveal, voice bubble and preview zoom (MiMo's numbers)")
  check("a small backlog shows at least two a frame", revealStep(1) === 1 && revealStep(10) === 2 && revealStep(44) === 2, [
    revealStep(1),
    revealStep(10),
    revealStep(44),
  ])
  check("a normal backlog drains in about 22 frames", revealStep(66) === 3 && revealStep(200) === 10, [revealStep(66), revealStep(200)])
  check("past a 200-character lag the reveal catches up", revealStep(260) === 20 && revealStep(500) === 100, [revealStep(260), revealStep(500)])
  check("nothing to show shows nothing", revealStep(0) === 0 && revealStep(-3) === 0)
  check("a character fades in over 220ms on a cubic ease-out", fadeOpacity(0) === 0 && fadeOpacity(110) === 0.875 && fadeOpacity(220) === 1 && fadeOpacity(400) === 1, [
    fadeOpacity(0),
    fadeOpacity(110),
    fadeOpacity(220),
  ])
  check("finished fades are dropped, oldest first", JSON.stringify(pruneStamps([0, 100, 300], 310)) === "[100,300]", pruneStamps([0, 100, 300], 310))
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

  check("a notification is titled project · conversation", noticeTitle("MCode", { project: "proj", title: "Fix it" }) === "proj · Fix it")
  check("either half alone, or the app name", noticeTitle("MCode", { title: "Only" }) === "Only" && noticeTitle("MCode", {}) === "MCode")
  const longTitle = noticeTitle("MCode", { project: "a-long-project-name", title: "and a long conversation title too" })
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

  await subagentChecks(root, project)
  await projectListChecks()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
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

async function subagentChecks(root: string, project: string) {
  section("Subagents (task tool)")

  // Pure pieces first.
  check("a numbered general subagent takes its own tone", subagentTone("general-1") === 0 && subagentTone("general-6") === 5)
  check("any other name hashes onto one of six tones", [..."abcdefgh"].every((c) => subagentTone(`explore-${c}`) >= 0 && subagentTone(`explore-${c}`) < 6))
  check("the answer comes back out of the call's output", subagentAnswer(subagentOutput("ses_1", "  the answer\n")) === "the answer")
  check("task is recorded through its subagent's own calls", reachOf("task") === "reads")
  const partOf = (status: ToolPart["status"], extra: Partial<ToolPart> = {}): ToolPart => ({
    type: "tool",
    id: `p-${Math.random()}`,
    callID: `c-${Math.random()}`,
    name: "task",
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
  check("the seconds column counts from the start", subagentTime({ ...listed[0]!, startedAt: 1000 }, 13_500).count === 12)
  check("an ended subagent reads minutes ago", subagentTime({ ...listed[1]!, endedAt: 0 }, 5 * 60_000).key === "subagents.minutesAgo")
  check("the completed group shows ten at first", COMPLETED_CAP === 10)
  check(
    "a subagent's request joins its parent's dock",
    confirmQueue("parent", [{ id: "r1", sessionID: "child", messageID: "m", callID: "c", kind: "bash", title: "", subject: "ls", time: 1 }], [], (id) =>
      id === "child" || id === "parent",
    ).length === 1,
  )

  // MiMo's actor actions: the pure pieces.
  check("a call that names no action is a run, as the tool always was", taskAction({ description: "x" }) === "run" && taskAction({ action: "spawn" }) === "spawn" && taskAction({ action: "later" }) === "run")
  const spawned = partOf("completed", { input: { action: "spawn", description: "Look around", prompt: "x", subagent_type: "explore" }, output: "subagent_id: explore-1" })
  const statusRow = partOf("completed", { input: { action: "status", subagent_id: "explore-1" }, output: JSON.stringify({ status: "running" }), title: "Look around" })
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
  check("the model is told which subagent finished and the whole of its answer", told.includes("subagent_id: explore-1") && told.includes("and the rest") && told.startsWith("<subagent-notification>"))
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
        if (step) return call(step.map((input) => ({ name: "task", input })))
        if (answered || !parentCalls.length) return say("parent done")
        return call(parentCalls.map((input) => ({ name: "task", input })))
      }

      childTools.push((asked.tools ?? []).map((tool) => tool.function?.name ?? ""))
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
        return call([{ name: "bash", input: { command: "echo subagent", description: "Say something" } }])
      }
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
      message.role === "assistant" ? message.parts.filter((part): part is ToolPart => part.type === "tool" && part.name === "task") : [],
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
  check("a subagent is offered no task tool of its own", childTools.length > 0 && childTools.every((names) => !names.includes("task")), childTools)
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
  check("the subagent is listed as running while it works", startedChild)
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
    [{ action: "status", subagent_id: "explore-1" }],
    [{ action: "wait", subagent_id: "explore-1" }],
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
    sixSpawn?.status === "completed" && /subagent_id: explore-1/.test(sixSpawn.output ?? "") && (sixSpawn.time.completed ?? Infinity) < (sixChild?.subagent?.ended ?? 0),
    { spawn: sixSpawn?.output, record: sixChild?.subagent },
  )
  check("status sees it still at work, by its description", reportOf(sixStatus).status === "running" && reportOf(sixStatus).description === "Look in the background", sixStatus?.output)
  check("wait holds until it is idle and hands back its result", reportOf(sixWait).status === "idle" && reportOf(sixWait).outcome === "success" && reportOf(sixWait).result === "background", sixWait?.output)
  check("its record says it ran in the background and succeeded", sixChild?.subagent?.background === true && sixChild.subagent.status === "idle" && sixChild.subagent.outcome === "success", sixChild?.subagent)
  const sixNotices = await noticesIn(six.id)
  check("the conversation is told it completed, its answer as the summary", sixNotices.some((entry) => entry.status === "completed" && entry.subagentID === "explore-1" && entry.summary === "background"), sixNotices)
  check("the conversation's model reads the notice", parentBodies.some((body) => body.includes("<subagent-notification>") && body.includes("subagent_id: explore-1")))

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
    [{ action: "wait", subagent_id: "explore-1", timeout_ms: 10_000 }],
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
    [{ action: "cancel", subagent_id: "explore-1" }],
    [{ action: "cancel", subagent_id: "explore-1" }],
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
    [{ action: "send", subagent_id: "general-1", message: "ANSWER:second" }],
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
  check("send queues a follow-up for a finished subagent", reportOf(tenSend).queued === true && reportOf(tenSend).subagent_id === "general-1", tenSend?.output)
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

  await new Promise<void>((resolve) => provider.close(() => resolve()))
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
