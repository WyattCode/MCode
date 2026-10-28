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
  /*
   * These two were on the read-only allowlist and not here, so they were the
   * one pair that read a file with nothing asked and nothing checked:
   * `cut -c1-9999 <appdata>/credentials.json` returned the saved sign-ins,
   * where `cat` of the same path is refused (R25-B1).
   */
  "cut", "column",
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
  /**
   * Read out of another command rather than written on the line - the script
   * inside `bash -c "..."`, or the program a wrapper runs.
   *
   * It counts for everything that guards: what is deleted, which files are
   * named, what is written. It must never contribute an "always", because the
   * pattern saved for it would be the inner program's prefix - one "always" for
   * `bash -c "npm test"` would otherwise save `npm *` and let a later bare
   * `npm publish` through unasked (R25-B2).
   */
  derived?: true
  /**
   * Whether this command is PowerShell, which can differ from the line it
   * came from: `powershell -Command "Remove-Item x"` written in bash is a bash
   * line whose inner command is PowerShell. Read with the outer line's rules,
   * that `Remove-Item` kept its capitals, matched no case-folded delete, and
   * deleted with an ordinary question - found on the LAN Qwen, whose shell
   * here is Git Bash. Undefined is the line's own.
   */
  powershell?: boolean
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

/**
 * Commands that run another command handed to them in their own arguments.
 *
 * The program is not the first word on these lines, and every guard here reads
 * the first word: `env rm -rf src`, `xargs rm -rf .` and `nohup npm publish`
 * each showed no delete and no publish at all (R25-B2).
 */
const WRAPPERS = new Set([
  "env", "xargs", "nohup", "time", "timeout", "nice", "ionice", "stdbuf", "command", "exec", "setsid", "sudo", "doas", "unbuffer",
])

/**
 * `eval` runs its arguments as a command line, so the arguments are the
 * command. It was in neither table, and `eval "rm -rf src"` therefore showed
 * no delete at all (R26-E3) - while `command-risk`'s own dangerous-word list
 * has named it all along, so the codebase knew about it and this scanner did
 * not.
 */
const EVAL_WORDS = new Set(["eval", "source", ".", "invoke-expression", "iex"])

/**
 * PowerShell's quote characters, which are more than the ASCII two: it reads
 * the typographic quotes as quotes too, any of a kind closing any other. Read
 * as ordinary letters, `Write-Output ‘a'; Remove-Item x; 'b’` was one long
 * string to this scanner and a delete to PowerShell (OpenCode v2's
 * adversarial scanner tests, 9d387f6b).
 */
const POSH_SINGLE = new Set(["'", "‘", "’", "‚", "‛"])
const POSH_DOUBLE = new Set(['"', "“", "”", "„"])

/**
 * A command whose program is computed when it runs - `$(printf rm) -rf src`,
 * `` `printf rm` ``, `$tool x`, PowerShell's `& $x` - names no program this
 * scanner can know. It is treated as one that may delete: asked every time and
 * never remembered, where its first word as an "always" rule would have let any
 * later computed program through.
 */
function computedProgram(tokens: string[], powershell: boolean): boolean {
  const first = tokens[0] ?? ""
  // PowerShell reads a leading variable as a value, not a program: only its call operators run one.
  if (powershell) return (first === "&" || first === ".") && /^[$(]/.test(tokens[1] ?? "")
  return /^\$|^"\$|`/.test(first)
}

/**
 * Interpreters whose inline code is itself a command line, so it can be read as
 * one. `node -e` and `python -c` are not here: their code is not shell, and
 * reading it as shell would name programs nobody runs. Neither is on the
 * read-only allowlist, so they are asked about as ordinary commands anyway.
 */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "fish", "pwsh", "powershell", "cmd"])

/** How far one line's `bash -c "bash -c ..."` is followed. */
const NEST_LIMIT = 4

/** The shell's reserved words that can stand in front of a command without being it. */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"])

/**
 * A wrapper's flags that take the next word as their value.
 *
 * Without this `sudo -u bob rm -rf src` skipped `-u` and took `bob` for the
 * program, so the line named `bob` and showed no delete (R28-2). Only flags
 * whose value is a separate word are listed; `--user=bob` carries its own.
 */
const WRAPPER_VALUE_FLAGS = new Map<string, Set<string>>([
  ["sudo", new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--other-user", "--close-from", "--command-timeout"])],
  ["doas", new Set(["-u", "-C"])],
  ["env", new Set(["-u", "-C", "--unset", "--chdir"])],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"])],
  ["xargs", new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--delimiter", "--eof", "--arg-file"])],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["exec", new Set(["-a"])],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
])

/** Leading words of a wrapper's arguments that are not the program it runs. */
function programAfterWrapper(tokens: string[]): string[] {
  const takesValue = WRAPPER_VALUE_FLAGS.get(programName(tokens[0] ?? ""))
  let at = 1
  while (at < tokens.length) {
    const token = tokens[at] ?? ""
    if (takesValue?.has(token)) {
      at += 2
      continue
    }
    // A flag, a flag's count or duration, an `env` assignment, or xargs' `-I` placeholder.
    if (/^-/.test(token) || /^\d+(?:\.\d+)?[smhd]?$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "{}") at++
    else break
  }
  return tokens.slice(at)
}

/**
 * The commands `find` runs for each file it finds: whatever follows `-exec`,
 * `-execdir`, `-ok` or `-okdir`, up to the `;` or `+` that ends it.
 * `find . -name "*.log" -exec rm {} +` named `find` and showed no delete
 * (R28-2).
 */
function findActions(tokens: string[]): string[][] {
  const out: string[][] = []
  for (let at = 1; at < tokens.length; at++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(tokens[at] ?? "")) continue
    const action: string[] = []
    for (at++; at < tokens.length; at++) {
      const token = tokens[at] ?? ""
      if (token === "+" || token === "\\;" || token === "';'" || token === '";"' || token === "\\") break
      action.push(token)
    }
    if (action.length) out.push(action)
  }
  return out
}

/**
 * The body an interpreter was handed inline.
 *
 * Short flags cluster, and R25's reading of them was wrong in both directions
 * (R26-E2): `bash -lc "rm -rf src"` and `sh -xc "..."` matched nothing at all
 * and were never looked inside, while `powershell -ep bypass -Command "..."`
 * matched `-ep` and answered "p" - so the real script, sitting behind
 * `-Command`, was never read. A cluster is now read as the set of letters it
 * is: if it carries the code letter, the body is whatever follows in the same
 * token, or the next token when nothing does.
 */
function inlineBody(tokens: string[], posh: boolean): string | undefined {
  for (let at = 1; at < tokens.length; at++) {
    const token = tokens[at] ?? ""
    /*
     * PowerShell does not cluster its parameters, it abbreviates them, so the
     * cluster reading below is wrong for it: `-ep bypass` is
     * -ExecutionPolicy, and reading it as "a cluster carrying e and p" answered
     * "bypass" and never reached the -Command that held the script.
     */
    if (posh) {
      /*
       * -EncodedCommand carries the script as base64 UTF-16LE, which is how a
       * line that deletes gets past a reader that only looks at words. It is
       * decoded here so the command inside is read like any other; a body that
       * will not decode is left alone rather than guessed at.
       */
      if (/^(?:--?|\/)(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i.test(token)) {
        const encoded = unquote(tokens[at + 1] ?? "")
        if (!encoded) return undefined
        try {
          const decoded = Buffer.from(encoded, "base64").toString("utf16le")
          return /�/.test(decoded) ? undefined : decoded.trim() || undefined
        } catch {
          return undefined
        }
      }
      // `-Command`, and as pwsh also takes it, `--command` and `/command`; pwsh 7.4's `-CommandWithArgs` too.
      if (/^(?:--?|\/)(?:c|co|com|comm|comma|comman|command|cwa|commandwithargs)$/i.test(token)) return unquote(tokens[at + 1] ?? "") || undefined
      continue
    }
    // cmd's own two: /c runs and ends, /k runs and stays.
    if (/^\/[ck]$/i.test(token)) return unquote(tokens[at + 1] ?? "") || undefined
    /*
     * Only a shell reaches here, and a shell's code flag is `c` alone. This
     * used to share the interpreters' table, where `-e` and `-p` are node's
     * and perl's code flags - but to bash they are errexit and privileged
     * mode, so `sh -e -c "rm -rf src"`, the form scripts write most, answered
     * "-c" as the code, read nothing behind it, and deleted with no question
     * asked (R28-1).
     */
    // A cluster of short flags: `-c`, `-lc`, `-ec`. Long options are not clusters.
    const cluster = /^-([A-Za-z]+)(.*)$/.exec(token)
    if (!cluster || token.startsWith("--")) continue
    const letters = cluster[1] ?? ""
    const rest = cluster[2] ?? ""
    if (!letters.includes("c")) continue
    if (rest) return unquote(rest) || undefined
    return unquote(tokens[at + 1] ?? "") || undefined
  }
  return undefined
}

/**
 * What a simple command runs that is not the simple command itself.
 *
 * Every guard on this path - the delete question that is asked every time and
 * never remembered, the refusal to write into the app's own data folder, the
 * question about files outside the project - reads the first word of each
 * simple command. So `rm -rf src` raised the red card and `bash -c "rm -rf
 * src"` raised nothing at all, deleting the tree at full access or under any
 * "always" that covered the outer line (R25-B2).
 */
function runsWithin(entry: SimpleCommand, powershell: boolean, depth: number): SimpleCommand[] {
  if (depth >= NEST_LIMIT) return []
  const head = programName((entry.tokens[0] ?? "").replace(ANY_QUOTE, ""))
  if (head === "find") {
    return findActions(entry.tokens).flatMap((tokens) => {
      const action: SimpleCommand = { tokens, source: tokens.join(" "), redirects: [], derived: true, powershell: entry.powershell ?? powershell }
      return [action, ...runsWithin(action, powershell, depth + 1)]
    })
  }
  // `env -S "rm -rf src"` splits its string into the command it runs, as eval does.
  if (head === "env") {
    const split = entry.tokens.findIndex((token) => token === "-S" || token === "--split-string" || token.startsWith("--split-string="))
    if (split > 0) {
      const token = entry.tokens[split]!
      const body = unquote(token.includes("=") ? token.slice(token.indexOf("=") + 1) : (entry.tokens[split + 1] ?? "")).trim()
      if (body) return scanCommands(body, powershell, depth + 1).map((found) => ({ ...found, derived: true }))
    }
  }
  /*
   * `command -v rm` asks where rm is; it does not run it. Read as a wrapper it
   * produced `rm` as a program of its own and the harmless lookup raised the
   * delete card - the "one question too many" every careful reader of the
   * prompt writes at least once (round 25 recorded it, round 78 fixed it).
   * `-v` and `-V` are the whole of what `command` does without running the
   * word that follows (`-p` only changes the PATH it searches), so a line
   * whose `command` carries either returns nothing.
   */
  if (head === "command" && entry.tokens.slice(1).some((token) => /^-[pPvV]+$/.test(token) && /[vV]/.test(token))) return []
  if (WRAPPERS.has(head)) {
    const inner = programAfterWrapper(entry.tokens)
    if (!inner.length) return []
    /*
     * And then what *that* runs. R25 stopped at one hop: the wrapper's program
     * was produced as a command of its own and never looked inside again, so
     * `env bash -c "rm -rf src"` - wrapper around interpreter - showed no
     * delete at all, and at full access the tree went with no question asked.
     * The bash tool's forced delete question is decided by this list alone;
     * there is no second guard behind it (R26-E1).
     */
    const program: SimpleCommand = { tokens: inner, source: inner.join(" "), redirects: [], derived: true, powershell: entry.powershell ?? powershell }
    return [program, ...runsWithin(program, powershell, depth + 1)]
  }
  if (EVAL_WORDS.has(head)) {
    // `Invoke-Expression -Command '...'` names its script's parameter: the script is what follows it.
    const words = entry.tokens.slice(1)
    if (powershell && /^-(?:c|co|com|comm|comma|comman|command)$/i.test(words[0] ?? "")) words.shift()
    const body = words.map(unquote).join(" ").trim()
    if (!body) return []
    return scanCommands(body, powershell, depth + 1).map((found) => ({ ...found, derived: true }))
  }
  if (!SHELL_INTERPRETERS.has(head)) return []
  const asPowershell = head === "pwsh" || head === "powershell"
  const body = inlineBody(entry.tokens, asPowershell)
  if (!body) return []
  return scanCommands(body, asPowershell, depth + 1).map((found) => ({ ...found, derived: true }))
}

/** The simple commands a command line runs, substitutions included, in order. */
export function simpleCommands(command: string, powershell: boolean): SimpleCommand[] {
  return scanCommands(command, powershell, 0)
}

function scanCommands(command: string, powershell: boolean, depth: number): SimpleCommand[] {
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
    /*
     * `then rm -rf src` runs rm: the shell's own words in front of a command
     * are not the command. Read as the program, `if true; then rm -rf src; fi`
     * named a program called `then` and showed no delete (R28-2).
     */
    if (!powershell) while (tokens.length && SHELL_KEYWORDS.has(tokens[0]!)) tokens.shift()
    /*
     * PowerShell runs what follows an assignment: `$x = Remove-Item src`, or
     * `[string]$x=Remove-Item src`, deletes. Read as a command named `$x`
     * it showed no delete (OpenCode v2's adversarial tests).
     */
    if (powershell) {
      // `& 'Remove-Item' src` runs Remove-Item; `& $x` stays as it is, for `computedProgram`.
      if ((tokens[0] === "&" || tokens[0] === ".") && tokens.length > 1 && !/^[$(]/.test(tokens[1]!)) tokens = tokens.slice(1)
      // A bare `&` or `.` in front of a script block runs the block, whose commands are read on their own.
      else if ((tokens[0] === "&" || tokens[0] === ".") && tokens.length === 1) tokens = []
      const variable = /^(?:\[[^\]]*\])*\$[\w:{}?]+$/
      if (variable.test(tokens[0] ?? "") && /^[-+*/%?]?\?*=$/.test(tokens[1] ?? "")) tokens = tokens.slice(2)
      else {
        const joined = /^((?:\[[^\]]*\])*\$[\w:{}?]+)[-+*/%]?=(.+)$/.exec(tokens[0] ?? "")
        if (joined) tokens = [joined[2]!, ...tokens.slice(1)]
      }
    }
    // `FOO=1 git status` runs git; assignments in front are not the command, and a line of only them runs nothing.
    const first = powershell ? 0 : tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
    const words = first === -1 ? [] : tokens.slice(first)
    // What the dialog shows and a rule is matched against starts where the command does, too.
    const source = command.slice(start, end).trim()
    const shown = powershell ? source : source.replace(/^(?:(?:if|then|else|elif|do|while|until|!)\s+)+/, "")
    if (words.length) out.push({ tokens: words, source: shown, redirects, powershell })
    tokens = []
    redirects = []
    start = -1
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (start === -1 && !/\s/.test(ch) && !";&|\n".includes(ch)) start = i
    // PowerShell's block comment, `<# ... #>`: not a redirection from a file named `#`.
    if (powershell && ch === "<" && command[i + 1] === "#") {
      const close = command.indexOf("#>", i + 2)
      i = (close === -1 ? command.length : close + 2) - 1
      continue
    }
    if (ch === "#" && !inWord) {
      const newline = command.indexOf("\n", i)
      i = (newline === -1 ? command.length : newline) - 1
      continue
    }
    if (ch === "'" || (powershell && POSH_SINGLE.has(ch))) {
      let close = i + 1
      while (close < command.length && !(powershell ? POSH_SINGLE.has(command[close]!) : command[close] === "'")) close++
      const end = close >= command.length ? command.length - 1 : close
      word += command.slice(i, end + 1)
      inWord = true
      i = end
      continue
    }
    if (ch === '"' || (powershell && POSH_DOUBLE.has(ch))) {
      let j = i + 1
      while (j < command.length && !(powershell ? POSH_DOUBLE.has(command[j]!) : command[j] === '"')) {
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
      // A backtick before the line's end continues the line: it is a space between words, not part of one.
      if (powershell && (command[i + 1] === "\n" || command[i + 1] === "\r")) {
        endWord()
        i += command[i + 1] === "\r" && command[i + 2] === "\n" ? 2 : 1
        continue
      }
      if (powershell) {
        // An escape in a bare word is the character itself: `Remove-`Item` runs Remove-Item.
        word += command[i + 1] ?? ""
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
    // PowerShell's `&` in front of a command is its call operator, not a separator; at a command's end it backgrounds it.
    if (powershell && ch === "&" && command[i + 1] !== "&" && tokens.length === 0 && !inWord) {
      word = "&"
      inWord = true
      endWord()
      /*
       * `& (Get-Command Remove-Item) src` runs whatever the parentheses work
       * out to. Ended at the `(` like any group, the call lost its operator and
       * read as nothing computed: the group stays one word after the `&`, and
       * what is inside it is read too.
       */
      let k = i + 1
      while (command[k] === " " || command[k] === "\t") k++
      if (command[k] === "(") {
        const close = closing(command, k)
        nested.push(command.slice(k + 1, close))
        word = command.slice(k, close + 1)
        inWord = true
        i = close
      }
      continue
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      endCommand(i)
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++
      continue
    }
    /*
     * `f(){ rm -rf src; }; f` defines a function and runs it. The name and its
     * `()` were read as one word, `f(){`, so the body's `rm` was that word's
     * argument and showed no delete (OpenCode v2's adversarial tests). A name
     * followed by `()` ends there, and the body is read as commands.
     */
    if (!powershell && ch === "(" && inWord && command[i + 1] === ")" && /^[A-Za-z_][\w.:-]*$/.test(word)) {
      endCommand(i)
      i++
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
  for (const body of nested) out.push(...scanCommands(body, powershell, depth + 1))
  const found = out.filter((entry) => entry.tokens.length > 0)
  if (depth >= NEST_LIMIT) return found
  return [...found, ...found.flatMap((entry) => runsWithin(entry, powershell, depth))]
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
  /*
   * A wrapper keeps what it wraps, for the same reason an interpreter keeps its
   * script. `env` has an arity of one, so one "always" for
   * `env bash -c "npm test"` saved `env *` - which every later `env <anything>`
   * matches. The wrapper is not the program; the rule has to name the program.
   */
  if (WRAPPERS.has(programName(tokens[0] ?? ""))) {
    const inner = programAfterWrapper(tokens)
    if (!inner.length) return `${tokens[0]} *`
    const within = rememberedPattern(inner, inner.join(" "))
    if (!within) return undefined
    return `${tokens.slice(0, tokens.length - inner.length).join(" ")} ${within}`.trim()
  }
  const prefix = arityPrefix(tokens)
  /*
   * An interpreter keeps its script as well as its name, whatever the arity
   * table says. The narrowing used to fire only for a command the table does
   * not list, so `python`, whose arity is 2, took the generic branch and one
   * "always" for `python -m pytest -q` saved `python -m *` - the second word
   * there is a flag, not a target, so every later `python -m pip install
   * <anything>` ran unasked (R25-B6). The first word that is not a flag is what
   * the rule should name.
   */
  if (INTERPRETERS.has(programName(tokens[0] ?? "")) && tokens[1]) {
    const named = tokens.slice(prefix.length).find((token) => !token.startsWith("-"))
    return `${(named ? [...prefix, named] : prefix).join(" ")} *`
  }
  return `${prefix.join(" ")} *`
}

/*
 * The program a line runs, as every table here names it.
 *
 * The first word as written was compared directly, so `/bin/rm -rf src`,
 * `\rm -rf src` (bash's way past an alias) and `"rm" -rf src` each named a
 * program called something other than `rm` - and showed no delete at all
 * (R28-2). The shell strips the quotes and follows the path; so does this.
 */
function headOf(tokens: string[], powershell: boolean): string | undefined {
  const first = tokens[0]
  if (first === undefined) return undefined
  const word = (first.replace(ANY_QUOTE, "").split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "")
  if (!word) return undefined
  return powershell ? word.toLowerCase() : word
}

export function isDelete(tokens: string[], powershell: boolean): boolean {
  const head = headOf(tokens, powershell)
  if (!head) return false
  if (DELETE_COMMANDS.has(head)) return true
  // A program computed when the line runs may be any program, a delete among them.
  if (computedProgram(tokens, powershell)) return true
  // `find . -delete` removes every file it matches.
  if (head === "find") return tokens.includes("-delete")
  if (head !== "git" || tokens.length < 2) return false
  const flags = GIT_DESTRUCTIVE.get(tokens[1])
  if (!flags) return false
  return flags.size === 0 || tokens.slice(2).some((token) => flags.has(token))
}

/** Commands whose first ordinary argument is what to look for, not where to look. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "findstr"])

function pathArgs(tokens: string[], powershell: boolean): string[] {
  if (!powershell) {
    /*
     * A flag's value is not a file, and a pattern is not a file.
     *
     * Every non-flag token used to be read as a path, so `head -c 9999 notes`
     * named a file called 9999 and `grep "/etc/passwd" notes.txt` raised an
     * "access files outside the project → C:\etc" card for a path the command
     * never opens (R25-B7). A card that describes something other than what
     * will happen teaches the reader to wave cards through, and an "always"
     * given on one is stored against a pattern that means nothing.
     */
    const out: string[] = []
    let afterShortFlag = false
    /*
     * The pattern slot is only open when the pattern was not supplied by a
     * flag. R25 missed that, and it reopened the hole R25 had just closed:
     * `grep -e x <appdata>/credentials.json` had `x` eaten as the flag's value
     * and then the credentials path eaten as "the pattern", so `scan.files`
     * came back empty, `guardAppData` never ran, and grep - being on the
     * read-only allowlist - printed the saved sign-ins with nothing asked
     * (R26-E-II). Reading a path as a pattern is the dangerous direction; the
     * other way costs a question nobody needed.
     */
    const patternFromFlag = tokens.some((token) => /^-e$/.test(token) || /^--regexp=/.test(token) || /^-[A-Za-z]*e$/.test(token))
    let wantsPattern = PATTERN_FIRST.has(tokens[0] ?? "") && !patternFromFlag
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-") && !(tokens[0] === "chmod" && token.startsWith("+"))) {
        // Only a short flag takes its value as the next word; `--include=x` carries its own.
        afterShortFlag = token.length === 2
        continue
      }
      /*
       * A count or a placeholder, never a path - `head -c 9999 notes` names no
       * file called 9999. Anything else after a flag is pushed, because a
       * one-character file name is a real file and dropping it is how a path
       * stops being checked.
       */
      if (afterShortFlag && (/^\d+$/.test(token) || token === "{}")) {
        afterShortFlag = false
        continue
      }
      afterShortFlag = false
      if (wantsPattern) {
        wantsPattern = false
        continue
      }
      out.push(token)
    }
    return out
  }
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
  // PowerShell's typographic quotes, any of a kind closing any other. In bash they are letters, and reading them as quotes there only asks more.
  if (text.length >= 2 && ((POSH_SINGLE.has(text[0]!) && POSH_SINGLE.has(text[text.length - 1]!)) || (POSH_DOUBLE.has(text[0]!) && POSH_DOUBLE.has(text[text.length - 1]!)))) return text.slice(1, -1)
  return text
}

/** Every quote character, straight or typographic, taken out of a word to find the program it names. */
const ANY_QUOTE = /["'‘’‚‛“”„]/g

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
  const name = (raw: string, posh: boolean) => {
    const resolved = argPath(raw, effective, posh)
    if (resolved) written.push(resolved)
  }
  const moveTo = (tokens: string[], posh: boolean) => {
    const raw = pathArgs(tokens, posh)[0]
    // A literal location can include spaces, a drive spelling or a known
    // PowerShell environment variable, just like a write's own path. A glob
    // does not identify a single location before the command runs.
    if (!raw || /[?*[]/.test(raw)) return
    const resolved = argPath(raw, effective, posh)
    if (resolved) effective = resolved
  }
  for (const { tokens, redirects, powershell: own } of simpleCommands(command, powershell)) {
    // Each command by its own shell's rules: see SimpleCommand.powershell.
    const posh = own ?? powershell
    const head = headOf(tokens, posh)
    if (!head) continue
    if (head === "cd" || head === "set-location") {
      moveTo(tokens, posh)
      continue
    }
    if (head === "pushd" || head === "push-location") {
      stack.push(effective)
      moveTo(tokens, posh)
      continue
    }
    if (head === "popd" || head === "pop-location") {
      effective = stack.pop() ?? path.resolve(cwd)
      continue
    }
    for (const target of redirects) name(target, posh)
    if (WRITE_COMMANDS.has(head) || isSedInPlace(tokens, posh)) {
      const args = tokens.slice(1).filter((token) => !token.startsWith("-"))
      for (const arg of COPY_DEST_ONLY.has(head) ? args.slice(-1) : args) name(arg, posh)
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
  for (const { tokens, source, derived, powershell: own } of simpleCommands(command, powershell)) {
    // Each command by its own shell's rules: see SimpleCommand.powershell.
    const posh = own ?? powershell
    const head = headOf(tokens, posh)
    if (head && FILES.has(head)) {
      for (const arg of pathArgs(tokens, posh)) {
        const resolved = argPath(arg, cwd, posh)
        if (resolved) files.add(resolved)
        if (!resolved || inside(project, resolved)) continue
        const isDir = await fs.stat(resolved).then((stat) => stat.isDirectory(), () => false)
        dirs.add(isDir ? resolved : path.dirname(resolved))
      }
    }
    if (!head || !CWD.has(head)) {
      patterns.add(source)
      // Never from a command read out of another one: see SimpleCommand.derived.
      const remembered = derived ? undefined : rememberedPattern(tokens, source)
      if (remembered) always.add(remembered)
    }
    if (isDelete(tokens, posh)) {
      deletes.add(source)
      const args = head && DELETE_COMMANDS.has(head) ? pathArgs(tokens, posh) : []
      if (args.length === 0) tempOnly = false
      for (const arg of args) {
        const resolved = argPath(arg, cwd, posh)
        if (!resolved || !insideTemp(resolved) || inside(project, resolved)) tempOnly = false
      }
    }
  }
  return { patterns: [...patterns], always: [...always], deletes: [...deletes], tempOnlyDeletes: deletes.size > 0 && tempOnly, dirs: [...dirs], files: [...files] }
}
