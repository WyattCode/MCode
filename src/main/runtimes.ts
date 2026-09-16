import path from "node:path"

/**
 * MiMo's bundled runtimes: a package build carries Node.js, Python (with the
 * document libraries) and ripgrep under `resources/runtimes/<platform>-<arch>`
 * (scripts/runtimes.mjs puts them there). They are not put on PATH - a
 * machine's own tools keep precedence, as in MiMo - but every child process is
 * told where they are through these variables, which the built-in skills name.
 * A variable the user already set wins over the bundled path.
 *
 * Electron-free; the caller passes the resources folder and an existence check.
 */

export const RUNTIME_VARIABLES = {
  node: "MCODE_NODE",
  npm: "MCODE_NPM",
  python: "MCODE_PYTHON",
  ripgrep: "MCODE_RIPGREP_PATH",
} as const

type Runtime = keyof typeof RUNTIME_VARIABLES

/** Where each program sits inside the runtime folder. */
export function runtimeFile(runtime: Runtime, platform: NodeJS.Platform): string {
  const windows = platform === "win32"
  switch (runtime) {
    case "node":
      return windows ? path.join("node", "node.exe") : path.join("node", "bin", "node")
    case "npm":
      return windows ? path.join("node", "node_modules", "npm", "bin", "npm-cli.js") : path.join("node", "lib", "node_modules", "npm", "bin", "npm-cli.js")
    case "python":
      return windows ? path.join("python", "python.exe") : path.join("python", "bin", "python3")
    case "ripgrep":
      return path.join("ripgrep", windows ? "rg.exe" : "rg")
  }
}

/**
 * The folders searched, in order: the packaged app's resources, then (for an
 * unpackaged run) the repository's resources/runtimes.
 */
export function runtimeFolders(options: { resourcesDir?: string; devDir?: string; platform: NodeJS.Platform; arch: string }): string[] {
  const tag = `${options.platform}-${options.arch}`
  const folders: string[] = []
  if (options.resourcesDir) folders.push(path.join(options.resourcesDir, "runtimes", tag))
  if (options.devDir) folders.push(path.join(options.devDir, tag))
  return folders
}

/** The variables for the runtimes that exist, plus PYTHONDONTWRITEBYTECODE when Python does (its folder may not be writable). */
export function bundledRuntimeEnv(options: {
  resourcesDir?: string
  devDir?: string
  platform: NodeJS.Platform
  arch: string
  exists(file: string): boolean
}): Record<string, string> {
  const found: Record<string, string> = {}
  const folders = runtimeFolders(options)
  for (const runtime of Object.keys(RUNTIME_VARIABLES) as Runtime[]) {
    for (const folder of folders) {
      const file = path.join(folder, runtimeFile(runtime, options.platform))
      try {
        if (!options.exists(file)) continue
      } catch {
        continue
      }
      found[RUNTIME_VARIABLES[runtime]] = file
      break
    }
  }
  if (found.MCODE_PYTHON) found.PYTHONDONTWRITEBYTECODE = "1"
  return found
}

/** Sets each variable the environment does not already have; returns the names it set. */
export function applyRuntimeEnv(env: Record<string, string | undefined>, found: Record<string, string>): string[] {
  const applied: string[] = []
  for (const [name, value] of Object.entries(found)) {
    if (env[name]) continue
    env[name] = value
    applied.push(name)
  }
  return applied
}
