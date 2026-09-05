import pkg from "../../../package.json"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"

/**
 * OAuth login for provider subscriptions.
 *
 * These flows use *public* clients with PKCE, which is the whole reason a
 * third-party app can offer them at all: a public client has no secret to be
 * issued, so the client id shipped inside the vendor's own CLI is public by
 * design and the proof-of-possession comes from the code verifier instead. The
 * ids below are the ones those CLIs send.
 *
 * The redirect lands on a loopback server this process owns, so the code never
 * leaves the machine.
 */

export interface OAuthTokens {
  access: string
  refresh?: string
  /** Epoch ms; refreshed slightly early rather than exactly on expiry. */
  expires?: number
  /** When these tokens were issued, so an unstated lifetime can still age out. */
  obtained?: number
  /** Which ChatGPT workspace the login belongs to - the API demands it. */
  accountId?: string
}

export interface OAuthProvider {
  id: string
  authorizeURL: string
  tokenURL: string
  clientId: string
  scope: string
  /** The vendor pins its CLI to one loopback port; the redirect must match. */
  port: number
  callbackPath: string
  extra: Record<string, string>
  /** Device authorization, for machines with no browser of their own. */
  device: {
    startURL: string
    pollURL: string
    /** Where the user types the code, shown alongside it. */
    verificationURL: string
    redirectURI: string
  }
}

export const CHATGPT: OAuthProvider = {
  id: "chatgpt",
  authorizeURL: "https://auth.openai.com/oauth/authorize",
  tokenURL: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: "openid profile email offline_access",
  port: 1455,
  callbackPath: "/auth/callback",
  extra: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "mcode",
  },
  device: {
    startURL: "https://auth.openai.com/api/accounts/deviceauth/usercode",
    pollURL: "https://auth.openai.com/api/accounts/deviceauth/token",
    verificationURL: "https://auth.openai.com/codex/device",
    redirectURI: "https://auth.openai.com/deviceauth/callback",
  },
}

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = { chatgpt: CHATGPT }

/** Identifies this client to the vendor, as its own CLI does. */
export const USER_AGENT = `mcode/${pkg.version}`

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface Pending {
  provider: OAuthProvider
  verifier: string
  state: string
  redirectURI: string
  url: string
}

/** Builds the authorize URL and the secrets that must survive until exchange. */
export function begin(provider: OAuthProvider): Pending {
  const verifier = randomBytes(64).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url")
  const state = randomBytes(32).toString("base64url")
  const redirectURI = `http://localhost:${provider.port}${provider.callbackPath}`

  const params = new URLSearchParams({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: redirectURI,
    scope: provider.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...provider.extra,
  })

  return { provider, verifier, state, redirectURI, url: `${provider.authorizeURL}?${params}` }
}

// ---------------------------------------------------------------------------
// Loopback callback
// ---------------------------------------------------------------------------

function page(message: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>MCode</title>` +
    `<body style="font:15px/1.6 system-ui;display:grid;place-items:center;` +
    `height:100vh;margin:0;background:#0a0a0a;color:#e7e7e7">` +
    `<p>${message}</p></body>`
  )
}

export class CallbackServer {
  private server?: Server
  /** Settles the in-flight listen() when the attempt is abandoned. */
  private abandon?: () => void

  /**
   * Resolves with the authorization code once the browser comes back.
   *
   * The state check is not ceremony: without it any page the user happens to
   * have open could hit this port and feed us a code from a different login.
   */
  listen(pending: Pending, timeoutMs = 300_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, code?: string) => {
        clearTimeout(timer)
        this.abandon = undefined
        this.close()
        if (error) reject(error)
        else resolve(code as string)
      }

      const timer = setTimeout(() => finish(new Error("auth.timeout")), timeoutMs)
      this.abandon = () => finish(new Error("auth.cancelled"))

      this.server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", `http://localhost:${pending.provider.port}`)
        if (url.pathname !== pending.provider.callbackPath) {
          response.writeHead(404).end()
          return
        }

        const failure = url.searchParams.get("error")
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")

        if (failure) {
          response.writeHead(200, { "Content-Type": "text/html" }).end(page("Login failed."))
          finish(new Error(failure))
          return
        }
        if (state !== pending.state) {
          response.writeHead(400, { "Content-Type": "text/html" }).end(page("Invalid state."))
          finish(new Error("auth.state"))
          return
        }
        if (!code) {
          response.writeHead(400, { "Content-Type": "text/html" }).end(page("No code returned."))
          finish(new Error("auth.nocode"))
          return
        }

        response
          .writeHead(200, { "Content-Type": "text/html" })
          .end(page("Signed in. You can close this tab."))
        finish(undefined, code)
      })

      this.server.on("error", (cause) => finish(cause as Error))
      this.server.listen(pending.provider.port, "127.0.0.1")
    })
  }

  /**
   * Ends the attempt for good. Closing the socket alone would leave listen()
   * pending with its timeout still armed, and that stale rejection would later
   * land on whatever attempt had replaced this one.
   */
  close(): void {
    const abandon = this.abandon
    this.abandon = undefined
    this.server?.close()
    this.server = undefined
    abandon?.()
  }
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

function toTokens(payload: TokenResponse): OAuthTokens {
  const claims = payload.id_token ? decodeClaims(payload.id_token) : undefined
  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
    obtained: Date.now(),
    accountId: claims ? accountId(claims) : undefined,
  }
}

export async function exchange(pending: Pending, code: string): Promise<OAuthTokens> {
  const response = await fetch(pending.provider.tokenURL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectURI,
      client_id: pending.provider.clientId,
      code_verifier: pending.verifier,
    }).toString(),
  })
  if (!response.ok) throw new Error(`auth.exchange:${response.status}`)
  return toTokens((await response.json()) as TokenResponse)
}

/** Assumed access-token lifetime when the issuer states none. */
const ASSUMED_TTL = 45 * 60_000

/** Renew a minute early, so a turn never starts on a token about to expire. */
const EARLY = 60_000

/**
 * An issuer that states no lifetime used to mean "never refresh", so the token
 * was used until it started failing. Age it out on an assumed lifetime instead:
 * refreshing early is harmless, running on a dead token is not. Tokens stored
 * before `obtained` existed have neither field and refresh once, which gives
 * them one.
 */
export function needsRefresh(tokens: OAuthTokens, now = Date.now()): boolean {
  const expiry = tokens.expires ?? (tokens.obtained !== undefined ? tokens.obtained + ASSUMED_TTL : undefined)
  return expiry === undefined || expiry - now < EARLY
}

export async function refresh(provider: OAuthProvider, token: string): Promise<OAuthTokens> {
  const response = await fetch(provider.tokenURL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: provider.clientId,
      scope: provider.scope,
    }).toString(),
  })
  if (!response.ok) throw new Error(`auth.refresh:${response.status}`)
  const tokens = toTokens((await response.json()) as TokenResponse)
  // A refresh response usually omits the refresh token, meaning "keep the old".
  return { ...tokens, refresh: tokens.refresh ?? token }
}


// ---------------------------------------------------------------------------
// Device authorization
// ---------------------------------------------------------------------------

/**
 * The no-browser path. Instead of a loopback redirect the user is given a short
 * code to type on another device, and this process polls until they finish.
 */
/** Added to the advertised poll interval so we never crowd the endpoint. */
const POLL_BUFFER = 3_000

export interface DeviceAuth {
  provider: OAuthProvider
  userCode: string
  deviceAuthId: string
  verificationURL: string
  intervalMs: number
}

export async function beginDevice(provider: OAuthProvider): Promise<DeviceAuth> {
  const response = await fetch(provider.device.startURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client_id: provider.clientId }),
  })
  if (!response.ok) throw new Error(`auth.device:${response.status}`)

  const payload = (await response.json()) as {
    user_code?: string
    device_auth_id?: string
    interval?: string | number
  }
  return {
    provider,
    userCode: payload.user_code ?? "",
    deviceAuthId: payload.device_auth_id ?? "",
    verificationURL: provider.device.verificationURL,
    intervalMs: Math.max(Number(payload.interval) || 5, 1) * 1000,
  }
}

/**
 * Polls until the code is approved, then trades the authorization code the
 * device endpoint hands back for real tokens. The verifier comes from the
 * server here rather than being generated locally - the device flow moves the
 * PKCE pair to whichever side holds the browser.
 */
export async function pollDevice(auth: DeviceAuth, signal: AbortSignal): Promise<OAuthTokens> {
  while (!signal.aborted) {
    const response = await fetch(auth.provider.device.pollURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ device_auth_id: auth.deviceAuthId, user_code: auth.userCode }),
      signal,
    })

    if (response.ok) {
      const granted = (await response.json()) as {
        authorization_code?: string
        code_verifier?: string
      }
      const exchanged = await fetch(auth.provider.tokenURL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: granted.authorization_code ?? "",
          redirect_uri: auth.provider.device.redirectURI,
          client_id: auth.provider.clientId,
          code_verifier: granted.code_verifier ?? "",
        }).toString(),
      })
      if (!exchanged.ok) throw new Error(`auth.exchange:${exchanged.status}`)
      return toTokens((await exchanged.json()) as TokenResponse)
    }

    /*
     * Only 403 and 404 mean "not approved yet". Treating every 4xx as pending
     * made an expired or revoked code poll forever instead of reporting a
     * failure the user could act on.
     */
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`auth.device:${response.status}`)
    }

    // A little more than the advertised interval, to stay clear of rate limits.
    await new Promise((resolve) => setTimeout(resolve, auth.intervalMs + POLL_BUFFER))
  }
  throw new Error("auth.cancelled")
}

// ---------------------------------------------------------------------------
// id_token claims
// ---------------------------------------------------------------------------

export function decodeClaims(idToken: string): Record<string, unknown> | undefined {
  const parts = idToken.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

/** The workspace id the codex endpoint wants, wherever the issuer put it. */
export function accountId(claims: Record<string, unknown>): string | undefined {
  const nested = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined
  const orgs = claims.organizations as { id?: string }[] | undefined
  return (claims.chatgpt_account_id as string) ?? nested?.chatgpt_account_id ?? orgs?.[0]?.id
}
