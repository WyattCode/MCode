import fs from "node:fs/promises"
import path from "node:path"
import { which } from "../tool/post-edit-check"
import type { Diagnostic } from "../tool/post-edit-check"
import { LspClient, pathToUri, uriToPath, type LspDiagnostic } from "./client"

interface ServerSpec {
  id: string
  extensions: string[]
  command: string
  args: string[]
  languageId(file: string): string
  /** Files whose presence in a folder make it a server root. */
  rootMarkers: string[]
  /**
   * Optional `initialize` params. The project directory is associated with the
   * root by `startClient` so this can stay a two-argument spec hook.
   */
  initializationOptions?(root: string, allowProjectTools: boolean): Promise<Record<string, unknown> | undefined>
}

/** The TypeScript server's language id, by extension. */
function tsLanguageId(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".tsx":
      return "typescriptreact"
    case ".jsx":
      return "javascriptreact"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript"
    default:
      return "typescript"
  }
}

const SERVERS: ServerSpec[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: tsLanguageId,
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    initializationOptions: async (root, allowProjectTools) => {
      const projectDir = projectDirByRoot.get(root) ?? root

      if (allowProjectTools && (await hasWorkspaceTypeScript(root, projectDir))) {
        return undefined
      }

      const tsc = await which("tsc").catch(() => undefined)
      if (!tsc) return undefined

      try {
        const realTsc = await fs.realpath(tsc)
        if (isInside(projectDir, realTsc)) return undefined

        const tsserver = path.join(path.dirname(realTsc), "..", "lib", "tsserver.js")
        if (await isFile(tsserver)) {
          return { tsserver: { path: tsserver } }
        }
      } catch {
        return undefined
      }

      return undefined
    },
  },
  {
    id: "python",
    extensions: [".py", ".pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
    languageId: () => "python",
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", "requirements.txt"],
  },
]

/** The server that handles a file, by extension; undefined for anything else. */
export function serverForFile(file: string): ServerSpec | undefined {
  const ext = path.extname(file).toLowerCase()
  return SERVERS.find((server) => server.extensions.includes(ext))
}

/** Whether the LSP feature is switched off for this process. */
export function lspDisabled(): boolean {
  return process.env.MCODE_LSP === "0"
}

interface Cached {
  promise: Promise<LspClient | undefined>
  client?: LspClient
  lastUsed: number
}

const clients = new Map<string, Cached>()
const failures = new Map<string, number>()
const projectDirByRoot = new Map<string, string>()
const shutdownPromises = new Map<LspClient, Promise<void>>()
const FAILURE_TTL = 60_000
const IDLE_MS = 10 * 60_000
const MAX_LIVE = 4
const DIAGNOSTIC_MAX = 20
const LOCATION_MAX = 50
const HOVER_MAX = 4000

let sweeper: NodeJS.Timeout | undefined

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile()
  } catch {
    return false
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

async function hasWorkspaceTypeScript(root: string, projectDir: string): Promise<boolean> {
  let current = path.resolve(root)
  const stop = path.resolve(projectDir)

  for (;;) {
    if (await isFile(path.join(current, "node_modules", "typescript", "lib", "tsserver.js"))) {
      return true
    }
    if (current === stop) return false

    const rel = path.relative(stop, current)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false

    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * The server's executable: a project-local one only when project tools are
 * allowed (the same gate as the post-edit check), otherwise whatever is on
 * PATH. Undefined when neither is there, so the caller falls back quietly.
 */
async function resolveCommand(spec: ServerSpec, projectDir: string, allowProjectTools: boolean): Promise<string | undefined> {
  if (allowProjectTools) {
    const bin = path.join(projectDir, "node_modules", ".bin", spec.command)
    const candidates = process.platform === "win32" ? [bin, `${bin}.cmd`, `${bin}.exe`] : [bin]
    for (const candidate of candidates) {
      if (await isFile(candidate)) return candidate
    }
  }
  return await which(spec.command)
}

/**
 * The nearest ancestor of the file (walking up to and including the project
 * root) that holds one of the server's root markers; the project root itself
 * when none does.
 */
async function findRoot(spec: ServerSpec, file: string, projectDir: string): Promise<string> {
  const project = path.resolve(projectDir)
  let current = path.dirname(path.resolve(file))
  for (;;) {
    for (const marker of spec.rootMarkers) {
      if (await isFile(path.join(current, marker))) return current
    }
    if (current === project) return project
    const rel = path.relative(project, current)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return project
    const parent = path.dirname(current)
    if (parent === current) return project
    current = parent
  }
}

function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of clients) {
      if (entry.client && !entry.client.isDead() && now - entry.lastUsed > IDLE_MS) {
        const client = entry.client
        clients.delete(key)
        void shutdownClient(client)
      }
    }
  }, 60_000)
  sweeper.unref?.()
}

/** Keep at most MAX_LIVE servers up, shutting the least recently used. */
function enforceMaxLive(): void {
  const live: [string, Cached][] = []
  for (const [key, entry] of clients) {
    if (entry.client && !entry.client.isDead()) live.push([key, entry])
  }
  if (live.length <= MAX_LIVE) return
  live.sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [key, entry] of live.slice(0, live.length - MAX_LIVE)) {
    clients.delete(key)
    if (entry.client) void shutdownClient(entry.client)
  }
}

function shutdownClient(client: LspClient): Promise<void> {
  const existing = shutdownPromises.get(client)
  if (existing) return existing
  const promise = client.shutdown().finally(() => {
    shutdownPromises.delete(client)
  })
  shutdownPromises.set(client, promise)
  return promise
}

async function startClient(spec: ServerSpec, root: string, key: string, projectDir: string, allowProjectTools: boolean): Promise<LspClient | undefined> {
  const command = await resolveCommand(spec, projectDir, allowProjectTools).catch(() => undefined)
  if (!command) {
    failures.set(key, Date.now())
    clients.delete(key)
    return undefined
  }

  projectDirByRoot.set(root, path.resolve(projectDir))

  let initializationOptions: Record<string, unknown> | undefined
  try {
    initializationOptions = await spec.initializationOptions?.(root, allowProjectTools)
  } catch {
    failures.set(key, Date.now())
    clients.delete(key)
    return undefined
  }

  try {
    const client = new LspClient({ command, args: spec.args, cwd: root, rootUri: pathToUri(root) })
    await client.initialize(root, initializationOptions)
    const entry = clients.get(key)
    if (entry) {
      entry.client = client
      entry.lastUsed = Date.now()
    }
    ensureSweeper()
    enforceMaxLive()
    return client
  } catch {
    failures.set(key, Date.now())
    clients.delete(key)
    return undefined
  }
}

/** The live client for a file's server and root, starting one on first use. */
async function getClient(spec: ServerSpec, file: string, projectDir: string, allowProjectTools: boolean): Promise<LspClient | undefined> {
  if (lspDisabled()) return undefined
  const root = await findRoot(spec, file, projectDir)
  const key = `${spec.id}\u0000${root}`
  const failedAt = failures.get(key)
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < FAILURE_TTL) return undefined
    failures.delete(key)
  }
  const existing = clients.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    return await existing.promise
  }
  const promise = startClient(spec, root, key, projectDir, allowProjectTools)
  clients.set(key, { promise, lastUsed: Date.now() })
  return await promise
}

export interface LspDiagnosticsResult {
  server: string
  diagnostics: Diagnostic[]
  errors: number
}

/** One LSP diagnostic, as the post-edit check reports them. */
function toDiagnostic(file: string, projectDir: string, d: LspDiagnostic): Diagnostic {
  const severity = d.severity === 1 ? "error" : "warning"
  const code = d.code === undefined || d.code === null ? "" : ` ${String(d.code)}`
  return {
    file: path.relative(projectDir, file).split(path.sep).join("/"),
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    message: `${severity}${code}: ${d.message}`,
  }
}

/**
 * Diagnostics for a file from its language server, or undefined on any failure,
 * timeout or abort. Never throws: the caller treats it as an optional extra.
 */
export async function lspDiagnostics(
  file: string,
  projectDir: string,
  opts: { signal?: AbortSignal; allowProjectTools?: boolean; timeoutMs?: number } = {},
): Promise<LspDiagnosticsResult | undefined> {
  try {
    if (lspDisabled()) return undefined
    if (opts.signal?.aborted) return undefined
    const spec = serverForFile(file)
    if (!spec) return undefined
    const text = await fs.readFile(file, "utf8")
    const client = await getClient(spec, file, projectDir, opts.allowProjectTools ?? false)
    if (!client) return undefined
    const uri = pathToUri(file)
    const before = Date.now()
    client.openOrChange(file, text, spec.languageId(file))
    const first = await client.waitForDiagnostics(uri, before, opts.timeoutMs ?? 8000)
    if (first === undefined) return undefined
    // A TypeScript server often publishes an empty set first, then the real one:
    // wait a little more and take whatever is newest.
    await client.waitForDiagnostics(uri, client.diagnosticsAt(uri), 600)
    const published = client.currentDiagnostics(uri) ?? first
    if (opts.signal?.aborted) return undefined
    const diagnostics = published.filter((d) => d.severity === 1 || d.severity === 2).slice(0, DIAGNOSTIC_MAX).map((d) => toDiagnostic(file, projectDir, d))
    const errors = published.filter((d) => d.severity === 1).length
    return { server: spec.id, diagnostics, errors }
  } catch {
    return undefined
  }
}

interface LspLocation {
  uri: string
  range: { start: { line: number; character: number } }
}

interface LspHover {
  contents?: unknown
}

function locationLines(locations: LspLocation[], projectDir: string): string {
  const lines: string[] = []
  for (const location of locations.slice(0, LOCATION_MAX)) {
    let rel: string
    try {
      rel = path.relative(projectDir, uriToPath(location.uri)).split(path.sep).join("/")
    } catch {
      continue
    }
    lines.push(`${rel}:${location.range.start.line + 1}:${location.range.start.character + 1}`)
  }
  return lines.join("\n")
}

/** Hover contents, whatever shape the server used, as plain text. */
function hoverText(contents: unknown): string {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n")
  if (contents && typeof contents === "object") {
    const value = contents as { value?: unknown; language?: unknown }
    if (typeof value.value === "string") {
      const language = typeof value.language === "string" ? value.language : ""
      return `\`\`\`${language}\n${value.value}\n\`\`\``
    }
  }
  return ""
}

/** Strip markdown code fences and collapse blank runs. */
function plainText(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * A definition, references or hover for a position, formatted as text, or
 * undefined on any failure. Never throws.
 */
export async function lspRequest(
  kind: "definition" | "references" | "hover",
  file: string,
  line: number,
  column: number,
  projectDir: string,
  opts: { signal?: AbortSignal; allowProjectTools?: boolean; timeoutMs?: number } = {},
): Promise<string | undefined> {
  try {
    if (lspDisabled()) return undefined
    if (opts.signal?.aborted) return undefined
    const spec = serverForFile(file)
    if (!spec) return undefined
    const text = await fs.readFile(file, "utf8")
    const client = await getClient(spec, file, projectDir, opts.allowProjectTools ?? false)
    if (!client) return undefined
    client.openOrChange(file, text, spec.languageId(file))
    const uri = pathToUri(file)
    const position = { line: Math.max(0, line - 1), character: Math.max(0, column - 1) }
    const timeout = opts.timeoutMs ?? 8000
    if (kind === "hover") {
      const hover = (await client.request<LspHover | null>("textDocument/hover", { textDocument: { uri }, position }, timeout)) ?? undefined
      if (!hover) return undefined
      const plain = plainText(hoverText(hover.contents))
      if (!plain) return undefined
      return plain.length > HOVER_MAX ? `${plain.slice(0, HOVER_MAX)}\n… (cut)` : plain
    }
    const method = kind === "definition" ? "textDocument/definition" : "textDocument/references"
    const params = kind === "definition" ? { textDocument: { uri }, position } : { textDocument: { uri }, position, context: { includeDeclaration: true } }
    const result = await client.request<unknown>(method, params, timeout)
    const locations = Array.isArray(result) ? (result as LspLocation[]) : result && typeof result === "object" && Array.isArray((result as { links?: LspLocation[] }).links) ? (result as { links: LspLocation[] }).links : []
    if (!locations.length) return undefined
    return locationLines(locations, projectDir)
  } catch {
    return undefined
  }
}

/** Shut every live client down and forget the cache. */
export async function shutdownLsp(): Promise<void> {
  if (sweeper) {
    clearInterval(sweeper)
    sweeper = undefined
  }

  const entries = [...clients.values()]
  clients.clear()

  const pending = [...shutdownPromises.values()]
  for (const entry of entries) {
    if (entry.client) pending.push(shutdownClient(entry.client))
  }

  await Promise.all(pending)
  projectDirByRoot.clear()
}

/** The block appended to an edit's output when the server found something. */
export function formatLspDiagnostics(rel: string, result: LspDiagnosticsResult): string {
  if (!result.diagnostics.length) return ""
  const lines = result.diagnostics.map((d) => `${d.file}:${d.line}:${d.column}: ${d.message}`).join("\n")
  return `\n\nLSP (${result.server}) diagnostics for ${rel}:\n${lines}\nFix these before moving on, or say why they are expected.`
}
