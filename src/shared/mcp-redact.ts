/**
 * Secret-looking values in MCP commands, addresses and headers, masked for
 * display and logs.
 *
 * MiMo's engine masks the same three shapes before an MCP command or address
 * is shown or logged: whatever follows `Bearer`, the value of a query
 * parameter or `name=value` pair whose name looks like a credential, and the
 * argument that follows a credential-looking flag. This is this app's own
 * implementation of that behaviour.
 */

export const MASK = "****"

/** Names that mark a value as a credential. */
const SENSITIVE = ["authorization", "token", "api_key", "api-key", "apikey", "key", "secret", "password", "credential"]

export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE.some((part) => lower.includes(part))
}

const NAMES = "(?:authorization|token|api[_-]?key|apikey|key|secret|password|credential)"

/** A command argument, an address or a header value with its secret parts masked. */
export function redactString(input: string): string {
  return input
    .replace(/(Bearer\s+)[^\s]+/gi, `$1${MASK}`)
    .replace(new RegExp(`([?&][^=\\s&]*${NAMES}[^=\\s&]*=)[^&\\s#]+`, "gi"), `$1${MASK}`)
    .replace(new RegExp(`(${NAMES}=)[^\\s&]+`, "gi"), `$1${MASK}`)
}

/**
 * An address with its secret parts masked: the user name and password before
 * the host (`https://user:pass@host`), and the secret-looking parts
 * `redactString` finds. Everything else stays exactly as typed, so an address
 * with nothing secret in it comes back unchanged and compares equal.
 *
 * Round 9, beyond MiMo: its engine masks MCP addresses the `redactString` way
 * but leaves the user-info part, and does not mask a provider's base URL.
 */
export function redactUrl(input: string): string {
  // Greedy up to the authority's last "@": a password typed with a bare "@" in it is still all masked.
  return redactString(input.replace(/^(\s*[a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i, `$1${MASK}@`))
}

/** A split command with the value after a credential-looking flag masked, and every part redacted. */
export function redactCommand(parts: readonly string[]): string[] {
  return parts.map((part, index) => {
    const previous = parts[index - 1]
    // A flag that carries its own value (`--token=x`) is handled by redactString; the one before a bare value masks it.
    if (index > 0 && previous !== undefined && previous.startsWith("-") && !previous.includes("=") && isSensitiveName(previous)) return MASK
    return redactString(part)
  })
}
