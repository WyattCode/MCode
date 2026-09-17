/**
 * Round 11, doing many things at once and staying alive for a long time
 * (N11-1 onwards). Kept apart from smoke.ts the way the earlier rounds are;
 * smoke.ts calls `roundElevenChecks` with its own check and section.
 *
 * Most of these read the sources rather than run the app: the behaviours they
 * guard (a quit path, a lock, a timeout, a concurrency gate) only show up when
 * two things happen at once, which a probe can stage but a smoke run cannot.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

/** Every text source under a folder, as bytes, so control characters survive. */
async function sourceBytes(root: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>()
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|tsx|vue|js|mjs|cjs|json|css|html)$/.test(entry.name)) found.set(full, await fs.readFile(full))
    }
  }
  await walk(root)
  return found
}

export async function roundElevenChecks(check: Check, section: (name: string) => void): Promise<void> {
  const read = (file: string) => fs.readFile(path.join(process.cwd(), file), "utf8")

  section("Round 11 (N11-8): no stray control bytes in the sources")
  {
    // ripgrep treats a file with a NUL as binary and stops printing matches, so
    // everything after the first one is invisible to every search-based audit.
    const offenders: string[] = []
    for (const folder of ["src", "scripts"]) {
      for (const [file, bytes] of await sourceBytes(path.join(process.cwd(), folder))) {
        const at = bytes.indexOf(0)
        if (at >= 0) offenders.push(`${path.relative(process.cwd(), file)} @${at}`)
      }
    }
    check("no source file carries a raw NUL byte", offenders.length === 0, offenders)
  }
  void read
}
