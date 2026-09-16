/**
 * MiMo's environment refresh at launch: the environment MCode was started with
 * can be older than the machine's. An app opened from the installer's last
 * page, from a long-running Explorer, or relaunched after an update inherits
 * the PATH of that moment, so a git, node or python installed since is "not
 * found"; a macOS app opened from the Dock gets only the system paths, and
 * nothing Homebrew put in the login shell's profile.
 *
 * So, once, before the backend or any terminal starts:
 *  - Windows reads the machine and user environment from the registry (read
 *    only), expands `%VAR%`, and puts that PATH first;
 *  - macOS and Linux ask the login shell (`$SHELL -ilc` / `-lc`) for its
 *    environment and put its PATH first.
 * Variables the process does not have yet are added; ones it has are left as
 * they are, so a value set on purpose for this launch still wins. Every step is
 * bounded (3 s) and a failure leaves the environment untouched. Development
 * runs (the dev server) are left alone, as MiMo's are.
 *
 * Electron-free: the caller passes execFileSync, so smoke can feed it canned
 * `reg query` and shell output.
 */

export type ExecFileSync = (file: string, args: string[], options: Record<string, unknown>) => string | Buffer

export const ENV_TIMEOUT_MS = 3000
const MAX_OUTPUT = 1024 * 1024
const BEGIN = "__MCODE_LOGIN_ENV_BEGIN__"
const END = "__MCODE_LOGIN_ENV_END__"
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/* The machine's environment first, then the user's, which Windows lets override it. */
const REGISTRY_KEYS = ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"]

/**
 * The variables the login shell is started with: enough for a profile script
 * to find the user, the terminal and the network, and nothing of Electron's.
 */
const SHELL_BASELINE = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "TERM", "COLORTERM", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
])

/** `reg query` output as name -> raw value, for string values only. Names may contain spaces. */
export function parseRegQuery(output: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^ {4}(.+?) {4}REG_(?:EXPAND_)?SZ {4}(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim()
    if (!value) continue
    values[match[1].toUpperCase() === "PATH" ? "PATH" : match[1]] = value
  }
  return values
}

/** `%NAME%` replaced from `env` (names compared without case, as Windows does); unknown names stay as written. */
export function expandPercent(text: string, env: Record<string, string | undefined>): string {
  const byName = new Map<string, string>()
  for (const [name, value] of Object.entries(env)) if (typeof value === "string") byName.set(name.toUpperCase(), value)
  return text.replace(/%([^%]+)%/g, (whole, name: string) => byName.get(name.toUpperCase()) ?? whole)
}

/** The entries of `first` then those of `second`, each once. Windows compares them without case. */
export function unionPath(first: string, second: string, delimiter: string, ignoreCase: boolean): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...first.split(delimiter), ...second.split(delimiter)]) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = ignoreCase ? trimmed.replace(/[\\/]+$/, "").toLowerCase() : trimmed
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out.join(delimiter)
}

/** The environment between the markers the login shell printed, NUL-separated. */
export function parseShellEnv(output: string): Record<string, string> | undefined {
  const parts = output.split("\0")
  let start = -1
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].endsWith(BEGIN)) {
      start = index
      break
    }
  }
  if (start < 0) return undefined
  const end = parts.indexOf(END, start + 1)
  if (end < 0) return undefined
  const env: Record<string, string> = {}
  for (const entry of parts.slice(start + 1, end)) {
    const equals = entry.indexOf("=")
    if (equals <= 0) continue
    const name = entry.slice(0, equals)
    if (NAME.test(name)) env[name] = entry.slice(equals + 1)
  }
  return env
}

const text = (output: string | Buffer) => (typeof output === "string" ? output : output.toString("utf8"))

/**
 * Reads one registry key through cmd with the UTF-8 code page. reg.exe writes
 * in the console's code page, so a plain call garbles every non-ASCII path (a
 * user folder with a Chinese name, say) when read back as UTF-8.
 */
function queryKey(exec: ExecFileSync, env: Record<string, string | undefined>, key: string): Record<string, string> {
  const root = env.SystemRoot || env.windir || "C:\\Windows"
  const shell = env.ComSpec || `${root}\\System32\\cmd.exe`
  const reg = `${root}\\System32\\reg.exe`
  const output = exec(shell, ["/d", "/s", "/c", `"chcp 65001>nul & "${reg}" query "${key}""`], {
    timeout: ENV_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
  return parseRegQuery(text(output))
}

export interface RefreshResult {
  source: "registry" | "login-shell" | "unchanged"
  /** Names added to the environment (PATH counts when it changed). */
  added: string[]
}

/** Updates `env` in place (process.env in the app). Never throws. */
export function refreshEnvironment(options: {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  exec: ExecFileSync
  development: boolean
  home: string
}): RefreshResult {
  const { env, platform, exec } = options
  const unchanged: RefreshResult = { source: "unchanged", added: [] }
  if (options.development) return unchanged
  try {
    let found: Record<string, string> = {}
    let freshPath = ""
    let source: RefreshResult["source"]
    if (platform === "win32") {
      const paths: string[] = []
      for (const key of REGISTRY_KEYS) {
        let values: Record<string, string>
        try {
          values = queryKey(exec, env, key)
        } catch {
          continue
        }
        const { PATH: keyPath, ...rest } = values
        if (keyPath) paths.push(keyPath)
        Object.assign(found, rest)
      }
      const scope = { ...env, ...found }
      found = Object.fromEntries(Object.entries(found).map(([name, value]) => [name, expandPercent(value, scope)]))
      freshPath = paths.length ? expandPercent(paths.join(";"), { ...env, ...found }) : ""
      source = "registry"
    } else {
      const shell = env.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "/bin/bash")
      const script = `printf '${BEGIN}\\0'; command env -0 2>/dev/null || command env | tr '\\n' '\\0'; printf '${END}\\0'`
      const baseline = Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && (SHELL_BASELINE.has(name) || name.startsWith("LC_") || name.startsWith("XDG_"))))
      const output = exec(shell, [platform === "darwin" ? "-ilc" : "-lc", script], {
        timeout: ENV_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        cwd: options.home,
        env: baseline,
        stdio: ["ignore", "pipe", "ignore"],
      })
      const parsed = parseShellEnv(text(output))
      if (!parsed) return unchanged
      const { PATH: shellPath, ...rest } = parsed
      found = rest
      freshPath = shellPath ?? ""
      source = "login-shell"
    }
    const added: string[] = []
    for (const [name, value] of Object.entries(found)) {
      if (env[name] !== undefined || !value) continue
      env[name] = value
      added.push(name)
    }
    if (freshPath) {
      const windows = platform === "win32"
      const merged = unionPath(freshPath, env.PATH ?? "", windows ? ";" : ":", windows)
      if (merged !== env.PATH) {
        env.PATH = merged
        added.push("PATH")
      }
    }
    return added.length || freshPath ? { source, added } : unchanged
  } catch {
    return unchanged
  }
}
