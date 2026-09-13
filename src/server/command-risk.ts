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
