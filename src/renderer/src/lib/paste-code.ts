/**
 * Pasted code goes into the box wrapped in a fence of its language.
 *
 * MiMo's rule, with MCode's own patterns: no fence already in the text, at
 * least five non-empty lines, and either JSON that parses or a language whose
 * line patterns match at least three of those lines.
 */

export const MIN_CODE_LINES = 5
export const MIN_LANGUAGE_HITS = 3

/* Line shapes that are telling for each language. Order breaks a tie: TypeScript before JavaScript. */
const PATTERNS: [string, RegExp[]][] = [
  [
    "python",
    [
      /^\s*def \w+\(.*\)\s*(->.*)?:\s*$/,
      /^\s*(from [\w.]+ )?import \w+/,
      /^\s*class \w+(\(.*\))?:\s*$/,
      /^\s*(if|elif|while|for|with|try|except)\b.*:\s*$/,
      /^\s*@\w+/,
      /\bself\./,
      /^\s*print\(/,
    ],
  ],
  [
    "ts",
    [
      /^\s*(export\s+)?(interface|type|enum)\s+\w+/,
      /:\s*(string|number|boolean|void|unknown|never|Promise<|Record<)/,
      /^\s*(export\s+)?(const|let)\s+\w+\s*:\s*[\w<[]/,
      /\bas const\b/,
      /^\s*(public|private|protected|readonly)\s+\w+/,
      /^\s*import type\b/,
    ],
  ],
  [
    "js",
    [
      /^\s*(const|let|var)\s+\w+\s*=/,
      /^\s*(async\s+)?function\s*\w*\s*\(/,
      /=>\s*[{(]?\s*$|=>\s*\S/,
      /^\s*(module\.exports|exports\.\w+)\s*=/,
      /\brequire\(["']/,
      /\bconsole\.\w+\(/,
      /^\s*import .+ from ["']/,
      /^\s*export (default|const|function|class)\b/,
    ],
  ],
  [
    "java",
    [
      /^\s*(public|private|protected)\s+(static\s+)?(final\s+)?[\w<>[\]]+\s+\w+\s*\(/,
      /^\s*package\s+[\w.]+;\s*$/,
      /^\s*import\s+[\w.]+(\.\*)?;\s*$/,
      /\bSystem\.out\.print/,
      /^\s*@Override\b/,
      /^\s*(public\s+)?(final\s+)?class\s+\w+/,
    ],
  ],
  [
    "go",
    [/^\s*package \w+\s*$/, /^\s*func (\(\w+ \*?\w+\) )?\w+\(/, /\w+\s*:=\s*/, /^\s*import \($/, /\bfmt\.\w+\(/, /^\s*if err != nil\b/],
  ],
  [
    "rust",
    [
      /^\s*(pub\s+)?fn \w+/,
      /^\s*let (mut )?\w+/,
      /^\s*use [\w:]+/,
      /^\s*impl\b/,
      /\bprintln!\(/,
      /^\s*(pub\s+)?(struct|enum|trait|mod) \w+/,
      /&mut\b|->\s*Result</,
    ],
  ],
  [
    "cpp",
    [
      /^\s*#include\s*[<"]/,
      /\bstd::/,
      /^\s*(int|void|auto|bool|char|double|float)\s+\w+\s*\(.*\)\s*\{?\s*$/,
      /^\s*(class|struct|namespace)\s+\w+/,
      /\bcout\s*<</,
      /^\s*#(define|ifndef|endif|pragma)\b/,
    ],
  ],
  [
    "bash",
    [
      /^#!.*\b(ba|z)?sh\b/,
      /^\s*(echo|export|cd|sudo|apt|apt-get|brew|npm|pnpm|yarn|git|curl|wget|chmod|mkdir|rm|cp|mv)\s/,
      /\$\{?\w+\}?/,
      /^\s*(then|fi|elif|else|do|done|esac)\b/,
      /\|\s*(grep|awk|sed|xargs|sort|head|tail)\b/,
    ],
  ],
  [
    "html",
    [/^\s*<!DOCTYPE html>/i, /^\s*<\/?(html|head|body|div|span|p|a|ul|ol|li|script|style|section|meta|link|button|form)\b/i, /<\/\w+>\s*$/],
  ],
  [
    "css",
    [/^\s*[.#]?[\w-]+(\s*[,>+~]?\s*[.#:]?[\w-]+)*\s*\{\s*$/, /^\s*[\w-]+\s*:\s*[^;{}]+;\s*$/, /^\s*@(media|import|keyframes|font-face)\b/],
  ],
  [
    "sql",
    [
      /^\s*SELECT\b/i,
      /^\s*FROM\b/i,
      /^\s*WHERE\b/i,
      /^\s*(INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i,
      /^\s*((LEFT|RIGHT|INNER|OUTER)\s+)?JOIN\b|^\s*(GROUP|ORDER) BY\b/i,
    ],
  ],
]

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** The fence language for pasted text, or nothing when it should paste as it is. */
export function detectCodeLanguage(text: string): string | undefined {
  if (text.includes("```")) return undefined
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < MIN_CODE_LINES) return undefined
  const trimmed = text.trim()
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && parsesAsJson(trimmed)) return "json"
  let best: string | undefined
  let hits = 0
  for (const [language, patterns] of PATTERNS) {
    const count = lines.filter((line) => patterns.some((pattern) => pattern.test(line))).length
    if (count > hits) {
      best = language
      hits = count
    }
  }
  return hits >= MIN_LANGUAGE_HITS ? best : undefined
}

/**
 * The draft with the fenced block in place of the selection, on lines of its
 * own, and the caret at the end of what was put in.
 */
export function insertFence(
  draft: string,
  start: number,
  end: number,
  language: string,
  code: string,
): { text: string; caret: number } {
  const before = draft.slice(0, start)
  const after = draft.slice(end)
  const lead = before && !before.endsWith("\n") ? "\n" : ""
  const tail = after && !after.startsWith("\n") ? "\n" : ""
  const block = `${lead}\`\`\`${language}\n${code.replace(/\s+$/, "")}\n\`\`\`${tail}`
  return { text: before + block + after, caret: before.length + block.length }
}
