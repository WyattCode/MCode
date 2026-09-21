/**
 * The models.dev catalog, kept fresh the way MiMo's engine keeps it.
 *
 * MiMo's desktop starts its engine's catalog refresh as soon as the engine is
 * up: the cached copy is used when it is under five minutes old, otherwise
 * `https://models.dev/api.json` is fetched with a ten-second timeout, and the
 * same happens every hour after. A download is written atomically to a cache
 * file and laid over the copy shipped with the app; when nothing was ever
 * downloaded, or the cache is unreadable, the shipped copy stands alone.
 * Every failure is logged and otherwise ignored - the catalog only improves
 * what is known about a model and never stops the app from working.
 *
 * MCODE_DISABLE_MODELS_FETCH turns the network off (the shipped and cached
 * copies still load), and MCODE_MODELS_URL points it at another host, as
 * MiMo's MIMOCODE_ variables do.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { overlayCatalog, trimCatalog, type Catalog } from "@shared/models-dev"

/** MiMo's freshness window for the cache and its refresh period. */
export const CATALOG_FRESH_MS = 5 * 60 * 1000
export const CATALOG_REFRESH_MS = 60 * 60 * 1000
export const CATALOG_TIMEOUT_MS = 10_000
export const CATALOG_SOURCE = "https://models.dev"

export interface CatalogOptions {
  /** Where a download is kept between launches. */
  cacheFile: string
  /** The copy shipped with the app. */
  shipped: () => Promise<unknown>
  /** The host to fetch from; `/api.json` is appended. */
  source?: string
  /** True when the network must not be used. */
  disabled?: () => boolean
  fetch?: typeof fetch
  onError?: (error: unknown) => void
}

/** The shipped copy, loaded only when first asked for. */
export async function shippedCatalog(): Promise<unknown> {
  return (await import("../../../resources/models-snapshot.json")).default
}

export class ModelCatalog {
  private current: Catalog = {}
  private shipped?: Promise<Catalog>
  private loaded?: Promise<void>
  private flight?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private readonly listeners = new Set<() => void>()

  constructor(private readonly options: CatalogOptions) {}

  /** The catalog as it stands; empty until `load` has run. */
  get(): Catalog {
    return this.current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The cached download over the shipped copy, or the shipped copy alone. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      this.current = await this.compose(await this.readCache())
    })()
    return this.loaded
  }

  /** Fetches unless the cache is fresh (or `force`), then publishes what changed. Never rejects. */
  refresh(force = false): Promise<void> {
    if (!force && this.options.disabled?.()) return Promise.resolve()
    this.flight ??= this.update(force)
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.flight = undefined
      })
    return this.flight
  }

  /** MiMo's schedule: once now, then every hour, for as long as the app runs. */
  startRefresh(): () => void {
    if (this.timer || this.options.disabled?.()) return () => this.stop()
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), CATALOG_REFRESH_MS)
    this.timer.unref?.()
    return () => this.stop()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async update(force: boolean): Promise<void> {
    await this.load()
    if (!force && (await this.fresh())) return this.publish(await this.compose(await this.readCache()))
    const source = (this.options.source ?? CATALOG_SOURCE).replace(/\/+$/, "")
    const response = await (this.options.fetch ?? fetch)(`${source}/api.json`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
    const next = trimCatalog(await response.json())
    await fs.mkdir(path.dirname(this.options.cacheFile), { recursive: true })
    const temporary = `${this.options.cacheFile}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(next), { flag: "wx" })
      await fs.rename(temporary, this.options.cacheFile)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
    this.publish(await this.compose(next))
  }

  private async fresh(): Promise<boolean> {
    if (!(await this.readCache())) return false
    const stat = await fs.stat(this.options.cacheFile).catch(() => undefined)
    return Boolean(stat && Date.now() - stat.mtimeMs < CATALOG_FRESH_MS)
  }

  private async readCache(): Promise<Catalog | undefined> {
    try {
      return trimCatalog(JSON.parse(await fs.readFile(this.options.cacheFile, "utf8")))
    } catch {
      return undefined
    }
  }

  private async compose(downloaded?: Catalog): Promise<Catalog> {
    this.shipped ??= this.options
      .shipped()
      .then(trimCatalog)
      .catch((error: unknown) => {
        this.options.onError?.(error)
        return {}
      })
    const shipped = await this.shipped
    return downloaded ? overlayCatalog(shipped, downloaded) : shipped
  }

  private publish(next: Catalog): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return
    this.current = next
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.options.onError?.(error)
      }
    }
  }
}
