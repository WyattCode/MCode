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

/** Group B: conversation errors, permissions and attachments - one sentence, cause then fix. */
export const GROUP_B: Row[] = [
  ["error.modelTimeout", "模型超时无响应，请重试"],
  ["error.sessionBusy", "上一条消息仍在处理中，请稍后再试"],
  ["error.contentBlocked", "抱歉，这个请求我无法处理，请换个问题试试"],
  ["error.quotaExceeded", "额度已用尽，可在供应商账户的用量或账单页查看后继续使用"],
  ["error.authInvalid", "API Key 无效或已过期，请在设置 → 模型中检查后重试"],
  ["error.noModel", "暂无可用模型，请先在设置 → 模型中添加"],
  ["error.noReply", "请求中断，模型未返回内容，请重试"],
  ["error.gatewayBlocked", "请求被网关或代理拦截，请检查网络设置后重试"],
  ["error.diskFull", "磁盘空间不足，请释放空间后重试"],
  ["error.replyLoop", "回复陷入重复，已中断本轮，请重试"],
  ["stream.interrupted", "回合已中止（引擎未能继续）", "Turn stopped (the engine couldn’t continue)"],
  ["error.backend", "引擎未能启动，请重新打开 MCode；若仍无法连接，请检查安全软件是否拦截了本机端口"],
  ["error.backendLost", "与引擎的连接已断开，请稍后重试；若反复出现，请重新打开 MCode"],
  ["error.connectionRecovering", "与引擎的连接正在恢复，消息将在连接就绪后立即发出…"],
  ["stream.retryUnavailable", "无法重试：没有可重发的提问，或对话仍在生成中"],
  ["stream.emptyConvo", "这个对话还没有消息", "This conversation has no messages yet"],
  ["perm.failed", "权限操作提交失败，请重试"],
  ["perm.outside", "访问工作目录外的文件", "Access files outside the working directory"],
  ["attach.unreadable", "无法读取文件", "Cannot read file"],
  ["attach.tooLarge", "文件过大，未添加（上限 {size}）"],
  ["attach.noImageInput", "{model} 不支持图片，本条图片不会发送"],
  ["composer.access.failed", "切换审批权限失败，请重试"],
  ["composer.access.autoHint", "项目内的文件改动和常规命令无需确认；删除命令与高风险操作仍会请你确认"],
  ["composer.shellExit", "按 Esc 退出", "Esc to exit"],
  ["stepList.interactiveSkipped", "该命令需要交互输入，未运行。可让 Agent 改用非交互方式重试"],
  ["toast.bashInteractive", "当前环境不支持交互式命令，已跳过一条需要输入的命令"],
  ["rp.diff.filesChanged", "{n} 个文件已更改", "{n} files changed"],
]

export const GROUPS: [name: string, rows: Row[]][] = [
  ["A: the goal switch and bar", GROUP_A],
  ["B: conversation errors, permissions and attachments", GROUP_B],
]

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
