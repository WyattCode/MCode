import type { McpServerConfig } from "@shared/protocol"

/**
 * Saving an MCP server from the settings form, as MiMo's does.
 *
 * The form never gets the saved environment and header values back: an edit
 * shows those rows blank under 「已保存，留空表示不变」. So a row that comes back
 * blank and is named in `keep` takes the value already stored under that key;
 * any other row is written as sent. A kept key with nothing stored is dropped.
 */
export function mergeMcpSecrets(
  stored: McpServerConfig | undefined,
  incoming: McpServerConfig,
  keep: { env?: string[]; headers?: string[] } = {},
): McpServerConfig {
  const merged: McpServerConfig = { ...incoming }
  const fill = (sent: Record<string, string> | undefined, old: Record<string, string> | undefined, names: string[] = []) => {
    if (!sent) return undefined
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(sent)) {
      if (value === "" && names.includes(name)) {
        if (old?.[name] !== undefined) out[name] = old[name]
      } else out[name] = value
    }
    return Object.keys(out).length ? out : undefined
  }
  if (incoming.environment) merged.environment = fill(incoming.environment, stored?.environment, keep.env)
  if (incoming.headers) merged.headers = fill(incoming.headers, stored?.headers, keep.headers)
  if (!merged.environment) delete merged.environment
  if (!merged.headers) delete merged.headers
  return merged
}
