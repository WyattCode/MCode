import path from "node:path"
import fs from "node:fs/promises"
import { ToolError } from "./types"

/**
 * The app's own folder, kept out of the model's reach.
 *
 * `config.json` there decides which MCP servers start at launch, and a changed
 * file is picked up while the app runs. At the default access level a write
 * outside the project is allowed without a question, so a model steered by a
 * page it read could otherwise write one line there and have a program of its
 * choosing start with the user's whole environment on every launch after. The
 * access level itself stays as the user chose it; this folder is simply not
 * one the file tools write to, whatever the level.
 *
 * Only what a feature genuinely writes through the tools is let through: the
 * memory folder (the memory feature is the model writing notes there), plan
 * files (planning writes its plan in `storage/plans` for a folder that is not a
 * repository), the user's skills folder (the skill-creator skill makes them
 * there) and the global AGENTS.md (the user's own instructions, which the user
 * asks the model to edit). The saved credentials are not read either.
 */

const roots = new Set<string>()

/** Registered by the backend at start: its data folder. */
export function protectAppData(directory: string): void {
  roots.add(path.resolve(directory))
}

/** Where a path really leads, following links; a path that does not exist yet is judged by its deepest existing parent. */
async function realOf(target: string): Promise<string> {
  let head = path.resolve(target)
  const tail: string[] = []
  for (;;) {
    const real = await fs.realpath(head).catch(() => undefined)
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real
    const parent = path.dirname(head)
    if (parent === head) return path.resolve(target)
    tail.push(path.basename(head))
    head = parent
  }
}

/** The part of `target` below `root`, or undefined when it is not strictly below it. */
function below(root: string, target: string): string | undefined {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  // Compared case-blind: on Windows and macOS `Storage\Config.json` is the same file.
  return relative.split(path.sep).join("/").toLowerCase()
}

/** Whether a path inside the data folder is one a feature writes through the tools. */
function writable(inner: string): boolean {
  if (inner === "memory" || inner.startsWith("memory/")) return true
  if (inner.startsWith("storage/plans/") && inner.endsWith(".md")) return true
  if (inner === "storage/skills" || inner.startsWith("storage/skills/")) return true
  if (inner === "storage/skill" || inner.startsWith("storage/skill/")) return true
  return inner === "storage/agents.md"
}

/** The files holding saved sign-ins and keys. */
function secret(inner: string): boolean {
  return inner === "credentials.json" || inner === "storage/mcp-auth.json" || inner.startsWith("credentials.json:") || inner.startsWith("storage/mcp-auth.json:")
}

/**
 * Why a tool may not touch this path, or undefined.
 *
 * Judged both by the path as written and by where it really leads, so neither
 * a link into the folder nor a differently spelled path gets past it.
 */
export async function appDataRefusal(target: string, access: "read" | "write" | "view"): Promise<"write" | "secret" | "hidden" | undefined> {
  if (!roots.size) return undefined
  const spelled = path.resolve(target)
  const candidates = [...new Set([spelled, await realOf(spelled)])]
  const realRoots = await Promise.all([...roots].map(async (root) => [root, await realOf(root)]))
  for (const candidate of candidates) {
    for (const pair of realRoots) {
      for (const root of new Set(pair)) {
        const inner = below(root, candidate)
        if (inner === undefined) continue
        if (secret(inner)) return "secret"
        if (access === "write" && !writable(inner)) return "write"
        // The window's files tab shows what a feature puts there for the reader, and a cut tool output; nothing else.
        if (access === "view" && !writable(inner) && !inner.startsWith("storage/tool-output/")) return "hidden"
      }
    }
  }
  return undefined
}

/** Throws the refusal the model and the reader are shown, when there is one. */
export async function guardAppData(target: string, access: "read" | "write", shown = target): Promise<void> {
  const refusal = await appDataRefusal(target, access)
  if (refusal === "secret") {
    throw new ToolError(
      `Refused: ${shown} holds this app's saved sign-ins and keys, which no tool may read or change. Nothing was read. Do not try another way to reach it.`,
      "tool.err.appSecret",
      { path: shown },
    )
  }
  if (refusal === "write") {
    throw new ToolError(
      `Refused: ${shown} is part of this app's own configuration and data, which tools may not change at any access level. Nothing was written. ` +
        `If the user wants a setting changed, tell them which one to change in Settings.`,
      "tool.err.appData",
      { path: shown },
    )
  }
}
