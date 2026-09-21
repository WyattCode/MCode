/**
 * Round 20, V3: the interface copy follows Xiaomi MiMo 26.920.
 *
 * Short labels read as MiMo's own; longer sentences are MCode's own wording in
 * MiMo's shape. Each row below pins the zh-CN value (and the English one where
 * it changed with it), so every row fails against the tables before the round.
 * smoke.ts calls `roundTwentyCopyChecks` with its own check and section.
 */
import fs from "node:fs"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { readTables } from "./smoke-wording"

type Row = [key: string, zh: string, en?: string]

/** Group A: the goal switch is MiMo's 追求目标, its bar MiMo's labels. */
export const GROUP_A: Row[] = [
  ["composer.goal", "追求目标", "Pursue goal"],
  ["composer.goalSub", "持续推进，直到目标彻底达成"],
  ["composer.goalChipTip", "追求目标已开启，点击关闭"],
  ["composer.goalBar.label", "目标", "Goal"],
  ["composer.goalBar.active", "进行中", "In progress"],
  ["composer.goalBar.paused", "已暂停", "Paused"],
  ["composer.goalBar.complete", "已完成", "Complete"],
  ["composer.goalBar.blocked", "受阻", "Blocked"],
  ["composer.goalBar.edit", "编辑目标", "Edit goal"],
  ["composer.goalBar.resend", "重新执行", "Re-run"],
  ["composer.goalBar.stop", "停止目标", "Stop goal"],
  ["composer.goalBar.remove", "退出目标模式", "Exit goal mode"],
  ["composer.goalBar.dismiss", "关闭", "Dismiss"],
  ["composer.goalBar.expand", "展开", "Expand"],
  ["composer.goalBar.collapse", "收起", "Collapse"],
  ["composer.goalBar.judgeFailed", "目标评估未给出结论"],
  ["stream.setAsGoal", "被设为目标", "Set as goal"],
  ["stream.goalAchieved", "已在 {dur} 内达成目标", "Goal achieved in {dur}"],
  ["toast.goalOn", "追求目标 已开启", "Pursue goal enabled"],
  ["toast.goalOff", "追求目标 已关闭", "Pursue goal disabled"],
  ["key.label.toggle-goal", "切换追求目标"],
  ["key.desc.toggle-goal", "开启或关闭当前输入框的追求目标"],
]

export const GROUPS: [name: string, rows: Row[]][] = [["A: the goal switch and bar", GROUP_A]]

/** Rows whose zh-CN or English value is not the pinned one. */
export function copyDrift(tables: Record<string, Record<string, string>>, rows: Row[]): string[] {
  const out: string[] = []
  for (const [key, zh, en] of rows) {
    if (tables.zhCN?.[key] !== zh) out.push(`zhCN ${key} reads ${JSON.stringify(tables.zhCN?.[key])}`)
    if (en !== undefined && tables.en?.[key] !== en) out.push(`en ${key} reads ${JSON.stringify(tables.en?.[key])}`)
  }
  return out
}

export function roundTwentyCopyChecks(check: Check, section: (name: string) => void): void {
  const tables = readTables(fs.readFileSync(path.join(process.cwd(), "src/renderer/src/lib/i18n.ts"), "utf8"))
  for (const [name, rows] of GROUPS) {
    section(`Round 20 (V3-${name})`)
    const drift = copyDrift(tables, rows)
    check(`${rows.length} rows read as MiMo 26.920 words them`, drift.length === 0, drift.slice(0, 8))
  }
}
