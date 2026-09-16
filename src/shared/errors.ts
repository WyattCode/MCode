/**
 * A failure the window can phrase, rather than one it can only repeat.
 *
 * MiMo sorts every failure into a central table of codes and shows that code's
 * sentence, keeping the raw text aside (`{code, message, detail}`). Errors
 * raised in the backend reach this app's window as a string on the response
 * frame, so an English sentence written at the throw site is what a Chinese
 * reader sees. Carrying the code instead lets the window say it in its own
 * language, and the message stays as the detail for a log.
 */
export class CodedError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Values the code's sentence names, filled into its `{placeholders}`. */
    readonly params?: Record<string, string | number>,
  ) {
    super(message)
    this.name = "CodedError"
  }
}

/** The code a failure names, when it names one. */
export function codeOf(err: unknown): string | undefined {
  return err instanceof CodedError ? err.code : undefined
}

/** What that code's sentence fills in, when it has anything to fill. */
export function paramsOf(err: unknown): Record<string, string | number> | undefined {
  return err instanceof CodedError ? err.params : undefined
}

/** Disk failures MiMo gathers into one class ("artifact could not be written: <code>"). */
const FULL = new Set(["ENOSPC", "EDQUOT"])
const READONLY = new Set(["EROFS", "EACCES", "EPERM"])

/**
 * A write that failed for a reason the user can act on, said as one.
 *
 * A full disk and a data folder the app may not write are the two failures
 * that are neither transient nor a defect, and both used to surface as the
 * raw `ENOSPC: no space left on device` in a notice body.
 */
export function diskErrorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (!code) return undefined
  if (FULL.has(code)) return "error.diskFull"
  if (READONLY.has(code)) return "error.databaseReadonly"
  return undefined
}
