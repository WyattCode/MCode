/**
 * Which system a package build is for, and whether this machine can make it.
 *
 * A package carries the terminal's native module (node-pty) for the machine
 * it was installed on, and only that one is in node_modules; a dmg can only be
 * made on a Mac at all. So a package is built on the system it is for, and a
 * build for another one stops before anything is changed, saying where to run it.
 */
const NAMES = { win32: "Windows", darwin: "macOS", linux: "Linux" }
const FLAGS = { "--win": "win32", "--mac": "darwin", "--linux": "linux" }

/** The platform the flags ask for: the one flag given, or this machine's with none. */
export function packageTarget(flags, host) {
  const asked = [...new Set(flags.filter((flag) => flag in FLAGS).map((flag) => FLAGS[flag]))]
  if (asked.length > 1) return { error: "Build one platform at a time: pass only one of --win, --mac or --linux." }
  const target = asked[0] ?? host
  if (!(target in NAMES)) return { error: `MCode is not packaged for ${target}.` }
  if (target !== host) {
    return {
      error: `A ${NAMES[target]} package has to be built on ${NAMES[target]} (this machine runs ${NAMES[host] ?? host}): its terminal module is installed per system. Run the same command there, or in CI on that system.`,
    }
  }
  return { target }
}
