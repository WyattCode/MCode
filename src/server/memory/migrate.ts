import fs from "node:fs/promises"
import path from "node:path"
import { projectKey } from "../history/extract"
import { folderMemoryID, withMemoryLock } from "./paths"
import { projectMemoryID } from "./project-id"

/**
 * memory: moves project memory from the per-folder layout to MiMo's
 * per-repository one (round ten, R10-6).
 *
 * Before, each conversation folder had its own `projects/<hash of folder>`;
 * now every folder of one repository shares the repository's id, and every
 * folder outside a repository shares `global`. The folders this app knows of -
 * its conversations' and its project list's - say which old folder belongs to
 * which new id. Nothing is thrown away:
 *
 * - the whole `projects` tree is copied to `<data>/backup/` first;
 * - a file whose new place is free is moved there;
 * - a file whose new place already holds the same text is dropped, since the
 *   text is kept;
 * - a markdown file whose new place holds other text is appended to it under a
 *   heading naming the folder it came from;
 * - any other clashing file is kept beside it under a name saying where it
 *   came from.
 *
 * An old folder no known folder hashes to is left where it is: which project
 * it belonged to cannot be told, and it stays searchable.
 */

export interface MemoryMigration {
  /** Old folders emptied into new ones. */
  moved: number
  /** Markdown files appended to one already in the new place. */
  merged: number
  /** Where the old layout was copied, when anything was moved. */
  backup?: string
}

const OLD_ID = /^[0-9a-f]{16}$/

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) found.push(full)
    }
  }
  await walk(root)
  return found.sort()
}

/** Removes empty folders from the bottom up, and the root too if it ends up empty. */
async function pruneEmpty(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await pruneEmpty(path.join(directory, entry.name))
  }
  const left = await fs.readdir(directory).catch(() => ["?"])
  if (!left.length) await fs.rmdir(directory).catch(() => undefined)
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

interface MemoryMigrationInput {
  dataDirectory: string
  directories: readonly string[]
  now?: Date
  home?: string
}

export function migrateMemoryLayout(input: MemoryMigrationInput): Promise<MemoryMigration> {
  return withMemoryLock(path.join(input.dataDirectory, "memory"), () => migrateProjects(input))
}

async function migrateProjects(input: MemoryMigrationInput): Promise<MemoryMigration> {
  const projects = path.join(input.dataDirectory, "memory", "projects")
  const present = new Set(
    (await fs.readdir(projects, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && OLD_ID.test(entry.name))
      .map((entry) => entry.name),
  )
  const result: MemoryMigration = { moved: 0, merged: 0 }
  if (!present.size) return result

  // Each old folder with the folder it was made for and the id it now belongs under.
  const plan = new Map<string, { directory: string; to: string }>()
  const seen = new Set<string>()
  for (const directory of input.directories) {
    const key = projectKey(directory)
    if (seen.has(key)) continue
    seen.add(key)
    const old = folderMemoryID(directory)
    if (!present.has(old) || plan.has(old)) continue
    const to = projectMemoryID(directory, { home: input.home })
    if (to !== old) plan.set(old, { directory, to })
  }
  if (!plan.size) return result

  const now = input.now ?? new Date()
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  const backup = path.join(input.dataDirectory, "backup", `memory-projects-${stamp}`)
  await fs.mkdir(path.dirname(backup), { recursive: true })
  await fs.cp(projects, backup, { recursive: true, errorOnExist: false, force: false })
  result.backup = backup

  const day = now.toISOString().slice(0, 10)
  for (const [old, { directory, to }] of [...plan].sort(([a], [b]) => a.localeCompare(b))) {
    const from = path.join(projects, old)
    for (const file of await filesUnder(from)) {
      const relative = path.relative(from, file)
      const target = path.join(projects, to, relative)
      await fs.mkdir(path.dirname(target), { recursive: true })
      if (!(await exists(target))) {
        await fs.rename(file, target)
        continue
      }
      const [incoming, current] = await Promise.all([fs.readFile(file), fs.readFile(target)])
      // The same text already there - whole, or merged in from another folder - is kept once.
      if (incoming.equals(current) || (/\.md$/i.test(file) && current.toString("utf8").includes(incoming.toString("utf8").trim()))) {
        await fs.rm(file, { force: true })
        continue
      }
      if (/\.md$/i.test(file)) {
        const text = incoming.toString("utf8").trim()
        if (text) {
          const joined = `${current.toString("utf8").replace(/\s*$/, "")}\n\n## Merged from ${directory} (${day})\n\n${text}\n`
          await fs.writeFile(target, joined, "utf8")
          result.merged++
        }
        await fs.rm(file, { force: true })
        continue
      }
      await fs.rename(file, `${target}.from-${old}`)
    }
    await pruneEmpty(from)
    result.moved++
  }
  return result
}
