import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"

/**
 * The cap every tool's output passes through before the model reads it, as
 * MiMo's engine applies one to every tool - built-in, MCP or otherwise.
 *
 * Output over 2,000 lines or 50 KB is cut. What is kept is the start, or - when
 * the end looks like a failure - 70% start and 30% end, so the error that ended
 * a long run is not the part thrown away. The whole text is saved to a file
 * the result names, which the model can search or read in parts. Saved files
 * are removed after a week.
 *
 * A tool that already capped its own output says so with `truncated` in its
 * metadata and is left alone.
 */

export const OUTPUT_MAX_LINES = 2000
export const OUTPUT_MAX_BYTES = 50 * 1024

/**
 * What a tool's output is allowed when the conversation is close to its line.
 *
 * MiMo's `Truncate.output` takes `pressureCaps`, and setting it halves both
 * limits - 1,000 lines and 25 KB rather than 2,000 and 50 KB. Without it a
 * conversation at the edge of compaction still spends a full 50 KB on every
 * tool result, so it crosses the line sooner and is compacted more often than
 * MiMo's would be.
 */
export const PRESSURE_MAX_LINES = OUTPUT_MAX_LINES / 2
export const PRESSURE_MAX_BYTES = OUTPUT_MAX_BYTES / 2

/**
 * When a conversation counts as being under that pressure.
 *
 * MiMo's own trigger for setting `pressureCaps` is not readable from the
 * bundle, so this is MCode's: seven tenths of the room a conversation has
 * before it must be compacted (`usableContext`, itself 90% of the window). Far
 * enough back that the halving has time to help, and not so early that ordinary
 * turns lose half their output.
 */
export const PRESSURE_RATIO = 0.7

/** How a call ended, which changes what the note says was cut. */
export type CapOutcome = "success" | "failure"

export interface CapOptions {
  /**
   * Whether the conversation can hand the file to a subagent, which is what
   * the note then suggests.
   */
  delegate?: boolean
  /** The conversation is near its compaction line, so half of each cap applies. */
  pressure?: boolean
  /** Whether the call this output came from succeeded. */
  outcome?: CapOutcome
}
/** How much of the end is looked at for signs of a failure. */
const TAIL_SCAN_CHARS = 2048
const FAILURE = /error|exception|failed|fatal|traceback|panic|exit code/i
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 60 * 60 * 1000
const FIRST_SWEEP_MS = 60 * 1000

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8")

/** The lines kept from the start, within both limits; each line after the first costs its newline too. */
function head(lines: readonly string[], maxLines: number, maxBytes: number): { kept: string[]; bytes: number; hitBytes: boolean } {
  const kept: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length && kept.length < maxLines; i++) {
    const size = bytesOf(lines[i]) + (i > 0 ? 1 : 0)
    if (bytes + size > maxBytes) return { kept, bytes, hitBytes: true }
    kept.push(lines[i])
    bytes += size
  }
  return { kept, bytes, hitBytes: false }
}

function tail(lines: readonly string[], maxLines: number, maxBytes: number): string[] {
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const size = bytesOf(lines[i]) + (kept.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    kept.unshift(lines[i])
    bytes += size
  }
  return kept
}

/** What the model is told after a cut: where the rest is, and how to get at it without reading it all back in. */
function note(file: string, delegate: boolean, outcome?: CapOutcome): string {
  const how = delegate
    ? "To look through it, start an explore subagent with the task tool and have it grep and read the file in parts, rather than reading the whole file here."
    : "Search it with grep, or read the parts you need with read and an offset and limit."
  /*
   * MiMo says which it was. A model reading "this output was too long" cannot
   * tell whether the call it is looking at worked, and the difference decides
   * whether the next step is to carry on or to fix something.
   */
  const said =
    outcome === "failure"
      ? "The tool call failed, and its output was too long and was cut."
      : outcome === "success"
        ? "The tool call succeeded, but its output was too long and was cut."
        : "This output was too long and was cut."
  return `${said} The complete output is saved at ${file}\n${how}`
}

export class ToolOutputs {
  constructor(readonly directory: string) {}

  /** Saves a complete output and says where. */
  async save(text: string): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, `tool_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`)
    await fs.writeFile(file, text, "utf8")
    return file
  }

  /**
   * The text the model reads for one output, and the saved file when it was cut.
   *
   * A bare `true` is still read as `delegate`, which is what every call site
   * meant before the other two options existed.
   */
  async cap(text: string, options: boolean | CapOptions = {}): Promise<{ text: string; truncated: boolean; file?: string }> {
    const { delegate = false, pressure = false, outcome } = typeof options === "boolean" ? { delegate: options } : options
    const maxLines = pressure ? PRESSURE_MAX_LINES : OUTPUT_MAX_LINES
    const maxBytes = pressure ? PRESSURE_MAX_BYTES : OUTPUT_MAX_BYTES
    const lines = text.split("\n")
    const total = bytesOf(text)
    if (lines.length <= maxLines && total <= maxBytes) return { text, truncated: false }

    const end = text.length > TAIL_SCAN_CHARS ? text.slice(-TAIL_SCAN_CHARS) : text
    if (FAILURE.test(end)) {
      const headLines = Math.floor(maxLines * 0.7)
      const headBytes = Math.floor(maxBytes * 0.7)
      const start = head(lines, headLines, headBytes).kept
      const finish = tail(lines, maxLines - headLines, maxBytes - headBytes)
      const omitted = lines.length - start.length - finish.length
      const file = await this.save(text)
      return {
        text: `${start.join("\n")}\n\n... ${omitted} lines left out between the start and the end ...\n\n${finish.join("\n")}\n\n${note(file, delegate, outcome)}`,
        truncated: true,
        file,
      }
    }

    const { kept, bytes, hitBytes } = head(lines, maxLines, maxBytes)
    const removed = hitBytes ? `${total - bytes} bytes` : `${lines.length - kept.length} lines`
    const file = await this.save(text)
    return { text: `${kept.join("\n")}\n\n... ${removed} cut ...\n\n${note(file, delegate, outcome)}`, truncated: true, file }
  }

  /** Whether a path is one of the saved outputs, which a tool may read wherever the project is. */
  holds(target: string): boolean {
    const relative = path.relative(path.resolve(this.directory), path.resolve(target))
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
  }

  /** Removes saved outputs older than a week. */
  async sweep(now = Date.now()): Promise<void> {
    const names = await fs.readdir(this.directory).catch(() => [] as string[])
    for (const name of names) {
      if (!name.startsWith("tool_")) continue
      const file = path.join(this.directory, name)
      const stat = await fs.stat(file).catch(() => undefined)
      if (stat && now - stat.mtimeMs > RETENTION_MS) await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  /** Sweeps a minute after starting and every hour after that, without keeping the process alive. */
  start(): void {
    const first = setTimeout(() => {
      void this.sweep()
      setInterval(() => void this.sweep(), SWEEP_EVERY_MS).unref()
    }, FIRST_SWEEP_MS)
    first.unref()
  }
}
