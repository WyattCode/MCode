/**
 * The checks' own servers ask for port 0, and on a machine whose dynamic range
 * starts low the system can answer with one fetch refuses ("bad port"), which
 * failed an unrelated check now and then. A server that lands on such a port is
 * quietly moved to another before anyone hears it is listening.
 *
 * Imported first by the check scripts; the app itself takes its ports through
 * listenForWindow (src/server/index.ts) and preview-server.ts.
 */
import net from "node:net"
import { isBlockedPort } from "../src/shared/blocked-ports"

const listen = net.Server.prototype.listen

/** Also treated as refused - only so the check on this patch can make it move a server. */
export const moveAlso: { next?: (port: number) => boolean } = {}

function asksForAnyPort(args: unknown[]): boolean {
  const first = args[0]
  if (first === 0 || first === "0") return true
  return typeof first === "object" && first !== null && "port" in first && Number((first as { port: unknown }).port) === 0
}

net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  if (!asksForAnyPort(args)) return listen.apply(this, args as Parameters<typeof listen>)
  const server = this
  const emit = server.emit
  // A refused port is moved a bounded number of times, as both of the app's own listen loops are: a suite that never hears "listening" hangs with nothing to read.
  let moves = 0
  server.emit = function (event: string | symbol, ...rest: unknown[]) {
    if (event === "listening") {
      const bound = server.address()
      if (typeof bound === "object" && bound && (isBlockedPort(bound.port) || moveAlso.next?.(bound.port)) && moves++ < 8) {
        // A "close" listener would hear this one too; none is added before a server is up.
        server.close(() => {
          listen.apply(server, args.filter((arg) => typeof arg !== "function") as Parameters<typeof listen>)
        })
        return true
      }
      server.emit = emit
    }
    return emit.call(this, event, ...rest)
  } as typeof server.emit
  return listen.apply(this, args as Parameters<typeof listen>)
} as typeof listen
