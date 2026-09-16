import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { SECRET_PROTOCOL_PREFIX } from "@shared/socket-auth"

export { SOCKET_PROTOCOL, socketProtocols } from "@shared/socket-auth"

/**
 * Who may open the backend's socket.
 *
 * The socket speaks for the user's filesystem and can open a terminal, and a
 * WebSocket handshake is not bound by CORS: any page in any browser on this
 * machine can dial 127.0.0.1 and would be let in by a socket that only checks
 * the address it listens on. MiMo guards each of its loopback channels with a
 * secret made at launch, a Host check against its own port and a constant-time
 * comparison; this is the same posture.
 *
 * The secret travels in the handshake's subprotocol list - the one field a page
 * can set on a WebSocket - and never in a URL, so nothing that can read an
 * address bar, a Referer or a log of requested URLs ever sees it.
 */

/** A fresh secret for one launch: 32 random bytes, in characters a subprotocol may hold. */
export function newSocketSecret(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Equal without saying how nearly.
 *
 * Both sides are hashed first so the comparison always runs over the same
 * length - `timingSafeEqual` throws on a length mismatch, and returning early
 * on one would itself tell a caller the secret's length.
 */
export function sameSecret(offered: string, secret: string): boolean {
  const a = createHash("sha256").update(offered).digest()
  const b = createHash("sha256").update(secret).digest()
  return timingSafeEqual(a, b) && secret.length > 0
}

export interface Handshake {
  /** The Host header as sent. */
  host?: string
  /** The Origin header as sent; absent for a client that is not a browser. */
  origin?: string
  /** The raw Sec-WebSocket-Protocol header. */
  protocols?: string
}

export interface Admission {
  port: number
  secret: string
  /** Browser origins that belong to the app itself: the renderer page's own. */
  origins: readonly string[]
}

export type Refusal = "host" | "origin" | "secret"

/**
 * Why a handshake is refused, or undefined when it may proceed.
 *
 * The Host must name this very port on a loopback name, which a page reaching
 * the socket through a rebound DNS name cannot produce. A browser always sends
 * an Origin, and only the app's own page is accepted; a client with no Origin
 * is a local process rather than a page, and it still has to hold the secret.
 */
export function refusalOf(handshake: Handshake, admission: Admission): Refusal | undefined {
  const hosts = [`127.0.0.1:${admission.port}`, `localhost:${admission.port}`]
  if (!handshake.host || !hosts.includes(handshake.host.toLowerCase())) return "host"
  if (handshake.origin !== undefined && !admission.origins.includes(handshake.origin)) return "origin"
  const offered = (handshake.protocols ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(SECRET_PROTOCOL_PREFIX))
  if (!offered || !sameSecret(offered.slice(SECRET_PROTOCOL_PREFIX.length), admission.secret)) return "secret"
  return undefined
}

/**
 * The origin a renderer page sends from where it was loaded: the dev server's
 * own origin, or `file://` for the packaged page (Chromium's spelling for any
 * file page, which is why the packaged window is the only file page allowed a
 * preload - a file opened in the in-app browser runs in its own partition with
 * no secret to offer).
 */
export function rendererOrigins(devServer?: string): string[] {
  if (!devServer) return ["file://"]
  try {
    return [new URL(devServer).origin]
  } catch {
    return []
  }
}
