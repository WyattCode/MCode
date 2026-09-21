import net from "node:net"
import { isBlockedPort } from "@shared/blocked-ports"

/**
 * A free loopback port the window is allowed to connect to: port 0 is asked
 * for again while the system's answer is one a browser refuses.
 */
export async function windowSafePort(host: string): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = net.createServer()
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject)
      probe.listen(0, host, () => {
        const bound = probe.address()
        resolve(typeof bound === "object" && bound ? bound.port : 0)
      })
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    if (port && !isBlockedPort(port)) return port
  }
  return 0
}
