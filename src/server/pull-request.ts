import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { PullRequestState } from "@shared/protocol"

const run = promisify(execFile)

/**
 * The info card's pull-request row, as MiMo finds it: the current branch's
 * newest pull request on GitHub, asked of the public REST API without
 * credentials. Nothing here reads a token or calls `gh`; a private repository
 * simply answers 404 and the row stays away.
 *
 * Only the owner, the repository name and the branch leave the machine, and
 * only for a remote that is GitHub's.
 */

export interface GithubRepository {
  owner: string
  repo: string
}

/* GitHub's own rules for the two names: letters, digits, dot, dash, underscore. */
const NAME = /^[A-Za-z0-9._-]+$/

/**
 * Owner and name from a remote's address, or null for one that is not GitHub.
 *
 * Accepts the scp form (`git@github.com:owner/repo.git`) and https or ssh URLs
 * whose host is exactly github.com. Anything with more or fewer than two path
 * parts, or odd characters in them, is not taken for a repository. A user and
 * password in an https address are ignored, never kept.
 */
export function githubRepository(remote: string): GithubRepository | null {
  const text = String(remote ?? "").trim()
  if (!text) return null
  let pathname = ""
  const scp = /^(?:[^@\s/]+@)?github\.com:([^\s]+)$/i.exec(text)
  if (scp) pathname = scp[1] ?? ""
  else {
    try {
      const url = new URL(text)
      if (url.hostname.toLowerCase() !== "github.com") return null
      if (url.protocol !== "https:" && url.protocol !== "ssh:") return null
      if (url.port && url.port !== "443" && url.port !== "22") return null
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  }
  const parts = pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean)
  if (parts.length !== 2) return null
  const [owner, repo] = parts as [string, string]
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null
  return { owner, repo }
}

/** The page address the API gave, kept only when it is this repository's pull request on github.com. */
export function pullRequestUrl(raw: unknown, repository: GithubRepository, number: number): string | null {
  if (typeof raw !== "string") return null
  try {
    const url = new URL(raw)
    const prefix = `/${repository.owner}/${repository.repo}/pull/`.toLowerCase()
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null
    if (!url.pathname.toLowerCase().startsWith(prefix)) return null
    if (url.pathname.slice(prefix.length).split("/")[0] !== String(number)) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * The API's list, newest first, turned into the row's state. MiMo's order:
 * a draft is a draft, then merged, then GitHub's own open or closed.
 */
export function pullRequestFrom(list: unknown, repository: GithubRepository): PullRequestState {
  if (!Array.isArray(list)) return { ok: false, code: "bad-response" }
  if (!list.length) return { ok: true, kind: "none" }
  const first = list[0] as Record<string, unknown> | null
  if (!first || typeof first !== "object") return { ok: false, code: "bad-response" }
  const number = typeof first.number === "number" && Number.isInteger(first.number) && first.number > 0 ? first.number : 0
  const title = typeof first.title === "string" ? first.title : ""
  const url = pullRequestUrl(first.html_url, repository, number)
  if (!number || !url || (first.state !== "open" && first.state !== "closed")) return { ok: false, code: "bad-response" }
  const kind = first.draft === true ? "draft" : first.merged_at ? "merged" : first.state
  return { ok: true, kind, number, title, url }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/** One question to the API: pull requests in `remote`'s repository whose head is `headOwner:branch`. */
export async function askGithub(remote: string, branch: string, fetchImpl: FetchLike, headOwner?: string): Promise<PullRequestState> {
  const repository = githubRepository(remote)
  if (!repository) return { ok: false, code: "unsupported-remote" }
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`)
  url.searchParams.set("state", "all")
  url.searchParams.set("head", `${headOwner || repository.owner}:${branch}`)
  url.searchParams.set("per_page", "10")
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(url.href, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "MCode" },
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return { ok: false, code: "network" }
  }
  if (response.status === 403 || response.status === 429) return { ok: false, code: "rate-limited" }
  if (response.status === 401 || response.status === 404) return { ok: false, code: "unauthorized" }
  if (!response.ok) return { ok: false, code: "network" }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, code: "bad-response" }
  }
  return pullRequestFrom(body, repository)
}

export type GitRunner = (directory: string, args: string[]) => Promise<string>

const localGit: GitRunner = async (directory, args) => {
  const { stdout } = await run("git", args, { cwd: directory, windowsHide: true, maxBuffer: 1024 * 1024 })
  return stdout
}

/** `git remote -v` as name to fetch address. */
export function remotesOf(listing: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of listing.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/.exec(line.trim())
    if (match && (match[3] === "fetch" || !found.has(match[1]!))) found.set(match[1]!, match[2]!)
  }
  return found
}

/**
 * The GitHub repositories worth asking, upstream before origin and each once,
 * as MiMo orders them: a fork's pull request lives in the repository it forked.
 */
export function githubCandidates(remotes: Map<string, string>): { remote: string; repository: GithubRepository }[] {
  const seen = new Set<string>()
  return ["upstream", "origin"]
    .map((name) => ({ remote: remotes.get(name) ?? "", name }))
    .map((entry) => ({ remote: entry.remote, repository: githubRepository(entry.remote) }))
    .filter((entry): entry is { remote: string; repository: GithubRepository } => {
      if (!entry.repository) return false
      const key = `${entry.repository.owner}/${entry.repository.repo}`.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** Whether a repository's origin is on GitHub, which is when the info card has a pull-request row at all. */
export function hasGithubRemote(listing: string): boolean {
  const remotes = remotesOf(listing)
  return remotes.has("origin") && githubCandidates(remotes).length > 0
}

/** The current branch's pull request for the project at `directory`. */
export async function pullRequestState(
  directory: string,
  deps: { git?: GitRunner; fetch?: FetchLike } = {},
): Promise<PullRequestState> {
  const git = deps.git ?? localGit
  const fetchImpl = deps.fetch ?? (fetch as unknown as FetchLike)
  const inside = (await git(directory, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim()
  if (inside !== "true") return { ok: false, code: "not-a-repo" }
  const branch = (await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim()
  if (!branch) return { ok: false, code: "detached" }
  const remotes = remotesOf(await git(directory, ["remote", "-v"]).catch(() => ""))
  const origin = remotes.get("origin")
  if (!origin) return { ok: false, code: "no-remote" }
  const candidates = githubCandidates(remotes)
  if (!candidates.length) return { ok: false, code: "unsupported-remote" }
  const headOwner = githubRepository(origin)?.owner
  let failure: PullRequestState | undefined
  for (const candidate of candidates) {
    const answer = await askGithub(candidate.remote, branch, fetchImpl, headOwner || candidate.repository.owner)
    if (answer.ok && answer.kind !== "none") return answer
    if (!answer.ok && !failure) failure = answer
  }
  return failure ?? { ok: true, kind: "none" }
}
