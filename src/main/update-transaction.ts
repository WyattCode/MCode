/**
 * MiMo's update transaction (N9-4): before the installer runs, a small record
 * says which version is being replaced by which; the next launch compares it
 * with the version that actually started.
 *
 *  - the target version is running: the update finished, the record goes;
 *  - the installer was started but the old version is running, or an hour has
 *    passed without the target appearing, or the install failed to start:
 *    the update was interrupted - the window says so once, and the record goes;
 *  - otherwise (the installer may still be working) it is left for next time.
 *
 * MiMo also repairs shortcuts here; MCode's installer keeps them itself (it
 * runs with --updated, into the same folder), so that part is not repeated.
 *
 * Electron-free: the caller passes a store for the one file.
 */

export const TRANSACTION_FILE = "update-transaction.json"
export const STALE_AFTER_MS = 60 * 60 * 1000
const ERROR_LIMIT = 500

export interface TransactionStore {
  read(): string | undefined
  write(text: string): void
  remove(): void
}

export interface Transaction {
  version: 1
  phase: "pending" | "installer-started" | "interrupted"
  fromVersion: string
  targetVersion: string
  startedAt: number
  installerStartedAt?: number
  error?: string
}

export interface Interrupted {
  targetVersion: string
  /** The reason as recorded: "stale", "version-mismatch", "no-ready", "invalid", or the installer's error. */
  error: string
}

function parse(text: string): Transaction | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const entry = value as Partial<Transaction> | null
  if (!entry || typeof entry !== "object" || entry.version !== 1) return undefined
  if (!["pending", "installer-started", "interrupted"].includes(String(entry.phase))) return undefined
  if (typeof entry.fromVersion !== "string" || typeof entry.targetVersion !== "string" || !entry.targetVersion) return undefined
  if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) return undefined
  if (entry.phase === "interrupted" && (typeof entry.error !== "string" || !entry.error)) return undefined
  return entry as Transaction
}

export interface UpdateTransactions {
  /** Records the start of an install; false when the record could not be written. */
  begin(fromVersion: string, targetVersion: string): boolean
  markInstallerStarted(): void
  markFailed(error: unknown): void
  /** Called once at launch; returns an interruption to report, if any. */
  reconcile(currentVersion: string): Interrupted | undefined
}

export function createTransactions(store: TransactionStore, now: () => number = () => Date.now()): UpdateTransactions {
  const save = (entry: Transaction) => {
    try {
      store.write(JSON.stringify(entry))
      return true
    } catch {
      return false
    }
  }
  const load = () => {
    let text: string | undefined
    try {
      text = store.read()
    } catch {
      return undefined
    }
    return text === undefined ? undefined : { text, entry: parse(text) }
  }
  const drop = () => {
    try {
      store.remove()
    } catch {
      // A record that cannot be removed is reported again next time; nothing worse.
    }
  }

  return {
    begin(fromVersion, targetVersion) {
      return save({ version: 1, phase: "pending", fromVersion, targetVersion, startedAt: now() })
    },
    markInstallerStarted() {
      const entry = load()?.entry
      if (entry?.phase !== "pending") return
      save({ ...entry, phase: "installer-started", installerStartedAt: now() })
    },
    markFailed(error) {
      const entry = load()?.entry
      if (!entry || entry.phase === "interrupted") return
      const text = (error instanceof Error ? error.message : String(error ?? "")).trim().slice(0, ERROR_LIMIT) || "install failed"
      save({ ...entry, phase: "interrupted", error: text })
    },
    reconcile(currentVersion) {
      const found = load()
      if (!found) return undefined
      const entry = found.entry
      if (!entry) {
        drop()
        return { targetVersion: "", error: "invalid" }
      }
      if (entry.phase === "interrupted") {
        drop()
        return { targetVersion: entry.targetVersion, error: entry.error ?? "install failed" }
      }
      if (currentVersion === entry.targetVersion) {
        drop()
        return undefined
      }
      const stale = now() - entry.startedAt >= STALE_AFTER_MS
      const mismatch = entry.phase === "installer-started" && currentVersion === entry.fromVersion
      if (!stale && !mismatch) return undefined
      drop()
      return { targetVersion: entry.targetVersion, error: stale ? "stale" : "version-mismatch" }
    },
  }
}
