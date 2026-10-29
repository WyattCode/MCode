/**
 * Windows Hello as a reveal gate, not a lock on the data.
 *
 * DPAPI (safe-storage.ts) is what actually seals credentials at rest; this is
 * an extra UI gate in front of revealing them, so a machine left unlocked on a
 * desk does not hand its keys to whoever sits down. Nothing here imports
 * Electron: the PowerShell runner is handed in, so the checks can hand in a
 * stub and read back what it was asked to run.
 *
 * Electron 41 has no Windows Hello: `promptTouchID`/`canPromptTouchID` are
 * darwin-only. The only way to reach WinRT's UserConsentVerifier from here is
 * PowerShell, which is what the scripts below are.
 */

export const USER_VERIFY_FILE = "user-verify.json"

export type UserVerifyAvailability = "available" | "unavailable" | "unknown"
export type UserVerifyOutcome = "verified" | "canceled" | "failed" | "unsupported"

/** Windows Hello is a Windows feature; the other platforms have no gate to offer. */
export function userVerifySupported(platform: NodeJS.Platform): boolean {
  return platform === "win32"
}

/** The stored choice, which a missing or unreadable file leaves off. */
export function parseUserVerifyPref(text: string): boolean {
  try {
    return (JSON.parse(text) as { requireRevealGate?: unknown })?.requireRevealGate === true
  } catch {
    return false
  }
}

export function renderUserVerifyPref(requireRevealGate: boolean): string {
  return JSON.stringify({ requireRevealGate })
}

/*
 * The PowerShell both scripts share: load the WinRT type, then find the one
 * `AsTask` overload that turns an `IAsyncOperation<T>` into a `Task<T>` so the
 * result can be awaited from .NET. `try {` is left open for the caller's body.
 */
const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime] | Out-Null",
  "  Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
].join("\n")

/** PowerShell that prints one line `AVAIL:<enum>` using UserConsentVerifier.CheckAvailabilityAsync. */
export function availabilityScript(): string {
  return [
    PS_PRELUDE,
    "  $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()",
    "  $task = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @($op))",
    "  $task.Wait(30000) | Out-Null",
    "  Write-Output ('AVAIL:' + $task.Result)",
    "} catch {",
    "  Write-Output 'AVAIL:Unknown'",
    "}",
  ].join("\n")
}

/** PowerShell that prints one line `RESULT:<enum>` using RequestVerificationAsync(reason). */
export function verifyScript(reason: string): string {
  // A single-quoted PowerShell string escapes its own quote by doubling it.
  const quoted = `'${reason.split("'").join("''")}'`
  return [
    PS_PRELUDE,
    `  $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync(${quoted})`,
    "  $task = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))",
    "  $task.Wait(120000) | Out-Null",
    "  Write-Output ('RESULT:' + $task.Result)",
    "} catch {",
    "  Write-Output 'RESULT:Failed'",
    "}",
  ].join("\n")
}

/** The value after `prefix` on whichever line carries it, or nothing. */
function lineValue(stdout: string, prefix: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim()
  }
  return undefined
}

export function parseAvailability(stdout: string): UserVerifyAvailability {
  const value = lineValue(stdout, "AVAIL:")
  if (value === "Available") return "available"
  if (value === "DeviceNotPresent" || value === "NotConfiguredForUser" || value === "DisabledByPolicy" || value === "DeviceBusy") return "unavailable"
  return "unknown"
}

export function parseVerifyResult(stdout: string): UserVerifyOutcome {
  const value = lineValue(stdout, "RESULT:")
  if (value === "Verified") return "verified"
  if (value === "Canceled") return "canceled"
  return "failed"
}

/** What this needs of a process runner: a script in, its exit code and output out. */
export interface UserVerifyRunner {
  run(script: string): Promise<{ code: number; stdout: string; stderr: string }>
}

/** Whether Hello can be asked here at all. A spawn that failed, or a line nobody wrote, is unknown. */
export async function checkUserVerifyAvailable(runner: UserVerifyRunner): Promise<UserVerifyAvailability> {
  try {
    const result = await runner.run(availabilityScript())
    if (result.code !== 0) return "unknown"
    return parseAvailability(result.stdout)
  } catch {
    return "unknown"
  }
}

/** Asks Hello for the reason given. Never throws: a spawn that failed is a failed verification. */
export async function requestUserVerify(runner: UserVerifyRunner, reason: string): Promise<UserVerifyOutcome> {
  try {
    const result = await runner.run(verifyScript(reason))
    if (result.code !== 0) return "failed"
    return parseVerifyResult(result.stdout)
  } catch {
    return "failed"
  }
}

/**
 * Whether the reveal is unlocked for this session.
 *
 * In memory only: a restart, a lock or a suspend clears it, so the next reveal
 * asks again. Nothing is written down, because a written-down unlock is not a
 * gate.
 */
export class UserVerifySession {
  unlocked = false

  markUnlocked(): void {
    this.unlocked = true
  }

  clear(): void {
    this.unlocked = false
  }

  /**
   * If the gate is off, or this session is already unlocked, nothing is asked.
   * Otherwise Hello is asked, and only a verified answer unlocks the session.
   */
  async ensureUnlocked(
    runner: UserVerifyRunner,
    requireGate: boolean,
    reason: string,
  ): Promise<{ ok: boolean; skipped?: boolean; outcome?: UserVerifyOutcome }> {
    if (!requireGate) return { ok: true, skipped: true }
    if (this.unlocked) return { ok: true, skipped: true }
    const outcome = await requestUserVerify(runner, reason)
    if (outcome === "verified") {
      this.markUnlocked()
      return { ok: true }
    }
    return { ok: false, outcome }
  }
}
