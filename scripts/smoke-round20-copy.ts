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

/** Group C: the settings pages - MiMo's labels, MCode's descriptions in MiMo's shape. */
export const GROUP_C: Row[] = [
  ["set.config.pathCopied", "已复制路径", "Path copied"],
  ["set.config.copyPathFailed", "复制路径失败", "Failed to copy path"],
  ["set.mcp.applyNow", "立即生效", "Apply now"],
  ["set.mcp.applyDoing", "正在生效…", "Applying…"],
  ["set.mcp.applyDone", "已生效，下一条消息起使用新配置"],
  ["set.mcp.applyBusy", "有对话正在运行，暂不能立即生效，请稍后再试"],
  ["set.mcp.applyFailed", "暂时无法立即生效，新对话会使用新配置"],
  ["set.mcp.unapplied", "配置已修改，尚未生效"],
  ["set.mcp.importDone", "已导入 {n} 个 MCP 服务器，下个新对话生效"],
  ["set.models.probeBusy", "测试中…", "Testing…"],
  ["set.models.modelExists", "模型已存在", "Model already added"],
  ["set.models.comboEmpty", "未找到模型，请手动输入 model-id", "No models found. Enter a model-id manually."],
  ["set.models.cloneDesc", "为副本指定新的供应商 ID", "Pick a new provider ID for the copy"],
  ["set.models.removeProviderBody", "将删除「{name}」及其下所有模型，且无法恢复。"],
  ["set.models.intro", "自定义模型使用你自己的密钥：填入各家的 API Key 即可在对话里选用，仅保存在本机"],
  ["set.models.providerAdded", "已添加", "Added"],
  ["provider.custom.field.name.label", "名称", "Name"],
  ["provider.custom.field.baseURL.label", "接口地址", "Endpoint"],
  ["provider.custom.field.apiKey.label", "API Key", "API Key"],
  ["provider.custom.field.apiKey.placeholder", "API Key", "API Key"],
  ["provider.custom.models.name.placeholder", "展示名", "Display name"],
  ["provider.custom.error.providerID.required", "供应商 ID 不能为空"],
  ["provider.custom.error.name.required", "名称不能为空"],
  ["provider.custom.error.baseURL.required", "接口地址不能为空"],
  ["provider.custom.error.baseURL.format", "接口地址需以 http:// 或 https:// 开头"],
  ["provider.custom.field.apiKey.description", "选填；通过请求头鉴权时可留空"],
  ["provider.custom.field.providerID.placeholder", "my-provider", "my-provider"],
  ["provider.custom.models.remove", "删除", "Remove"],
  ["common.saving", "保存中…", "Saving…"],
  ["set.skillPaths.title", "技能兼容路径", "Skill path compatibility"],
  ["set.skillPaths.always", "始终启用"],
  ["set.skillPaths.note", "下一条消息起生效；同名技能将覆盖内置技能"],
  ["set.launchAtLoginSub", "开启后，登录电脑时自动启动 MCode"],
  ["set.voiceFeedbackSub", "开启后，告诉 Agent 你想要「语音反馈」，它就会用短句朗读进展（如「好的」「完成了」）"],
  ["set.ciHelp2", "内容只保存在本机，清空并保存即可停用"],
  ["set.updateInstallHint", "重启更新后，MCode 将关闭并完成安装，结束后自动重新打开，可能需要几分钟"],
  ["set.lab.sessionChat", "会话互聊", "Session chat"],
  ["set.lab.sessionChatSub", "实验性：允许模型联系其他对话或本机的其他编程工具，并创建协作对话。关闭后新回合不再提供相关工具与技能；历史消息照常显示"],
  ["set.closedSub", "关闭的项目会从侧栏移除，会话不会被删除"],
  ["set.usageSub", "本机记录的 token 用量与费用"],
  ["set.usageNone", "暂无记录"],
  ["set.usageWindow", "近 {n} 天数据，按本机时区统计；标题、Smart 路由、上下文压缩等后台请求计入费用，不计回合"],
  ["set.voiceModelSub", "仅用于语音转写；智能编辑由当前对话模型完成"],
  ["set.updateFeedSub", "填写存放 latest.yml 和安装包的 https 地址，用于检查更新"],
]

/** Group D: updates and toasts. */
export const GROUP_D: Row[] = [
  ["update.failed", "更新失败", "Update failed"],
  ["update.reason.noReady", "暂无已下载完成的更新，请稍后再试。"],
  ["update.reason.staging", "更新仍在下载，请稍后再点「重启更新」。"],
  ["update.reason.installFailed", "安装更新失败，请重试或手动下载安装。"],
  ["update.reason.notStarted", "安装程序未能启动（可能上次退出未完成），请重启 MCode 后重试。"],
  ["update.reason.versionMismatch", "上次更新没有生效，请重试或手动下载安装。"],
  ["update.reason.stale", "上次更新超时未完成，请重试或手动下载安装。"],
  ["update.reason.disabled", "此版本未开启自动更新。"],
  ["update.reason.unknown", "更新失败（原因未知），请重试或手动下载安装。"],
  ["update.reason.readOnlyVolume", "无法更新：MCode 正在只读位置运行。请先将它移到「应用程序」文件夹，重新打开后再更新。"],
  ["update.installingBody", "MCode 将关闭并完成安装，结束后自动重新打开，可能需要几分钟"],
  ["toast.compacted", "上下文压缩完成", "Context compacted"],
  ["toast.compactFailed", "上下文压缩失败，请稍后重试"],
  ["cmd.compact", "压缩上下文", "Compact context"],
  ["toast.undone", "已撤销 {n} 个文件的改动"],
  ["toast.redone", "已重做 {n} 个文件的改动"],
  ["toast.pickerBusy", "已有一个选择窗口打开，请先完成或取消（它可能被主窗口遮挡）"],
]

export const GROUPS: [name: string, rows: Row[]][] = [
  ["A: the goal switch and bar", GROUP_A],
  ["B: conversation errors, permissions and attachments", GROUP_B],
  ["C: the settings pages", GROUP_C],
  ["D: updates and toasts", GROUP_D],
]

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8")

/** The two wiring bugs of D: each returns what is wrong, so a check can also run against old source. */
export function deviceCodeHint(connectDialog: string, tables: Record<string, Record<string, string>>): string[] {
  const hint = /<span class="code-hint">\{\{ copied \? t\("([^"]+)"\) : t\("([^"]+)"\) \}\}<\/span>/.exec(connectDialog)
  if (!hint) return ["the device-code button's hint was not found"]
  const [, done, idle] = hint
  const out: string[] = []
  if (tables.zhCN?.[idle] !== "复制") out.push(`the idle hint reads ${JSON.stringify(tables.zhCN?.[idle])} (${idle})`)
  if (tables.zhCN?.[done] !== "已复制") out.push(`the copied hint reads ${JSON.stringify(tables.zhCN?.[done])} (${done})`)
  return out
}

export function downloadFailureTitle(app: string, tables: Record<string, Record<string, string>>): string[] {
  const call = /t\(result\.during === "download" \? "([^"]+)" : "([^"]+)"\)/.exec(app)
  if (!call) return ["the update check's failure branch was not found"]
  const [, download, check] = call
  const out: string[] = []
  if (tables.zhCN?.[download] !== "更新失败") out.push(`a download failure reads ${JSON.stringify(tables.zhCN?.[download])}`)
  if (tables.zhCN?.[check] === tables.zhCN?.[download]) out.push("a download failure and a check failure read the same")
  return out
}

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
  section("Round 20 (V3-D): the two wiring bugs")
  {
    const hint = deviceCodeHint(read("src/renderer/src/components/ConnectDialog.vue"), tables)
    check("the device-code button says 复制 / 已复制, not 复制回复 / 已保存", hint.length === 0, hint)
    const title = downloadFailureTitle(read("src/renderer/src/App.vue"), tables)
    check("a failed download says 更新失败, not the check's failure", title.length === 0, title)
  }
}
