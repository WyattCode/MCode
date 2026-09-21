/**
 * The pure rules of the models page's provider form (MiMo 26.920), shared by
 * the form and smoke.
 */

/* MiMo 26.920's limit menus: three sizes each, in tokens, and a custom field under them. */
export const LIMIT_PRESETS = {
  context: [256_000, 512_000, 1_000_000],
  output: [32_000, 64_000, 128_000],
} as const

/** A limit as MiMo writes it on its button: 256K, 1M, the number itself, or a dash when unset. */
export function limitLabel(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—"
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`
  return String(value)
}

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

/** The four inputs besides text a model's modalities menu offers, in MiMo's order. */
export const MODALITIES = ["image", "audio", "video", "pdf"] as const

export type Modality = (typeof MODALITIES)[number]

/**
 * The modalities button's summary: 全模态 when pictures, sound and video are
 * all read, otherwise the ones that are, joined with a dot; PDF after either;
 * a dash for none. MiMo's `omni` leaves PDF out of the test, and so does this.
 */
export function modalitySummary(on: Record<Modality, boolean>, label: (key: Modality | "omni") => string): string {
  const media = (["image", "audio", "video"] as const).filter((key) => on[key])
  const head = media.length === 3 ? label("omni") : media.map(label).join("·")
  return [head, on.pdf ? label("pdf") : ""].filter(Boolean).join("·") || "—"
}

/** A free id for a clone, MiMo's way: `<id>-copy`, then `-copy-2`, `-copy-3`... */
export function cloneId(source: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const id = n === 1 ? `${source}-copy` : `${source}-copy-${n}`
    if (!taken.has(id)) return id
  }
}
