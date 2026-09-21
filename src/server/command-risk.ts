/**
 * Whether a shell command is one the "auto" access level still asks about.
 *
 * The level exists so that everyday work - building, testing, reading the
 * repository's state - runs without a question each time. What it must not
 * wave through is anything that deletes, that reaches past the user's own
 * rights (elevation, permissions, other processes, the disk itself), or that
 * sends work out of the machine (publishing, pushing). Those come back to the
 * reader however they are spelled.
 *
 * It errs towards asking: a command is split at every separator and
 * substitution, and a single risky piece anywhere makes the whole command ask.
 * A false alarm costs one question; a miss could cost the user's files.
 */

const DELETE = new Set(["rm", "rmdir", "del", "erase", "rd", "remove-item", "ri", "rimraf", "unlink", "shred", "srm", "trash"])
const ELEVATE = new Set(["sudo", "su", "doas", "runas", "pkexec", "gsudo"])
const KILL = new Set(["kill", "pkill", "killall", "taskkill", "tskill", "stop-process", "spps"])
const RIGHTS = new Set(["chmod", "chown", "chgrp", "icacls", "cacls", "takeown", "setfacl", "attrib"])
const SYSTEM = new Set(["format", "mkfs", "dd", "diskpart", "fdisk", "parted", "shutdown", "reboot", "halt", "poweroff", "bcdedit", "reg", "setx"])

/* Tools whose subcommand decides: `git push` sends work away, `git status` does not. */
const SUBCOMMANDS: Record<string, string[]> = {
  git: ["push", "clean"],
  npm: ["publish", "unpublish"],
  pnpm: ["publish"],
  yarn: ["publish", "npm"],
  bun: ["publish"],
  cargo: ["publish"],
  twine: ["upload"],
  docker: ["push"],
  gh: ["release"],
  vsce: ["publish"],
  gem: ["push"],
  mvn: ["deploy"],
}

function program(token: string): string {
  const bare = token.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? ""
  return bare.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, "")
}

export type CommandRisk = "delete" | "elevate" | "kill" | "rights" | "system" | "publish" | "reset"

/** Risks only a person settles: they throw away work that cannot be brought back. */
export const LOST_WORK: readonly CommandRisk[] = ["delete", "reset"]

function pieceRisk(piece: string): CommandRisk | undefined {
  const lowered = piece.toLowerCase()
  if (/-verb\s+runas\b/.test(lowered)) return "elevate"
  // Environment assignments in front of the program (`FOO=1 rm x`) are not the program.
  const tokens = piece.split(/\s+/).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
  const first = program(tokens[0] ?? "")
  if (!first) return undefined
  if (DELETE.has(first)) return "delete"
  if (ELEVATE.has(first)) return "elevate"
  if (KILL.has(first)) return "kill"
  if (RIGHTS.has(first)) return "rights"
  if (SYSTEM.has(first)) return "system"
  const sub = (tokens.slice(1).find((token) => !token.startsWith("-")) ?? "").toLowerCase()
  if (SUBCOMMANDS[first]?.includes(sub)) return first === "git" && sub === "clean" ? "delete" : "publish"
  if (first === "git" && sub === "reset" && /--hard\b/.test(lowered)) return "reset"
  return undefined
}

/*
 * MiMo's approve-for-me (帮我审批) lets a command through unasked unless a word
 * of it is one of these, or it has one of these shapes - running what came
 * from elsewhere, publishing, deleting, reaching past the user's rights. Such a
 * command is put to the model's review instead.
 */
const DANGEROUS_WORDS = new Set([
  "sudo", "su", "doas", "dd", "diskutil", "mount", "umount", "launchctl", "systemctl", "shutdown", "reboot", "halt", "poweroff",
  "kill", "killall", "pkill", "taskkill", "chmod", "chown", "chflags", "icacls", "rm", "rmdir", "shred", "del", "rd", "erase",
  "eval", "source", "xargs", "env", "remove-item", "stop-process", "stop-computer", "restart-computer", "invoke-expression", "iex",
  "set-executionpolicy", "format-volume", "clear-disk", "nc", "ncat", "netcat", "crontab",
])
const DANGEROUS_SHAPES: RegExp[] = [
  /\b(?:npm|yarn|pnpm|cargo)\s+publish\b/i,
  /\btwine\s+upload\b/i,
  /\bgem\s+push\b/i,
  /\breg\s+delete\b/i,
  /\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/,
  /\|\s*(?:iex|invoke-expression|powershell|pwsh)\b/i,
  /\b(?:ba|z|da|fi)?sh\s+-c\b/,
  /\b(?:ba|z|da|fi)?sh\s+<\(/,
  /\bcmd(?:\.exe)?\s+\/c\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\s+[^\n]*?-(?:c|command|encodedcommand)\b/i,
  /\brsync\b[^\n]*?--delete/i,
]

export function dangerousCommand(command: string): boolean {
  const text = command
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    // Closing an office preview's process is ordinary work, as MiMo counts it.
    .replace(/\bpkill(?:\s+-[A-Za-z0-9]+)*\s+["']?soffice(?:\.bin)?["']?(?=$|[\s;|&)])/g, " ")
  if (DANGEROUS_SHAPES.some((shape) => shape.test(text))) return true
  return text.split(/[\s;|&(){}<>`"']+/).some((piece) => {
    const word = piece.replace(/^\$+/, "").toLowerCase()
    return Boolean(word) && (DANGEROUS_WORDS.has(word) || word.startsWith("mkfs"))
  })
}

/* MiMo's read-only allowlist: at Ask, a command made only of these runs once without a question. */
const READ_ONLY = new Set([
  "pwd", "whoami", "hostname", "uname", "date", "id", "uptime", "arch", "tty", "ls", "cat", "head", "tail", "wc", "echo", "which",
  "type", "printenv", "ps", "df", "du", "tree", "stat", "file", "basename", "dirname", "grep", "rg", "cut", "column", "true", "false",
])
const READ_ONLY_GIT = new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "describe", "shortlog", "reflog", "ls-files", "ls-tree", "whatchanged",
  "cat-file", "cherry", "count-objects", "rev-list", "name-rev", "for-each-ref", "symbolic-ref", "var", "version", "grep",
])
const READ_ONLY_POWERSHELL = new Set([
  "test-path", "get-item", "get-childitem", "get-location", "get-date", "get-process", "get-command", "get-host", "resolve-path",
  "split-path", "select-object", "select-string", "measure-object", "sort-object", "format-table", "format-list", "format-wide",
  "out-string", "write-output", "dir", "findstr", "ver",
])
/** Anything that writes, substitutes or groups disqualifies a command. */
const NOT_PLAIN = /[<>`\n(){}]|\$\(/
/** Redirections that only discard output, taken out before looking. */
const HARMLESS_REDIRECT = /(?:2>&1|&>\s*\/dev\/null|(?:\d)?\s*>\s*\/dev\/null)(?=$|[\s;|&])/g

function readOnlyPiece(piece: string): boolean {
  const words = piece.trim().split(/\s+/).filter(Boolean)
  const head = words[0] ?? ""
  if (!head) return false
  if (head === "git") return READ_ONLY_GIT.has(words[1] ?? "")
  if (head === "tail" && words.some((word) => word === "-f" || word === "--follow" || word.startsWith("--follow="))) return false
  return READ_ONLY.has(head) || READ_ONLY_POWERSHELL.has(head.toLowerCase())
}

export function readOnlyCommand(command: string): boolean {
  const text = command.replace(HARMLESS_REDIRECT, " ").replace(/\s+/g, " ").trim()
  if (!text) return false
  const parts = text.split(/\s*(?:&&|\|\||;)\s*/).map((part) => part.trim()).filter(Boolean)
  return (
    parts.length > 0 &&
    parts.every((part) => {
      if (NOT_PLAIN.test(part) || /(?:^|[^&])&(?:[^&]|$)/.test(part)) return false
      const pipes = part.split("|").map((piece) => piece.trim()).filter(Boolean)
      return pipes.length > 0 && pipes.every(readOnlyPiece)
    })
  )
}

/*
 * The whole chain is read, not just up to the first risk. What decides who
 * answers is the worst piece: `git push && rm -rf dist` is a delete, and a
 * delete is never left to the model however harmless the push in front of it.
 */
export function commandRisk(command: string): CommandRisk | undefined {
  const pieces = command
    .split(/&&|\|\||[;|\n`]|\$\(|\(|\)/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  let found: CommandRisk | undefined
  for (const piece of pieces) {
    const risk = pieceRisk(piece)
    if (risk && LOST_WORK.includes(risk)) return risk
    found ??= risk
  }
  return found
}
