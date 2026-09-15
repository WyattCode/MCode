/**
 * The pure rules of MiMo's add / edit model form, shared by the form and smoke.
 */

/* MiMo's preset pills: the label as written, the token count the pill writes into the field. */
export const LIMIT_PRESETS = {
  context: [
    { label: "32K", value: 32768 },
    { label: "64K", value: 65536 },
    { label: "128K", value: 131072 },
    { label: "256K", value: 262144 },
  ],
  output: [
    { label: "8K", value: 8192 },
    { label: "16K", value: 16384 },
    { label: "32K", value: 32768 },
    { label: "64K", value: 65536 },
  ],
} as const

/** A limit as typed: blank is the provider default; otherwise digits only, a positive safe integer. */
export function limitOf(text: string): { ok: boolean; value?: number } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? { ok: true, value } : { ok: false }
}

/** MiMo's endpoint check: it parses as a URL, it is http or https, and it names a host. */
export function validEndpoint(text: string): boolean {
  try {
    const url = new URL(text.trim())
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname)
  } catch {
    return false
  }
}
