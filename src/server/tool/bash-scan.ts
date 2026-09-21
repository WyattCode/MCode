import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import { windowsPath } from "../shell-path"

/**
 * What a shell command touches, read the way MiMo's bash tool reads it before
 * asking: split into its simple commands, each saved for "always" as its
 * command prefix (`git status *`), file arguments that leave the project
 * named as folders to ask about, and deleting commands picked out for their
 * own question. MiMo parses with tree-sitter; this is a tokenizer that handles
 * the same shapes a model writes - quotes, `&&` `||` `;` `|` `&`, subshells,
 * `$(...)` and backtick substitutions, redirections and comments.
 */

/** MiMo's command arities: how many leading words a command's "always" keeps. */
const ARITY: Record<string, number> = {
  cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1, grep: 1, kill: 1, killall: 1, ln: 1, ls: 1, mkdir: 1, mv: 1,
  ps: 1, pwd: 1, rm: 1, rmdir: 1, sleep: 1, source: 1, tail: 1, touch: 1, unset: 1, which: 1,
  aws: 3, az: 3, bazel: 2, brew: 2, bun: 2, "bun run": 3, "bun x": 3, cargo: 2, "cargo add": 3, "cargo run": 3, cdk: 2, cf: 2,
  cmake: 2, composer: 2, consul: 2, "consul kv": 3, crictl: 2, deno: 2, "deno task": 3, doctl: 3, docker: 2, "docker builder": 3,
  "docker compose": 3, "docker container": 3, "docker image": 3, "docker network": 3, "docker volume": 3, eksctl: 2, "eksctl create": 3,
  firebase: 2, flyctl: 2, gcloud: 3, gh: 3, git: 2, "git config": 3, "git remote": 3, "git stash": 3, go: 2, gradle: 2, helm: 2,
  heroku: 2, hugo: 2, ip: 2, "ip addr": 3, "ip link": 3, "ip netns": 3, "ip route": 3, kind: 2, "kind create": 3, kubectl: 2,
  "kubectl kustomize": 3, "kubectl rollout": 3, kustomize: 2, make: 2, mc: 2, "mc admin": 3, minikube: 2, mongosh: 2, mysql: 2,
  mvn: 2, ng: 2, npm: 2, "npm exec": 3, "npm init": 3, "npm run": 3, "npm view": 3, nvm: 2, nx: 2, openssl: 2, "openssl req": 3,
  "openssl x509": 3, pip: 2, pipenv: 2, pnpm: 2, "pnpm dlx": 3, "pnpm exec": 3, "pnpm run": 3, poetry: 2, podman: 2,
  "podman container": 3, "podman image": 3, psql: 2, pulumi: 2, "pulumi stack": 3, pyenv: 2, python: 2, rake: 2, rbenv: 2,
  "redis-cli": 2, rustup: 2, serverless: 2, sfdx: 3, skaffold: 2, sls: 2, sst: 2, swift: 2, systemctl: 2, terraform: 2,
  "terraform workspace": 3, tmux: 2, turbo: 2, ufw: 2, vault: 2, "vault auth": 3, "vault kv": 3, vercel: 2, volta: 2, wp: 2,
  yarn: 2, "yarn dlx": 3, "yarn run": 3,
}

/** Commands that change the working folder, which ask nothing themselves. */
const CWD = new Set(["cd", "push-location", "set-location"])
/** Commands whose arguments are files, looked at for paths outside the project. */
const FILES = new Set([
  ...CWD, "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat",
  "get-content", "set-content", "add-content", "copy-item", "move-item", "remove-item", "new-item", "rename-item",
  /*
   * The read-only allowlist runs these without a question, so their file
   * arguments have to be looked at too, or `grep -r . ~/.ssh` would read past
   * the project with nothing asked (round 8, X7).
   */
  "head", "tail", "wc", "grep", "rg", "type", "stat", "file", "tree", "du", "ls", "dir", "less", "more", "findstr",
  "select-string", "get-item", "get-childitem", "test-path", "resolve-path", "gc", "gci", "sls",
])
/** PowerShell parameters that take a path next, and switches that take nothing. */
const PATH_FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "del", "erase", "rd", "remove-item", "ri"])
/** git subcommands that lose work, with the flags that make them do it (none needed for an empty set). */
const GIT_DESTRUCTIVE = new Map<string, Set<string>>([
  ["reset", new Set(["--hard"])],
  ["clean", new Set(["-f", "-ff", "-fd", "-fdx", "-df", "-dfx", "-fx", "--force"])],
  ["branch", new Set(["-D", "--delete"])],
  ["tag", new Set(["-d", "--delete"])],
  ["worktree", new Set(["remove"])],
  ["push", new Set(["--force", "-f"])],
  ["stash", new Set(["drop", "clear"])],
])

export interface SimpleCommand {
  tokens: string[]
  source: string
  /** Files a `>`-style redirection writes to; `<` only reads and names none. */
  redirects: string[]
}

/** MiMo's write commands: the ones whose path arguments name a file they change. */
const WRITE_COMMANDS = new Set([
  "tee", "install", "touch", "mkdir", "cp", "mv", "ln", "truncate", "dd", "patch",
  "set-content", "add-content", "new-item", "copy-item", "move-item", "rename-item",
  "out-file", "tee-object", "set-item", "add-item", "new-volume", "clear-content",
])
/** Of these, only the last path is written: the ones before it are sources. */
const COPY_DEST_ONLY = new Set(["cp", "ln", "install", "copy-item"])
/** The index of the `)` closing the `(` at `open`, or the end of the text. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++
    else if (text[i] === ")" && --depth === 0) return i
  }
  return text.length
}

/** The simple commands a command line runs, substitutions included, in order. */
export function simpleCommands(command: string, powershell: boolean): SimpleCommand[] {
  const out: SimpleCommand[] = []
  const nested: string[] = []
  let tokens: string[] = []
  let redirects: string[] = []
  let word = ""
  let inWord = false
  let start = -1
  const endWord = () => {
    if (inWord) tokens.push(word)
    word = ""
    inWord = false
  }
  const endCommand = (end: number) => {
    endWord()
    // `FOO=1 git status` runs git; assignments in front are not the command, and a line of only them runs nothing.
    const first = powershell ? 0 : tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    const words = first === -1 ? [] : tokens.slice(first)
    if (words.length) out.push({ tokens: words, source: command.slice(start, end).trim(), redirects })
    tokens = []
    redirects = []
    start = -1
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (start === -1 && !/\s/.test(ch) && !";&|\n".includes(ch)) start = i
    if (ch === "#" && !inWord) {
      const newline = command.indexOf("\n", i)
      i = (newline === -1 ? command.length : newline) - 1
      continue
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close === -1 ? command.length - 1 : close
      word += command.slice(i, end + 1)
      inWord = true
      i = end
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if ((!powershell && command[j] === "\\") || (powershell && command[j] === "`")) j++
        else if (command[j] === "$" && command[j + 1] === "(") {
          const close = closing(command, j + 1)
          nested.push(command.slice(j + 2, close))
          j = close
        }
        j++
      }
      word += command.slice(i, j + 1)
      inWord = true
      i = j
      continue
    }
    if (ch === "$" && command[i + 1] === "(") {
      const close = closing(command, i + 1)
      nested.push(command.slice(i + 2, close))
      word += command.slice(i, close + 1)
      inWord = true
      i = close
      continue
    }
    if (ch === "`") {
      if (powershell) {
        word += command.slice(i, i + 2)
        inWord = true
        i++
      } else {
        const close = command.indexOf("`", i + 1)
        const end = close === -1 ? command.length - 1 : close
        nested.push(command.slice(i + 1, end))
        word += command.slice(i, end + 1)
        inWord = true
        i = end
      }
      continue
    }
    if (ch === "\\" && !powershell && process.platform !== "win32") {
      word += command.slice(i, i + 2)
      inWord = true
      i++
      continue
    }
    // A redirection and its target are not arguments: `2>&1`, `> out.txt`, `&> /dev/null`.
    if (ch === ">" || ch === "<" || (ch === "&" && command[i + 1] === ">")) {
      if (/^\d+$/.test(word)) {
        word = ""
        inWord = false
      }
      endWord()
      let j = i + 1
      while (command[j] === ">" || command[j] === "&" || command[j] === "|") j++
      const operator = command.slice(i, j)
      while (command[j] === " " || command[j] === "\t") j++
      const from = j
      // A quoted target runs to its closing quote: `> "C:\a b\c.json"` names that file, not `"C:\a`.
      if (command[j] === '"' || command[j] === "'") {
        const close = command.indexOf(command[j]!, j + 1)
        j = close === -1 ? command.length : close + 1
      } else {
        while (j < command.length && !/[\s;&|]/.test(command[j]!)) j++
      }
      // A redirection that writes names a file the command changes; `<` only reads one.
      if (operator.includes(">") && j > from) redirects.push(unquote(command.slice(from, j)))
      i = j - 1
      continue
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      endCommand(i)
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++
      continue
    }
    if ((ch === "(" || ch === ")" || ch === "{" || ch === "}") && !inWord) {
      endCommand(i)
      continue
    }
    if (/\s/.test(ch)) {
      endWord()
      continue
    }
    word += ch
    inWord = true
  }
  endCommand(command.length)
  for (const body of nested) out.push(...simpleCommands(body, powershell))
  return out.filter((entry) => entry.tokens.length > 0)
}

/** The words of a command its "always" keeps, by MiMo's arity table; the command's own name otherwise. */
export function arityPrefix(tokens: string[]): string[] {
  for (let length = tokens.length; length > 0; length--) {
    const arity = ARITY[tokens.slice(0, length).join(" ")]
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  return tokens.slice(0, 1)
}

/*
 * Interpreters, and the flags that hand them code on the command line.
 *
 * The arity table keeps one word for a command it does not list, so a single
 * "always" for `node build.js` used to save `node *` - and with it every
 * `node -e "<anything>"` after. An interpreter's "always" keeps its script as
 * well, and a line that carries its code inline is remembered only exactly as
 * it was approved.
 */
const INTERPRETERS = new Set([
  "node", "nodejs", "python", "python3", "py", "perl", "ruby", "php", "deno", "bun", "bash", "sh", "zsh", "dash", "fish",
  "pwsh", "powershell", "cmd", "osascript", "lua", "rscript", "tsx", "ts-node",
])
const INLINE_FLAGS = new Set([
  "-e", "-p", "-c", "-r", "--eval", "--print", "-command", "/c", "/k", "-encodedcommand", "-enc", "-ec", "eval",
])

const programName = (token: string) => (token.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "")

/** Whether a command runs code written on its own command line, rather than a named script. */
export function runsInlineCode(tokens: string[]): boolean {
  if (!INTERPRETERS.has(programName(tokens[0] ?? ""))) return false
  return tokens.slice(1).some((token) => INLINE_FLAGS.has(token.toLowerCase()) || /^-(?:e|c|p)\S/.test(token) || /^--eval=/.test(token))
}

/**
 * What an "always" for this command keeps: MiMo's arity prefix, narrowed for
 * interpreters; undefined when nothing can be kept safely - inline code holding
 * `*` or `?`, which a saved rule would read as wildcards.
 */
export function rememberedPattern(tokens: string[], source: string): string | undefined {
  if (runsInlineCode(tokens)) return /[*?]/.test(source) ? undefined : source.trim()
  const prefix = arityPrefix(tokens)
  if (prefix.length === 1 && INTERPRETERS.has(programName(tokens[0] ?? "")) && tokens[1]) return `${tokens.slice(0, 2).join(" ")} *`
  return `${prefix.join(" ")} *`
}

const headOf = (tokens: string[], powershell: boolean) => (powershell ? tokens[0]?.toLowerCase() : tokens[0])

export function isDelete(tokens: string[], powershell: boolean): boolean {
  const head = headOf(tokens, powershell)
  if (!head) return false
  if (DELETE_COMMANDS.has(head)) return true
  if (head !== "git" || tokens.length < 2) return false
  const flags = GIT_DESTRUCTIVE.get(tokens[1])
  if (!flags) return false
  return flags.size === 0 || tokens.slice(2).some((token) => flags.has(token))
}

function pathArgs(tokens: string[], powershell: boolean): string[] {
  if (!powershell) return tokens.slice(1).filter((token) => !token.startsWith("-") && !(tokens[0] === "chmod" && token.startsWith("+")))
  const out: string[] = []
  let wantPath = false
  for (const token of tokens.slice(1)) {
    if (wantPath) {
      out.push(token)
      wantPath = false
      continue
    }
    if (token.startsWith("-")) {
      const flag = token.toLowerCase()
      if (SWITCHES.has(flag)) continue
      wantPath = PATH_FLAGS.has(flag)
      continue
    }
    out.push(token)
  }
  return out
}

function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[0] === text[text.length - 1]) return text.slice(1, -1)
  return text
}

/** A file argument as a path, or undefined when it cannot be known before the command runs. */
function argPath(arg: string, cwd: string, powershell: boolean): string | undefined {
  let text = unquote(arg)
  if (text === "~") text = os.homedir()
  else if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(os.homedir(), text.slice(2))
  if (powershell) {
    text = text
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_whole, name: string) => {
        const key = Object.keys(process.env).find((entry) => entry.toLowerCase() === name.toLowerCase())
        return key ? (process.env[key] ?? "") : ""
      })
      .replace(/\$HOME\b/gi, os.homedir())
      .replace(/\$PWD\b/gi, cwd)
    text = text.replace(/^Microsoft\.PowerShell\.Core\\FileSystem::/i, "").replace(/^FileSystem::/i, "")
    // Another provider's drive - env:, HKLM:, cert: - is not a file.
    if (/^[a-z][a-z0-9]+:/i.test(text)) return undefined
  }
  const glob = /[?*[]/.exec(text)
  if (glob) {
    if (glob.index === 0) return undefined
    text = text.slice(0, glob.index)
  }
  if (text.startsWith("(") || text.startsWith("@(") || text.includes("$(") || text.includes("${") || text.includes("`")) return undefined
  if (text.includes("$")) return undefined
  if (!text) return undefined
  // A POSIX spelling of a Windows drive (/c/Users, /mnt/c/Users) is that drive, in any shell, as MiMo reads it.
  return path.resolve(cwd, windowsPath(text))
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

function realpathBestEffort(target: string): string {
  let current = target
  let suffix = ""
  for (;;) {
    try {
      return path.join(realpathSync.native(current), suffix)
    } catch {
      suffix = suffix ? path.join(path.basename(current), suffix) : path.basename(current)
      const parent = path.dirname(current)
      if (parent === current) return target
      current = parent
    }
  }
}

/** Inside the system temp folder, not the folder itself - where MiMo lets a delete go without its own question. */
function insideTemp(target: string): boolean {
  const real = realpathBestEffort(target)
  const roots = [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])].map(realpathBestEffort)
  return roots.some((root) => real !== root && real.startsWith(root + path.sep))
}

/** A token that could be a path: not a flag, and nothing only the shell could work out. */
function plausiblePathArg(token: string): string | undefined {
  if (!token || token.startsWith("-")) return undefined
  const text = unquote(token)
  if (!text || text.includes("*") || text.includes("$") || text.includes("(") || text.includes(" ")) return undefined
  return text
}

function isSedInPlace(tokens: string[], powershell: boolean): boolean {
  if (headOf(tokens, powershell) !== "sed") return false
  return tokens.slice(1).some((token) => token === "-i" || token === "--in-place" || token.startsWith("--in-place=") || /^-[^-]*i/.test(token))
}

export interface MutationTargets {
  /**
   * Every file the command names as written, read as generously as a path can
   * be known: quoted names with spaces, `~` and environment variables included.
   * What the guard on the app's own data folder checks, where a name slipping
   * past matters more than one counted too many.
   */
  written: string[]
}

/**
 * Where a command line would write, read the way MiMo's bash tool reads it: a
 * shell command names no file the way a write tool does, so this walks the
 * simple commands, follows `cd` and `pushd`/`popd` so a later command is
 * resolved from where it would actually run, and collects write redirections,
 * the path arguments of its write commands and `sed -i`.
 */
export function collectMutationTargets(command: string, cwd: string, powershell: boolean): MutationTargets {
  let effective = path.resolve(cwd)
  const stack: string[] = []
  const written: string[] = []
  const name = (raw: string) => {
    const resolved = argPath(raw, effective, powershell)
    if (resolved) written.push(resolved)
  }
  const moveTo = (raw: string | undefined) => {
    if (raw) effective = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(effective, raw)
  }
  for (const { tokens, redirects } of simpleCommands(command, powershell)) {
    const head = headOf(tokens, powershell)
    if (!head) continue
    if (head === "cd" || head === "set-location") {
      moveTo(plausiblePathArg(tokens[1] ?? ""))
      continue
    }
    if (head === "pushd" || head === "push-location") {
      stack.push(effective)
      moveTo(plausiblePathArg(tokens[1] ?? ""))
      continue
    }
    if (head === "popd" || head === "pop-location") {
      effective = stack.pop() ?? path.resolve(cwd)
      continue
    }
    for (const target of redirects) name(target)
    if (WRITE_COMMANDS.has(head) || isSedInPlace(tokens, powershell)) {
      const args = tokens.slice(1).filter((token) => !token.startsWith("-"))
      for (const arg of COPY_DEST_ONLY.has(head) ? args.slice(-1) : args) name(arg)
    }
  }
  return { written: [...new Set(written)] }
}

export interface BashScan {
  /** Each simple command that asks, as written. */
  patterns: string[]
  /** What "always" saves for them: each one's prefix and ` *`. */
  always: string[]
  /** The commands that delete or lose work. */
  deletes: string[]
  /** Every delete is of files in the temp folder outside the project, so it needs no question of its own. */
  tempOnlyDeletes: boolean
  /** Folders outside the project that file commands name. */
  dirs: string[]
  /** Every file or folder a file command names, inside the project or not. */
  files: string[]
}

export async function scanCommand(command: string, cwd: string, project: string, powershell: boolean): Promise<BashScan> {
  const patterns = new Set<string>()
  const always = new Set<string>()
  const deletes = new Set<string>()
  const dirs = new Set<string>()
  const files = new Set<string>()
  let tempOnly = true
  for (const { tokens, source } of simpleCommands(command, powershell)) {
    const head = headOf(tokens, powershell)
    if (head && FILES.has(head)) {
      for (const arg of pathArgs(tokens, powershell)) {
        const resolved = argPath(arg, cwd, powershell)
        if (resolved) files.add(resolved)
        if (!resolved || inside(project, resolved)) continue
        const isDir = await fs.stat(resolved).then((stat) => stat.isDirectory(), () => false)
        dirs.add(isDir ? resolved : path.dirname(resolved))
      }
    }
    if (!head || !CWD.has(head)) {
      patterns.add(source)
      const remembered = rememberedPattern(tokens, source)
      if (remembered) always.add(remembered)
    }
    if (isDelete(tokens, powershell)) {
      deletes.add(source)
      const args = head && DELETE_COMMANDS.has(head) ? pathArgs(tokens, powershell) : []
      if (args.length === 0) tempOnly = false
      for (const arg of args) {
        const resolved = argPath(arg, cwd, powershell)
        if (!resolved || !insideTemp(resolved) || inside(project, resolved)) tempOnly = false
      }
    }
  }
  return { patterns: [...patterns], always: [...always], deletes: [...deletes], tempOnlyDeletes: deletes.size > 0 && tempOnly, dirs: [...dirs], files: [...files] }
}
