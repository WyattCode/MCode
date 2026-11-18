import { ToolError, type ToolContext, type ToolResult } from "../tool/types"
import type { RemoteCommand } from "./pool"

export const remoteToolDescriptions: Readonly<Record<string, string>> = {
  bash: "Run non-interactive Bash on the SSH device. Set workdir for each call; cd does not persist between calls. Each call needs user approval.",
  read: "Read text or list a directory on the SSH device. Offset is 1-based and limit counts lines.",
  write: "Write the complete contents of a file on the SSH device. Creates missing parent folders.",
  glob: "Find file paths on the SSH device using a ripgrep glob.",
  grep: "Find matching lines on the SSH device using a ripgrep regular expression.",
}

export const REMOTE_TOOLS = new Set(Object.keys(remoteToolDescriptions))

export function sshAllowsTool(name: string, agent: string): boolean {
  return REMOTE_TOOLS.has(name) && (agent === "build" || ["read", "glob", "grep"].includes(name))
}

function quote(value: string): string {
  if (value.includes("\0")) throw new ToolError("SSH arguments cannot contain NUL.")
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function fileArg(value: unknown): string {
  const file = String(value ?? ".")
  return quote(file.startsWith("/") ? file : "./" + file)
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value ?? fallback)
  if (!Number.isSafeInteger(number) || number < 1) throw new ToolError("Expected a positive integer.")
  return number
}

export async function executeOnDevice(remote: RemoteCommand | undefined, tool: string, input: Record<string, unknown>,
  context: ToolContext, target: string | undefined, local: () => Promise<ToolResult>): Promise<ToolResult> {
  if (!remote) return local()

  const question = {
    sessionID: context.sessionID,
    messageID: context.messageID,
    callID: context.callID,
  }
  const file = fileArg(input.file_path)
  const directory = fileArg(input.path)
  let command: string
  let stdin: string | undefined
  let timeout = 30_000
  switch (tool) {
    case "bash": {
      const shell = String(input.command).trim()
      if (!shell) throw new ToolError("command is empty")
      if (input.interactive === true) throw new ToolError("SSH tool commands are non-interactive.")
      timeout = positiveInteger(input.timeout === 0 ? undefined : input.timeout, 120_000)
      // Local path scans cannot tell whether remote paths are safe, or what a
      // remote shell alias resolves to. Apply the existing forced bash gate.
      await context.permissions.ask({
        ...question, kind: "bash", title: "Run SSH command", subject: shell,
        preview: `Device: ${target}\nWorking directory: ${String(input.workdir ?? ".")}\n${shell}`, forced: true, requireExplicitApproval: true, always: [],
      })
      command = `cd ${fileArg(input.workdir)} && exec bash -c ${quote(shell)}`
      break
    }
    case "read": {
      const offset = positiveInteger(input.offset, 1)
      const limit = Math.min(positiveInteger(input.limit, 2000), 2000)
      command = `if [ -d ${file} ]; then ls -A ${file}; else sed -n '${offset},${offset + limit - 1}p;${offset + limit - 1}q' ${file}; fi`
      break
    }
    case "write":
      await context.permissions.ask({
        ...question, kind: "edit", title: "Write remote file", subject: String(input.file_path),
        preview: `Device: ${target}\n${String(input.content).slice(0, 2000)}`,
      })
      stdin = String(input.content)
      command = `target=${file}
parent=$(dirname "$target") || exit
mkdir -p "$parent" || exit
if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
  echo 'SSH write requires a regular file' >&2
  exit 1
fi
temp=$(mktemp "$parent/.mcode-write.XXXXXXXX") || exit
trap 'rm -f "$temp"' EXIT
trap 'exit 1' HUP INT TERM
if [ -f "$target" ]; then cp -p "$target" "$temp" || exit; fi
cat > "$temp" && [ "$(wc -c < "$temp")" -eq ${Buffer.byteLength(stdin)} ] && mv -f "$temp" "$target"`
      break
    case "glob":
      command = `rg --no-config --files -g ${quote(String(input.pattern))} -- ${directory}`
      break
    case "grep":
      command = `rg --no-config --no-heading --line-number --color=never ${input.include ? "-g " + quote(String(input.include)) : ""} -e ${quote(String(input.pattern))} -- ${directory}`
      break
    default:
      throw new ToolError("Unknown SSH tool.")
  }

  const result = await remote(command, { signal: context.signal, timeout, stdin, progress: tool === "bash" ? context.progress : undefined })
  const metadata = { exit: result.code, ...(result.timedOut ? { timedOut: true } : {}) }
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
  if (result.timedOut) return { output: `SSH command timed out.\n${output}`, metadata }
  if (tool === "bash") {
    const cap = positiveInteger(input.max_output_tokens, context.maxOutputTokens ?? 10_000) * 4
    return {
      output: output.slice(0, cap) || `SSH command exited with code ${result.code}.`,
      title: String(input.description || input.command),
      metadata: { ...metadata, command: input.command, cwd: input.workdir ?? ".", truncated: result.truncated === true || output.length > cap },
    }
  }
  if ((tool === "glob" || tool === "grep") && result.code === 1 && !result.stderr) return { output: "No matches.", metadata }
  if (result.code) throw new ToolError(`SSH command exited with code ${result.code}: ${output}`)
  const cap = positiveInteger(input.max_output_chars, 25_000)
  return {
    output: tool === "write" ? `Wrote ${String(input.file_path)} on the SSH device.` : output.slice(0, cap),
    metadata: { ...metadata, truncated: result.truncated === true || output.length > cap },
  }
}
