/**
 * The grammar of a slash command: what its placeholders are, and what a line
 * typed after the slash turns them into.
 *
 * Both halves are transcriptions of the reference's own code rather than
 * re-derivations, and they live in `shared` because the two ends of this app
 * need different halves: the server derives `hints` while building the command
 * list (node-BBwF64dM.js @32867267), and the composer expands the template
 * when the line is sent, which the reference does in `SessionPrompt.command`
 * (@32957943). The reference can keep both server-side because a slash line
 * there goes back to the server as `session.command`; this app has no such
 * request, so the expansion happens in the window and the same rules have to
 * be reachable from both.
 */

/**
 * How a typed argument line is cut into words.
 *
 * Verbatim the reference's `argsRegex` (@32957950): a quoted run is one word,
 * `[Image 1]` is one word, and anything else breaks on whitespace.
 */
const ARGUMENT_WORDS = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi

/** Its `quoteTrimRegex`: the quotes that made a word are not part of it. */
const SURROUNDING_QUOTES = /^["']|["']$/g

/** Its `placeholderRegex`. */
const PLACEHOLDER = /\$(\d+)/g

/**
 * The placeholders a template uses, in the order to fill them.
 *
 * Verbatim the reference's `hints` (@32867267), including the plain
 * lexicographic `sort()`: `$10` therefore sorts before `$2`, which is a quirk
 * of its implementation rather than an intention, and it is copied because
 * this list is shown to the user and a different order would be a different
 * hint. `$ARGUMENTS` is appended last when the template mentions it at all.
 */
export function hints(template: string): string[] {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

/**
 * The words typed after the command name, as the reference cuts them.
 *
 * Quotes group and are then stripped, so `deploy "west coast" now` is three
 * arguments and the first keeps its space.
 */
export function commandWords(argumentLine: string): string[] {
  const raw = argumentLine.match(ARGUMENT_WORDS) ?? []
  return raw.map((word) => word.replace(SURROUNDING_QUOTES, ""))
}

/**
 * The prompt a command actually sends.
 *
 * Transcribed from `SessionPrompt.command` (@32957943), and every rule in it
 * is load-bearing:
 *
 * - `$1`, `$2` … take one word each, except the HIGHEST-numbered placeholder
 *   in the template, which takes that word and every word after it. That is
 *   what lets `/deploy $1 $2` put a whole sentence in `$2`.
 * - a placeholder with no word behind it becomes the empty string, not the
 *   literal `$3`.
 * - `$ARGUMENTS` is replaced with the line exactly as it was typed, quotes and
 *   all, after the numbered substitutions have run.
 * - a template that names no placeholder at all still gets the words: they are
 *   appended after a blank line. Without this rule a command with a fixed
 *   prompt would silently swallow whatever was typed beside it.
 *
 * This is only the argument half. A project or global command's ``!`cmd` ``
 * placeholders are then run by the backend (`expandCommand` in
 * server/command.ts), because the user decided on 2026-09-15 that command
 * templates run shell commands as MiMo's do: on invocation only, in the
 * configured shell, in the conversation's folder, after these substitutions.
 */
export function expandTemplate(template: string, argumentLine: string): string {
  const words = commandWords(argumentLine)
  const placeholders = template.match(PLACEHOLDER) ?? []
  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }
  const withWords = template.replaceAll(PLACEHOLDER, (_match, index: string) => {
    const position = Number(index)
    const at = position - 1
    if (at >= words.length) return ""
    if (position === last) return words.slice(at).join(" ")
    return words[at]
  })
  const usesArguments = template.includes("$ARGUMENTS")
  const expanded = withWords.replaceAll("$ARGUMENTS", argumentLine)
  if (placeholders.length === 0 && !usesArguments && argumentLine.trim()) {
    return expanded + "\n\n" + argumentLine
  }
  return expanded
}

/**
 * Splits a draft that begins with a slash into a name and the rest.
 *
 * The reference's own split, on the plain space and nothing cleverer
 * (main-8t-QUXax.js @4461049): `const [cmdName, ...args] = text.split(" ")`.
 * A draft that does not start with a slash is not a command line at all.
 */
export function splitCommandLine(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith("/")) return undefined
  const [first, ...rest] = text.split(" ")
  return { name: first.slice(1), args: rest.join(" ") }
}

/** MiMo's shell placeholder: everything between ``!` `` and the next backtick is one command. */
const SHELL_PLACEHOLDER = /!`([^`]+)`/g

/** The commands a filled-in template asks to run, in order, repeats included. */
export function shellPlaceholders(template: string): string[] {
  return [...template.matchAll(SHELL_PLACEHOLDER)].map((match) => match[1]!)
}

/**
 * Each placeholder replaced by its command's output, in order.
 *
 * A replacer function rather than a string, so a `$&` or `$1` in the output is
 * text and not a back-reference.
 */
export function substituteShell(template: string, outputs: readonly string[]): string {
  let at = 0
  return template.replace(SHELL_PLACEHOLDER, () => outputs[at++] ?? "")
}

/**
 * MiMo's file reference: `@` not preceded by a word character or a backtick,
 * then a path whose dots only count between other characters - so an email
 * address is not a file and a sentence's closing full stop is not part of one.
 */
const FILE_REFERENCE = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

/** The paths a template names with `@`, once each, in the order written. */
export function fileReferences(template: string): string[] {
  const out: string[] = []
  for (const match of template.matchAll(FILE_REFERENCE)) {
    const name = match[1]!
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * MiMo's built-in model tiers. With no `model_groups` configured - and this app
 * has no such setting - MiMo resolves each of them to the default model; any
 * other bare name is a group it cannot find.
 */
export const MODEL_TIERS = ["ultra", "standard", "lite"] as const
