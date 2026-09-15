import type { Message, TaskItem } from "@shared/protocol"
import type { SessionArtifact } from "@shared/session-files"

/**
 * The plan a conversation is working to, and the info card's own bookkeeping.
 *
 * What it has produced and what it has read live in @shared/session-files,
 * which the server reads too - the artifacts page answers for every stored
 * session, and both sides have to count a file as produced the same way.
 */
export { sessionFiles, projectRelative, fileKind, sessionArtifacts, sessionReferences, artifactKind } from "@shared/session-files"
export type { FileTouch, SessionFiles, FileKind, SessionArtifact, SessionReferences, ArtifactKind, ArtifactRole } from "@shared/session-files"

/** One entry of the plan a conversation's todowrite calls recorded, before the task registry replaced them. */
interface Todo {
  id: string
  content: string
  status: string
  parentId?: string
}

/**
 * The most recent todowrite plan in a conversation saved before the task
 * registry, with when it was written. Read from the transcript, whose newest
 * call is by definition the plan that stood.
 */
function latestTodoWrite(messages: readonly Message[]): { todos: Todo[]; at: number } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // Only an assistant turn runs tools; a user message has no parts at all.
    if (message?.role !== "assistant") continue
    const parts = message.parts
    for (let at = parts.length - 1; at >= 0; at -= 1) {
      const part = parts[at] as { metadata?: { todos?: Todo[] }; time?: { created?: number } }
      const found = part.metadata?.todos
      if (found?.length) return { todos: found, at: part.time?.created ?? message.time.created }
    }
  }
  return { todos: [], at: 0 }
}

/** MiMo's task statuses, with `stalled` derived for work a finished turn left open. */
export type InfoTaskStatus = "open" | "in_progress" | "stalled" | "blocked" | "done" | "abandoned"

export interface InfoTask {
  id: string
  summary: string
  status: InfoTaskStatus
  /** How far under its parent it is drawn; 0 at the top. */
  depth: number
}

/** The registry's statuses as they are; a saved todowrite plan's four words in MiMo's vocabulary. */
function mapStatus(status: string): InfoTaskStatus {
  if (status === "completed" || status === "done") return "done"
  if (status === "cancelled" || status === "abandoned") return "abandoned"
  if (status === "in_progress") return "in_progress"
  if (status === "blocked") return "blocked"
  return "open"
}

/** Finished tasks leave the card this long after they end, as MiMo archives them. */
const ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The task list as the card draws it: parents before their children, and an
 * item still in progress shown as stalled unless it changed during the turn
 * running now - otherwise the turn that meant to finish it has ended.
 *
 * The conversation's task registry when it has one; a conversation saved
 * before the registry shows the last plan its todowrite calls recorded.
 */
export function infoTasks(registry: readonly TaskItem[] | undefined, messages: readonly Message[], running: boolean, now = Date.now()): InfoTask[] {
  const entries: { id: string; summary: string; status: string; parentID?: string; at: number }[] = registry?.length
    ? registry
        .filter((task) => !(task.ended !== undefined && (task.status === "done" || task.status === "abandoned") && now - task.ended >= ARCHIVE_MS))
        .map((task) => ({ id: task.id, summary: task.summary, status: task.status, parentID: task.parentID, at: task.updated }))
    : (() => {
        const { todos, at } = latestTodoWrite(messages)
        return todos.map((todo) => ({ id: todo.id, summary: todo.content, status: todo.status, parentID: todo.parentId, at }))
      })()
  if (!entries.length) return []
  let runStarted = Infinity
  if (running) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      // A message steered into a running turn is part of that turn, not its start.
      if (message?.role === "user" && !message.steered) {
        runStarted = message.time.created
        break
      }
    }
  }
  const byParent = new Map<string, typeof entries>()
  const ids = new Set(entries.map((entry) => entry.id))
  for (const entry of entries) {
    const parent = entry.parentID && ids.has(entry.parentID) && entry.parentID !== entry.id ? entry.parentID : ""
    byParent.set(parent, [...(byParent.get(parent) ?? []), entry])
  }
  const out: InfoTask[] = []
  const seen = new Set<string>()
  const shown = (entry: (typeof entries)[number]): InfoTaskStatus => {
    const mapped = mapStatus(entry.status)
    return mapped === "in_progress" && !(running && entry.at >= runStarted) ? "stalled" : mapped
  }
  const walk = (parent: string, depth: number) => {
    for (const entry of byParent.get(parent) ?? []) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push({ id: entry.id, summary: entry.summary, status: shown(entry), depth })
      walk(entry.id, depth + 1)
    }
  }
  walk("", 0)
  // Anything caught in a parent loop is still listed, at the top.
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push({ id: entry.id, summary: entry.summary, status: mapStatus(entry.status), depth: 0 })
  }
  return out
}

/** Deliverables past this many are folded under 「更多」. */
export const ARTIFACT_ROWS = 10

export function artifactGroups(artifacts: readonly SessionArtifact[]) {
  const deliverable = artifacts.filter((artifact) => artifact.role === "deliverable")
  return {
    shown: deliverable.slice(0, ARTIFACT_ROWS),
    more: deliverable.slice(ARTIFACT_ROWS),
    intermediate: artifacts.filter((artifact) => artifact.role === "intermediate"),
  }
}

// ------------------------------------------------------ what stays folded

export type InfoSectionKey = "environment" | "tasks" | "artifacts" | "sources"
export type InfoSubgroupKey = "sources.upload" | "sources.project" | "artifacts.intermediate" | "artifacts.deliverable.more"

const SECTION_DEFAULTS: Record<InfoSectionKey, boolean> = { environment: true, tasks: true, artifacts: true, sources: true }
const SUBGROUP_DEFAULTS: Record<InfoSubgroupKey, boolean> = {
  "sources.upload": true,
  "sources.project": false,
  "artifacts.intermediate": false,
  "artifacts.deliverable.more": false,
}

const SECTIONS_STORE = "mcode.infoPanel.sections"
const SUBGROUPS_STORE = "mcode.infoPanel.subgroups"

/*
 * Kept per machine, like the card's own open state. Storage can be missing or
 * refuse; the defaults then hold for this run.
 */
function readOpen<K extends string>(store: string, defaults: Record<K, boolean>): Record<K, boolean> {
  const out = { ...defaults }
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(store) ?? "{}")
    if (parsed && typeof parsed === "object") {
      for (const key of Object.keys(defaults) as K[]) {
        const value = (parsed as Record<string, unknown>)[key]
        if (typeof value === "boolean") out[key] = value
      }
    }
  } catch {
    // Unreadable: the defaults stand.
  }
  return out
}

function writeOpen(store: string, value: Record<string, boolean>): void {
  try {
    localStorage.setItem(store, JSON.stringify(value))
  } catch {
    // Remembered for this run only.
  }
}

export const readSectionsOpen = () => readOpen(SECTIONS_STORE, SECTION_DEFAULTS)
export const readSubgroupsOpen = () => readOpen(SUBGROUPS_STORE, SUBGROUP_DEFAULTS)
export const writeSectionsOpen = (value: Record<InfoSectionKey, boolean>) => writeOpen(SECTIONS_STORE, value)
export const writeSubgroupsOpen = (value: Record<InfoSubgroupKey, boolean>) => writeOpen(SUBGROUPS_STORE, value)

/** The card's name and folder lines for a path. */
export function baseName(file: string): string {
  const at = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  return at === -1 ? file : file.slice(at + 1)
}

export function folderOf(file: string): string {
  const at = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  return at === -1 ? "" : file.slice(0, at)
}
