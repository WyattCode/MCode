import fs from "node:fs"
import path from "node:path"

/**
 * MiMo's log files: one `YYYY-MM-DD.log` a day under the profile's `logs`
 * folder, kept for fifteen days, with older files deleted when the log opens
 * and again whenever the day changes under a running app.
 *
 * Every line passes through `redactSecrets` first. The backend runs in this
 * process and a provider error can quote the request it failed on, so a key or
 * token must never reach the disk by way of a warning.
 */

export const LOG_DIR = "logs"
export const LOG_RETAIN_DAYS = 15
/* A single line past this is cut: a dumped response body is not worth a megabyte of log. */
const MAX_LINE = 8000
const DAY = 24 * 60 * 60 * 1000

const pad = (value: number) => String(value).padStart(2, "0")

/** The local calendar day, as the file is named. */
export function logDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export function logFileName(at: Date): string {
  return `${logDate(at)}.log`
}

/** The day a log file is for, or nothing for a file this log did not name. */
export function dayOfLogFile(name: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name)
  if (!match) return undefined
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return logDate(day) === name.slice(0, 10) ? day : undefined
}

/* Whole calendar days; rounded, so a daylight-saving change does not shave one off. */
function daysBetween(now: Date, then: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((today.getTime() - then.getTime()) / DAY)
}

/** The files to delete: dated ones at least `retainDays` old. Anything else in the folder is left alone. */
export function expiredLogFiles(names: readonly string[], now: Date, retainDays = LOG_RETAIN_DAYS): string[] {
  return names.filter((name) => {
    const day = dayOfLogFile(name)
    return day !== undefined && daysBetween(now, day) >= retainDays
  })
}

/*
 * Values that must not be written down. Shapes rather than a list of known
 * secrets, because the log never sees the config: provider key prefixes,
 * authorization schemes, and anything assigned to a key-like name.
 */
const SECRET_SHAPES: [RegExp, string][] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  // round 8 (X12): the rest of MiMo's table - GitHub, AWS, Slack tokens and JWTs.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  // A logged settings object: any JSON field whose own name marks it as a credential, custom header names included.
  [/("[^"\n]*(?:auth|token|secret|passw|credential|cookie|api[_-]?key|access[_-]?key)[^"\n]*"\s*:\s*")(?!\[redacted\])[^"\n]*(")/gi, "$1[redacted]$2"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [
    /((?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)(?!\[redacted\])[^"'\s,;&}]+/gi,
    "$1[redacted]",
  ],
  [/([?&](?:key|sig|signature|code)=)[^&\s"']+/gi, "$1[redacted]"],
  // MiMo's MCP shapes: a query parameter whose name holds a credential word, and the value after such a flag.
  [/([?&][^=\s&"']*(?:authorization|token|api[_-]?key|apikey|secret|password|credential)[^=\s&"']*=)(?!\[redacted\])[^&\s"']+/gi, "$1[redacted]"],
  [/((?:^|[\s"',[])--?[\w-]*(?:token|api[_-]?key|apikey|secret|password|credential|authorization)[\w-]*["']?[\s,]+["']?)(?![-[])[^\s"',\]]+/gi, "$1[redacted]"],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement)
  return out
}

/** Console arguments as one line of text, the way a console would print them. */
export function formatArgs(args: readonly unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") return value
      if (value instanceof Error) return value.stack ?? value.message
      try {
        return JSON.stringify(value)
      } catch {
        // A value that cannot be serialised is still worth naming.
        return String(value)
      }
    })
    .join(" ")
}

export function logLine(level: string, text: string, at: Date): string {
  const body = redactSecrets(text)
  const cut = body.length > MAX_LINE ? `${body.slice(0, MAX_LINE)} [cut ${body.length - MAX_LINE} chars]` : body
  return `${at.toISOString()} [${level}] ${cut}`
}

export interface DailyLogOptions {
  dir: string
  retainDays?: number
  now?: () => Date
}

/**
 * The open log. Writes go to an append stream for the current day; a failure
 * to write is swallowed, because the log is the last place left to report it.
 */
export class DailyLog {
  readonly dir: string
  private readonly retainDays: number
  private readonly now: () => Date
  private day: string
  private stream: fs.WriteStream | undefined
  private closed = false

  constructor(options: DailyLogOptions) {
    this.dir = options.dir
    this.retainDays = options.retainDays ?? LOG_RETAIN_DAYS
    this.now = options.now ?? (() => new Date())
    this.day = logDate(this.now())
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch {
      // No folder means no log; the app runs on.
    }
    this.prune()
  }

  /** Deletes the files past retention. */
  prune(): void {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of expiredLogFiles(names, this.now(), this.retainDays)) {
      try {
        fs.unlinkSync(path.join(this.dir, name))
      } catch {
        // Held open elsewhere, perhaps; the next prune tries again.
      }
    }
  }

  get file(): string {
    return path.join(this.dir, `${this.day}.log`)
  }

  write(level: string, text: string): void {
    if (this.closed) return
    const at = this.now()
    const day = logDate(at)
    if (day !== this.day) {
      this.stream?.end()
      this.stream = undefined
      this.day = day
      this.prune()
    }
    try {
      if (!this.stream) {
        this.stream = fs.createWriteStream(this.file, { flags: "a", encoding: "utf8" })
        this.stream.on("error", () => {})
      }
      this.stream.write(`${logLine(level, text, at)}\n`)
    } catch {
      // See the class comment.
    }
  }

  /** Flushes and closes; later writes are dropped. */
  close(): Promise<void> {
    this.closed = true
    const stream = this.stream
    this.stream = undefined
    if (!stream) return Promise.resolve()
    return new Promise((resolve) => stream.end(() => resolve()))
  }
}
