import type {
  PermissionAction,
  PermissionDecision,
  PermissionKind,
  PermissionRecord,
  PermissionRequest,
  PermissionResponse,
  PermissionRule,
} from "@shared/protocol"
import { PERMISSION_KINDS, SELF_ASKING_KINDS } from "@shared/protocol"
import { accessAction, defaultAccess, sessionAccess, type Access } from "@shared/access"
import { Identifier } from "@shared/id"
import { LOST_WORK, commandRisk, dangerousCommand, readOnlyCommand } from "./command-risk"
import path from "node:path"
import type { Bus } from "./bus"
import type { Config } from "./config"
import type { Storage } from "./storage"

/**
 * A call that was not allowed to run. It becomes the call's error result and
 * the turn goes on: the model reads the refusal and takes another route, as
 * MiMo's engine does with `continue_loop_on_deny` on (26.920, the user's
 * 2026-09-21 decision). Only Stop ends a turn.
 */
export class PermissionDenied extends Error {
  constructor(subject: string, reason?: string) {
    super(reason ?? `Permission denied by the user: ${subject}`)
    this.name = "PermissionDenied"
  }
}

/**
 * What the model is told when a person presses Deny, with or without a reason.
 *
 * Read in the same turn, so it has to say what to do next: the one thing it
 * must not do is send the call again, which would only put the same question
 * back in front of the person who just answered it.
 */
export function userRefusal(subject: string, reason?: string): string {
  return [
    `Permission denied by the user: ${subject}`,
    ...(reason ? [`The user explained: ${reason}`] : []),
    "This call was not run and nothing was changed. Do not make the same call again. Take their answer into account and carry on another way; if nothing else can do what is needed, say so and ask the user how to proceed.",
  ].join("\n")
}

/**
 * What the model is told when a bucket is set to Deny.
 *
 * A refusal is information, not a crash: the model is about to read this as the
 * result of its call, so it has to say what happened, that nothing ran, and
 * what there is to do about it. Without the last part the usual answer is to
 * try the same call again, which asks a question that was already answered.
 *
 * English, like every other tool result. This is the model's half of the
 * conversation and it is not written in the user's language anywhere else.
 */
function refusal(kind: string, subject: string): string {
  const what = subject ? ` (${subject})` : ""
  return (
    `Refused: the "${kind}" permission is set to Deny in this app's settings, so this call${what} ` +
    `was not run and nothing was changed. Asking again will be refused the same way. ` +
    `Carry on without this tool, or tell the user which setting to change if there is no other way.`
  )
}

/** The bucket a tool declares, when this build knows the name. */
/*
 * What the composer's middle level lets through, as MiMo's 帮我审批 does:
 * changes to files, reaching outside the project, and a command with nothing
 * dangerous in it. Everything else goes to the model's review.
 */
export function autoAllows(kind: PermissionKind, subject: string): boolean {
  if (kind === "edit" || kind === "outside") return true
  if (kind === "bash") return !dangerousCommand(subject)
  return false
}

/**
 * A second opinion on a question the middle level did not let through, from
 * the model working in that session.
 *
 * Resolves true only for a clear yes. Anything else - a no, an answer that is
 * neither, a failure - leaves the question to the user.
 */
export type CommandReviewer = (input: { sessionID: string; kind: string; subject: string }) => Promise<boolean>

/** How long a review may take before the user is asked instead: MiMo's judge gives it 8 seconds. */
export const REVIEW_TIMEOUT_MS = 8_000

/** The review's one tool; its answer counts only as a single call of it, with nothing written beside. */
export const VERDICT_TOOL_NAME = "permission_verdict"

export function verdictApproves(calls: readonly { name: string; input: Record<string, unknown> }[], text: string): boolean {
  if (calls.length !== 1 || calls[0].name !== VERDICT_TOOL_NAME || text.trim()) return false
  const input = calls[0].input
  return Object.keys(input).length === 1 && input.decision === "APPROVE"
}

/** A request that looks like it carries a credential, which the review is never shown, as MiMo leaves it out. */
export function looksSecret(text: string): boolean {
  return (
    /\bBearer\s+\S+/i.test(text) ||
    /\bBasic\s+[A-Za-z0-9+/=]+/i.test(text) ||
    /\b(api[_-]?key|token|password|passwd|secret|authorization)\s*[=:]/i.test(text) ||
    /\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|PASSWD|CREDENTIAL)\s*=/i.test(text) ||
    /--(api[_-]?key|token|password|passwd|secret)\b/i.test(text) ||
    /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/.test(text) ||
    /:\/\/[^/\s:]+:[^/\s@]+@/.test(text)
  )
}

/** MiMo's default read rules: a `.env` file asks, its `.env.example` does not; the last rule that matches wins. */
export function readAsks(file: string): boolean {
  let asks = false
  for (const [pattern, answer] of [["*.env", true], ["*.env.*", true], ["*.env.example", false]] as const) {
    if (wildcardMatch(file, pattern)) asks = answer
  }
  return asks
}

/** Whether a command line names a file `readAsks` covers, as a word of its own or at the end of a path. */
export function namesAskingFile(command: string): boolean {
  return command
    .split(/[\s;|&<>()]+/)
    .map((word) => word.replace(/^["']+|["',]+$/g, ""))
    .some((word) => Boolean(word) && readAsks(word.split(/[\\/]/).pop() ?? word))
}

/** What a background subagent is told when nothing already allows its call. */
function backgroundRefusal(kind: string, subject: string): string {
  return (
    `Refused: this subagent runs in the background, where no one can be asked, and nothing already allows this "${kind}" call (${subject}). ` +
    `It was not run. Carry on without it, or report that it needs the user's approval.`
  )
}

function bucketOf(kind: string): PermissionKind | undefined {
  return (PERMISSION_KINDS as readonly string[]).includes(kind) ? (kind as PermissionKind) : undefined
}

/**
 * The one line a question is really about.
 *
 * A tool that raises no question of its own has no chosen wording for one, so
 * the argument it works on is the closest thing to a subject: the path being
 * read, the pattern being matched. Anything else - a todo list, a call with
 * nothing but flags - falls back to the tool's own name, which at least says
 * what is being asked about rather than showing an empty line.
 */
function subjectOf(tool: string, args: Record<string, unknown> | undefined): string {
  for (const field of ["file_path", "notebook_path", "path", "output_dir", "pattern", "filePattern", "query", "url", "command"]) {
    const value = args?.[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return tool
}

/** A saved "always": the kind it was given for and the pattern it covers. */
interface Rule {
  kind: string
  pattern: string
}

/** Where saved "always" rules are kept, beside the rest of this app's documents. */
export const RULES_KEY = "permissions"

/**
 * Which build's idea of this document this one is.
 *
 * Raised only when a change would be misread by a build that predates it; a
 * document from a later build is read as far as it can be and never written
 * over, the same bargain `config.json` makes.
 */
export const RULES_SCHEMA_VERSION = 1

interface StoredRules {
  schemaVersion: number
  /**
   * Where a rule was granted, to the rules granted there: an absolute project
   * path, or `session:<id>` for one given in a conversation that named no
   * project. MiMo keeps both too - `permission(project_id)` in its engine's
   * database, and `permByConvo` in its desktop preferences.
   */
  projects: Record<string, Rule[]>
}


/**
 * MiMo's wildcard, as its permission rules match: `*` is any run of characters,
 * `?` one character, a pattern ending in " *" also matches the words alone (so
 * `git status *` covers `git status`), slashes match either way round, and case
 * is ignored on Windows.
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  let source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`
  return new RegExp(`^${source}$`, process.platform === "win32" ? "si" : "s").test(value.replaceAll("\\", "/"))
}

/** Where "always" is kept: the project when the asker names it, else the conversation alone. */
function projectKey(input: { directory?: string; sessionID: string }): string {
  if (!input.directory) return `session:${input.sessionID}`
  const resolved = path.resolve(input.directory)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** The pattern a scope stands for: a folder covers everything below it, anything else is its own name. */
function scopePattern(kind: string, scope: string): string {
  return kind === "outside" ? `${path.resolve(scope)}/*` : scope
}

interface Pending {
  request: PermissionRequest
  resolve: (response: PermissionResponse) => void
  /** The project its "always" would be kept for, and what it asks about. */
  key: string
  patterns: string[]
  /** Requires a current human response even at full access. */
  humanOnly?: boolean
  /** What the user said when refusing, if anything. */
  reason?: string
  /** How it was closed, for the record the transcript keeps. */
  decided?: PermissionDecision
}

/** The decision a person's answer stands for, as the transcript names it. */
function decisionOf(response: PermissionResponse, reason?: string): PermissionDecision {
  if (response === "once") return "allow-once"
  if (response === "always") return "allow-always"
  return reason?.trim() ? "reject-with-reason" : "reject"
}

/**
 * Gate in front of the tools.
 *
 * Every bucket carries one of three answers. Allow runs it, Ask parks the
 * calling tool on a promise and publishes a request for the UI to answer over
 * the socket, and Deny refuses before anything runs and without a question -
 * putting a question whose answer is already no is the thing being fixed here.
 *
 * "always" is remembered as MiMo's engine keeps it: one allow rule per saved
 * pattern, for the project - a command's prefix (`git status *`), a folder
 * outside the project (`dir/*`), or the whole kind (`*`).
 *
 * These now outlive the app, as MiMo's do. MiMo keeps them in two places that
 * both survive a restart - `permission(project_id, data)` and `permission_grant`
 * in its engine's database, and `permByConvo` in its desktop preferences - while
 * this app kept them in memory only, so every "always" was forgotten at quit and
 * the same question came back the next morning. They are written to
 * `storage/permissions.json`. Like MiMo's, no page lists them; the ones a
 * conversation was given go with it when it is deleted.
 */
export class Permissions {
  private readonly pending = new Map<string, Pending>()
  private readonly rules = new Map<string, Rule[]>()
  /** Where the rules are written; without one they last only as long as the process, as they used to. */
  private store: Storage | undefined
  /** Set when the stored rules were written by a later build: read as far as they go, never written over. */
  private fromNewerVersion = false
  /** The last write, so two cannot interleave. */
  private writing: Promise<void> = Promise.resolve()
  /** Background subagents, with the conversation each works for: they are never shown a question. */
  private readonly background = new Map<string, string>()
  /** Who wants to hear how a call's questions ended, by call id. */
  private readonly listeners = new Map<string, (record: PermissionRecord) => void>()
  /**
   * How many times each call has consulted the gate, by call id: one per
   * `ask`, plus each explicit `waive` for a path a tool lets through without a
   * question. The runner reads this to enforce the self-asking contract.
   */
  private readonly consultations = new Map<string, number>()
  private reviewer?: CommandReviewer
  private reviewTimeout = REVIEW_TIMEOUT_MS

  constructor(
    private readonly bus: Bus,
    private readonly config: Config,
  ) {
    this.bus.subscribe((event) => {
      // A conversation's own level changing settles its waiting questions the way a settings change does.
      if (event.type !== "config.updated" && event.type !== "session.updated") return
      void this.drainDecided()
    })
  }

  /** Where a conversation's own access level is read; without it every conversation follows the default. */
  private sessionLevel?: (sessionID: string) => Promise<unknown>

  useSessions(level: (sessionID: string) => Promise<unknown>): void {
    this.sessionLevel = level
  }

  /*
   * Answered at once when there is nowhere to read a conversation's level, so a
   * question is raised in the same tick as the call, as it always was.
   */
  private levelOf(sessionID: string): Access | Promise<Access> {
    if (!this.sessionLevel) return sessionAccess(undefined, this.config.get())
    return this.sessionLevel(sessionID)
      .catch(() => undefined)
      .then((own) => sessionAccess(own, this.config.get()))
  }

  /** The session runner hands this over once it exists; it owns the models. */
  useReviewer(reviewer: CommandReviewer, timeout = REVIEW_TIMEOUT_MS): void {
    this.reviewer = reviewer
    this.reviewTimeout = timeout
  }

  /*
   * The rest of "approve for me": a command that elevates, ends processes,
   * changes rights, touches the system or sends work away is put to the model
   * first. Losing work - a delete, a hard reset - is never put to it. A model
   * that says no, says something else, fails or takes too long hands the
   * question back to the user, so the review can only ever save a question.
   */
  private async reviewed(sessionID: string, kind: string, subject: string): Promise<boolean> {
    if (!this.reviewer) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.reviewer({ sessionID, kind, subject }).then((approved) => approved === true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.reviewTimeout)
        }),
      ])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Hears every question raised for one call once it is decided.
   *
   * The tools ask for themselves, so the runner cannot see the answers pass;
   * this is how it learns them and writes them onto the part. Only questions a
   * person was actually shown are reported - a call let through by a setting or
   * an earlier "always" asked nothing, and has nothing to redraw.
   */
  onDecided(callID: string, listener: (record: PermissionRecord) => void): () => void {
    this.listeners.set(callID, listener)
    return () => {
      if (this.listeners.get(callID) === listener) this.listeners.delete(callID)
    }
  }

  /**
   * The last user-written rule that covers one resource.
   *
   * Read from the end, as MiMo's `findLast` reads its ruleset: a later rule
   * overrides an earlier one. Both fields are wildcards, so `*` in `action`
   * covers every bucket and `*` in `resource` covers every command, path or
   * URL; `?` matches one character, and a slash is an ordinary character.
   */
  private ruleFor(kind: string, resource: string): PermissionRule | undefined {
    const rules = this.config.get().permissionRules ?? []
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index]
      if (wildcardMatch(kind, rule.action) && wildcardMatch(resource, rule.resource)) return rule
    }
    return undefined
  }

  /**
   * What one call does, knowing what it is about.
   *
   * The order is MiMo's: an explicit rule that covers the resource wins over
   * the bucket, and the bucket wins over the access level. A call with several
   * resources - the pieces of a command, the paths of a patch - gets the worst
   * answer of them: any deny refuses, else any ask asks, else it is allowed.
   */
  private decide(kind: string, level: Access, resources: readonly string[]): PermissionAction {
    const bucket = bucketOf(kind)
    if (!bucket) return "ask"
    const fallback = accessAction(bucket, level, this.config.get())
    if (resources.length === 0) return fallback
    let answer: PermissionAction = "allow"
    for (const resource of resources) {
      const effect = this.ruleFor(kind, resource)?.effect ?? fallback
      if (effect === "deny") return "deny"
      if (effect === "ask") answer = "ask"
    }
    return answer
  }

  /**
   * What the settings say about a bucket, or about one resource in it.
   *
   * A name this build does not know is treated as one that asks. That is the
   * safe direction for a tool arriving from somewhere else - an MCP server, or
   * a build newer than this config - and it is what happened before, when an
   * unknown name simply failed to match anything in the approved list.
   */
  action(kind: string, level: Access = defaultAccess(this.config.get()), resource?: string | readonly string[]): PermissionAction {
    const bucket = bucketOf(kind)
    if (!bucket) return "ask"
    const resources = resource === undefined ? [] : typeof resource === "string" ? [resource] : resource
    return this.decide(kind, level, resources)
  }

  /** How many times this call has consulted the gate, asked or waived. */
  asked(callID: string): number {
    return this.consultations.get(callID) ?? 0
  }

  private consult(callID: string): void {
    this.consultations.set(callID, (this.consultations.get(callID) ?? 0) + 1)
  }

  /**
   * A tool's own record that this call deliberately needed no question - a
   * memory file it may write silently, a command it is about to refuse for
   * another reason. It counts as consulting the gate, so the runner's
   * self-asking check is satisfied without asking anyone anything.
   */
  waive(callID: string): void {
    this.consult(callID)
  }

  /** Drops the count for a call once it has settled, so the map does not grow for the process's life. */
  forget(callID: string): void {
    this.consultations.delete(callID)
  }

  /**
   * Marks a subagent as running in the background for `parentID`, or clears it.
   * As MiMo's background actors, it runs at its conversation's level and on its
   * project's "always" rules, and anything those do not allow is refused
   * without a question, since there is no one watching to answer one.
   */
  markBackground(sessionID: string, parentID: string | undefined): void {
    if (parentID) this.background.set(sessionID, parentID)
    else this.background.delete(sessionID)
  }

  /** True when a folder outside the project was already let in with "always", for this project. */
  allowsOutside(where: { directory?: string; sessionID: string }, scope: string): boolean {
    return this.allowedByRules(projectKey(where), "outside", [scopePattern("outside", scope)])
  }

  /** Whether every pattern asked about is covered by a saved "always" of the same kind. */
  private allowedByRules(key: string, kind: string, patterns: string[]): boolean {
    const saved = (this.rules.get(key) ?? []).filter((rule) => rule.kind === kind)
    return patterns.length > 0 && patterns.every((pattern) => saved.some((rule) => wildcardMatch(pattern, rule.pattern)))
  }

  /*
   * Saving "always", and then letting through anything still waiting in the
   * same project that it now covers, as MiMo's reply does. Those were not
   * answered by a person, but by the approval just given, and are recorded so.
   */
  private remember(key: string, kind: string, always: string[], answered: string): void {
    const saved = this.rules.get(key) ?? []
    for (const pattern of always) if (!saved.some((rule) => rule.kind === kind && rule.pattern === pattern)) saved.push({ kind, pattern })
    this.rules.set(key, saved)
    this.changed.add(key)
    // Written as it is granted, so tomorrow morning does not ask it again.
    void this.persist()
    for (const [id, pending] of [...this.pending]) {
      if (id === answered || pending.key !== key || pending.request.kind !== kind || pending.request.forced) continue
      if (!this.allowedByRules(key, kind, pending.patterns)) continue
      this.pending.delete(id)
      pending.decided = "allow-always"
      pending.resolve("once")
      this.bus.publish({ type: "permission.resolved", requestID: id, decided: "allow-always" })
    }
  }

  async ask(input: {
    sessionID: string
    messageID: string
    callID: string
    kind: PermissionKind
    title: string
    titleCode?: string
    subject: string
    preview?: string
    /**
     * What "always" should cover: a folder outside the project, or an MCP
     * server. Shorthand for giving the same single pattern as both `patterns`
     * and `always`.
     */
    scope?: string
    /** The project the call works in, which is what "always" is kept for; without it, the conversation. */
    directory?: string
    /** What exactly is asked about, each matched against saved "always" rules; the subject when left out. */
    patterns?: string[]
    /** What "always" saves: `*` - the whole kind - when left out. */
    always?: string[]
    /** Asked every time and never remembered, whatever was said before; decided from the command when left out. */
    forced?: boolean
    /** Requires a current human response even at full access. */
    humanOnly?: boolean
    /** A pattern rule asks for this call even where its bucket allows it - a `.env` read - except at full access. */
    patternAsks?: boolean
  }): Promise<void> {
    this.consult(input.callID)
    const found = this.levelOf(this.background.get(input.sessionID) ?? input.sessionID)
    const level = found instanceof Promise ? await found : found
    const key = projectKey(input)
    const scoped = input.scope ? [scopePattern(input.kind, input.scope)] : undefined
    const patterns = input.patterns?.length ? input.patterns : (scoped ?? [input.subject])
    const always = input.always ?? scoped ?? ["*"]
    /*
     * A user's own rule is read with the same patterns a saved "always" is
     * matched against, so `git push *` covers a command however its arguments
     * are spelled and a path rule covers the file the question names.
     */
    let action = this.action(input.kind, level, patterns)
    const explicitAsk = patterns.some((pattern) => this.ruleFor(input.kind, pattern)?.effect === "ask")
    if (action === "allow" && (input.humanOnly || (input.patternAsks && level !== "full"))) action = "ask"
    /*
     * Read first, before anything remembered. A bucket switched to Deny has to
     * beat an "always" granted earlier in the same session, or turning a tool
     * off would not take effect until the app was restarted.
     */
    if (action === "deny") throw new PermissionDenied(input.subject, refusal(input.kind, input.subject))
    /*
     * A command that loses work is asked about every time, whatever was said
     * for the bucket before: "always run commands" was an answer about builds
     * and tests, not about deleting things. As MiMo forces its delete question,
     * that holds when commands are allowed and at full access too, and neither
     * the middle level nor the model's review ever answers it.
     */
    const risk = input.kind === "bash" ? commandRisk(input.subject) : undefined
    const forced = input.humanOnly || (input.forced ?? (risk !== undefined && LOST_WORK.includes(risk)))
    /*
     * Except at full access. MiMo asks about a delete there too; the user chose
     * otherwise (2026-09-26): full access is the reader saying "do not ask me",
     * and a question at that level, deletes included, is one they have already
     * answered. A deliberate difference from MiMo - see HANDOFF. Every other
     * level, and "always allow commands" at any of them, still asks each time.
     */
    if (!input.humanOnly) {
      if (action === "allow" && (!forced || level === "full")) return
    }
    // MiMo's read-only allowlist: a command made only of reading pieces runs once without a question.
    // Except one naming a file the read rules ask about (`type .env`): reading it through a shell asks too,
    // and except a command a user rule deliberately put to them.
    if (!forced && !explicitAsk && input.kind === "bash" && readOnlyCommand(input.subject) && !namesAskingFile(input.subject)) return
    /*
     * A background subagent runs with nobody watching, so a remembered
     * "always" carries it only for commands the middle level would let through
     * anyway; anything dangerous is refused there as any other question is.
     */
    const unattendedRisk = this.background.has(input.sessionID) && input.kind === "bash" && dangerousCommand(input.subject)
    if (!forced && !unattendedRisk && this.allowedByRules(key, input.kind, patterns)) return
    if (this.background.has(input.sessionID)) throw new PermissionDenied(input.subject, backgroundRefusal(input.kind, input.subject))
    /*
     * The middle access level, as this conversation runs at. What it does not
     * let through goes to the model's review - except a delete, which only a
     * person answers, and except a rule that deliberately asked.
     */
    if (!forced && !explicitAsk && level === "auto") {
      // A `.env` named on a command line is the model's review to pass, as a `.env` read is.
      if (!input.patternAsks && autoAllows(input.kind, input.subject)) return
      if (await this.reviewed(input.sessionID, input.kind, input.subject)) return
    }

    const request: PermissionRequest = {
      id: Identifier.permission(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      kind: input.kind,
      title: input.title,
      titleCode: input.titleCode,
      subject: input.subject,
      preview: input.preview,
      ...(forced ? { forced: true } : {}),
      time: Date.now(),
    }

    let entry: Pending | undefined
    const response = await new Promise<PermissionResponse>((resolve) => {
      entry = { request, resolve, key, patterns, humanOnly: input.humanOnly }
      this.pending.set(request.id, entry)
      this.bus.publish({ type: "permission.requested", request })
    })

    const reason = entry?.reason?.trim()
    this.listeners.get(input.callID)?.({
      requestID: request.id,
      kind: request.kind,
      ...(forced ? { forced: true } : {}),
      subject: request.subject,
      ...(request.preview ? { preview: request.preview } : {}),
      decided: entry?.decided ?? decisionOf(response, reason),
      ...(reason ? { reason } : {}),
      time: Date.now(),
    })

    if (response === "always" && !forced) this.remember(key, input.kind, always, request.id)
    if (response === "reject") {
      /*
       * A question closed because its bucket was switched to Deny while it sat
       * on screen is a refusal by policy, not a person pressing Deny, and the
       * model can act on the difference: one says try something else, the other
       * says this particular thing was not wanted.
       */
      if (this.action(input.kind, level, patterns) === "deny") {
        throw new PermissionDenied(input.subject, refusal(input.kind, input.subject))
      }
      // A person said no; anything else here is a question closed by Stop, which ends the turn by itself.
      if (entry?.decided === "reject" || entry?.decided === "reject-with-reason") throw new PermissionDenied(input.subject, userRefusal(input.subject, reason))
      throw new PermissionDenied(input.subject)
    }
  }

  /**
   * The check in front of a tool call, whatever the tool is.
   *
   * There are two sorts of tool here. One sort can describe what it is about to
   * do - the shell has a command, edit has a diff, an MCP call has its
   * arguments - and raises that question itself, in far more useful terms than
   * anything this could put together; for those this enforces Deny and then
   * stands aside, so a refusal costs nothing and no one is asked twice.
   *
   * The other sort - reading a file, listing a directory, matching a glob,
   * searching, keeping a todo list - has never asked anything. That is why five
   * buckets could be declared on their tools and still be beyond configuring:
   * their names had nowhere to be matched and no moment at which to be
   * consulted. This is that moment.
   *
   * Called from the session runner immediately before `tool.execute`, which is
   * the one place every call of every tool goes through.
   */
  async check(input: {
    sessionID: string
    messageID: string
    callID: string
    /** The tool's own name, which is what the request falls back to naming. */
    tool: string
    /** The bucket the tool declares, from `ToolDefinition.permission`. */
    kind: string
    /** What the model passed, so the question can name the file or pattern. */
    arguments?: Record<string, unknown>
    target?: string
    /** The project the call works in, which "always" is kept for. */
    directory?: string
  }): Promise<void> {
    const bucket = bucketOf(input.kind)
    if (!bucket) return

    const subject = subjectOf(input.tool, input.arguments)

    /*
     * Deny is enforced here even for a tool that would ask for itself, because
     * refusing before the tool starts is both cheaper and the same answer.
     * Everything else about those tools is left to the question they raise.
     */
    if (SELF_ASKING_KINDS.includes(bucket)) {
      // The resource is what the tool is about, so a user rule can deny one command or one path before it starts.
      if (this.action(bucket, undefined, subject) === "deny") {
        throw new PermissionDenied(subject, refusal(bucket, subject))
      }
      return
    }

    await this.ask({
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      kind: bucket,
      /*
       * The reference's own description of the bucket, which is a sentence
       * about what is being permitted - "Reading a file", "Search file contents
       * using regular expressions" - and reads as a heading over the subject.
       * The plain title is the fallback for a window with no string for it.
       */
      title: input.tool,
      titleCode: `tool.desc.${bucket}`,
      preview: input.target ? `Device: ${input.target}` : undefined,
      subject,
      directory: input.directory,
      patternAsks: bucket === "read" && readAsks(subject),
    })
  }

  respond(requestID: string, response: PermissionResponse, reason?: string): void {
    const pending = this.pending.get(requestID)
    if (!pending) return
    this.pending.delete(requestID)
    // A forced ask must never record allow-always: remember() already skips forced, but the
    // decided frame and the resolve() value must say once too.
    if (response === "always" && pending.request.forced) response = "once"
    if (response === "reject" && reason) pending.reason = reason
    pending.decided = decisionOf(response, pending.reason)
    pending.resolve(response)
    this.bus.publish({
      type: "permission.resolved",
      requestID,
      decided: pending.decided,
      ...(pending.reason?.trim() ? { reason: pending.reason.trim() } : {}),
    })
  }

  /**
   * Settles anything already parked whose bucket has just been decided.
   *
   * Called when the config changes. A bucket set to Allow releases its parked
   * requests, which is what it has always done. A bucket set to Deny now closes
   * them with a refusal, because leaving a question on screen after answering
   * it in settings is the same defect as raising one for a tool that is
   * switched off, only slower to notice.
   *
   * A bucket moved back to Ask leaves its questions alone. The answer to "stop
   * approving these" is not to answer the one already on screen for them.
   */
  async drainDecided(): Promise<void> {
    for (const [id, pending] of [...this.pending]) {
      const found = this.levelOf(pending.request.sessionID)
      const level = found instanceof Promise ? await found : found
      // Answered, or settled by another pass, while the level was read.
      if (this.pending.get(id) !== pending) continue
      const action = this.action(pending.request.kind, level, pending.patterns)
      /*
       * A delete waiting for its answer is settled by a person, or by the
       * reader switching this conversation to full access - never by a bucket
       * that happens to read "allow". This pass runs on every session update,
       * titles and usage included, so a delete raised while commands were set
       * to "always allow" was answered "once" by the next unrelated update,
       * with nobody having pressed anything (R28-8).
       */
      if (pending.request.forced && action === "allow" && (pending.humanOnly || level !== "full")) continue
      const auto = level === "auto"
      /*
       * The middle level switched on while a question was up - MiMo's 帮我审批 -
       * lets through what it would not have asked about, as an approval for once.
       * A delete is never among them.
       */
      const bucket = bucketOf(pending.request.kind)
      const explicitAsk = pending.patterns.some((pattern) => this.ruleFor(pending.request.kind, pattern)?.effect === "ask")
      const released =
        action === "ask" && auto && !pending.request.forced && !explicitAsk && bucket !== undefined && autoAllows(bucket, pending.request.subject)
      if (action === "ask" && !released) continue
      this.pending.delete(id)
      pending.decided = released ? "allow-once" : "policy"
      pending.resolve(action === "deny" ? "reject" : "once")
      this.bus.publish({ type: "permission.resolved", requestID: id, decided: pending.decided })
    }
  }

  /** Rejects everything still parked for a session - used when a turn aborts. */
  rejectAll(sessionID: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionID !== sessionID) continue
      this.pending.delete(id)
      pending.decided = "cancelled"
      pending.resolve("reject")
      this.bus.publish({ type: "permission.resolved", requestID: id, decided: "cancelled" })
    }
  }

  /**
   * Reads the saved rules, once, as the backend starts.
   *
   * A document that will not parse is kept as evidence rather than written over:
   * it is this machine's only record of what it has allowed. One written by a
   * later build is read as far as it goes and never written back, the same
   * bargain the settings make - a downgrade that still saves is how the newer
   * build's rules would be lost.
   */
  async load(storage: Storage): Promise<void> {
    this.store = storage
    const read = await storage.readOrCorrupt<Partial<StoredRules>>(RULES_KEY)
    /*
     * A file the disk would not hand over is not a damaged file. Starting
     * empty and then saving the next approval would replace every rule this
     * machine had remembered with the one just granted, so nothing is written
     * for the rest of the run - the same bargain the credential store makes
     * when its own quarantine fails.
     */
    if (read.unreadable) {
      this.blocked = read.unreadable
      return
    }
    if (read.corrupt) {
      const aside = await storage.quarantine(RULES_KEY)
      // Kept as evidence, or not moved at all - in which case it may not be written over either.
      if (aside === undefined) this.blocked = read.corrupt
      return
    }
    const stored = read.value
    if (!stored) return
    this.fromNewerVersion = typeof stored.schemaVersion === "number" && stored.schemaVersion > RULES_SCHEMA_VERSION
    for (const [key, rules] of Object.entries(stored.projects ?? {})) {
      if (!Array.isArray(rules)) continue
      // A hand-edited document must not put a rule this build cannot read into force.
      const kept = rules.filter((rule): rule is Rule => Boolean(rule) && typeof rule.kind === "string" && typeof rule.pattern === "string")
      if (kept.length) this.rules.set(key, kept)
    }
  }

  /** Why the saved rules may not be written: the document could not be read and could not be kept aside. */
  private blocked: string | undefined

  /**
   * Writes the remembered approvals, over what is on disk *now* rather than
   * over what this process read at start-up.
   *
   * The document was read once, at load, and written back whole on every
   * change - so with two instances sharing one data directory, an approval
   * granted in the other window disappeared the moment this one remembered
   * anything at all, and a conversation deleted over there had its rules
   * written back from this one's stale copy (R26-B4). Two instances sharing a
   * data directory is a supported case, and this is this machine's only record
   * of what it has allowed.
   *
   * So the file is re-read inside the write queue, and only what this process
   * has itself changed is laid over it. R26 laid *every* project it had loaded
   * over the file, which undid its own point twice (R28-4): a conversation the
   * other window deleted came straight back from this one's start-up copy, and
   * an approval the other window added to a project this one then added to was
   * lost, because this one's list replaced the file's.
   *
   * A project's rules are only ever added to - there is no way to take one
   * rule back, only to drop a conversation's whole set - so the two lists are
   * merged by union, and a dropped conversation is dropped from the file.
   */
  private persist(): Promise<void> {
    const storage = this.store
    if (!storage || this.fromNewerVersion || this.blocked) return this.writing
    const mine = new Map([...this.changed].flatMap((key) => (this.rules.has(key) ? [[key, [...this.rules.get(key)!]] as const] : [])))
    // Serialised, so two approvals answered at once cannot land in the wrong order.
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        const read = await storage.readOrCorrupt<Partial<StoredRules>>(RULES_KEY)
        /*
         * A document that will not read is not written over, here as at load:
         * this process would be replacing a file it cannot see with its own
         * partial view of it.
         */
        if (read.unreadable !== undefined || read.corrupt !== undefined) return
        if (typeof read.value?.schemaVersion === "number" && read.value.schemaVersion > RULES_SCHEMA_VERSION) return
        const projects: Record<string, Rule[]> = {}
        for (const [key, rules] of Object.entries(read.value?.projects ?? {})) {
          if (Array.isArray(rules)) projects[key] = rules as Rule[]
        }
        for (const [key, rules] of mine) {
          const merged = [...(projects[key] ?? [])]
          for (const rule of rules) if (!merged.some((kept) => kept.kind === rule.kind && kept.pattern === rule.pattern)) merged.push(rule)
          projects[key] = merged
        }
        // A conversation this process has dropped is dropped on disk too, rather than coming back from the file.
        for (const key of this.forgotten) delete projects[key]
        await storage.write(RULES_KEY, { schemaVersion: RULES_SCHEMA_VERSION, projects })
      })
      .catch(() => undefined)
    return this.writing
  }

  /**
   * Projects whose rules this process has deliberately dropped.
   *
   * Without this, re-reading the file before a write would bring a forgotten
   * project's rules straight back: they are absent from `this.rules` exactly
   * because they were removed, and absent is also what a project this process
   * never touched looks like.
   */
  private readonly forgotten = new Set<string>()

  /** Projects whose rules this process has added to since it started: the only ones it writes. */
  private readonly changed = new Set<string>()

  /**
   * Settles the last write, for a caller that has to know the rules have
   * reached the disk.
   *
   * Granting one deliberately does not wait for the write: the tool that asked
   * the question is held up until `ask` returns, and a disk that is busy would
   * be felt as the approval taking a moment to take effect. The rule is in
   * force the instant it is granted either way; this is for the checks, and for
   * anything that wants to be sure before the process ends.
   */
  flush(): Promise<void> {
    return this.writing
  }

  /** Drops what one conversation was allowed "always", as its conversation is deleted. */
  async forgetSession(sessionID: string): Promise<void> {
    // A subagent's background mark goes with it too (N11-37); it was only cleared for one run without a parent.
    this.background.delete(sessionID)
    if (!this.rules.delete(`session:${sessionID}`)) return
    // Remembered as deliberately dropped, or the re-read in `persist` would bring it back.
    this.forgotten.add(`session:${sessionID}`)
    this.changed.delete(`session:${sessionID}`)
    await this.persist()
  }

  /**
   * Every question still waiting for an answer.
   *
   * The request itself is announced once, on the bus, so a window that was not
   * connected at that moment has no way to learn about it. `session.list`
   * hands this back for the same reason it hands back the busy sessions: it is
   * the state a reconnecting window has to be told, rather than deduce.
   */
  outstanding(): PermissionRequest[] {
    return [...this.pending.values()].map((pending) => pending.request)
  }
}
