import type { AppConfig, CustomProvider, McpServerConfig, ProviderStatus, ServerFrame } from "@shared/protocol"
import { MASK, isSensitiveName, redactCommand, redactUrl } from "@shared/mcp-redact"

/**
 * The settings as the window is sent them.
 *
 * The window never shows an MCP server's environment or header values (its
 * form offers them back blank as 已保存), yet the whole document used to cross
 * the socket, so a page that got script running could read every bearer token
 * the user had configured. They are masked here, at the one place frames
 * leave, along with the secret-looking parts of MCP commands and addresses, an
 * OAuth client secret, and the values of custom provider headers whose names
 * mark them as credentials. A masked value that comes back unchanged means "keep what is
 * stored" - see `restoreMasked`.
 */

const maskValues = (record: Record<string, string> | undefined, only?: (name: string) => boolean) =>
  record ? Object.fromEntries(Object.entries(record).map(([name, value]) => [name, !only || only(name) ? MASK : value])) : undefined

function maskServer(entry: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...entry }
  if (entry.command) out.command = redactCommand(entry.command)
  if (entry.url) out.url = redactUrl(entry.url)
  if (entry.environment) out.environment = maskValues(entry.environment)
  if (entry.headers) out.headers = maskValues(entry.headers)
  if (entry.oauth && entry.oauth.clientSecret) out.oauth = { ...entry.oauth, clientSecret: MASK }
  return out
}

/*
 * A provider's address (round 9): only its secret parts are masked - the user
 * name and password before the host, and secret-looking query values. An
 * address with none is sent exactly as typed, so the provider list and the
 * endpoint field still show and compare it as they did.
 */
function maskProvider(entry: CustomProvider): CustomProvider {
  return {
    ...entry,
    baseURL: redactUrl(entry.baseURL),
    ...(entry.headers ? { headers: maskValues(entry.headers, isSensitiveName) } : {}),
  }
}

const maskEndpoints = (endpoints: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(endpoints ?? {}).map(([id, url]) => [id, redactUrl(url)]))

export function configForWindow(config: AppConfig): AppConfig {
  return {
    ...config,
    mcpServers: Object.fromEntries(Object.entries(config.mcpServers ?? {}).map(([name, entry]) => [name, maskServer(entry)])),
    customProviders: (config.customProviders ?? []).map(maskProvider),
    providerEndpoints: maskEndpoints(config.providerEndpoints),
  }
}

/** The provider list as the window is sent it: each endpoint in force, masked the same way. */
function providersForWindow(providers: ProviderStatus[]): ProviderStatus[] {
  return providers.map((entry) => (entry.baseURL ? { ...entry, baseURL: redactUrl(entry.baseURL) } : entry))
}

/** A frame about to leave for a window, with any settings document or provider list in it masked. */
export function frameForWindow(frame: ServerFrame): ServerFrame {
  if (frame.kind === "event") {
    if (frame.event.type === "config.updated") return { ...frame, event: { ...frame.event, config: configForWindow(frame.event.config) } }
    if (frame.event.type === "auth.completed") return { ...frame, event: { ...frame.event, providers: providersForWindow(frame.event.providers) } }
    // Every pushed providers list carries the stored addresses; the pushed ones used to cross unmasked.
    if (frame.event.type === "providers.updated" || frame.event.type === "auth.expired")
      return { ...frame, event: { ...frame.event, providers: providersForWindow(frame.event.providers) } }
    return frame
  }
  if (frame.kind === "response" && frame.ok) {
    let data = frame.data
    if (isConfigHolder(data)) data = { ...data, config: configForWindow(data.config) }
    if (isProviderHolder(data)) data = { ...data, providers: providersForWindow(data.providers) }
    return data === frame.data ? frame : { ...frame, data }
  }
  return frame
}

function isProviderHolder(data: unknown): data is { providers: ProviderStatus[] } {
  if (!data || typeof data !== "object") return false
  const providers = (data as { providers?: unknown }).providers
  return Array.isArray(providers) && providers.every((entry) => Boolean(entry) && typeof entry === "object" && "authMethods" in entry && "configured" in entry)
}

function isConfigHolder(data: unknown): data is { config: AppConfig } {
  if (!data || typeof data !== "object") return false
  const config = (data as { config?: unknown }).config
  return Boolean(config) && typeof config === "object" && "mcpServers" in (config as object) && "permissions" in (config as object)
}

const keepRecord = (incoming: Record<string, string> | undefined, stored: Record<string, string> | undefined) =>
  incoming
    ? Object.fromEntries(Object.entries(incoming).map(([name, value]) => [name, value === MASK && stored?.[name] !== undefined ? stored[name]! : value]))
    : undefined

/** A command sent back with masked parts, each masked part taking the stored part it was made from. */
function keepCommand(incoming: string[] | undefined, stored: string[] | undefined): string[] | undefined {
  if (!incoming || !stored) return incoming
  const shown = redactCommand(stored)
  const used = new Set<number>()
  return incoming.map((part, index) => {
    if (!part.includes(MASK)) return part
    // The same position first, as an unchanged form sends it; else the first unused stored part that masks the same.
    const at = shown[index] === part && !used.has(index) ? index : shown.findIndex((candidate, position) => candidate === part && !used.has(position))
    if (at < 0) return part
    used.add(at)
    return stored[at]!
  })
}

/** An MCP entry the window sent back, with what it was only shown masked put back as stored. */
export function restoreServer(incoming: McpServerConfig, stored: McpServerConfig | undefined): McpServerConfig {
  if (!stored) return incoming
  const out: McpServerConfig = { ...incoming }
  if (incoming.command) out.command = keepCommand(incoming.command, stored.command)
  if (incoming.url && stored.url && incoming.url === redactUrl(stored.url)) out.url = stored.url
  if (incoming.environment) out.environment = keepRecord(incoming.environment, stored.environment)
  if (incoming.headers) out.headers = keepRecord(incoming.headers, stored.headers)
  if (incoming.oauth && incoming.oauth.clientSecret === MASK && stored.oauth) out.oauth = { ...incoming.oauth, clientSecret: stored.oauth.clientSecret }
  return out
}

function restoreProvider(incoming: CustomProvider, stored: CustomProvider | undefined): CustomProvider {
  if (!stored) return incoming
  return {
    ...incoming,
    baseURL: restoreUrl(incoming.baseURL, stored.baseURL),
    ...(incoming.headers ? { headers: keepRecord(incoming.headers, stored.headers) } : {}),
  }
}

/** An address the window sent back exactly as it was shown takes the stored one it was made from. */
export function restoreUrl(incoming: string, stored: string | undefined): string {
  return stored !== undefined && incoming !== stored && incoming === redactUrl(stored) ? stored : incoming
}

/** A settings patch from the window, with masked values put back as stored. */
export function restoreMasked(stored: AppConfig, patch: Partial<AppConfig>): Partial<AppConfig> {
  const out = { ...patch }
  if (patch.providerEndpoints) {
    out.providerEndpoints = Object.fromEntries(
      Object.entries(patch.providerEndpoints).map(([id, url]) => [id, restoreUrl(url, stored.providerEndpoints?.[id])]),
    )
  }
  if (patch.mcpServers) {
    out.mcpServers = Object.fromEntries(Object.entries(patch.mcpServers).map(([name, entry]) => [name, restoreServer(entry, stored.mcpServers?.[name])]))
  }
  if (patch.customProviders) {
    out.customProviders = patch.customProviders.map((entry) => restoreProvider(entry, stored.customProviders?.find((candidate) => candidate.id === entry.id)))
  }
  return out
}

/** Custom provider headers from the edit form, with masked values taking the stored ones. */
export function restoreHeaders(incoming: Record<string, string> | undefined, stored: Record<string, string> | undefined): Record<string, string> | undefined {
  return keepRecord(incoming, stored)
}
