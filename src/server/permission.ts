import type {
  PermissionAction,
  PermissionKind,
  PermissionRequest,
  PermissionResponse,
} from "@shared/protocol"
import { DEFAULT_PERMISSIONS, PERMISSION_KINDS, SELF_ASKING_KINDS } from "@shared/protocol"
import { Identifier } from "@shared/id"
import type { CommandRisk } from "./command-risk"
import { LOST_WORK, commandRisk } from "./command-risk"
import path from "node:path"
import type { Bus } from "./bus"
import type { Config } from "./config"

export class PermissionDenied extends Error {
  constructor(subject: string, reason?: string) {
    super(reason ?? `Permission denied by the user: ${subject}`)
    this.name = "PermissionDenied"
  }
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
 * What the composer's middle level lets through. Changes inside the project and
 * reaching outside it go ahead, and so does a command - unless it deletes or is
 * risky, which still asks. Everything else keeps whatever its bucket says.
 */
export function autoAllows(kind: PermissionKind, subject: string): boolean {
  if (kind === "edit" || kind === "write" || kind === "outside") return true
  if (kind === "bash") return commandRisk(subject) === undefined
  return false
}

/**
 * A second opinion on a risky command, from the model working in that session.
 *
 * Resolves true only for a clear yes. Anything else - a no, an answer that is
 * neither, a failure - leaves the question to the user.
 */
export type CommandReviewer = (input: { sessionID: string; command: string; risk: CommandRisk }) => Promise<boolean>

/** How long a review may take before the user is asked instead. */
export const REVIEW_TIMEOUT_MS = 30_000

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
  for (const field of ["path", "pattern", "filePattern", "query", "url", "command"]) {
    const value = args?.[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return tool
}

interface Pending {
  request: PermissionRequest
  resolve: (response: PermissionResponse) => void
  /** What the user said when refusing, if anything. */
  reason?: string
}

/**
 * Gate in front of the tools.
 *
 * Every bucket carries one of three answers. Allow runs it, Ask parks the
 * calling tool on a promise and publishes a request for the UI to answer over
 * the socket, and Deny refuses before anything runs and without a question -
 * putting a question whose answer is already no is the thing being fixed here.
 *
 * "always" is remembered for the rest of the process per (session, bucket)
 * pair - deliberately not persisted to disk, so a blanket approval cannot
 * silently outlive the app.
 */
export class Permissions {
  private readonly pending = new Map<string, Pending>()
  private readonly approved = new Set<string>()
  /** Directories outside the project that the user let this session reach. */
  private readonly outsideRoots = new Map<string, Set<string>>()
  private reviewer?: CommandReviewer
  private reviewTimeout = REVIEW_TIMEOUT_MS

  constructor(
    private readonly bus: Bus,
    private readonly config: Config,
  ) {
    this.bus.subscribe((event) => {
      if (event.type !== "config.updated") return
      this.drainDecided()
    })
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
  private async reviewed(sessionID: string, command: string): Promise<boolean> {
    const risk = commandRisk(command)
    if (!risk || LOST_WORK.includes(risk) || !this.reviewer) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.reviewer({ sessionID, command, risk }).then((approved) => approved === true),
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

  private key(sessionID: string, kind: string) {
    return `${sessionID}:${kind}`
  }

  /**
   * What the settings say about a bucket.
   *
   * A name this build does not know is treated as one that asks. That is the
   * safe direction for a tool arriving from somewhere else - an MCP server, or
   * a build newer than this config - and it is what happened before, when an
   * unknown name simply failed to match anything in the approved list.
   */
  action(kind: string): PermissionAction {
    const bucket = bucketOf(kind)
    if (!bucket) return "ask"
    return this.config.get().permissions?.[bucket] ?? DEFAULT_PERMISSIONS[bucket]
  }

  /** True when `target` sits under something already approved for this session. */
  allowsOutside(sessionID: string, target: string): boolean {
    const roots = this.outsideRoots.get(sessionID)
    if (!roots) return false
    const resolved = path.resolve(target)
    for (const root of roots) {
      const relative = path.relative(root, resolved)
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) return true
    }
    return false
  }

  private allowOutside(sessionID: string, root: string): void {
    const roots = this.outsideRoots.get(sessionID) ?? new Set<string>()
    roots.add(path.resolve(root))
    this.outsideRoots.set(sessionID, roots)
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
     * What "always" should cover. Without it an approval is remembered for the
     * whole bucket, which is far too broad for a directory outside the project.
     */
    scope?: string
  }): Promise<void> {
    const action = this.action(input.kind)
    /*
     * Read first, before anything remembered. A bucket switched to Deny has to
     * beat an "always" granted earlier in the same session, or turning a tool
     * off would not take effect until the app was restarted.
     */
    if (action === "deny") throw new PermissionDenied(input.subject, refusal(input.kind, input.subject))
    if (action === "allow") return
    // The middle access level. A refusal set in settings has already won above.
    if (this.config.get().accessLevel === "auto") {
      if (autoAllows(input.kind, input.subject)) return
      if (input.kind === "bash" && (await this.reviewed(input.sessionID, input.subject))) return
    }
    if (input.scope && this.allowsOutside(input.sessionID, input.scope)) return
    /*
     * A command that loses work is asked about every time, whatever was said
     * for the bucket before: "always run commands" was an answer about builds
     * and tests, not about deleting things.
     */
    const risk = input.kind === "bash" ? commandRisk(input.subject) : undefined
    const forced = risk !== undefined && LOST_WORK.includes(risk)
    if (!input.scope && !forced && this.approved.has(this.key(input.sessionID, input.kind))) return

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
      entry = { request, resolve }
      this.pending.set(request.id, entry)
      this.bus.publish({ type: "permission.requested", request })
    })

    if (response === "always" && !forced) {
      if (input.scope) this.allowOutside(input.sessionID, input.scope)
      else this.approved.add(this.key(input.sessionID, input.kind))
    }
    if (response === "reject") {
      /*
       * A question closed because its bucket was switched to Deny while it sat
       * on screen is a refusal by policy, not a person pressing Deny, and the
       * model can act on the difference: one says try something else, the other
       * says this particular thing was not wanted.
       */
      if (this.action(input.kind) === "deny") {
        throw new PermissionDenied(input.subject, refusal(input.kind, input.subject))
      }
      const reason = entry?.reason?.trim()
      if (reason) {
        throw new PermissionDenied(
          input.subject,
          `Permission denied by the user: ${input.subject}\nThe user explained: ${reason}`,
        )
      }
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
      if (this.action(bucket) === "deny") {
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
      subject,
    })
  }

  respond(requestID: string, response: PermissionResponse, reason?: string): void {
    const pending = this.pending.get(requestID)
    if (!pending) return
    this.pending.delete(requestID)
    if (response === "reject" && reason) pending.reason = reason
    pending.resolve(response)
    this.bus.publish({ type: "permission.resolved", requestID })
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
  drainDecided(): void {
    for (const [id, pending] of [...this.pending]) {
      const action = this.action(pending.request.kind)
      if (action === "ask") continue
      this.pending.delete(id)
      pending.resolve(action === "allow" ? "once" : "reject")
      this.bus.publish({ type: "permission.resolved", requestID: id })
    }
  }

  /** Rejects everything still parked for a session - used when a turn aborts. */
  rejectAll(sessionID: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionID !== sessionID) continue
      this.pending.delete(id)
      pending.resolve("reject")
      this.bus.publish({ type: "permission.resolved", requestID: id })
    }
  }

  /** Drops every remembered approval - part of returning to first run. */
  forget(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, "reject")
    this.approved.clear()
    this.outsideRoots.clear()
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
