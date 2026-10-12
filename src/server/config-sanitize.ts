import { APP_ICONS, DEFAULT_APP_ICON } from "@shared/app-icons"
import { migrateChime } from "@shared/chime"
import { AGENT_NAMES, EFFORTS, SKILL_PATH_SOURCES, type AppConfig } from "@shared/protocol"

/**
 * Every stored value, checked as it is read - MiMo's rule for its preferences.
 *
 * MiMo reads each preference through a guard: an enum must be one of its
 * values or it is the default, a boolean is only a boolean, a font size is
 * clamped (and a non-number is the default), an effort it does not know is
 * medium, an access level it does not know is the default level, a chime is
 * one of its eight or bloom, and its preference file is cleared when it does
 * not validate. This app used to spread whatever config.json said over the
 * defaults, so a hand edit could scale the window sevenfold, name a theme the
 * stylesheet has no colours for, or - with a number where a chord should be -
 * throw while reading the shortcuts and leave every custom one dead.
 *
 * Mutates `doc` in place and answers whether anything had to change.
 * `fallback` is the defaults, which is what an unusable value becomes. The
 * corrected copy is for this process only: the settings never write it back
 * over the stored values by itself (L12-5, see `sanitizeHeld`).
 */
export function sanitizeConfig(doc: AppConfig, fallback: AppConfig): boolean {
  const record = doc as unknown as Record<string, unknown>
  const base = fallback as unknown as Record<string, unknown>
  let changed = false
  const put = (key: string, value: unknown) => {
    if (Object.is(record[key], value)) return
    record[key] = value
    changed = true
  }
  const drop = (key: string) => {
    if (!(key in record)) return
    delete record[key]
    changed = true
  }

  const oneOf = (key: string, allowed: readonly unknown[]) => {
    if (!allowed.includes(record[key])) put(key, base[key])
  }
  oneOf("theme", ["system", "light", "dark"])
  oneOf("reduceMotion", ["system", "on", "off"])
  oneOf("diffMarks", ["color", "signs"])
  oneOf("voiceMode", ["smart", "fast"])
  oneOf("agent", AGENT_NAMES)
  // MiMo's effort guard answers medium for anything it does not know, as the default does.
  oneOf("effort", EFFORTS)
  oneOf("appIcon", APP_ICONS.map((icon) => icon.id))
  if (typeof record.appIcon !== "string") put("appIcon", DEFAULT_APP_ICON)
  // A retired figure moves to its nearest chime, anything else unknown to bloom.
  put("taskDoneSound", migrateChime(record.taskDoneSound))

  // An unknown access level is no level of its own: the default level is read off the map.
  if (record.accessLevel !== undefined && !["ask", "auto", "full"].includes(record.accessLevel as string)) drop("accessLevel")

  for (const key of ["allowFullAccess", "goalMode", "tray", "voiceSend", "voiceFeedback", "fontSmoothing", "pointerCursor", "spineSound"]) {
    if (typeof record[key] !== "boolean") put(key, base[key])
  }
  for (const key of ["smart", "browserEnabled", "videoCardDetails", "sessionChat", "removeExplicitWatermark"]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") drop(key)
  }

  for (const key of ["language", "directory", "projectRoot", "updateFeed", "instructions", "shell"]) {
    if (typeof record[key] !== "string") put(key, base[key])
  }

  // MiMo's sizes: a number or a numeric string, clamped and rounded; anything else is the default.
  const size = (key: string, min: number, max: number) => {
    const value = typeof record[key] === "number" ? (record[key] as number) : Number.parseFloat(String(record[key]))
    put(key, !Number.isFinite(value) || value <= 0 ? base[key] : Math.round(Math.min(max, Math.max(min, value))))
  }
  size("uiFontSize", 10, 24)
  size("codeFontSize", 9, 24)

  if (record.maxSteps !== undefined && !(Number.isSafeInteger(record.maxSteps) && (record.maxSteps as number) > 0)) drop("maxSteps")

  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string")
  for (const key of ["pinnedTabs", "pinnedProjects", "projectOrder", "projects", "closedProjects", "migrations", "disabledProviders", "trustedMcpProjects"]) {
    const value = record[key]
    if (!Array.isArray(value)) put(key, base[key])
    else if (!strings(value)) put(key, value.filter((item) => typeof item === "string"))
  }
  if (record.disabledSkills !== undefined) {
    const value = record.disabledSkills
    if (!Array.isArray(value)) drop("disabledSkills")
    else if (!strings(value)) put("disabledSkills", value.filter((item) => typeof item === "string"))
  }
  // Only the four known folders, each a boolean; anything else is its default.
  if (record.skillPaths !== undefined) {
    const value = record.skillPaths as Record<string, unknown> | null
    if (!value || typeof value !== "object" || Array.isArray(value)) drop("skillPaths")
    else {
      const kept = Object.fromEntries(SKILL_PATH_SOURCES.flatMap((source) => (typeof value[source] === "boolean" ? [[source, value[source]]] : [])))
      if (Object.keys(kept).length !== Object.keys(value).length) put("skillPaths", kept)
    }
  }
  if (record.memory !== undefined) {
    const memory = record.memory as Record<string, unknown> | null
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) drop("memory")
    else if (memory.disableWrite !== undefined && typeof memory.disableWrite !== "boolean") {
      const { disableWrite: _ignored, ...rest } = memory
      put("memory", rest)
    }
  }
  if (record.instructionFiles !== undefined) {
    const value = record.instructionFiles
    if (!Array.isArray(value)) drop("instructionFiles")
    else if (!strings(value)) put("instructionFiles", value.filter((item) => typeof item === "string"))
  }
  if (!Array.isArray(record.customProviders)) put("customProviders", base.customProviders)
  else if (!record.customProviders.every(isProvider)) put("customProviders", record.customProviders.filter(isProvider))

  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  for (const key of ["mcpServers", "commands", "taskOrder", "projectNames", "projectUsed", "projectIcons", "projectColors", "providerEndpoints"]) {
    if (!isObject(record[key])) put(key, base[key])
  }

  // MiMo's shortcut store recovers rather than failing: only a chord written as text is a chord.
  const binds = record.keybinds
  if (!isObject(binds)) put("keybinds", {})
  else if (!Object.values(binds).every((chord) => typeof chord === "string")) {
    put("keybinds", Object.fromEntries(Object.entries(binds).filter(([, chord]) => typeof chord === "string")))
  }

  if (!isModel(record.model)) put("model", base.model)
  for (const key of ["smartFast", "smartMain", "titleModel", "voiceModel"]) {
    if (record[key] !== undefined && !isModel(record[key])) drop(key)
  }
  return changed
}

function isModel(value: unknown): boolean {
  const ref = value as { provider?: unknown; model?: unknown } | undefined
  return Boolean(ref) && typeof ref === "object" && typeof ref!.provider === "string" && typeof ref!.model === "string"
}

function isProvider(value: unknown): boolean {
  const entry = value as { id?: unknown; name?: unknown; baseURL?: unknown } | undefined
  return Boolean(entry) && typeof entry === "object" && typeof entry!.id === "string" && typeof entry!.name === "string" && typeof entry!.baseURL === "string"
}
