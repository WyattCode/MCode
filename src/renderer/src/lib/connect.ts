import type { AuthMethodKind, ProviderStatus } from "@shared/protocol"
import { t } from "./i18n"

/**
 * Grouping providers by brand, and listing the ways into each.
 *
 * A brand can be several providers underneath - a ChatGPT subscription and the
 * metered OpenAI API are different endpoints with different credentials - but
 * to someone connecting an account they are one vendor offering a choice. The
 * settings page and the connect dialog need the same answer, and two copies
 * would drift.
 */

export interface Group {
  id: string
  name: string
  recommended: boolean
  order: number
  entries: ProviderStatus[]
}

/** One selectable way in: a provider paired with one of its auth methods. */
export interface Way {
  key: string
  provider: ProviderStatus
  method: AuthMethodKind
  label: string
}

export function groupProviders(providers: ProviderStatus[], includeCustom = false): Group[] {
  const byId = new Map<string, Group>()
  for (const provider of providers) {
    if (provider.custom && !includeCustom) continue
    const id = provider.group ?? provider.id
    const existing = byId.get(id)
    if (existing) {
      existing.entries.push(provider)
      existing.recommended ||= provider.recommended
      existing.order = Math.min(existing.order, provider.order)
      continue
    }
    byId.set(id, {
      id,
      name: provider.groupName ?? provider.name,
      recommended: provider.recommended,
      order: provider.order,
      entries: [provider],
    })
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** Methods for one provider, subscription logins first. An empty list means a key. */
function methodsOf(provider: ProviderStatus): AuthMethodKind[] {
  const methods = provider.authMethods.length ? provider.authMethods : (["api-key"] as AuthMethodKind[])
  return [...methods].sort((a, b) => Number(a === "api-key") - Number(b === "api-key"))
}

function methodName(method: AuthMethodKind): string {
  if (method === "api-key") return t("auth.apiKey")
  if (method === "local") return t("auth.local")
  return t(method === "oauth-browser" ? "auth.browser" : "auth.headless")
}

/**
 * Every way into a brand, flattened.
 *
 * @param brand a group's entries, or a single provider's, wrapped in an array.
 */
export function waysFor(entries: ProviderStatus[]): Way[] {
  const out: Way[] = []
  for (const entry of entries) {
    for (const method of methodsOf(entry)) {
      /*
       * A vendor can offer two keyed endpoints - metered API and a subscription
       * plan - so a bare "API key" on both would make them indistinguishable.
       * Anything else is named after the provider it belongs to, because the
       * brand row above already says which brand this is.
       */
      const label =
        method === "api-key"
          ? entries.length > 1 && entry.modeLabel
            ? t(entry.modeLabel)
            : t("auth.apiKey")
          : method === "local"
            ? t("auth.local")
            : `${entry.name} (${methodName(method)})`
      out.push({ key: `${entry.id}:${method}`, provider: entry, method, label })
    }
  }
  return out.sort((a, b) => Number(a.method === "api-key") - Number(b.method === "api-key"))
}

/** Whether a brand is already usable, however it was connected. */
export function groupConnected(group: Group): boolean {
  return group.entries.some((entry) => entry.configured)
}
