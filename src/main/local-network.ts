import dgram from "node:dgram"
import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import { alreadyAsked, buildStamp, sendQuery } from "./local-network-core"

/*
 * Asks for Local Network access once per installed build, at first launch.
 *
 * The app's own sockets are all loopback, which macOS exempts - but a provider
 * can be pointed at a runtime on another machine (LM Studio on the desk next
 * door), and that is local network traffic. Left alone, the system prompt would
 * arrive at the worst moment: mid-task, on the click that connects a provider,
 * with the request already failing behind it. Asking on first launch puts the
 * question where the user is still setting the app up.
 *
 * There is no API to raise the prompt directly - macOS shows it the first time
 * an app touches the local network - so this sends the one packet a Bonjour
 * browse would send and lets the system do the rest.
 */
const MARKER = "local-network-asked"

function build(): string {
  let stamp = 0
  try {
    stamp = fs.statSync(app.getPath("exe")).mtimeMs
  } catch {
    // No executable to stat: the version alone still tells most builds apart.
  }
  return buildStamp(app.getVersion(), stamp)
}

export function askForLocalNetwork(): void {
  // The permission only exists on macOS; everywhere else this is one pointless
  // multicast packet.
  if (process.platform !== "darwin") return

  const marker = path.join(app.getPath("userData"), MARKER)
  const current = build()
  // Asked once of this build. The answer lives in System Settings from then on,
  // and asking again would neither change it nor re-open the prompt.
  let written: string | undefined
  try {
    written = fs.readFileSync(marker, "utf8")
  } catch {
    // No marker yet: ask.
  }
  if (alreadyAsked(written, current)) return

  let socket: dgram.Socket
  try {
    socket = dgram.createSocket({ type: "udp4", reuseAddr: true })
  } catch {
    return
  }
  sendQuery(socket, () => {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true })
      fs.writeFileSync(marker, current, "utf8")
    } catch {
      // Worst case the packet is sent again next launch, which macOS ignores
      // once the user has answered.
    }
  })
}
