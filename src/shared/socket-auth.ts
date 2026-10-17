/**
 * How a client proves it belongs to this launch of the app.
 *
 * The secret rides in the WebSocket handshake's subprotocol list - the one
 * field a page can set on a socket - and never in a URL. The server answers
 * with the plain name, so the secret is never sent back. The server's side of
 * this is `server/socket-guard.ts`.
 */

/** The subprotocol the server picks. */
export const SOCKET_PROTOCOL = "mcode"

/** The prefix of the offered subprotocol that carries the secret. */
export const SECRET_PROTOCOL_PREFIX = "mcode.auth."

/** The protocols a client offers: the plain one first, then the one carrying the secret. */
export function socketProtocols(secret: string): string[] {
  return [SOCKET_PROTOCOL, `${SECRET_PROTOCOL_PREFIX}${secret}`]
}

/**
 * MCode Remote (docs/remote-design.md): the pairing token rides the same way -
 * in the subprotocol list, never in a URL. The phone offers
 * `mcode.remote.<token>`; the gateway's side is `server/remote/gateway.ts`.
 */
export const REMOTE_PROTOCOL_PREFIX = "mcode.remote."

/** The subprotocols a paired phone offers: the plain one first, then the token. */
export function remoteProtocols(token: string): string[] {
  return [SOCKET_PROTOCOL, `${REMOTE_PROTOCOL_PREFIX}${token}`]
}
