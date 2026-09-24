import dgram from "node:dgram"
import fs from "node:fs"
import path from "node:path"
import { app } from "electron"

/*
 * Asks for Local Network access once, at first launch.
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

/** The service-enumeration query every Bonjour browse opens with. */
function serviceQuery(): Buffer {
  const labels = ["_services", "_dns-sd", "_udp", "local"]
  const name = Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])),
    Buffer.from([0]),
  ])
  const header = Buffer.alloc(12)
  header.writeUInt16BE(1, 4) // one question, no answers
  const question = Buffer.alloc(4)
  question.writeUInt16BE(12, 0) // PTR
  question.writeUInt16BE(1, 2) // IN
  return Buffer.concat([header, name, question])
}

export function askForLocalNetwork(): void {
  // The permission only exists on macOS; everywhere else this is one pointless
  // multicast packet.
  if (process.platform !== "darwin") return

  const marker = path.join(app.getPath("userData"), MARKER)
  // Asked once. The answer lives in System Settings from then on, and asking
  // again would neither change it nor re-open the prompt.
  if (fs.existsSync(marker)) return

  let socket: dgram.Socket
  try {
    socket = dgram.createSocket({ type: "udp4", reuseAddr: true })
  } catch {
    return
  }

  const done = () => {
    try {
      socket.close()
    } catch {
      // Already closed by the error path.
    }
  }

  // Denied permission surfaces here as a send error, which is not a failure to
  // report: the user answered the question, and that answer is theirs to make.
  socket.once("error", done)
  const query = serviceQuery()
  socket.send(query, 5353, "224.0.0.251", () => done())

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, new Date().toISOString(), "utf8")
  } catch {
    // Worst case the prompt is provoked again next launch, which macOS ignores
    // once the user has answered.
  }
}