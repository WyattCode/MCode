import dgram from "node:dgram"
import fs from "node:fs"
import path from "node:path"
import { app } from "electron"

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

/**
 * Which build the question was asked of. macOS ties the answer to the app's code
 * signature, and an ad-hoc signature is new with every package, so a marker that
 * only said "asked" would outlive the answer it stands for and leave the prompt
 * to arrive on the first real connection. The version and the executable's
 * modification time change with any rebuild or update.
 */
function build(): string {
  let stamp = 0
  try {
    stamp = fs.statSync(app.getPath("exe")).mtimeMs
  } catch {
    // No executable to stat: the version alone still tells most builds apart.
  }
  return `${app.getVersion()}:${stamp}`
}

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
  const current = build()
  // Asked once of this build. The answer lives in System Settings from then on,
  // and asking again would neither change it nor re-open the prompt.
  try {
    if (fs.readFileSync(marker, "utf8").trim() === current) return
  } catch {
    // No marker yet, or one from an older build: ask.
  }

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

  // The marker is written only once the system has taken the packet: a send that
  // failed (no usable interface yet, offline) never raised the prompt, so the
  // next launch should try again. Denied permission also surfaces as an error
  // here; asking again then is one more packet that macOS ignores.
  socket.once("error", done)
  try {
    socket.send(serviceQuery(), 5353, "224.0.0.251", (error) => {
      done()
      if (error) return
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true })
        fs.writeFileSync(marker, current, "utf8")
      } catch {
        // Worst case the packet is sent again next launch, which macOS ignores
        // once the user has answered.
      }
    })
  } catch {
    done()
  }
}
