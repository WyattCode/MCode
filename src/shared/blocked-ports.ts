/**
 * Ports a browser will not fetch from, whatever the scheme says (the Fetch
 * standard's "bad port" list, which Chromium also applies to WebSockets).
 *
 * The system hands out a listening port when asked for port 0, and on a machine
 * whose dynamic range starts low (this one's begins at 1024) it can hand out
 * 5060 or 6000. A window told to connect there is refused before a byte is
 * sent, so whatever listens for the window takes a port from outside this list.
 */
const BLOCKED = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
  115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
  563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
])

export function isBlockedPort(port: number): boolean {
  return BLOCKED.has(port)
}
