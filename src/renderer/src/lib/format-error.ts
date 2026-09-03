import { t } from "./i18n"

/**
 * Turns whatever was thrown into something a person can paste into a bug report.
 *
 * A thrown value is not necessarily an Error. It can be a string, a plain
 * object from a rejected request, or an Error carrying another Error as its
 * cause - and it is the cause, two or three links down, that usually says what
 * actually went wrong. Printing only the outermost message throws that away,
 * and `String(error)` on an object gives "[object Object]", which is worse than
 * nothing because it looks like a real answer.
 *
 * So the whole chain is walked, each link separated by a rule and labelled with
 * the reason it is there. The shape below is the reference's, so the text a
 * user sends us reads the same whichever of the two apps produced it.
 */

/**
 * A rule between links in the chain.
 *
 * Wide enough to be obvious in a monospace field but narrow enough not to wrap
 * at the widths the panel uses.
 */
const CHAIN_SEPARATOR = "\n" + "─".repeat(40) + "\n"

/**
 * JSON that cannot itself throw.
 *
 * `JSON.stringify` refuses two things that turn up in real thrown values: a
 * bigint, which it throws on outright, and an object that contains itself,
 * which it also throws on. Either one would mean the error page fails while
 * trying to describe a failure, so both are handled here rather than left to
 * chance.
 */
function safeJson(value: unknown, circular: string): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (typeof entry === "bigint") return entry.toString()
      if (typeof entry === "object" && entry) {
        if (seen.has(entry)) return circular
        seen.add(entry)
      }
      return entry
    },
    2,
  )
  // undefined, a function, or a symbol all stringify to nothing at the top level.
  return json ?? Object.prototype.toString.call(value)
}

function formatChain(error: unknown, depth: number, parentMessage?: string): string {
  if (!error) return t("error.chain.unknown")

  /*
   * Only a link below the first is introduced. The outermost error is the one
   * the reader already knows about - it is why they are looking at this page.
   */
  const causedBy = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""

  if (error instanceof Error) {
    /*
     * A cause that repeats its parent's message word for word.
     *
     * Wrapping an error without changing the message is common, and printing
     * the same sentence three times pushes the part that differs - the stack -
     * off the visible area of the field. When the message is a repeat only the
     * new stack is worth showing.
     */
    const duplicate = depth > 0 && parentMessage === error.message
    const parts: string[] = []
    const header = `${error.name}${error.message ? `: ${error.message}` : ""}`
    const stack = error.stack?.trim()

    if (stack) {
      // V8 puts the header on the first line of the stack; other engines do not.
      const stackHasHeader = stack.startsWith(header)
      if (duplicate && stackHasHeader) {
        const trace = stack.split("\n").slice(1).join("\n").trim()
        if (trace) parts.push(causedBy + trace)
      } else if (duplicate || stackHasHeader) {
        parts.push(causedBy + stack)
      } else {
        parts.push(causedBy + `${header}\n${stack}`)
      }
    }
    if (!stack && !duplicate) parts.push(causedBy + header)

    if (error.cause) {
      const cause = formatChain(error.cause, depth + 1, error.message)
      if (cause) parts.push(cause)
    }
    return parts.join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    return causedBy + error
  }

  return causedBy + safeJson(error, t("error.page.circular"))
}

/** The whole chain, outermost first, in the language the app is running in. */
export function formatError(error: unknown): string {
  return formatChain(error, 0)
}
