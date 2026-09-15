import fs from "node:fs/promises"
import path from "node:path"

/**
 * Which files a search walks past, the way ripgrep decides it for MiMo's glob
 * and grep: hidden files are searched, `.git` never is, and ignore files are
 * honoured - `.gitignore` (and `.git/info/exclude`) only inside a repository,
 * `.ignore` and `.rgignore` anywhere.
 *
 * A rule is one line of an ignore file. Last match wins, a `!` line brings a
 * path back, and a directory that is ignored is not entered at all - so, as in
 * git, nothing inside it can be brought back by a later rule.
 */

export interface IgnoreRule {
  regex: RegExp
  negate: boolean
  dirOnly: boolean
  /** A rule with a slash before its end is matched against the whole path below `base`; otherwise against the name. */
  anchored: boolean
  /** The folder the rule was read in, with forward slashes. */
  base: string
}

const posix = (value: string) => value.split(path.sep).join("/")

/**
 * A glob, as ignore files and ripgrep's `--glob` spell one, turned into a
 * regex over a forward-slash path: `*` stays inside a segment, `**` crosses
 * them, `?` is one character, `[...]` a class and `{a,b}` alternatives.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "\\" && i + 1 < pattern.length) {
      i++
      out += pattern[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    } else if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** spans directory separators; **/ also matches zero directories.
        i++
        if (pattern[i + 1] === "/") {
          i++
          out += "(?:.*/)?"
        } else {
          out += ".*"
        }
      } else {
        out += "[^/]*"
      }
    } else if (char === "?") out += "[^/]"
    else if (char === "[") {
      const close = pattern.indexOf("]", i + 2)
      if (close === -1) out += "\\["
      else {
        const body = pattern.slice(i + 1, close)
        const negated = body.startsWith("!") || body.startsWith("^")
        const members = (negated ? body.slice(1) : body).replace(/\\/g, "\\\\").replace(/\]/g, "\\]")
        out += `[${negated ? "^" : ""}${members}]`
        i = close
      }
    } else if (char === "{") {
      const close = pattern.indexOf("}", i)
      if (close === -1) out += "\\{"
      else {
        const options = pattern.slice(i + 1, close).split(",")
        out += `(?:${options.map((option) => globToRegExp(option).source.slice(1, -1)).join("|")})`
        i = close
      }
    } else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

/** One glob line as a rule read in `base`; undefined for a blank line or a comment. */
export function compileRule(line: string, base: string): IgnoreRule | undefined {
  // Trailing spaces are dropped unless escaped; a leading "\#" or "\!" is literal.
  let text = line.replace(/(?<!\\)\s+$/, "")
  if (!text || text.startsWith("#")) return undefined
  let negate = false
  if (text.startsWith("!")) {
    negate = true
    text = text.slice(1)
  } else if (text.startsWith("\\!") || text.startsWith("\\#")) text = text.slice(1)
  let dirOnly = false
  if (text.endsWith("/")) {
    dirOnly = true
    text = text.replace(/\/+$/, "")
  }
  if (!text) return undefined
  const anchored = text.includes("/")
  if (text.startsWith("/")) text = text.slice(1)
  return { regex: globToRegExp(text), negate, dirOnly, anchored, base: posix(base) }
}

/** Whether `target` is matched by `rule`, which only speaks for paths below its own folder. */
export function ruleMatches(rule: IgnoreRule, target: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false
  const rel = path.posix.relative(rule.base, posix(target))
  if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) return false
  return rule.regex.test(rule.anchored ? rel : rel.slice(rel.lastIndexOf("/") + 1))
}

/** Whether the rules, read in order, leave `target` ignored. */
export function isIgnored(rules: readonly IgnoreRule[], target: string, isDir: boolean): boolean {
  let ignored = false
  for (const rule of rules) if (ruleMatches(rule, target, isDir)) ignored = !rule.negate
  return ignored
}

async function rulesFrom(file: string, base: string): Promise<IgnoreRule[]> {
  const text = await fs.readFile(file, "utf8").catch(() => "")
  return text.split(/\r?\n/).flatMap((line) => compileRule(line, base) ?? [])
}

/** The ignore files one folder holds, in ripgrep's order of precedence: later wins. */
async function rulesIn(dir: string, inRepo: boolean): Promise<IgnoreRule[]> {
  const files = [...(inRepo ? [".gitignore"] : []), ".ignore", ".rgignore"]
  return (await Promise.all(files.map((name) => rulesFrom(path.join(dir, name), dir)))).flat()
}

/** The folder holding `.git` at or above `start`, if there is one. */
async function repositoryOf(start: string): Promise<string | undefined> {
  let current = path.resolve(start)
  for (;;) {
    if (await fs.stat(path.join(current, ".git")).then(() => true, () => false)) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Every file under `root` a search should look at, in walk order.
 *
 * `onFile` may return true to stop the walk early. Links are not followed,
 * as ripgrep does not follow them by default.
 */
export async function walkFiles(
  root: string,
  onFile: (absolute: string) => boolean | void | Promise<boolean | void>,
  signal: AbortSignal,
): Promise<void> {
  const repo = await repositoryOf(root)
  const inherited: IgnoreRule[] = []
  if (repo) {
    inherited.push(...(await rulesFrom(path.join(repo, ".git", "info", "exclude"), repo)))
    // Ignore files in the folders between the repository and the search root apply as well.
    const between: string[] = []
    for (let dir = path.dirname(path.resolve(root)); dir.length >= repo.length && dir.startsWith(repo); dir = path.dirname(dir)) {
      between.unshift(dir)
      if (dir === repo) break
    }
    for (const dir of between) inherited.push(...(await rulesIn(dir, true)))
  }

  const queue: { dir: string; rules: IgnoreRule[] }[] = [{ dir: path.resolve(root), rules: inherited }]
  while (queue.length) {
    if (signal.aborted) return
    const { dir, rules: parentRules } = queue.shift()!
    const rules = [...parentRules, ...(await rulesIn(dir, repo !== undefined))]
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === ".git") continue
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!isIgnored(rules, absolute, true)) queue.push({ dir: absolute, rules })
      } else if (entry.isFile()) {
        if (isIgnored(rules, absolute, false)) continue
        if (await onFile(absolute)) return
      }
    }
  }
}

/**
 * A `--glob` pattern as ripgrep applies it to files under the search root: one
 * with a slash is matched against the path from the root, one without against
 * the file's name at any depth - so `*.ts` finds `src/deep/x.ts`.
 */
export function globMatcher(pattern: string): (relative: string) => boolean {
  const rule = compileRule(pattern, "/")
  if (!rule) return () => false
  return (relative) => {
    const rel = relative.split("\\").join("/")
    const hit = rule.regex.test(rule.anchored ? rel : rel.slice(rel.lastIndexOf("/") + 1))
    return rule.negate ? !hit : hit
  }
}
