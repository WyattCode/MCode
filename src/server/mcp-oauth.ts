import { appendFileSync } from "node:fs"
import { browserTarget, openUrl } from "./open-url"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createConnection } from "node:net"
import { createHash, randomBytes } from "node:crypto"
import type { McpOAuthConfig } from "@shared/protocol"
import { CodedError } from "@shared/errors"
import { writeAtomic, type Storage } from "./storage"
import { oauthFetch } from "./oauth-fetch"

/**
 * Signing in to a remote MCP server, the way MiMo's engine does it.
 *
 * MiMo's engine hands this to the MCP SDK's `auth()` with a provider of its
 * own; this is the same flow written out here, so MCode keeps its no-SDK MCP
 * client: protected-resource metadata (from the 401's WWW-Authenticate, then
 * the path-aware well-known address, then the root one), authorization server
 * metadata (OAuth, then OpenID, path-inserted before path-appended), dynamic
 * client registration unless a client is configured, the refresh grant before
 * a new authorization, and PKCE S256 with state on the fixed loopback callback
 * http://127.0.0.1:19876/mcp/oauth/callback. An invalid client drops everything
 * stored and starts again; an invalid grant drops the tokens and starts again.
 *
 * Tokens stay on this machine, in the app's storage with owner-only access,
 * and never reach the window.
 */

export const OAUTH_CALLBACK_PORT = 19876
export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"
const PROTOCOL_VERSION = "2025-11-25"
const CALLBACK_TIMEOUT = 5 * 60 * 1000
const KEY = "mcp-auth"

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message)
    this.name = "UnauthorizedError"
  }
}

const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "unsupported_response_type",
  "unsupported_token_type",
  "invalid_token",
  "method_not_allowed",
  "too_many_requests",
  "invalid_client_metadata",
  "insufficient_scope",
  "invalid_target",
])

/** An error the authorization server named; an unrecognised one counts as server_error. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message || code)
    this.name = "OAuthError"
  }
}

// ---------------------------------------------------------------------------
// What is kept per server
// ---------------------------------------------------------------------------

export interface McpAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch seconds. */
  expiresAt?: number
  scope?: string
}

export interface McpAuthClient {
  clientId: string
  clientSecret?: string
  clientIdIssuedAt?: number
  clientSecretExpiresAt?: number
}

export interface McpAuthEntry {
  tokens?: McpAuthTokens
  clientInfo?: McpAuthClient
  codeVerifier?: string
  oauthState?: string
  /** The server the entry belongs to; a server pointed elsewhere starts over. */
  serverUrl?: string
}

export class McpAuthStore {
  private queue: Promise<void> = Promise.resolve()

  /** Why the file cannot be written right now: it could not be read, and was not moved aside. */
  private blocked: string | undefined

  constructor(private readonly storage: Storage) {}

  /**
   * Every sign-in, or none while the file cannot be read.
   *
   * A file that will not parse used to read as no sign-ins, and the next
   * change wrote its one entry over it, losing every other server's tokens
   * (L12-10). It is now moved aside as `mcp-auth.json.corrupt-<time>`. One that
   * cannot be read at all - a lock, a permission - or cannot be moved stays
   * exactly where it is, and every change is refused until it reads again.
   */
  async all(): Promise<Record<string, McpAuthEntry>> {
    try {
      const value = await this.storage.read<Record<string, McpAuthEntry>>(KEY)
      this.blocked = undefined
      return value ?? {}
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      const aside = err instanceof SyntaxError ? await this.storage.quarantine(KEY) : undefined
      if (aside) {
        console.warn(`[mcp] the MCP sign-ins could not be read (${why}); the file was kept as ${aside}`)
        this.blocked = undefined
      } else {
        if (this.blocked === undefined) console.warn(`[mcp] the MCP sign-ins could not be read (${why}); nothing is saved over them`)
        this.blocked = why
      }
      return {}
    }
  }

  async get(name: string): Promise<McpAuthEntry | undefined> {
    return (await this.all())[name]
  }

  async getForUrl(name: string, serverUrl: string): Promise<McpAuthEntry | undefined> {
    const entry = await this.get(name)
    return entry?.serverUrl && entry.serverUrl === serverUrl ? entry : undefined
  }

  /* One write at a time, each re-reading the file, so two updates cannot lose each other. */
  private mutate(change: (all: Record<string, McpAuthEntry>) => void): Promise<void> {
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        const all = await this.all()
        if (this.blocked !== undefined) {
          const file = this.storage.fileOf(KEY)
          throw new CodedError(`${file} could not be read (${this.blocked}), so nothing is saved over it`, "error.mcpAuthUnreadable", { file })
        }
        change(all)
        await writeAtomic(this.storage.fileOf(KEY), JSON.stringify(all, null, 2), 0o600)
      })
    this.queue = next
    return next
  }

  set(name: string, entry: McpAuthEntry, serverUrl?: string): Promise<void> {
    return this.mutate((all) => {
      all[name] = serverUrl ? { ...entry, serverUrl } : entry
    })
  }

  remove(name: string): Promise<void> {
    return this.mutate((all) => {
      delete all[name]
    })
  }

  update<K extends keyof McpAuthEntry>(name: string, field: K, value: McpAuthEntry[K], serverUrl?: string): Promise<void> {
    return this.mutate((all) => {
      const entry = all[name] ?? {}
      entry[field] = value
      if (serverUrl) entry.serverUrl = serverUrl
      all[name] = entry
    })
  }

  clear(name: string, field: keyof McpAuthEntry): Promise<void> {
    return this.mutate((all) => {
      if (all[name]) delete all[name][field]
    })
  }
}

// ---------------------------------------------------------------------------
// The provider: what the flow asks of the app
// ---------------------------------------------------------------------------

interface ClientInformation {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
  token_endpoint_auth_method?: string
}

interface TokenSet {
  access_token: string
  token_type?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

export class McpOAuthProvider {
  constructor(
    readonly name: string,
    readonly serverUrl: string,
    private readonly config: McpOAuthConfig,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
    private readonly store: McpAuthStore,
  ) {}

  get redirectUrl(): string {
    return this.config.redirectUri ?? `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "MCode",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  async clientInformation(): Promise<ClientInformation | undefined> {
    if (this.config.clientId) return { client_id: this.config.clientId, client_secret: this.config.clientSecret }
    const info = (await this.store.getForUrl(this.name, this.serverUrl))?.clientInfo
    if (!info) return undefined
    // A registration whose secret has run out is registered again.
    if (info.clientSecretExpiresAt && info.clientSecretExpiresAt < Date.now() / 1000) return undefined
    return { client_id: info.clientId, client_secret: info.clientSecret }
  }

  saveClientInformation(info: ClientInformation): Promise<void> {
    return this.store.update(
      this.name,
      "clientInfo",
      {
        clientId: info.client_id,
        ...(info.client_secret ? { clientSecret: info.client_secret } : {}),
        ...(info.client_id_issued_at ? { clientIdIssuedAt: info.client_id_issued_at } : {}),
        ...(info.client_secret_expires_at ? { clientSecretExpiresAt: info.client_secret_expires_at } : {}),
      },
      this.serverUrl,
    )
  }

  async tokens(): Promise<TokenSet | undefined> {
    const tokens = (await this.store.getForUrl(this.name, this.serverUrl))?.tokens
    if (!tokens) return undefined
    return {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresAt ? Math.max(0, Math.floor(tokens.expiresAt - Date.now() / 1000)) : undefined,
      scope: tokens.scope,
    }
  }

  saveTokens(tokens: TokenSet): Promise<void> {
    return this.store.update(
      this.name,
      "tokens",
      {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expires_in ? { expiresAt: Date.now() / 1000 + tokens.expires_in } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
      this.serverUrl,
    )
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.onRedirect(url)
  }

  saveCodeVerifier(verifier: string): Promise<void> {
    return this.store.update(this.name, "codeVerifier", verifier)
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.store.get(this.name))?.codeVerifier
    if (!verifier) throw new Error(`No code verifier saved for MCP server: ${this.name}`)
    return verifier
  }

  async state(): Promise<string> {
    const stored = (await this.store.get(this.name))?.oauthState
    if (stored) return stored
    const fresh = randomBytes(32).toString("hex")
    await this.store.update(this.name, "oauthState", fresh)
    return fresh
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens"): Promise<void> {
    const entry = await this.store.get(this.name)
    if (!entry) return
    if (scope === "all") return this.store.remove(this.name)
    const next = { ...entry }
    if (scope === "client") delete next.clientInfo
    else delete next.tokens
    await this.store.set(this.name, next)
  }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

interface ResourceMetadata {
  resource: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

interface ServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  response_types_supported: string[]
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

export type AuthResult = "AUTHORIZED" | "REDIRECT"

export interface AuthOptions {
  serverUrl: string
  authorizationCode?: string
  scope?: string
  resourceMetadataUrl?: URL
}

/**
 * One renewal per server at a time (N11-26).
 *
 * Two calls on one server that meet a 401 together each started a refresh
 * with the same refresh token. With rotating refresh tokens the loser's
 * invalid_grant then invalidated the tokens - including the ones the winner
 * had just stored - and the reader was sent back to sign in in the browser. A
 * second caller now waits for the first and takes its answer. Keyed by server
 * name, since the stored credentials are, across every project that has it.
 */
const renewing = new Map<string, Promise<AuthResult>>()

export function authOnce(server: string, work: () => Promise<AuthResult>): Promise<AuthResult> {
  const running = renewing.get(server)
  if (running) return running
  const started = work().finally(() => {
    if (renewing.get(server) === started) renewing.delete(server)
  })
  renewing.set(server, started)
  return started
}

/** Signs in, renews, or sends the reader to the authorization page; retried once on a stale client or grant. */
export async function auth(provider: McpOAuthProvider, options: AuthOptions): Promise<AuthResult> {
  try {
    return await authInternal(provider, options)
  } catch (err) {
    if (err instanceof OAuthError && (err.code === "invalid_client" || err.code === "unauthorized_client")) {
      await provider.invalidateCredentials("all")
      return authInternal(provider, options)
    }
    if (err instanceof OAuthError && err.code === "invalid_grant") {
      await provider.invalidateCredentials("tokens")
      return authInternal(provider, options)
    }
    throw err
  }
}

async function authInternal(provider: McpOAuthProvider, options: AuthOptions): Promise<AuthResult> {
  const { serverUrl, authorizationCode, scope, resourceMetadataUrl } = options
  const info = await discoverServerInfo(serverUrl, resourceMetadataUrl)
  const resource = selectResourceURL(serverUrl, info.resourceMetadata)

  let client = await provider.clientInformation()
  if (!client) {
    if (authorizationCode !== undefined) {
      throw new Error("Existing OAuth client information is required when exchanging an authorization code")
    }
    client = await registerClient(serverUrl, info.authorizationServerUrl, info.metadata, provider.clientMetadata)
    await provider.saveClientInformation(client)
  }

  if (authorizationCode !== undefined) {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      code_verifier: await provider.codeVerifier(),
      redirect_uri: provider.redirectUrl,
    })
    const tokens = await tokenRequest(serverUrl, info.authorizationServerUrl, info.metadata, params, client, resource)
    await provider.saveTokens(tokens)
    return "AUTHORIZED"
  }

  const held = await provider.tokens()
  if (held?.refresh_token) {
    try {
      const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: held.refresh_token })
      const fresh = await tokenRequest(serverUrl, info.authorizationServerUrl, info.metadata, params, client, resource)
      await provider.saveTokens({ refresh_token: held.refresh_token, ...fresh })
      return "AUTHORIZED"
    } catch (err) {
      // A refusal the server spelled out is final; anything else falls through to a new sign-in.
      if (err instanceof OAuthError && err.code !== "server_error") throw err
    }
  }

  const state = await provider.state()
  const { url, verifier } = startAuthorization(info.authorizationServerUrl, info.metadata, {
    client,
    redirectUrl: provider.redirectUrl,
    scope: scope || info.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope,
    state,
    resource,
  })
  await provider.saveCodeVerifier(verifier)
  await provider.redirectToAuthorization(url)
  return "REDIRECT"
}

/** The resource metadata address and scope a 401 names. */
export function wwwAuthenticateParams(response: Response): { resourceMetadataUrl?: URL; scope?: string } {
  const header = response.headers.get("www-authenticate")
  if (!header) return {}
  const [type, scheme] = header.split(" ")
  if (type?.toLowerCase() !== "bearer" || !scheme) return {}
  const field = (name: string) => {
    const match = new RegExp(`${name}=(?:"([^"]+)"|([^\\s,]+))`).exec(header)
    return match ? match[1] || match[2] : undefined
  }
  let resourceMetadataUrl: URL | undefined
  const hinted = field("resource_metadata")
  if (hinted) {
    try {
      resourceMetadataUrl = new URL(hinted)
    } catch {
      // Not an address; discovery goes on without it.
    }
  }
  const scope = field("scope")
  return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) }
}

/*
 * Every request below goes to an address the MCP server named, so each goes
 * through `oauthFetch` (round 9): resolved once, refused unless public (or the
 * server's own host), and connected to exactly as checked.
 */
async function fetchMetadata(serverUrl: string, url: URL, headers?: Record<string, string>): Promise<Response | undefined> {
  try {
    return await oauthFetch(serverUrl, url, headers ? { headers } : {})
  } catch (err) {
    if (err instanceof TypeError) return headers ? fetchMetadata(serverUrl, url, undefined) : undefined
    throw err
  }
}

function wellKnownPath(prefix: string, pathname: string): string {
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  return `/.well-known/${prefix}${trimmed}`
}

async function discoverResourceMetadata(serverUrl: string, metadataUrl?: URL): Promise<ResourceMetadata> {
  const issuer = new URL(serverUrl)
  const headers = { "MCP-Protocol-Version": PROTOCOL_VERSION }
  let url: URL
  if (metadataUrl) {
    url = new URL(metadataUrl)
  } else {
    url = new URL(wellKnownPath("oauth-protected-resource", issuer.pathname), issuer)
    url.search = issuer.search
  }
  let response = await fetchMetadata(serverUrl, url, headers)
  const retry = !response || (response.status >= 400 && response.status < 500 && issuer.pathname !== "/")
  if (!metadataUrl && retry) {
    await response?.body?.cancel().catch(() => {})
    response = await fetchMetadata(serverUrl, new URL("/.well-known/oauth-protected-resource", issuer), headers)
  }
  if (!response || response.status === 404) {
    await response?.body?.cancel().catch(() => {})
    throw new Error("Resource server does not implement OAuth 2.0 Protected Resource Metadata.")
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`HTTP ${response.status} trying to load well-known OAuth protected resource metadata.`)
  }
  const body = (await response.json()) as ResourceMetadata
  if (!body || typeof body.resource !== "string") throw new Error("Invalid OAuth protected resource metadata")
  return body
}

function discoveryUrls(authorizationServerUrl: string): URL[] {
  const url = new URL(authorizationServerUrl)
  if (url.pathname === "/") {
    return [new URL("/.well-known/oauth-authorization-server", url.origin), new URL("/.well-known/openid-configuration", url.origin)]
  }
  const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
  return [
    new URL(`/.well-known/oauth-authorization-server${pathname}`, url.origin),
    new URL(`/.well-known/openid-configuration${pathname}`, url.origin),
    new URL(`${pathname}/.well-known/openid-configuration`, url.origin),
  ]
}

async function discoverServerMetadata(serverUrl: string, authorizationServerUrl: string): Promise<ServerMetadata | undefined> {
  const headers = { "MCP-Protocol-Version": PROTOCOL_VERSION, Accept: "application/json" }
  for (const url of discoveryUrls(authorizationServerUrl)) {
    const response = await fetchMetadata(serverUrl, url, headers)
    if (!response) continue
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status >= 400 && response.status < 500) continue
      throw new Error(`HTTP ${response.status} trying to load authorization server metadata from ${url}`)
    }
    const body = (await response.json()) as ServerMetadata
    if (
      !body ||
      typeof body.authorization_endpoint !== "string" ||
      typeof body.token_endpoint !== "string" ||
      !Array.isArray(body.response_types_supported)
    ) {
      throw new Error(`Invalid authorization server metadata from ${url}`)
    }
    return body
  }
  return undefined
}

/* A host name or literal address on this machine or a private network. */
function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1") return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true
  return /^(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/.test(host) || /^::ffff:/.test(host)
}

/**
 * An address the MCP server named for discovery, if it may be followed.
 *
 * The server's own 401 names where its metadata lives, and that metadata names
 * the authorization server; left unchecked, a hostile server could point the
 * app at anything on this machine or the local network. The server's own host
 * is always fine; any other host has to be https and not a private or loopback
 * address.
 */
export function trustedDiscoveryUrl(serverUrl: string, candidate: string | URL | undefined): URL | undefined {
  if (!candidate) return undefined
  let url: URL
  let server: URL
  try {
    url = new URL(candidate)
    server = new URL(serverUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  if (url.hostname.toLowerCase() === server.hostname.toLowerCase()) return url
  if (url.protocol !== "https:" || privateHost(url.hostname)) return undefined
  return url
}

async function discoverServerInfo(serverUrl: string, hintedMetadataUrl?: URL) {
  let resourceMetadata: ResourceMetadata | undefined
  let authorizationServerUrl: string | undefined
  // A hint that may not be followed is dropped, and discovery goes on at the server's own well-known address.
  const resourceMetadataUrl = trustedDiscoveryUrl(serverUrl, hintedMetadataUrl)
  try {
    resourceMetadata = await discoverResourceMetadata(serverUrl, resourceMetadataUrl)
    const named = resourceMetadata.authorization_servers?.[0]
    if (named && !trustedDiscoveryUrl(serverUrl, named)) throw new Error(`The MCP server named an authorization server that may not be used: ${named}`)
    authorizationServerUrl = named
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("The MCP server named an authorization server")) throw err
    // A server without resource metadata is its own authorization server.
  }
  authorizationServerUrl ??= String(new URL("/", serverUrl))
  const metadata = await discoverServerMetadata(serverUrl, authorizationServerUrl)
  return { authorizationServerUrl, metadata, resourceMetadata }
}

function selectResourceURL(serverUrl: string, resourceMetadata?: ResourceMetadata): URL | undefined {
  if (!resourceMetadata) return undefined
  const requested = new URL(serverUrl)
  requested.hash = ""
  const configured = new URL(resourceMetadata.resource)
  const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`
  const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`
  const allowed =
    requested.origin === configured.origin &&
    requested.pathname.length >= configured.pathname.length &&
    requestedPath.startsWith(configuredPath)
  if (!allowed) {
    throw new Error(`Protected resource ${resourceMetadata.resource} does not match expected ${requested} (or origin)`)
  }
  return configured
}

async function errorFrom(response: Response): Promise<OAuthError> {
  const body = await response.text().catch(() => "")
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string }
    if (typeof parsed.error !== "string") throw new Error("no error field")
    const code = OAUTH_ERROR_CODES.has(parsed.error) ? parsed.error : "server_error"
    return new OAuthError(code, parsed.error_description || "")
  } catch (err) {
    return new OAuthError(
      "server_error",
      `HTTP ${response.status}: Invalid OAuth error response: ${err instanceof Error ? err.message : String(err)}. Raw body: ${body}`,
    )
  }
}

async function registerClient(
  serverUrl: string,
  authorizationServerUrl: string,
  metadata: ServerMetadata | undefined,
  clientMetadata: Record<string, unknown>,
): Promise<ClientInformation> {
  let url: URL
  if (metadata) {
    if (!metadata.registration_endpoint) {
      throw new Error("Incompatible auth server: does not support dynamic client registration")
    }
    url = new URL(metadata.registration_endpoint)
  } else {
    url = new URL("/register", authorizationServerUrl)
  }
  const response = await oauthFetch(serverUrl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clientMetadata),
  })
  if (!response.ok) throw await errorFrom(response)
  const info = (await response.json()) as ClientInformation
  if (!info || typeof info.client_id !== "string") throw new Error("Client registration returned no client_id")
  return info
}

function clientAuthMethod(client: ClientInformation, supported: string[]): string {
  const hasSecret = client.client_secret !== undefined
  if (supported.length === 0) return hasSecret ? "client_secret_post" : "none"
  const own = client.token_endpoint_auth_method
  if (own && ["client_secret_basic", "client_secret_post", "none"].includes(own) && supported.includes(own)) return own
  if (hasSecret && supported.includes("client_secret_basic")) return "client_secret_basic"
  if (hasSecret && supported.includes("client_secret_post")) return "client_secret_post"
  if (supported.includes("none")) return "none"
  return hasSecret ? "client_secret_post" : "none"
}

async function tokenRequest(
  serverUrl: string,
  authorizationServerUrl: string,
  metadata: ServerMetadata | undefined,
  params: URLSearchParams,
  client: ClientInformation,
  resource?: URL,
): Promise<TokenSet> {
  const url = metadata?.token_endpoint ? new URL(metadata.token_endpoint) : new URL("/token", authorizationServerUrl)
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
  if (resource) params.set("resource", resource.href)
  const method = clientAuthMethod(client, metadata?.token_endpoint_auth_methods_supported ?? [])
  if (method === "client_secret_basic") {
    if (!client.client_secret) throw new Error("client_secret_basic authentication requires a client_secret")
    headers.Authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`
  } else {
    params.set("client_id", client.client_id)
    if (method === "client_secret_post" && client.client_secret) params.set("client_secret", client.client_secret)
  }
  const response = await oauthFetch(serverUrl, url, { method: "POST", headers, body: params.toString() })
  if (!response.ok) throw await errorFrom(response)
  const tokens = (await response.json()) as TokenSet
  if (!tokens || typeof tokens.access_token !== "string") throw new Error("The token response carried no access_token")
  return tokens
}

function startAuthorization(
  authorizationServerUrl: string,
  metadata: ServerMetadata | undefined,
  input: { client: ClientInformation; redirectUrl: string; scope?: string; state: string; resource?: URL },
): { url: URL; verifier: string } {
  let url: URL
  if (metadata) {
    url = new URL(metadata.authorization_endpoint)
    if (!metadata.response_types_supported.includes("code")) {
      throw new Error("Incompatible auth server: does not support response type code")
    }
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
      throw new Error("Incompatible auth server: does not support code challenge method S256")
    }
  } else {
    url = new URL("/authorize", authorizationServerUrl)
  }
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.client.client_id)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("redirect_uri", input.redirectUrl)
  url.searchParams.set("state", input.state)
  if (input.scope) url.searchParams.set("scope", input.scope)
  if (input.scope?.includes("offline_access")) url.searchParams.append("prompt", "consent")
  if (input.resource) url.searchParams.set("resource", input.resource.href)
  return { url, verifier }
}

// ---------------------------------------------------------------------------
// The callback listener and the browser
// ---------------------------------------------------------------------------

interface PendingCallback {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let callbackServer: Server | undefined
let currentPort = OAUTH_CALLBACK_PORT
let currentPath = OAUTH_CALLBACK_PATH
const pendingCallbacks = new Map<string, PendingCallback>()
const stateByServer = new Map<string, string>()

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

const PAGE_STYLE =
  "body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#161616;color:#e8e8e8}main{text-align:center;padding:2rem}p{color:#9a9a9a}code{display:block;margin-top:1rem;padding:.75rem 1rem;border-radius:8px;background:#2a1b1b;color:#f0a8a8}"

const PAGE_OK = `<!doctype html><html><head><meta charset="utf-8"><title>MCode</title><style>${PAGE_STYLE}</style></head><body><main><h1>Signed in</h1><p>You can close this tab and return to MCode.</p></main><script>setTimeout(() => window.close(), 2000)</script></body></html>`

const pageFailed = (reason: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>MCode</title><style>${PAGE_STYLE}</style></head><body><main><h1>Sign-in did not complete</h1><p>Return to MCode and try again.</p><code>${escapeHtml(reason)}</code></main></body></html>`

function forget(state: string) {
  for (const [name, held] of stateByServer) {
    if (held === state) {
      stateByServer.delete(name)
      break
    }
  }
}

function handleCallback(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", `http://127.0.0.1:${currentPort}`)
  if (url.pathname !== currentPath) {
    response.writeHead(404).end("Not found")
    return
  }
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const html = (status: number, body: string) => response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(body)
  if (!state) {
    html(400, pageFailed("Missing required state parameter"))
    return
  }
  if (error) {
    const reason = url.searchParams.get("error_description") || error
    const pending = pendingCallbacks.get(state)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingCallbacks.delete(state)
      forget(state)
      pending.reject(new Error(reason))
    }
    html(200, pageFailed(reason))
    return
  }
  if (!code) {
    html(400, pageFailed("No authorization code provided"))
    return
  }
  const pending = pendingCallbacks.get(state)
  if (!pending) {
    html(400, pageFailed("Invalid or expired state parameter"))
    return
  }
  clearTimeout(pending.timeout)
  pendingCallbacks.delete(state)
  forget(state)
  pending.resolve(code)
  html(200, PAGE_OK)
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })
}

function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  try {
    const url = new URL(redirectUri)
    const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
    return { port, path: url.pathname || OAUTH_CALLBACK_PATH }
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
}

/**
 * Starts the callback listener on the redirect's port.
 *
 * A port something else already answers on is refused rather than given way
 * to: whatever holds it would be handed the authorization code.
 */
export async function ensureCallbackServer(redirectUri?: string): Promise<void> {
  const { port, path } = parseRedirectUri(redirectUri)
  if (callbackServer && (currentPort !== port || currentPath !== path)) await stopCallbackServer()
  if (callbackServer) return
  if (await portInUse(port)) throw new Error(`Another program is listening on port ${port}, where the sign-in answer would arrive; close it and try again.`)
  currentPort = port
  currentPath = path
  const server = createServer(handleCallback)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
  server.unref()
  callbackServer = server
}

export function waitForCallback(state: string, name?: string): Promise<string> {
  if (name) stateByServer.set(name, state)
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pendingCallbacks.has(state)) return
      pendingCallbacks.delete(state)
      if (name) stateByServer.delete(name)
      reject(new Error("OAuth callback timeout - authorization took too long"))
    }, CALLBACK_TIMEOUT)
    pendingCallbacks.set(state, { resolve, reject, timeout })
  })
}

export function cancelCallback(name: string): void {
  const state = stateByServer.get(name)
  const key = state ?? name
  const pending = pendingCallbacks.get(key)
  if (!pending) return
  clearTimeout(pending.timeout)
  pendingCallbacks.delete(key)
  stateByServer.delete(name)
  pending.reject(new Error("Authorization cancelled"))
}

export async function stopCallbackServer(): Promise<void> {
  const server = callbackServer
  callbackServer = undefined
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const pending of pendingCallbacks.values()) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("OAuth callback server stopped"))
  }
  pendingCallbacks.clear()
  stateByServer.clear()
}

/*
 * The system browser, without Electron in the server layer. A test can name a
 * file to receive the address instead, so no browser opens during a probe.
 */
export function openInBrowser(url: string): void {
  if (!browserTarget(url)) return
  const log = process.env.MCODE_OAUTH_OPEN_FILE
  if (log) {
    appendFileSync(log, `${url}\n`)
    return
  }
  openUrl(url)
}
