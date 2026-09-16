import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP, type LookupFunction } from "node:net"
import type { LookupAddress } from "node:dns"
import type { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"

/**
 * The requests MCP sign-in makes to addresses the MCP server itself named.
 *
 * A remote MCP server's 401 names where its metadata lives, the metadata names
 * the authorization server, and that server's metadata names where to register
 * and where to trade the code for a token. Every one of those is the server's
 * choice. Round eight (X16) already refuses a loopback or private address, or
 * plain http, when it is spelled in the address; that check reads the host
 * name only, so a public-looking name whose DNS answers 127.0.0.1 - or answers
 * a public address when checked and a private one a moment later, which is
 * DNS rebinding - still reached this machine or the local network.
 *
 * So each such request resolves the name once, refuses it unless every address
 * is public, and connects to exactly the address it checked: the TLS
 * certificate is still verified against the name, but the name is not looked
 * up again. Redirects are followed by hand, each hop checked the same way.
 *
 * What stays as it was: the MCP server's own host is trusted, since the user
 * typed it; and a server that is itself on this machine or the local network
 * may name other hosts there, since nothing outside is steering it. MiMo's
 * sign-in (the MCP SDK's) makes none of these checks; this is stricter only
 * against addresses no legitimate public server names.
 */

/** Everything that is not the public internet. */
const NOT_PUBLIC = (() => {
  const list = new BlockList()
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4")
  }
  for (const [network, prefix] of [
    // The unspecified and loopback addresses, and the old IPv4-compatible form (::a.b.c.d).
    ["::", 96],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6")
  }
  return list
})()

/** Whether an address is on the public internet; an IPv4 address written inside IPv6 is judged as IPv4. */export function publicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "")
  const family = isIP(bare)
  if (family === 4) return !NOT_PUBLIC.check(bare, "ipv4")
  if (family !== 6) return false
  // BlockList judges an IPv4-mapped address (::ffff:a.b.c.d, in either spelling) by the IPv4 rules.
  return !NOT_PUBLIC.check(bare, "ipv6")
}

export class UnsafeAddressError extends Error {
  constructor(url: URL, why: string) {
    super(`MCP sign-in refused to contact ${url.origin}: ${why}`)
    this.name = "UnsafeAddressError"
  }
}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>

const systemResolve: Resolve = async (host) => {
  const bare = host.replace(/^\[|\]$/g, "")
  const family = isIP(bare)
  if (family) return [{ address: bare, family }]
  return lookup(bare, { all: true, verbatim: true })
}

/** Where a request will connect, once checked: nothing to pin for the server's own host. */
export interface CheckedTarget {
  pin?: { address: string; family: number }
}

/**
 * Checks one address the server named, resolving it once.
 *
 * Throws `UnsafeAddressError` for an address that may not be contacted; the
 * result says which address to connect to.
 */
export async function checkTarget(serverUrl: string, target: URL, resolve: Resolve = systemResolve): Promise<CheckedTarget> {
  const server = new URL(serverUrl)
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new UnsafeAddressError(target, "not a web address")
  if (target.username || target.password) throw new UnsafeAddressError(target, "the address carries credentials")
  if (target.hostname.toLowerCase() === server.hostname.toLowerCase()) return {}
  if (target.protocol !== "https:") throw new UnsafeAddressError(target, "another host must be reached over https")
  let addresses: { address: string; family: number }[]
  try {
    addresses = await resolve(target.hostname)
  } catch {
    throw new UnsafeAddressError(target, "the host name did not resolve")
  }
  if (!addresses.length) throw new UnsafeAddressError(target, "the host name did not resolve")
  if (addresses.some((entry) => !publicAddress(entry.address)) && (await serverIsPublic(server, resolve))) {
    throw new UnsafeAddressError(target, "it resolves to an address on this machine or a private network")
  }
  return { pin: { address: addresses[0]!.address, family: addresses[0]!.family } }
}

/* A server that cannot be resolved is treated as public: the stricter reading. */
async function serverIsPublic(server: URL, resolve: Resolve): Promise<boolean> {
  try {
    const addresses = await resolve(server.hostname)
    return !addresses.length || addresses.some((entry) => publicAddress(entry.address))
  } catch {
    return true
  }
}

export interface OAuthRequest {
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_HOPS = 5
const MAX_BODY = 4 * 1024 * 1024
const TIMEOUT_MS = 30_000

/**
 * A request to an address the MCP server named, checked and pinned at every
 * hop. Answers with a standard `Response`; a network failure is a `TypeError`,
 * as `fetch` reports one, and a refused address is an `UnsafeAddressError`.
 */
export async function oauthFetch(serverUrl: string, url: URL, init: OAuthRequest = {}, resolve: Resolve = systemResolve): Promise<Response> {
  let current = new URL(url)
  let method = init.method ?? "GET"
  let body = init.body
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const target = await checkTarget(serverUrl, current, resolve)
    const response = target.pin
      ? await send(current, { method, headers: init.headers, body }, target.pin)
      : await fetch(current, { method, headers: init.headers, body, redirect: "manual" })
    const location = response.headers.get("location")
    if (!REDIRECTS.has(response.status) || !location) return response
    await response.body?.cancel().catch(() => {})
    current = new URL(location, current)
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET"
      body = undefined
    }
  }
  throw new TypeError("too many redirects")
}

/** One request to a pinned address; the body is read whole, as the callers read it anyway. */
function send(url: URL, init: OAuthRequest, pin: NonNullable<CheckedTarget["pin"]>): Promise<Response> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest
  // The name is not looked up again: the connection goes to the address that was checked.
  const pinned: LookupFunction = (_host, options, done) => {
    if (options.all) (done as unknown as (error: null, addresses: LookupAddress[]) => void)(null, [{ address: pin.address, family: pin.family }])
    else done(null, pin.address, pin.family)
  }
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: init.method,
        headers: {
          "Accept-Encoding": "gzip, deflate, br",
          ...init.headers,
          ...(init.body !== undefined ? { "Content-Length": String(Buffer.byteLength(init.body)) } : {}),
        },
        timeout: TIMEOUT_MS,
        lookup: pinned,
      },
      (response) => {
        const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase()
        // fetch undoes a compressed body; so does this.
        const incoming: Readable =
          encoding === "gzip" || encoding === "x-gzip"
            ? response.pipe(createGunzip())
            : encoding === "deflate"
              ? response.pipe(createInflate())
              : encoding === "br"
                ? response.pipe(createBrotliDecompress())
                : response
        const chunks: Buffer[] = []
        let size = 0
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY) {
            response.destroy()
            reject(new TypeError("response too large"))
            return
          }
          chunks.push(chunk)
        })
        response.on("error", (error) => reject(new TypeError(String(error))))
        incoming.on("error", (error) => reject(new TypeError(String(error))))
        incoming.on("end", () => {
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            // The body handed on is already decoded, so its encoding and length no longer describe it.
            if (name === "content-encoding" || name === "content-length") continue
            if (Array.isArray(value)) for (const item of value) headers.append(name, item)
            else if (value !== undefined) headers.set(name, value)
          }
          const status = response.statusCode ?? 502
          const empty = status === 204 || status === 205 || status === 304
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status: status < 200 || status > 599 ? 502 : status, headers }))
        })
      },
    )
    outgoing.on("timeout", () => outgoing.destroy(new Error("timed out")))
    outgoing.on("error", (error) => reject(new TypeError(String(error))))
    if (init.body !== undefined) outgoing.write(init.body)
    outgoing.end()
  })
}
