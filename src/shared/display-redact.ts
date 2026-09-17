/*
 * Secrets and personal numbers hidden in what a step shows.
 *
 * Beyond parity (the user's 2026-09-17 decision): MiMo masks a step's title,
 * output and input only when a conversation is reopened, so a key printed a
 * moment ago shows until then. MCode masks the same kinds of value both live
 * and after a reload. Display only - the stored transcript and what the model
 * receives are never changed, and opening a path uses the path as written.
 *
 * The kinds follow MiMo's list (bearer tokens, JWTs, well-known key prefixes,
 * `key = value` assignments, Chinese ID numbers that pass their check digit,
 * card numbers that pass Luhn with a known issuer prefix, and a recovery
 * phrase after its label); the patterns are this app's own.
 */

type Rule = [RegExp, string | ((match: string, ...groups: string[]) => string)]

/** Characters a token is made of; a match must not be glued to more of them. */
const TOKEN = "[A-Za-z0-9._~+/=-]"

const SECRET_RULES: Rule[] = [
  // An Authorization header's credential.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [token]"],
  // A JSON Web Token: three base64url parts, the first an encoded `{"`.
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[jwt]"],
  // Keys known by their prefix: OpenAI-style, GitHub, GitLab, AWS, Slack, Google.
  [new RegExp(`(?<!${TOKEN})(?:sk-[\\w-]{8,}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_\\w{22,}|glpat-[\\w-]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,})`, "g"), "[key]"],
  [/(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, "[key]"],
  [/(?<![\w-])AIza[\w-]{35}(?![\w-])/g, "[key]"],
  // `api_key = …`, `"access-token": "…"`, `SECRET_KEY=…`: the name stays, the value goes.
  [/\b((?:[A-Za-z]+[_-])?(?:api|access|secret|private|client)[_-]?(?:token|key|secret))(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1$2[token]"],
  [/\b((?:password|passwd|pwd))(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, "$1$2[token]"],
  // A short name for a long value: `token: abcdef…` of sixteen or more.
  [/((?:^|[\s"'{,(])(?:sk|key|token|secret|apikey|api_key|auth))(["']?\s*[:=]\s*["']?)[\w-]{16,}/gim, "$1$2[redacted]"],
]

/* Chinese resident ID: 18 characters, a plausible birth date, and a check character that agrees. */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK = "10X98765432"

export function validChineseID(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false
  const month = Number(id.slice(10, 12))
  const day = Number(id.slice(12, 14))
  const year = Number(id.slice(6, 10))
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return false
  let sum = 0
  for (let at = 0; at < 17; at++) sum += Number(id[at]) * ID_WEIGHTS[at]!
  return ID_CHECK[sum % 11] === id[17]!.toUpperCase()
}

/* A payment card: the Luhn sum, and a length its issuer uses. */
function luhn(digits: string): boolean {
  let sum = 0
  for (let at = 0; at < digits.length; at++) {
    let value = Number(digits[digits.length - 1 - at])
    if (at % 2 === 1) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
  }
  return sum % 10 === 0
}

export function validCardNumber(digits: string): boolean {
  const size = digits.length
  if (!/^\d{13,19}$/.test(digits) || !luhn(digits)) return false
  const starts = (pattern: RegExp) => pattern.test(digits)
  if (starts(/^62/)) return size >= 16 // UnionPay
  if (starts(/^4/)) return size === 13 || size === 16 || size === 19 // Visa
  if (starts(/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]))/)) return size === 16 // Mastercard
  if (starts(/^3[47]/)) return size === 15 // American Express
  if (starts(/^(35|6011|64|65)/)) return size === 16 // JCB, Discover
  return false
}

const NUMBER_RULES: Rule[] = [
  [/(?<![\dXx])\d{17}[\dXx](?![\dXx])/g, (match) => (validChineseID(match) ? "[idcard]" : match)],
  // Thirteen to nineteen digits, grouped by single spaces or dashes as cards are printed.
  [/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, (match) => (validCardNumber(match.replace(/\D/g, "")) ? "[bankcard]" : match)],
  // A recovery phrase after its label: twelve to twenty-four lowercase words.
  [/((?:助记词|助记短语|种子短语|恢复短语|mnemonic|(?:seed|recovery|secret)[\s_-]?phrase)["']?\s*[:=：]\s*["']?)([a-z]+(?:[,，]?[ \t]+[a-z]+){11,23})/gi, "$1[mnemonic]"],
]

const RULES = [...SECRET_RULES, ...NUMBER_RULES]

/** Text with its secrets and personal numbers replaced by a bracketed kind. */
export function redactText(text: string): string {
  if (!text) return text
  let out = text
  for (const [pattern, replacement] of RULES) {
    out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement as (match: string) => string)
  }
  return out
}

/** A call's input with every string masked, four levels deep as MiMo goes. */
export function redactValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactText(value) as T
  if (depth >= 4 || !value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1)) as T
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, depth + 1)])) as T
}
