import type { AppConfig } from "@shared/protocol"
import { LANGUAGE_IDS } from "@shared/locale"
import type { ToolDefinition } from "./types"

/*
 * MiMo's desktop-settings tools: the model reads and changes a few appearance
 * settings the way the user would in Settings. They go through the same config
 * patch the settings page sends, so the change is saved and every window
 * redraws from the `config.updated` it publishes. No permission is asked, as
 * MiMo asks none (user decision, 2026-09-15).
 *
 * What the model reads back is Chinese where MiMo's is (the user's T10-55
 * decision), in this app's own words, and a failure comes back as a result the
 * model reads rather than as a failed call, as MiMo's does (T10-54).
 */

/** What the tools need of the config: its current value and the patch path. */
export interface SettingsConfig {
  get(): AppConfig
  set(patch: Partial<AppConfig>): Promise<AppConfig>
}

let bound: SettingsConfig | undefined

/** Called once the backend has its config; the tools report themselves unavailable before that. */
export function bindDesktopSettings(config: SettingsConfig | undefined) {
  bound = config
}


/** The settings page's own bounds; MiMo's are the same. */
export const FONT_BOUNDS = {
  ui_font_size: { base: 14, min: 10, max: 24 },
  code_font_size: { base: 12, min: 9, max: 24 },
} as const

export const SETTING_KEYS = ["theme", "ui_font_size", "code_font_size", "diff_style", "language"] as const
type SettingKey = (typeof SETTING_KEYS)[number]

const LEGAL: Record<SettingKey, string> = {
  theme: "light | dark | system（也可写 浅色 / 深色 / 跟随系统）",
  ui_font_size: `整数像素，${FONT_BOUNDS.ui_font_size.min}–${FONT_BOUNDS.ui_font_size.max}（超出范围时取最近的边界值）`,
  code_font_size: `整数像素，${FONT_BOUNDS.code_font_size.min}–${FONT_BOUNDS.code_font_size.max}（超出范围时取最近的边界值）`,
  diff_style: "colored | plus-minus（也可写 颜色 / +/-）",
  language: ["system", ...LANGUAGE_IDS].join(" | "),
}

/** The Chinese names MiMo's settings take beside the English ones. */
const THEME_NAMES: Record<string, "light" | "dark" | "system"> = { 浅色: "light", 深色: "dark", 跟随系统: "system" }
const DIFF_NAMES: Record<string, "colored" | "plus-minus"> = { 颜色: "colored", "+/-": "plus-minus" }

/** The settings as the model sees them, in MiMo's key names and MiMo's `{ ok, settings }` wrapping. */
export function settingsSnapshot(config: AppConfig) {
  return {
    ok: true,
    settings: {
      theme: config.theme ?? "system",
      ui_font_size: config.uiFontSize,
      code_font_size: config.codeFontSize,
      diff_style: config.diffMarks === "signs" ? "plus-minus" : "colored",
      language: config.language ? config.language : "system",
      adjustable_keys: LEGAL,
    },
  }
}

export type SettingChange = { ok: true; key: SettingKey; value: string; patch: Partial<AppConfig> } | { ok: false; error: string }

/* MiMo's rounding: a number past a bound takes the bound, and zero or less the default. */
function fontSize(value: string, bounds: { base: number; min: number; max: number }): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return bounds.base
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, parsed)))
}

/** A requested change as a config patch, or the reason it cannot be made. */
export function settingChange(rawKey: unknown, rawValue: unknown): SettingChange {
  const key = String(rawKey ?? "").trim()
  const value = String(rawValue ?? "").trim()
  if (!(SETTING_KEYS as readonly string[]).includes(key)) {
    return {
      ok: false,
      error: `这个工具不能调整「${key}」。可调整的键：${SETTING_KEYS.join(", ")}。模型、MCP 服务器、技能开关、快捷键等其他设置，请告诉用户去设置里的哪一页修改。`,
    }
  }
  const setting = key as SettingKey
  const invalid = (): SettingChange => ({ ok: false, error: `「${value}」不是 ${setting} 能用的值。可用的值：${LEGAL[setting]}。` })
  const lower = value.toLowerCase()
  switch (setting) {
    case "theme": {
      const theme = (["light", "dark", "system"] as const).find((name) => name === lower) ?? THEME_NAMES[value]
      return theme ? { ok: true, key: setting, value: theme, patch: { theme } } : invalid()
    }
    case "diff_style": {
      const style = lower === "colored" || lower === "plus-minus" ? lower : DIFF_NAMES[value]
      if (style === "colored") return { ok: true, key: setting, value: "colored", patch: { diffMarks: "color" } }
      if (style === "plus-minus") return { ok: true, key: setting, value: "plus-minus", patch: { diffMarks: "signs" } }
      return invalid()
    }
    case "language": {
      if (lower === "system") return { ok: true, key: setting, value: "system", patch: { language: "" } }
      // An exact id first, then a regional tag on a language listed once (en-US is en).
      const exact = LANGUAGE_IDS.find((id) => id.toLowerCase() === lower)
      const loose = LANGUAGE_IDS.filter((id) => id.toLowerCase().split("-")[0] === lower.split("-")[0])
      const id = exact ?? (loose.length === 1 ? loose[0] : undefined)
      return id ? { ok: true, key: setting, value: id, patch: { language: id } } : invalid()
    }
    case "ui_font_size":
    case "code_font_size": {
      const size = fontSize(value, FONT_BOUNDS[setting])
      if (size === undefined) return invalid()
      const patch: Partial<AppConfig> = setting === "ui_font_size" ? { uiFontSize: size } : { codeFontSize: size }
      return { ok: true, key: setting, value: String(size), patch }
    }
  }
}

/** What the model reads when the backend has no config to hand yet. */
const UNAVAILABLE = "桌面设置暂时还不能读取或修改，请稍后再试。"
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const GetDesktopSettingsTool: ToolDefinition = {
  name: "get_desktop_settings",
  description: [
    "Read MCode's current appearance and language settings as JSON ({ ok, settings }): theme, ui_font_size, code_font_size, diff_style, language, and the values each adjustable key accepts.",
    "Use it before set_desktop_setting, or when the user asks what these settings are. It changes nothing.",
  ].join("\n"),
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    if (!bound) return { output: UNAVAILABLE, metadata: { available: false } }
    try {
      return { output: JSON.stringify(settingsSnapshot(bound.get()), null, 2) }
    } catch (error) {
      return { output: `读取桌面设置时出错：${failure(error)}` }
    }
  },
}

export const SetDesktopSettingTool: ToolDefinition = {
  name: "set_desktop_setting",
  description: [
    "Change ONE of MCode's appearance or language settings. It applies at once and is saved, exactly as if the user changed it in Settings. Call get_desktop_settings first, and once per key.",
    `Keys: theme (light | dark | system), ui_font_size (10-24), code_font_size (9-24), diff_style (colored | plus-minus), language (system or a language id).`,
    "Colours and font families are not adjustable. Models, MCP servers, skills, shortcuts and everything else are not changed here: tell the user which Settings page to use.",
    "A rejected value comes back with the values the key accepts. Tell the user the outcome in your reply.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      // Plain text, as MiMo's is: an unknown key is answered with the keys that exist, not refused unread.
      key: { type: "string", description: "The setting to change: theme, ui_font_size, code_font_size, diff_style or language" },
      value: { type: "string", description: "The new value, as text" },
    },
    required: ["key", "value"],
    additionalProperties: false,
  },
  async execute(input) {
    const title = `${String(input.key ?? "")} → ${String(input.value ?? "")}`
    if (!bound) return { output: UNAVAILABLE, title, metadata: { applied: false } }
    const change = settingChange(input.key, input.value)
    if (!change.ok) return { output: `没有修改：${change.error}`, title, metadata: { applied: false } }
    try {
      await bound.set(change.patch)
    } catch (error) {
      return { output: `修改桌面设置时出错：${failure(error)}`, title, metadata: { applied: false } }
    }
    return {
      output: `桌面设置已修改：${change.key} → ${change.value}，已立即生效并保存。`,
      title: `${change.key} → ${change.value}`,
      metadata: { applied: true, key: change.key, value: change.value },
    }
  },
}
