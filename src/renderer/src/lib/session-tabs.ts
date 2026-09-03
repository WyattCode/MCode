import { ref } from "vue"

/**
 * Which tabs the right-hand panel is showing, remembered per session.
 *
 * The reference keeps a map rather than two window-global flags: `sessionTabs:
 * { [sessionKey]: { all: string[]; active?: string } }` inside one persisted
 * layout blob (out/renderer/assets/main-8t-QUXax.js @2476077), read back
 * through `layout.tabs(sessionKey)` (@2503841). So opening the Context tab in
 * one conversation and moving to the next does not carry it along, and coming
 * back finds it where it was left - across a restart too. What MCode had
 * instead was two refs and a watch that emptied them on every session change,
 * with a comment saying there was nowhere to hang per-session state. This is
 * that somewhere.
 *
 * Two rules are copied along with the shape, because they are what the map is
 * for. Context is always spliced to the FRONT of the strip when it is opened
 * (`openSessionTab` @2471688: `all: [tab, ...current.tabs.all.filter(item =>
 * item !== tab)]`), and closing a tab moves to its left neighbour, then its
 * right, then the first (`closeSessionTab`: `active: all[index - 1] ?? all[index
 * + 1] ?? all2[0]`). Review is not in `all` at all - the reference filters it
 * out of the stored list and rejects it in `setAll`, because it is the
 * permanent tab the others sit beside.
 */

/** The tab that is always there, and so is never stored in the strip. */
export const REVIEW = "review"

export interface TabStrip {
  /** The tabs beside the review, in the order they are drawn. */
  all: string[]
  active?: string
}

interface Entry extends TabStrip {
  /** Last touched, for the eviction below. */
  used: number
}

const EMPTY: TabStrip = { all: [] }

/**
 * `const MAX_SESSION_KEYS = 50` (@2450055), with `pruneSessionKeys` scoring
 * every key by when it was last touched, pinning the current session at
 * `Number.MAX_SAFE_INTEGER` so it can never be the one dropped, and deleting
 * everything past the cap. Without it the blob grows once per session opened
 * and is never cleaned up.
 */
const MAX_SESSION_KEYS = 50

const STORAGE = "mcode.sessionTabs"

/**
 * Base64 of the directory, then the session, which is the reference's key minus
 * its first segment: `SessionStateKey.from(scope, SessionRouteKey.fromRoute(dir,
 * id))` (@1793948) composes `<scope>\0<base64(dir)>/<sessionID>`. The scope
 * names which server the session belongs to and this app's store does not
 * expose one - a window talks to a single server - so there is nothing to put
 * there rather than a placeholder pretending to be a scope.
 */
export function stripKey(directory?: string, sessionID?: string): string | undefined {
  if (!directory || !sessionID) return undefined
  // btoa reads its argument as latin1 and throws on anything else, and a
  // project path can be in any script at all.
  const bytes = new TextEncoder().encode(directory)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${btoa(binary)}/${sessionID}`
}

function load(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(STORAGE)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: Record<string, Entry> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<Entry>
      if (!Array.isArray(entry?.all)) continue
      out[key] = {
        all: entry.all.filter((tab): tab is string => typeof tab === "string" && tab !== REVIEW),
        active: typeof entry.active === "string" ? entry.active : undefined,
        used: typeof entry.used === "number" ? entry.used : 0,
      }
    }
    return out
  } catch {
    // A blob written by a newer build, or storage that is not there at all: the
    // strips are a convenience, and losing them is not worth failing to start.
    return {}
  }
}

const strips = ref<Record<string, Entry>>(load())

function save() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(strips.value))
  } catch {
    // Quota, or a private profile. The map still works for this run.
  }
}

/** Everything past the cap, oldest first, with the open session kept. */
function prune(pinned?: string) {
  const keys = Object.keys(strips.value)
  if (keys.length <= MAX_SESSION_KEYS) return
  const score = (key: string) => (key === pinned ? Number.MAX_SAFE_INTEGER : (strips.value[key]?.used ?? 0))
  const doomed = keys.sort((a, b) => score(b) - score(a)).slice(MAX_SESSION_KEYS)
  for (const key of doomed) delete strips.value[key]
}

/** The keys currently held, which is what the cap above is counted in. */
export function stripKeys(): string[] {
  return Object.keys(strips.value)
}

export function readStrip(key?: string): TabStrip {
  if (!key) return EMPTY
  return strips.value[key] ?? EMPTY
}

export function writeStrip(key: string | undefined, next: TabStrip): void {
  if (!key) return
  strips.value[key] = { all: next.all.filter((tab) => tab !== REVIEW), active: next.active, used: Date.now() }
  prune(key)
  save()
}

/** `openSessionTab`: the tab goes to the front of the strip, and becomes active. */
export function openTab(strip: TabStrip, tab: string): TabStrip {
  return { all: [tab, ...strip.all.filter((item) => item !== tab)], active: tab }
}

/** `closeSessionTab`: the neighbour to the left, then to the right, then review. */
export function closeTab(strip: TabStrip, tab: string): TabStrip {
  const at = strip.all.indexOf(tab)
  if (at < 0) return strip
  return {
    all: strip.all.filter((item) => item !== tab),
    active: strip.all[at - 1] ?? strip.all[at + 1] ?? REVIEW,
  }
}
