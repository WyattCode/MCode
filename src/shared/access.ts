import { DEFAULT_PERMISSIONS, PERMISSION_ACTIONS, PERMISSION_KINDS, type PermissionAction, type PermissionKind } from "./protocol"

/**
 * MiMo's access levels, and which one a conversation runs at.
 *
 * Three positions: the default (the settings' own answers), 帮我审批 in the
 * middle, and full access. The app keeps one default - the level the home
 * screen's chip sets - and each conversation may keep a level of its own,
 * saved with it; a conversation without one follows the default.
 */
export type Access = "ask" | "auto" | "full"
export const ACCESS_LEVELS: readonly Access[] = ["ask", "auto", "full"]

export interface AccessConfig {
  accessLevel?: string
  permissions?: Readonly<Partial<Record<string, string>>>
  /** The map full access replaced, put back when the default leaves it. */
  accessBefore?: Readonly<Partial<Record<string, string>>>
  allowFullAccess?: boolean
}

export function isAccess(value: unknown): value is Access {
  return typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value)
}

/** The default level, read the way the chip reads it: the middle one when set, full once nothing asks. */
export function defaultAccess(config: AccessConfig | undefined): Access {
  if (config?.accessLevel === "auto") return "auto"
  const map = config?.permissions
  if (!map) return "ask"
  return PERMISSION_KINDS.some((kind) => map[kind] === "ask") ? "ask" : "full"
}

/**
 * A conversation's level: its own if it has one, else the default. Its own full
 * access lapses once full access is no longer allowed, as MiMo reads it.
 */
export function sessionAccess(own: unknown, config: AccessConfig | undefined): Access {
  if (!isAccess(own)) return defaultAccess(config)
  if (own === "full" && !config?.allowFullAccess) return defaultAccess(config)
  return own
}

function actionOf(value: unknown, fallback: PermissionAction): PermissionAction {
  return typeof value === "string" && (PERMISSION_ACTIONS as readonly string[]).includes(value) ? (value as PermissionAction) : fallback
}

/**
 * The answers a conversation below full access runs on: the settings' map, or,
 * while the default is itself full access, the map that full access set aside.
 * A refusal is kept either way.
 */
export function belowFullMap(config: AccessConfig | undefined): Record<PermissionKind, PermissionAction> {
  const map = config?.permissions ?? {}
  const kept = defaultAccess(config) === "full" ? (config?.accessBefore ?? {}) : map
  const out = {} as Record<PermissionKind, PermissionAction>
  for (const kind of PERMISSION_KINDS) {
    out[kind] = actionOf(map[kind], DEFAULT_PERMISSIONS[kind]) === "deny" ? "deny" : actionOf(kept[kind], DEFAULT_PERMISSIONS[kind])
  }
  return out
}

/** What one bucket does in a conversation at `level`: at full access everything not refused runs. */
export function accessAction(kind: PermissionKind, level: Access, config: AccessConfig | undefined): PermissionAction {
  const below = belowFullMap(config)[kind]
  if (level !== "full") return below
  return below === "deny" ? "deny" : "allow"
}
