import { appendFileSync } from "node:fs"
import { exec } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createHash, randomBytes } from "node:crypto"
import type { Storage } from "./storage"

/**
 * Signing in to a remote MCP server, as MiMo's 授权 does.
 *
 * The MCP authorization flow is OAuth 2.1 with the discovery and dynamic client
 * registration the spec asks servers to offer: the server's 401 names its
 * protected-resource metadata, that names the authorization server, whose
 * metadata gives the endpoints. This registers MCode as a public client, sends
 * the reader's browser to the authorization page with a PKCE challenge, takes
 * the code on a loopback port that exists only for this attempt, and keeps the
 * tokens it is given - on this machine, in the app's own storage, never shown
 * to the window.
 */

export interface McpOAuthRecord {
  /** The server URL the tokens were issued for; a server pointed elsewhere asks again. */
  url: string
  clientId: string
  clientSecret?: string
  tokenEndpoint: string
  resource: string
  access: string
  refresh?: string
  /** Epoch ms. */
  expires?: number
}

const KEY = "mcp-auth"
const TIMEOUT = 300_000
/** Tokens are renewed this long before they run out rather than on the dot. */
const EARLY = 60_000

/*
 * The system browser, without Electron in the server layer. A test can name a
 * file to receive the address instead, so no browser opens during a probe.
 */
function openInBrowser(url: string): void {
  const log = process.env.MCODE_OAUTH_OPEN_FILE
  if (log) {
    appendFileSync(log, `${url}\n`)
    return
  }
  const quoted = url.replace(/"/g, "%22")
  if (process.platform === "win32") exec(`start "" "${quoted}"`)
  else if (process.platform === "darwin") exec(`open "${quoted}"`)
  else exec(`xdg-open "${quoted}"`)
}

async function readJSON<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } })
    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

interface Endpoints {
  resource: string
  scopes?: string[]
  authorize: string
  token: string
  register?: string
}

async function discover(serverURL: string, headers?: Record<string, string>): Promise<Endpoints> {
  const target = new URL(serverURL)
  let hint: string | undefined
  try {
    const probe = await fetch(serverURL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(headers ?? {}) },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "MCode", version: "0" } },
      }),
    })
    hint = /resource_metadata="([^"]+)"/i.exec(probe.headers.get("www-authenticate") ?? "")?.[1]
    await probe.body?.cancel().catch(() => {})
  } catch {
    // A server that cannot be reached at all is found out by the lookups below.
  }

  const path = target.pathname.replace(/\/$/, "")
  let resource: { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] } | undefined
  for (const candidate of [
    hint,
    `${target.origin}/.well-known/oauth-protected-resource${path}`,
    `${target.origin}/.well-known/oauth-protected-resource`,
  ]) {
    if (!candidate) continue
    resource = await readJSON(candidate)
    if (resource) break
  }

  const issuer = new URL(resource?.authorization_servers?.[0] ?? target.origin)
  const issuerPath = issuer.pathname.replace(/\/$/, "")
  let meta: { authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string } | undefined
  for (const candidate of [
    `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
    issuerPath ? `${issuer.origin}${issuerPath}/.well-known/openid-configuration` : undefined,
  ]) {
    if (!candidate) continue
    meta = await readJSON(candidate)
    if (meta) break
  }

  return {
    resource: resource?.resource ?? serverURL,
    ...(resource?.scopes_supported?.length ? { scopes: resource.scopes_supported } : {}),
    authorize: meta?.authorization_endpoint ?? `${issuer.origin}/authorize`,
    token: meta?.token_endpoint ?? `${issuer.origin}/token`,
    // Without metadata the spec's default path is tried; with metadata, only what it names.
    register: meta ? meta.registration_endpoint : `${issuer.origin}/register`,
  }
}

const PAGE_OK =
  '<!doctype html><meta charset="utf-8"><title>MCode</title><p style="font:15px system-ui;margin:48px">Authorization complete. You can close this tab and return to MCode.</p>'
const PAGE_FAILED =
  '<!doctype html><meta charset="utf-8"><title>MCode</title><p style="font:15px system-ui;margin:48px">Authorization did not complete. Return to MCode and try again.</p>'

/* A loopback listener for this one attempt, on whatever port is free. */
async function loopback(state: string) {
  let settle: (error?: Error, code?: string) => void = () => {}
  const code = new Promise<string>((resolve, reject) => {
    settle = (error, value) => (error ? reject(error) : resolve(value ?? ""))
  })
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/callback") {
      response.writeHead(404).end()
      return
    }
    const error = url.searchParams.get("error")
    const given = url.searchParams.get("code")
    const matches = url.searchParams.get("state") === state
    const ok = !error && Boolean(given) && matches
    response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" }).end(ok ? PAGE_OK : PAGE_FAILED)
    if (error) settle(new Error(url.searchParams.get("error_description") || error))
    else if (!given || !matches) settle(new Error("the authorization reply did not belong to this request"))
    else settle(undefined, given)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const timer = setTimeout(() => settle(new Error("authorization timed out")), TIMEOUT)
  // Settled already or not, nothing waits on it once the attempt ends.
  code.catch(() => {})
  return {
    redirect: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => {
      clearTimeout(timer)
      server.close()
    },
  }
}

async function tokenRequest(endpoint: string, body: URLSearchParams): Promise<Pick<McpOAuthRecord, "access" | "refresh" | "expires">> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  })
  if (!response.ok) throw new Error(`token request failed (HTTP ${response.status})`)
  const tokens = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!tokens.access_token) throw new Error("the token response carried no access token")
  return {
    access: tokens.access_token,
    ...(tokens.refresh_token ? { refresh: tokens.refresh_token } : {}),
    ...(typeof tokens.expires_in === "number" ? { expires: Date.now() + tokens.expires_in * 1000 } : {}),
  }
}

export class McpOAuthStore {
  constructor(private readonly storage: Storage) {}

  private async all(): Promise<Record<string, McpOAuthRecord>> {
    return (await this.storage.read<Record<string, McpOAuthRecord>>(KEY)) ?? {}
  }

  async set(name: string, record: McpOAuthRecord): Promise<void> {
    const all = await this.all()
    all[name] = record
    await this.storage.write(KEY, all)
  }

  /** The tokens to send to this server, renewed first when they are about to run out. */
  async usable(name: string, url: string): Promise<McpOAuthRecord | undefined> {
    const record = (await this.all())[name]
    if (!record || record.url !== url) return undefined
    if (record.refresh && record.expires !== undefined && record.expires - Date.now() < EARLY) {
      return (await this.renew(name, record)) ?? record
    }
    return record
  }

  /** Trades the refresh token for new tokens; nothing when the server will not. */
  async renew(name: string, record: McpOAuthRecord): Promise<McpOAuthRecord | undefined> {
    if (!record.refresh) return undefined
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: record.refresh,
        client_id: record.clientId,
        resource: record.resource,
      })
      if (record.clientSecret) body.set("client_secret", record.clientSecret)
      const tokens = await tokenRequest(record.tokenEndpoint, body)
      const next: McpOAuthRecord = { ...record, ...tokens, refresh: tokens.refresh ?? record.refresh }
      await this.set(name, next)
      return next
    } catch {
      return undefined
    }
  }
}

/** The whole sign-in for one server; resolves once its tokens are stored. */
export async function authorizeMcpServer(
  store: McpOAuthStore,
  name: string,
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  const found = await discover(url, headers)
  if (!found.register) throw new Error("this server offers no client registration")
  const state = randomBytes(24).toString("base64url")
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const callback = await loopback(state)
  try {
    const registered = await fetch(found.register, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "MCode",
        redirect_uris: [callback.redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    if (!registered.ok) throw new Error(`client registration failed (HTTP ${registered.status})`)
    const client = (await registered.json()) as { client_id?: string; client_secret?: string }
    if (!client.client_id) throw new Error("client registration returned no client id")

    const page = new URL(found.authorize)
    page.searchParams.set("response_type", "code")
    page.searchParams.set("client_id", client.client_id)
    page.searchParams.set("redirect_uri", callback.redirect)
    page.searchParams.set("code_challenge", challenge)
    page.searchParams.set("code_challenge_method", "S256")
    page.searchParams.set("state", state)
    page.searchParams.set("resource", found.resource)
    if (found.scopes) page.searchParams.set("scope", found.scopes.join(" "))
    openInBrowser(page.toString())

    const code = await callback.code
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callback.redirect,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: found.resource,
    })
    if (client.client_secret) body.set("client_secret", client.client_secret)
    const tokens = await tokenRequest(found.token, body)
    await store.set(name, {
      url,
      clientId: client.client_id,
      ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
      tokenEndpoint: found.token,
      resource: found.resource,
      ...tokens,
    })
  } finally {
    callback.close()
  }
}
