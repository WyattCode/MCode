import type dgram from "node:dgram"

/*
 * The parts of asking for Local Network access that do not need Electron, so a
 * check can run them: what the marker says, and when the packet counts as sent.
 * local-network.ts wires them to the app.
 */

/** The service-enumeration query every Bonjour browse opens with. */
export function serviceQuery(): Buffer {
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

/**
 * Which build the question was asked of. macOS ties the answer to the app's code
 * signature, and an ad-hoc signature is new with every package, so a marker that
 * only said "asked" would outlive the answer it stands for and leave the prompt
 * to arrive on the first real connection. The version and the executable's
 * modification time change with any rebuild or update.
 */
export function buildStamp(version: string, mtimeMs: number): string {
  return `${version}:${mtimeMs}`
}

/** Whether the marker on disk (absent when there is none) was written for this build. */
export function alreadyAsked(marker: string | undefined, current: string): boolean {
  return marker !== undefined && marker.trim() === current
}

type Sender = Pick<dgram.Socket, "send" | "close" | "once">

/**
 * Sends the one packet and closes the socket. `sent` runs only once the system
 * has taken the packet: a send that failed (no usable interface yet, offline)
 * never raised the prompt, so it is not recorded and the next launch tries
 * again. Denied permission also surfaces as an error here; asking again then is
 * one more packet that macOS ignores.
 */
export function sendQuery(socket: Sender, sent: () => void): void {
  const done = () => {
    try {
      socket.close()
    } catch {
      // Already closed by the error path.
    }
  }
  socket.once("error", done)
  try {
    socket.send(serviceQuery(), 5353, "224.0.0.251", (error) => {
      done()
      if (!error) sent()
    })
  } catch {
    done()
  }
}
