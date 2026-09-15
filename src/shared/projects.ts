import type { AppConfig, SessionInfo } from "./protocol"

/**
 * MiMo's project list, kept as a list rather than read off conversations.
 *
 * A project is a folder in `projects`; `closedProjects` is MiMo's hidden set,
 * the folders removed from the list whose conversations stay. The two never
 * share a folder. Names, pins, the dragged order and the home picker's memory
 * stay in their own maps, keyed by folder, as before the list existed.
 */
export type ProjectConfig = Pick<
  AppConfig,
  "projects" | "closedProjects" | "pinnedProjects" | "projectOrder" | "projectUsed" | "projectNames"
>

type ProjectSession = Pick<SessionInfo, "directory" | "updated" | "archived" | "scratch" | "sideOf" | "parentID">

/**
 * The folders conversations make projects of, newest conversation first.
 *
 * A task with no project, a side chat and a subagent's conversation name no
 * project of their own; archived conversations are left out as the side column
 * always left them out, so nothing it did not show turns up as a project.
 */
export function projectDirectoriesOf(sessions: readonly ProjectSession[]): string[] {
  const latest = new Map<string, number>()
  for (const session of sessions) {
    if (session.archived || session.scratch || session.sideOf || session.parentID || !session.directory) continue
    latest.set(session.directory, Math.max(latest.get(session.directory) ?? 0, session.updated))
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([directory]) => directory)
}

/** The list as stored, removed folders aside, in the order projects were added (newest first). */
export function listedProjects(config?: Partial<ProjectConfig>): string[] {
  const closed = new Set(config?.closedProjects ?? [])
  return (config?.projects ?? []).filter((directory) => !closed.has(directory))
}

/**
 * MiMo's `add`: a new folder goes to the front, a removed one comes back, and
 * one already listed stays where it is. `usedAt` is MiMo's markProjectUsed,
 * kept strictly after every other pick so the project heads the list.
 */
export function addedProject(
  config: ProjectConfig,
  directory: string,
  usedAt?: number,
): { patch: Partial<AppConfig>; existed: boolean } {
  const closed = config.closedProjects ?? []
  const list = config.projects ?? []
  const existed = list.includes(directory) && !closed.includes(directory)
  const patch: Partial<AppConfig> = {
    projects: existed ? list : [directory, ...list.filter((entry) => entry !== directory)],
    closedProjects: closed.filter((entry) => entry !== directory),
  }
  if (usedAt !== undefined) {
    const used = config.projectUsed ?? {}
    const newest = Math.max(0, ...Object.values(used).filter((at) => Number.isFinite(at)))
    patch.projectUsed = { ...used, [directory]: Math.max(usedAt, newest + 1) }
  }
  return { patch, existed }
}

/**
 * MiMo's `remove`: off the list and hidden, unpinned, out of the dragged order
 * and the picker's memory, and its name gone with the entry. Conversations are
 * not touched; adding the folder again lists them under it again.
 */
export function removedProjects(config: ProjectConfig, directories: readonly string[]): Partial<AppConfig> {
  const gone = new Set(directories)
  const closed = config.closedProjects ?? []
  const names = { ...(config.projectNames ?? {}) }
  const used = { ...(config.projectUsed ?? {}) }
  for (const directory of gone) {
    delete names[directory]
    delete used[directory]
  }
  return {
    projects: (config.projects ?? []).filter((entry) => !gone.has(entry)),
    closedProjects: [...closed, ...[...gone].filter((entry) => !closed.includes(entry))],
    pinnedProjects: (config.pinnedProjects ?? []).filter((entry) => !gone.has(entry)),
    projectOrder: (config.projectOrder ?? []).filter((entry) => !gone.has(entry)),
    projectNames: names,
    projectUsed: used,
  }
}

/**
 * MiMo's `ensureDerived`: a conversation's folder that is neither listed nor
 * removed joins the end of the list. Nothing to change answers undefined.
 */
export function adoptedProjects(config: ProjectConfig, directories: readonly string[]): Partial<AppConfig> | undefined {
  const known = new Set([...(config.projects ?? []), ...(config.closedProjects ?? [])])
  const fresh: string[] = []
  for (const directory of directories) {
    if (!directory || known.has(directory)) continue
    known.add(directory)
    fresh.push(directory)
  }
  return fresh.length ? { projects: [...(config.projects ?? []), ...fresh] } : undefined
}

/**
 * The list after a write that moved folders into or out of the removed set.
 *
 * Several places bring a folder back by taking it out of `closedProjects`, and
 * that has always meant "it is a project again"; here it also puts the folder
 * at the front of the list. A folder put into the removed set leaves the list.
 */
export function reconciledProjects(
  before: Pick<ProjectConfig, "projects" | "closedProjects">,
  after: Pick<ProjectConfig, "projects" | "closedProjects">,
): string[] {
  const closed = new Set(after.closedProjects ?? [])
  let list = after.projects ?? []
  for (const directory of before.closedProjects ?? []) {
    if (!closed.has(directory) && !list.includes(directory)) list = [directory, ...list]
  }
  return list.filter((directory) => !closed.has(directory))
}

/**
 * The order the side column and the home picker list projects in: the later of
 * a project's newest conversation and its last pick first, as MiMo sorts by the
 * pick; the stored list breaks ties, so a project added without being picked
 * sits where MiMo's would.
 */
export function projectsByRecency(config: Partial<ProjectConfig> | undefined, sessions: readonly ProjectSession[]): string[] {
  const listed = listedProjects(config)
  const at = new Map(listed.map((directory) => [directory, config?.projectUsed?.[directory] ?? 0]))
  for (const session of sessions) {
    if (session.archived || session.scratch) continue
    const seen = at.get(session.directory)
    if (seen !== undefined && session.updated > seen) at.set(session.directory, session.updated)
  }
  return listed
    .map((directory, index) => ({ directory, index, at: at.get(directory) ?? 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.directory)
}
