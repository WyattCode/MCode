import { gitSubcommand, simpleCommands } from "./tool/bash-scan"

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

/*
 * Words that run another program rather than being one: `env rm -rf src` and
 * `ls | xargs rm -rf .` deleted a tree while this function read `env` and
 * `xargs` and found nothing (R25-B2). `sudo` and its kin are deliberately not
 * here - they are a risk in their own right and must stay the answer.
 */
const WRAPPERS = new Set(["env", "xargs", "nohup", "time", "timeout", "nice", "ionice", "stdbuf", "command", "exec", "setsid", "unbuffer"])

function commandTokens(all: string[]): string[] {
  let at = 0
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/
  while (at < all.length && assignment.test(all[at]!)) at++
  while (at < all.length && WRAPPERS.has(program(all[at]!))) {
    at++
    // The wrapper's own flags, and the count or duration one of them takes.
    while (at < all.length && (assignment.test(all[at]!) || /^-/.test(all[at]!) || /^\d+(?:\.\d+)?[smhd]?$/.test(all[at]!) || all[at] === "{}")) at++
  }
  return all.slice(at)
}

function pieceRisk(piece: string): CommandRisk | undefined {
  if (/-verb\s+runas\b/i.test(piece)) return "elevate"
  const tokens = commandTokens(piece.split(/\s+/))
  const first = program(tokens[0] ?? "")
  if (!first) return undefined
  if (DELETE.has(first)) return "delete"
  if (ELEVATE.has(first)) return "elevate"
  if (KILL.has(first)) return "kill"
  if (RIGHTS.has(first)) return "rights"
  if (SYSTEM.has(first)) return "system"
  const sub = (tokens.slice(1).find((token) => !token.startsWith("-")) ?? "").toLowerCase()
  if (SUBCOMMANDS[first]?.includes(sub)) return "publish"
  return undefined
}

function gitRisk(tokens: string[]): CommandRisk | undefined {
  const words = commandTokens(tokens)
  if (program(words[0] ?? "") !== "git") return undefined
  const sub = gitSubcommand(words)
  if (!sub || sub.name === "clean") return "delete"
  if (sub.name === "reset" && sub.args.includes("--hard")) return "reset"
  if (sub.name === "push") return "publish"
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
  "mv", "truncate", "move-item",
])
const DANGEROUS_SHAPES: RegExp[] = [
  /\b(?:npm|yarn|pnpm|cargo)\s+publish\b/i,
  /\btwine\s+upload\b/i,
  /\bgem\s+push\b/i,
  /\breg\s+delete\b/i,
  /\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/,
  /\|\s*(?:iex|invoke-expression|powershell|pwsh)\b/i,
  /*
   * Any flags in front of the code flag, and the code flag inside a cluster:
   * written as `sh\s+-c` this sent `bash -c "$(curl …)"` to review and ran
   * `bash -lc`, `sh -ec` and `sh -e -c` with the same body unasked (R28-3).
   */
  /\b(?:ba|z|da|fi)?sh(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*c[A-Za-z]*\b/,
  /\b(?:ba|z|da|fi)?sh\s+<\(/,
  // cmd's switches come in any order: `cmd /d /c`, `cmd /q /k`.
  /\bcmd(?:\.exe)?(?:\s+\/[A-Za-z](?::\S+)?)*\s+\/[ck]\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\s+[^\n]*?-(?:c|command|encodedcommand)\b/i,
  /\brsync\b[^\n]*?--delete/i,
  /* Options/args may sit before the subcommand: `git -c a=b push`, `gh --repo o/r pr merge`. Not `git stash push`. */
  /\bgit(?!\s+stash\b)(?:\s+\S+)*?\s+push\b/i,
  /\bgh(?:\s+\S+)*?\s+pr\s+merge\b/i,
  /\b(?:python3?|node|nodejs)(?:\s+--?[A-Za-z0-9-]+)*\s+-[A-Za-z]*[ce][A-Za-z]*\b/i,
  /\bfind\b[^\n]*?-delete\b/i,
  /* Discard worktree paths: `git checkout -- file` (bare `--`), not `--track`/`--ours` flags. */
  /\bgit\s+checkout\b[^\n]*?(?:\s)--(?:\s|$)/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+stash\s+(?:drop|clear)\b/i,
  /\b(?:curl|wget)\b[\s\S]*?(?:&&|\|\||;|\n)\s*(?:env\s+)?(?:ba|z|da|fi)?sh\b/i,
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
  "type", "ps", "df", "du", "tree", "stat", "file", "basename", "dirname", "grep", "rg", "cut", "column", "true", "false",
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

/*
 * Shell strips matching outer quotes before a program sees its arguments. A
 * token that still carries a quote after that is not something this allowlist
 * can reason about, so callers fail closed.
 */
function stripArgQuotes(word: string): string | undefined {
  let out = word
  while (
    out.length >= 2 &&
    ((out[0] === "'" && out[out.length - 1] === "'") ||
      (out[0] === '"' && out[out.length - 1] === '"'))
  ) {
    out = out.slice(1, -1)
  }
  return /['"]/.test(out) ? undefined : out
}

/*
 * Normalize whitespace-split tokens the way the shell would. Long options may
 * quote only their value (`--config="..."`), so strip that too; anything left
 * with a quote, a dollar sign, or a backslash is a substitution or escape this
 * allowlist cannot reason about, so callers fail closed.
 */
function normalizeWords(words: string[]): string[] | undefined {
  const out: string[] = []
  for (const word of words) {
    const stripped = stripArgQuotes(word)
    if (stripped !== undefined) {
      if (/[\\$'"]/.test(stripped)) return undefined
      out.push(stripped)
      continue
    }
    const eq = word.indexOf("=")
    if (eq > 0) {
      const value = stripArgQuotes(word.slice(eq + 1))
      if (value !== undefined) {
        const token = `${word.slice(0, eq + 1)}${value}`
        if (/[\\$'"]/.test(token)) return undefined
        out.push(token)
        continue
      }
    }
    return undefined
  }
  return out
}

/*
 * ripgrep's `--pre` runs a program over every match before it is searched; the
 * value is that program. `--pre-glob` only says which files the preprocessor
 * sees and is harmless, so only `--pre` and `--pre=` are the exec hook.
 */
function hasPreExec(words: string[]): boolean {
  return words.some((word) => word === "--pre" || word.startsWith("--pre="))
}

/*
 * A read-only git subcommand turned dangerous by a flag after it: `-O` /
 * `--open-files-in-pager` runs a pager program, `--output` writes a file,
 * `--ext-diff` may invoke an external diff, `--textconv` runs textconv filters,
 * `--show-signature` may invoke gpg, and `--paginate` runs a pager. A `-c` /
 * `--config` that sets an exec-capable key is the same trick spelled
 * differently. Git config keys are case-insensitive, and the value may be glued
 * to the flag, so both are refused. The global `-c` sits before the subcommand
 * and is refused there already; this scans what follows it.
 */
const GIT_CONFIG_TRICK =
  /^(?:core\.(?:pager|editor|askpass)|pager\.|alias\.|diff\.external|diff\.[^=]+\.textconv|gpg\.program|filter\.|interactive\.difffilter)/i
function gitUnsafeArgs(words: string[]): boolean {
  const sub = words[1] ?? ""

  /*
   * `symbolic-ref` with one name only reads; a second name writes the ref, and
   * `--delete` / `-d` removes one. Count non-flag args after the subcommand.
   */
  if (sub === "symbolic-ref") {
    let nonFlagArgs = 0
    for (let at = 2; at < words.length; at++) {
      const word = words[at] ?? ""
      if (word === "--delete" || word.startsWith("--delete=") || word === "-d" || /^-[A-Za-z]*d[A-Za-z]*$/.test(word)) {
        return true
      }
      if (!word.startsWith("-")) nonFlagArgs++
    }
    if (nonFlagArgs >= 2) return true
  }

  /* `--filters` runs smudge/filter drivers; `--batch-command` can write objects. */
  if (sub === "cat-file") {
    for (let at = 2; at < words.length; at++) {
      const word = words[at] ?? ""
      if (
        word === "--filters" ||
        word.startsWith("--filters=") ||
        word === "--batch-command" ||
        word.startsWith("--batch-command=")
      ) {
        return true
      }
    }
  }

  /* `reflog show` (default) reads; `delete` / `expire` mutate the reflog. */
  if (sub === "reflog") {
    for (let at = 2; at < words.length; at++) {
      const word = words[at] ?? ""
      if (word.startsWith("-")) continue
      const lower = word.toLowerCase()
      if (lower === "delete" || lower === "expire") return true
      break
    }
  }

  for (let at = 2; at < words.length; at++) {
    const word = words[at] ?? ""
    if (word.startsWith("-O")) return true
    if (word === "--open-files-in-pager" || word.startsWith("--open-files-in-pager=")) return true
    if (word === "--output" || word.startsWith("--output=")) return true
    if (word === "--ext-diff" || word.startsWith("--ext-diff=")) return true
    if (word === "--textconv" || word.startsWith("--textconv=")) return true
    if (word === "--show-signature" || word.startsWith("--show-signature=")) return true
    if (word === "--paginate" || word.startsWith("--paginate=")) return true
    if ((word === "-c" || word === "--config") && GIT_CONFIG_TRICK.test(words[at + 1] ?? "")) return true
    if (word.startsWith("--config=") && GIT_CONFIG_TRICK.test(word.slice("--config=".length))) return true
    if (word.startsWith("-c") && word.length > 2 && GIT_CONFIG_TRICK.test(word.slice(2))) return true
  }
  return false
}

function readOnlyPiece(piece: string): boolean {
  const rawWords = piece.trim().split(/\s+/).filter(Boolean)
  const words = normalizeWords(rawWords)
  if (!words) return false
  const head = words[0] ?? ""
  if (!head) return false
  if (head === "git") return READ_ONLY_GIT.has(words[1] ?? "") && !gitUnsafeArgs(words)
  if (head === "tail" && words.some((word) => word === "--follow" || word.startsWith("--follow=") || /^-[A-Za-z]*[fF]/.test(word))) return false
  if ((head === "rg" || head === "grep") && hasPreExec(words)) return false
  return READ_ONLY.has(head) || READ_ONLY_POWERSHELL.has(head.toLowerCase())
}

export function readOnlyCommand(command: string): boolean {
  /*
   * A line break separates shell commands. Collapsing it into a space would
   * make `pwd\nchmod …` look like one read-only piece while bash still runs
   * both lines — Ask would auto-allow. Refuse any line break first.
   */
  if (/[\n\r\u2028\u2029]/.test(command)) return false
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
  // Git option values may contain spaces and quotes. Keep the tokenizer's argument boundaries.
  let gitPublish: CommandRisk | undefined
  for (const { tokens } of simpleCommands(command, process.platform === "win32")) {
    const risk = gitRisk(tokens)
    if (risk && LOST_WORK.includes(risk)) return risk
    gitPublish ??= risk
  }
  /*
   * A quote ends a piece as surely as a semicolon does. Without this, the whole
   * of `bash -c "rm -rf src"` was one piece whose first word is `bash`, and the
   * line carried no risk at all - so approve-for-me ran it (R25-B2). Reading
   * the quoted half as its own piece means `echo "rm -rf src"` asks too; that
   * is the trade this module states at the top, and a question costs less than
   * a tree.
   */
  const pieces = command
    .split(/&&|\|\||[;|\n`'"]|\$\(|\(|\)/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  let found: CommandRisk | undefined
  for (const piece of pieces) {
    const risk = pieceRisk(piece)
    if (risk && LOST_WORK.includes(risk)) return risk
    found ??= risk
  }
  return found ?? gitPublish
}
