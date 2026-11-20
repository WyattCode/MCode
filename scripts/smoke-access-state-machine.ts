import { isDeepStrictEqual } from "node:util"
import { belowFullMap, defaultAccess, sessionAccess } from "../src/shared/access"
import { DEFAULT_PERMISSIONS, PERMISSION_KINDS, type PermissionAction, type PermissionKind } from "../src/shared/protocol"
import { accessPatch, fullAccessOff } from "../src/renderer/src/lib/confirm-queue"
import type { Check } from "./smoke-round5"

export function accessStateMachine(check: Check, section: (name: string) => void): void {
  section("Access state transitions")
  const allAllow = Object.fromEntries(PERMISSION_KINDS.map((kind) => [kind, "allow"])) as Record<PermissionKind, PermissionAction>
  const off = { allowFullAccess: false, accessLevel: "ask", permissions: allAllow } as const
  const full = { ...off, allowFullAccess: true, accessLevel: "full" } as const

  check("an ask-free map with the switch off stays at default", defaultAccess(off) === "ask")
  check("an explicit full level falls back with the switch off", defaultAccess({ ...off, accessLevel: "full" }) === "ask")
  check("an explicit full level stays full with the switch on", defaultAccess(full) === "full")
  check("a session at full follows the default with the switch off", sessionAccess("full", off) === "ask")

  const enabled = { ...off, ...accessPatch(off, "full"), allowFullAccess: true }
  const { patch, dropped } = fullAccessOff(enabled)
  const wirePatch = JSON.parse(JSON.stringify(patch))
  check("switching off drops the level and restores the ask-free map",
    dropped && patch.accessLevel === "ask" && isDeepStrictEqual(patch.permissions, allAllow), patch)
  check("switching off serializes an empty backup over the stored backup",
    isDeepStrictEqual(patch.accessBefore, {}) && isDeepStrictEqual(wirePatch.accessBefore, {}), patch)
  check("the merged configuration stays at default after the round trip", defaultAccess({ ...enabled, ...wirePatch }) === "ask")

  const accessBefore = { ...DEFAULT_PERMISSIONS, edit: "allow", bash: "ask" } as const
  const repeated = accessPatch({ ...full, accessBefore }, "full")
  check("entering full again preserves the original answers", isDeepStrictEqual(repeated?.accessBefore, accessBefore), repeated)

  const withoutBackup = { ...full, permissions: { ...allAllow, bash: "deny" as const }, accessBefore: {} }
  const defaultsWithDeny = { ...DEFAULT_PERMISSIONS, bash: "deny" }
  check("leaving full with an empty backup restores defaults and keeps deny",
    isDeepStrictEqual(accessPatch(withoutBackup, "ask")?.permissions, defaultsWithDeny))
  check("below full an empty backup uses defaults and keeps deny",
    isDeepStrictEqual(belowFullMap(withoutBackup), defaultsWithDeny))
  check("below full the switch off uses the live map despite a stale backup",
    isDeepStrictEqual(belowFullMap({ ...off, accessBefore }), allAllow))
}
