import type { DirEntry, Message, ToolPart } from "@shared/protocol"
import { parseUnifiedDiff } from "@shared/unified-diff"

/*
 * The files and review tabs' logic that needs no window: which colour a file's
 * icon takes, how the lazily listed tree reads as rows, what the breadcrumb
 * says, and when a turn's edits mean the tab should read again.
 */

export type FileCategory = "code" | "web" | "data" | "doc" | "media" | "shell" | "archive" | "default"

/* MiMo's extension table for the tree's icon colours, whole. */
const CATEGORY = new Map<string, Exclude<FileCategory, "default">>()
const GROUPS: [Exclude<FileCategory, "default">, string][] = [
  ["code", "js mjs cjs jsx ts tsx py go rs java kt c h cpp cc hpp cs rb php swift lua dart scala r pl vue svelte"],
  ["web", "html htm xhtml xml svg astro css scss sass less"],
  ["data", "json yaml yml toml ini env csv tsv sql conf lock"],
  ["doc", "md markdown txt pdf doc docx ppt pptx xls xlsx rtf"],
  ["media", "png jpg jpeg gif webp bmp ico mp4 mov avi webm mp3 wav"],
  ["shell", "sh bash zsh fish bat cmd ps1 command"],
  ["archive", "zip tar gz tgz rar 7z bz2 xz"],
]
for (const [category, extensions] of GROUPS) for (const extension of extensions.split(" ")) CATEGORY.set(extension, category)

/* The last extension decides, so `.env` is data and `a.tar.gz` an archive. */
export function fileCategory(name: string): FileCategory {
  const match = /\.([^.]+)$/.exec(name || "")
  return match ? (CATEGORY.get(match[1].toLowerCase()) ?? "default") : "default"
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export interface TreeRow {
  path: string
  name: string
  directory: boolean
  depth: number
  open: boolean
}

/* The listed folders as rows: a folder's children follow it while it is open and listed. */
export function treeRows(listing: Readonly<Record<string, DirEntry[]>>, expanded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    for (const entry of listing[dir] ?? []) {
      const path = joinRel(dir, entry.name)
      const directory = entry.type === "dir"
      const open = directory && expanded.has(path)
      out.push({ path, name: entry.name, directory, depth, open })
      if (open) walk(path, depth + 1)
    }
  }
  walk("", 0)
  return out
}

/* MiMo's indent: 10 plus 14 a level, and a file 16 further in where a folder has its chevron. */
export function rowIndent(row: Pick<TreeRow, "depth" | "directory">): number {
  return 10 + row.depth * 14 + (row.directory ? 0 : 16)
}

/* The breadcrumb: the project's name then the file's folders and name; a lone "/" with no root. */
export function crumbsFor(root: string | undefined, rootLabel: string, file?: string): string[] {
  if (!root) return ["/"]
  return [rootLabel, ...(file ? file.split("/").filter(Boolean) : [])]
}

/* A save's refusal in MiMo's words: its toobig, binary and noent, anything else cannot write. */
export function saveFailureKey(message: string): string {
  if (/\btoobig\b/i.test(message)) return "rp.files.errTooBig"
  if (/\bbinary\b/i.test(message)) return "rp.files.errBinary"
  if (/ENOENT|noent/.test(message)) return "rp.files.errNoEnt"
  return "rp.files.errCannotWrite"
}

/* A path as the project sees it: forward slashes, relative when it lies inside the root. */
export function relativeTo(root: string, file: string): string {
  const target = file.replace(/\\/g, "/")
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const windows = /^[a-zA-Z]:/.test(base)
  const inside = windows ? target.toLowerCase().startsWith(`${base.toLowerCase()}/`) : target.startsWith(`${base}/`)
  return inside ? target.slice(base.length + 1) : target.replace(/^\.\//, "")
}

const EDITING = new Set(["edit", "multiedit", "write", "patch"])

/* Every file one edit, write or patch call names, by its input and by the diff it recorded. */
export function editTargets(part: ToolPart): string[] {
  const out = new Set<string>()
  // `file_path` since the tools took MiMo's names; `path` on turns stored before.
  const named = part.input?.file_path ?? part.input?.path
  if (typeof named === "string" && named) out.add(named)
  const diff = part.metadata?.diff
  if (typeof diff === "string") for (const section of parseUnifiedDiff(diff)) if (section.file) out.add(section.file)
  return [...out]
}

export interface EditCounts {
  /* Finished edit, write and patch calls across the conversation. */
  total: number
  /* Those that touched the file on show. */
  onFile: number
  /* Turns whose file changes were taken back. */
  reverted: number
}

/*
 * The counts a tab watches to know the agent has changed something: a rise in
 * `total` re-lists, a rise in `onFile` reads the open file again, as MiMo's
 * files and review tabs do while a turn is still running.
 */
export function editCounts(messages: readonly Message[], root?: string, file?: string): EditCounts {
  const counts: EditCounts = { total: 0, onFile: 0, reverted: 0 }
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if (message.reverted) counts.reverted++
    for (const part of message.parts) {
      if (part.type !== "tool" || !EDITING.has(part.name) || part.status !== "completed") continue
      counts.total++
      if (root && file && editTargets(part).some((target) => relativeTo(root, target) === file)) counts.onFile++
    }
  }
  return counts
}
