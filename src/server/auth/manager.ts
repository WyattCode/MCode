import { exec } from "node:child_process"
import type { AuthMethodKind } from "@shared/protocol"
import type { Bus } from "../bus"
import type { Config } from "../config"
import { discoverSubscriptionModels } from "../provider/discover"
import {
  CallbackServer,
  OAUTH_PROVIDERS,
  begin,
  beginDevice,
  exchange,
  needsRefresh,
  pollDevice,
  refresh,
  type OAuthTokens,
  type Pending,
} from "./oauth"

/** Opens the system browser without pulling Electron into the server layer. */
function openExternal(url: string): void {
  const quoted = url.replace(/"/g, '%22')
  if (process.platform === "win32") exec(`start "" "${quoted}"`)
  else if (process.platform === "darwin") exec(`open "${quoted}"`)
  else exec(`xdg-open "${quoted}"`)
}

/**
 * Drives subscription logins.
 *
 * The browser flow cannot be a plain request/response: the user may take
 * minutes on the vendor's page, and holding an RPC open that long would stall
 * the socket. So begin() returns as soon as the URL exists and the outcome
 * arrives later as an event.
 */
export interface StartedLogin {
  /** Where to send the user - a vendor page, or the device-code page. */
  url: string
  /** Short code the user types on the other device, when there is one. */
  userCode?: string
}

export class AuthManager {
  /**
   * Attempts are identified, not just named by provider: an abandoned login can
   * still reject minutes later, and comparing provider alone let that stale
   * result cancel the attempt that had replaced it.
   */
  private attempts = 0
  private active?: {
    id: number
    provider: string
    pending?: Pending
    server?: CallbackServer
    controller?: AbortController
  }

  constructor(
    private readonly config: Config,
    private readonly bus: Bus,
  ) {}

  async start(provider: string, method: AuthMethodKind): Promise<StartedLogin> {
    const definition = OAUTH_PROVIDERS[provider]
    if (!definition) throw new Error(`${provider} does not support OAuth`)

    this.cancel()
    const id = ++this.attempts

    if (method === "oauth-headless") {
      // Device authorization: nothing here can host a redirect the other
      // machine could reach, so the vendor holds the browser half and we poll.
      const auth = await beginDevice(definition)
      const controller = new AbortController()
      this.active = { id, provider, controller }

      pollDevice(auth, controller.signal)
        .then((tokens) => this.store(id, provider, tokens))
        .catch((cause: Error) => this.fail(id, provider, cause))

      return { url: auth.verificationURL, userCode: auth.userCode }
    }

    const pending = begin(definition)
    const server = new CallbackServer()
    this.active = { id, provider, pending, server }

    server
      .listen(pending)
      .then((code) => exchange(pending, code))
      .then((tokens) => this.store(id, provider, tokens))
      .catch((cause: Error) => this.fail(id, provider, cause))

    openExternal(pending.url)
    return { url: pending.url }
  }

  cancel(): void {
    this.active?.server?.close()
    this.active?.controller?.abort()
    this.active = undefined
  }

  private fail(id: number, provider: string, cause: Error): void {
    if (this.active?.id !== id) return
    this.active = undefined
    // Cancelling is a user action, not a failure worth reporting back.
    if (cause.message === "auth.cancelled" || cause.name === "AbortError") return
    this.bus.publish({ type: "auth.failed", provider, message: cause.message })
  }

  async signOut(provider: string): Promise<void> {
    await this.config.setTokens(provider, undefined)
  }

  /**
   * Returns a usable access token, renewing it when it is close to expiry.
   * Called on every turn, so it must be cheap when nothing needs doing.
   */
  async accessToken(provider: string): Promise<OAuthTokens | undefined> {
    const stored = this.config.tokens(provider)
    if (!stored) return undefined

    const definition = OAUTH_PROVIDERS[provider]
    if (!definition || !stored.refresh) return stored

    if (!needsRefresh(stored)) return stored

    let renewed: OAuthTokens
    try {
      renewed = await refresh(definition, stored.refresh)
    } catch (cause) {
      // A rejected refresh means the grant is gone. Keeping the tokens would
      // leave the UI claiming "signed in" while every turn failed.
      const status = Number(/auth\.refresh:(\d+)/.exec((cause as Error).message)?.[1])
      if (status >= 400 && status < 500) {
        await this.config.setTokens(provider, undefined)
        // Said out loud, so the reader learns why the provider went quiet and can sign in again.
        const name = this.config.definition(provider)?.name ?? provider
        this.bus.publish({ type: "auth.expired", provider, name, providers: this.config.providers() })
        return undefined
      }
      throw cause
    }
    // The refresh response carries no id_token, so keep the account we know.
    const merged = { ...renewed, accountId: renewed.accountId ?? stored.accountId }
    await this.config.setTokens(provider, merged)
    return merged
  }

  private async store(id: number, provider: string, tokens: OAuthTokens): Promise<void> {
    if (this.active?.id !== id) return
    await this.config.setTokens(provider, tokens)
    this.active = undefined

    // Signing in is the first moment the live model list is reachable. A
    // failure here is not fatal - the catalog fallback still fills the picker.
    const definition = this.config.definition(provider)
    if (definition?.kind === "chatgpt" && definition.baseURL) {
      const models = await discoverSubscriptionModels(
        definition.baseURL,
        tokens.access,
        tokens.accountId,
      ).catch(() => [])
      if (models.length) await this.config.setDiscovered(provider, models)
    }

    this.bus.publish({
      type: "auth.completed",
      provider,
      providers: this.config.providers(),
    })
  }
}
