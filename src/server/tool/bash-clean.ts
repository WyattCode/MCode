/**
 * What a command's output is made cheaper to read before it reaches the model.
 *
 * A terminal's output carries things a model can do nothing with and pays for
 * twice: colour escapes, the frames of a progress bar redrawn over each other,
 * lines long enough to be a minified bundle, and whatever secret a command
 * printed on the way through. MiMo cleans its shell output with the same four
 * passes; this is the port of its pipeline (`bash_token_efficient_pipeline.ts`),
 * with the same order and the same promise.
 *
 * The order matters. Progress folds before ANSI because a carriage return is
 * what carries a redraw across an escape sequence; redaction runs before long
 * lines so a secret is masked rather than elided into an unrecognisable prefix.
 * And the whole chain is wrapped in one guard: if the result is not strictly
 * smaller than what came in, the original goes out untouched. A cleaner that
 * can inflate an output - a short secret expanding to a longer marker - must
 * never cost more tokens than leaving it alone.
 *
 * A caller that wants the raw bytes can say so: `# raw` or `# nofilter` in the
 * command, or `MCODE_BASH_RAW=1` in the environment, skips every pass.
 */

/** The ceiling for one line, and how much of its head is kept when it goes past. */
const MAX_LINE_CHARS = 500
const LINE_HEAD_KEEP = 160

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ANSI_DCS = /\x1b[PX^_][\s\S]*?\x1b\\/g
const BACKSPACE = /[^\n]\x08/g
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Token <opaque>
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1 <redacted>"],
  // JWT: three base64url segments separated by dots, at least ten characters each.
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "<redacted-jwt>"],
  // AWS access keys
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-aws-key>"],
  // GitHub fine-grained / classic tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted-gh-token>"],
  // Anthropic keys (before the OpenAI pattern, which would also match their `sk-` prefix)
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, "<redacted-anthropic-key>"],
  // OpenAI keys
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g, "<redacted-openai-key>"],
  // Slack tokens
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g, "<redacted-slack-token>"],
  // Generic api/secret/password/token assignments: KEY=VALUE or "key": "value".
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]

/** A PEM block, which may span many lines, becomes one marker. */
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const SKIP_MARKERS = ["# nofilter", "# raw"]

export interface CleanOptions {
  /** The command that produced the output, whose own markers can switch cleaning off. */
  command?: string
}

export interface CleanResult {
  text: string
  bytesIn: number
  bytesOut: number
  /** Cleaning made the output no smaller, so the original was kept. */
  degraded: boolean
  /** The caller asked for raw output, so no pass ran. */
  skipped: boolean
}

export interface CleanPlugin {
  name: string
  apply(text: string, context: CleanOptions): string
}

export interface CleanPipeline {
  plugins: readonly CleanPlugin[]
  run(text: string, options?: CleanOptions): CleanResult
}

function shouldSkip(command: string | undefined): boolean {
  if (process.env.MCODE_BASH_RAW === "1") return true
  if (!command) return false
  return SKIP_MARKERS.some((mark) => command.includes(mark))
}

/**
 * Folds a line redrawn in place with carriage returns down to the frame that
 * is actually on screen: everything after the last `\r` in the line.
 */
export function progressPlugin(): CleanPlugin {
  return {
    name: "progress",
    apply(text) {
      if (!text.includes("\r")) return text
      return text
        .split("\n")
        .map((line) => {
          const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
          const at = stripped.lastIndexOf("\r")
          return at === -1 ? stripped : stripped.slice(at + 1)
        })
        .join("\n")
    },
  }
}

/**
 * Strips terminal control sequences: CSI colour and cursor codes, OSC titles and
 * hyperlinks, DCS payloads, backspace overstrike (`ab\b\bcd` becomes `cd`) and
 * the remaining control bytes. Tabs and newlines stay.
 */
export function ansiPlugin(): CleanPlugin {
  return {
    name: "ansi",
    apply(text) {
      let out = text.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_DCS, "")
      while (BACKSPACE.test(out)) {
        out = out.replace(BACKSPACE, "")
        BACKSPACE.lastIndex = 0
      }
      return out.replace(CTRL_BYTES, "")
    },
  }
}

/** Masks the common credential shapes a command may print, PEM blocks first. */
export function redactPlugin(): CleanPlugin {
  return {
    name: "redact",
    apply(text) {
      return REDACT_PATTERNS.reduce(
        (out, [pattern, replacement]) => out.replace(pattern, replacement),
        text.replace(PEM_BLOCK, "<redacted-pem-block>"),
      )
    },
  }
}

/** Keeps the head of a line past the ceiling and says how much was left out. */
export function longLinePlugin(): CleanPlugin {
  return {
    name: "longline",
    apply(text) {
      if (text.length <= MAX_LINE_CHARS) return text
      return text
        .split("\n")
        .map((line) => (line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`))
        .join("\n")
    },
  }
}

/** The passes in the order they have to run, fresh for each caller. */
export function defaultPlugins(): CleanPlugin[] {
  return [progressPlugin(), ansiPlugin(), redactPlugin(), longLinePlugin()]
}

export function createPipeline(plugins: CleanPlugin[] = defaultPlugins()): CleanPipeline {
  return {
    plugins,
    run(text, options = {}) {
      const bytesIn = Buffer.byteLength(text, "utf8")
      if (!text || shouldSkip(options.command)) return { text, bytesIn, bytesOut: bytesIn, degraded: false, skipped: true }
      const out = plugins.reduce((current, plugin) => plugin.apply(current, options), text)
      const bytesOut = Buffer.byteLength(out, "utf8")
      // Strictly smaller, as MiMo's guard has it: equal bytes means the cleaning bought nothing.
      if (bytesOut >= bytesIn) return { text, bytesIn, bytesOut: bytesIn, degraded: true, skipped: false }
      return { text: out, bytesIn, bytesOut, degraded: false, skipped: false }
    },
  }
}

const defaultPipeline = createPipeline()

/** The entry point the shell tool calls: the default chain with its never-worse guard. */
export function cleanBashOutput(text: string, options: CleanOptions = {}): CleanResult {
  return defaultPipeline.run(text, options)
}
