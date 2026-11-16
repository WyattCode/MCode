# MCode vs MiMoCode 编程能力差异报告

> 对照对象：MCode `/Users/wyatt/MCode`（src/server 为主）与 小米 MiMoCode `/Users/wyatt/mimo-code-src`（packages/cli 为主）。
> 方法：只以源码为准，逐项核实两边的实现与调用链；不采信 README/注释宣传。所有结论附文件路径（行号以当前工作树为准）。
> 结论口径：`一致` / `MCode缺失` / `MCode差异但不吃亏` / `明确弱于MiMoCode`（并写清后果）。

## 0. 目录布局速览

- MiMoCode CLI：`packages/cli/src/tool/`（工具与 .txt 描述）、`src/session/`（会话/循环/压缩/prompt）、`src/permission/`、`src/memory/`、`src/provider/`、`src/agent/`、`src/actor/`（子智能体/子进程）、`src/skill/`、`src/lsp/`、`src/mcp/`。
- MCode：`src/server/tool/`、`src/server/session/`（runner/chat/steps/steer-join/retry/prune/summary）、`src/server/permission.ts`、`src/server/memory/`、`src/server/provider/`、`src/server/automation.ts`（无独立 agent 目录，子智能体在 tool/task.ts、tool/subagent.ts、tool/fanout.ts）。

## 1. 工具集与工具描述

### 1.1 逐项存在性

| 能力 | MiMoCode（packages/cli/src/tool） | MCode（src/server/tool） | 判定 |
|---|---|---|---|
| 读文件/目录 | `read`（`read.ts`，offset/limit） | `read`（`read.ts`，同参数） | 一致 |
| 写文件 | `write`（`write.ts`） | `write`（`edit.ts` 同文件导出） | 一致 |
| 精确替换 | `edit`（old_string/new_string/replace_all） | `edit`（同参数） | 一致 |
| 多段替换 | `multiedit`（`multiedit.ts`，已定义但**未进 builtin 列表**，只在 `available` 过滤里被引用，实际不提供给模型） | 无 | 一致（两边都不可用） |
| 官方 patch 信封 | `apply_patch`（`apply_patch.ts`，仅 GPT/codex 模式） | `patch`（`patch.ts`，仅 `usesPatch` 的 GPT 模型） | 语义一致，命名不同 |
| 通配查找 | `glob`（pattern/path） | `glob`（同） | 一致 |
| 内容搜索 | `grep`（pattern/path/include，ripgrep） | `grep`（同） | 一致 |
| 命令执行 | `bash`（command/timeout/max_output_tokens/workdir/interactive/description） | `bash`（同 + `interactive` 声明为“无法接管终端”） | 见 1.3 |
| 任务登记 | `task`（operation 判别联合：create/list/get/start/block/unblock/done/abandon/rename） | `task`（同 9 个动作，另接受扁平字段） | 一致 |
| 子代理 | `actor`（spawn/run/status/wait/cancel/send/models） | `actor`（`subagent.ts`，同名动作 + StructuredOutput 返回） | 一致，MCode 略多 |
| 问用户 | `question`（仅 app/cli/desktop 客户端开启） | `question` | 一致 |
| 外部抓取 | `webfetch`（url/format/timeout） | `webfetch`（同） | 一致 |
| 网络搜索 | `websearch`（Exa，`MIMOCODE_ENABLE_EXA` 开关） | `websearch`（可被设置/离线关闭） | 一致 |
| 代码/文档检索 | `codesearch`（Exa `get_code_context_exa`，`MIMOCODE_ENABLE_EXA`） | 无 | **MCode 缺失** |
| MCP 工具检索 | `mcp_tool_search`（`mcp-tool-search.ts`，618 行，动态目录检索） | 无（MCP 工具全量直接暴露） | **MCode 缺失** |
| 脚本化工具编排 | `exec`（`tool-script.ts`，JS 沙箱内 `tools.*`、批量/并发、`ALL_TOOLS` 检索；仅 codex 模式或 `MIMOCODE_ENABLE_EXEC_TOOL`） | 无 | **MCode 缺失** |
| 内置工作流 | `workflow`（`workflow.ts` + `workflow/builtin`，按 name 运行 deep-research 等） | 无 | **MCode 缺失** |
| LSP | `lsp`（9 种操作：definition/references/hover/documentSymbol/workspaceSymbol/implementation/call hierarchy；实验开关） | `lsp`（4 种：diagnostics/definition/references/hover；默认提供） | MCode 操作少但默认可用 |
| 技能 | `skill` + `skill_search` | `skill` + `skill_search` | 一致 |
| 记忆检索 | `memory`（search + scope/scope_id/type/limit；scope 含 `cc`） | `memory`（同参数；scope 只有 global/projects/sessions） | 一致，MiMo 多 `cc` |
| 历史检索 | `history`（search/around/get，含分页与附件） | `history`（同 3 操作，字段更细） | 一致，MCode 略多 |
| 计划退出 | `plan_exit` | `plan_exit` | 一致 |
| 定时任务 | `cron`（实验开关） | `cron`（仅 `MCODE_E2E=1` 提供） | 一致 |
| Notebook | `notebook_edit`（replace/insert/delete，cell_id） | `notebook_edit`（同，另支持 `#N` 位置） | 一致，MCode 略多 |
| 看图 | `view_image`（path/detail，仅 GPT/codex 模式；`read` 本身也附媒体） | 无独立工具；`read` 直接附图片/PDF/音视频 | 差异但不吃亏 |
| PDF 定位 | 无（`read` 附加 PDF） | `pdf_locate`（`present.ts`） | MCode 多 |
| 文件呈现 | 无 | `present_files` | MCode 多 |
| 桌面设置 | 无 | `get_desktop_settings` / `set_desktop_setting` | MCode 多（桌面产品向） |
| 会话互聊 | 无（引擎层是 inbox/steer） | `contacts` / `talk_to_session` / `create_session` / `update_session` | MCode 多（产品向） |
| 读别的工具会话 | 无 | `list_external_sessions` / `read_external_session` | MCode 多 |
| 自动化任务 | 无（cron 之外） | `automation_update`（仅 E2E） | MCode 多 |
| 语音 | 无 | `speak`（语音反馈开启时） | MCode 多 |
| 应用操作 | 无 | `app`（DevTools 端口操作正在构建的应用） | MCode 多 |
| 并排生成 | 无 | `fanout`（最多 16 个请求、并发最多 8、must_contain、重试） | MCode 多 |
| 页面验证 | 无 | `verify_page`（一次性浏览器 profile） | MCode 多 |

**参数语义差异（存在的同名工具）**

- `bash`：两边参数名一致（`command/timeout/max_output_tokens/workdir/interactive/description`）。MiMo 的 `interactive:true` 会把终端交给用户（`bash.ts:946-968` 走 `BashInteractive`）；MCode 的 `interactive:true` 直接返回拒绝文本并给出替代写法（`bash.ts:543-549`，`INTERACTIVE_REFUSAL` 为中文模型侧文案），因为桌面端没有可交出的终端。两边都把 `description` 作为必填（MiMo `bash.ts:179-187` 的 zod 字段无 `.optional()`；MCode `bash.ts:518-520` 写入 `required: ["command","description"]`）。
- `read`：MiMo `offset/limit` 用 `z.coerce.number()`，MCode 自己校验整数且报错文案更具体（`read.ts:327-331`）；MCode 额外做二进制探测、50KB 总量、读目录分页，并在被裁剪后重新投递目录内的 `AGENTS.md/CLAUDE.md/CONTEXT.md`（`read.ts:61-166`），MiMo 也投递 instruction，但以 `Instruction.Service` 的已给集合为准（`read.ts:269`）。
- `grep`：MiMo 只有 `pattern/path/include`；MCode 同样三个，但允许 `path` 指向单文件并自动取其父目录（`search.ts:224-228`），实际是更宽松的输入。
- `lsp`：MiMo 的 `line/character` 是 1-based 且为所有操作必填；MCode 改为 `action` + 可选 `line/column`，多了 `diagnostics`，少了 documentSymbol/workspaceSymbol/implementation/call hierarchy（`lsp.ts:9-27` 对比 `tool/lsp.ts:24-70`）。
- `actor`：MiMo 有 `action` 判别联合、`spawn` 默认、`models` 列出视觉模型；MCode 同构，但对子代理返回值有强制结构化输出工具 `StructuredOutput`（`subagent.ts:52-65`、`DEFAULT_EXPLORE_OUTPUT_SCHEMA`），且 explore 子代理有固定 schema。
- `patch`：MiMo 参数名 `patch_text`（`apply_patch.ts:19-21`），MCode 参数名 `patchText`（`patch.ts:69-72`），语义相同；模型迁移时提示词里的示例要跟着改。

### 1.2 工具描述（prompt 面）差异

- `bash`：MiMo 的描述是一整篇操作手册（`bash.txt` 200+ 行，含 git/PR 安全流程、交互式参数、输出截断后如何再读、`&&` 链式规则）；MCode 的 `bashDescription()`（`bash.ts:467-496`）压缩到约 30 行，保留“用 read/edit/glob/grep 而不是 cat/find/sed”“超 30k token 中间省略且全量落盘”“不给交互输入”“不自行 head/tail”与 git/PR 纪律。**信息密度 MCode 不差，但少了 MiMo 对命令链、`interactive` 的显式行为说明**；MCode 会按用户配置的 shell 动态改写描述（`registry.ts:toolsForTurn`），MiMo 也按 OS/shell 模板化（`bash.txt` 的 `${os}/${shell}`）。
- `edit`：MiMo 明确写“精确匹配、失败即失败、多处匹配报错、`replace_all`”（`edit.txt`）；MCode 的 edit 描述在 `edit.ts` 内置（参数描述写“Exact text to replace, including indentation”），并把“先读再改”“未读/已变”作为硬错误（见第 3 节）。**MCode 的描述更短，但用工具行为兜底，模型侧约束更硬。**
- `task`：两边描述几乎逐句同源（`task.txt` 与 `task.ts` 的 description）：都要求 3+ 步才建任务、只在完全完成时 done、同一时刻一个 in_progress、不要在回复里复述任务树。MCode 额外接受扁平字段并做了“MiMo 的 shape”兼容（`task.ts:252-259`）。
- `actor`：MiMo 的动态描述会把“可用 agent 类型及其工具”拼进去（`registry.ts:describeTask`），MCode 的 actor 描述是静态的（`registry.ts` 无对应拼接），子代理清单来自 `SUBAGENT_TYPES` 常量（`shared/protocol.ts:1148`）。**自定义子代理的发现性 MCode 弱于 MiMo。**

### 1.3 结论

- 一致项：read/write/edit/glob/grep/bash/task/actor/question/webfetch/websearch/skill(_search)/memory/history/plan_exit/cron/notebook/LSP/patch(apply_patch) 的存在与主参数语义。
- MCode 缺失：`codesearch`、`mcp_tool_search`、`exec` 脚本编排、`workflow` 内置工作流。（`multiedit` 两边都未真正提供给模型；`view_image` 在 MCode 被 `read` 的媒体附件吸收，不计为缺失。）
- MCode 差异但不吃亏：`patch` 代替 `apply_patch`、`read` 吸收 view_image、LSP 操作更少但默认可用、bash 描述更短但含动态 shell 与桌面限制。
- 明确弱于 MiMoCode：
  1. **无 `exec`（tool-script）**：MiMo 允许模型用一段 JS 并发调用多个工具、在沙箱内过滤大结果再返回（`tool-script.txt`），MCode 只能一步步发工具调用，多文件/多请求任务的步数与 token 成本更高。后果：同一任务 MCode 更容易撞步数上限与上下文上限。
  2. **无 `codesearch`**：MiMo 可直接检索外部库/API 文档（Exa code context），MCode 只能 webfetch 或凭记忆。后果：对新框架/新 API 的首次正确率更低。
  3. **无 `mcp_tool_search`**：MiMo 在 MCP 工具很多时先检索再调用，MCode 把所有 MCP 工具塞进每次请求。后果：MCP 多服务器场景下工具 schema 占用大量上下文，且模型选择准确率下降。
  4. **无 `workflow`**：MiMo 内置 deep-research 等命名工作流，MCode 只能靠提示词即兴。后果：复杂研究型任务一致性差（对纯编码影响较小）。
  5. **actor 子代理描述不动态列出可用类型与工具**：MCode 的自定义子代理不易被模型发现和正确调用（`registry.ts:describeTask` 对比 MCode `registry.ts` 静态 `SUBAGENT_TYPES`）。

## 2. 智能体循环

### 2.1 步进与终止

**MiMoCode**（`session/prompt.ts`）

- `while (true)` 主循环（`prompt.ts:4993`），每轮重新取 DB 消息切片、按 `agentID` 隔离（父/子代理共享 sessionID 但切片不同，`prompt.ts:5026-5032`）。
- 步数上限：`agent.steps ?? Infinity`（`prompt.ts:5534`），到达 `isLastStep` 时只做两件事——给最后一步注入“不要再调工具”的提示并 `toolChoice:none`；**不会因为步数到顶而强制退出循环**。MiMo 没有“本地模型默认 32 步”的保护。
- 终止判定集中在 `classifyAssistantStep`：`final` / `continue` / `failed` / `invalid` / `text-tool-call` / `filtered`（`prompt.ts:5244-5289`）。`final` 前还要过 `waitForSubagents`（父 turn 会等所有子代理结算，`prompt.ts:4819-4905`）和 `goalGate`（目标未达则继续，`prompt.ts:4475-4525`）。
- 子代理：`waitForSubagents` 会 poll 子代理 fiber，带 stall 检测、输入 revision 打断等待、超时后写 synthetic user 继续；系统代理（checkpoint-writer/dream/distill）被排除（`prompt.ts:4832`）。
- 停止：`interrupt` 会级联到同 session 的 actor/subagent（`prompt.ts:817-863`），并区分 execution ownership；崩溃/断连留下的孤儿 turn 有 sweep（`prompt.ts:3461-3495`）。
- 重入/续写：`session/checkpoint` 的 rebuild boundary、`resumeFrom`、parent user 锁定（`prompt.ts:5040-5105`）；`goalGate` 的 `MAX_GOAL_REACT` 限制重入次数。
- steering：inbox + claim/lease，按 `{sessionID, agentID}` lane 领取，step 边界 claim 新输入；子代理 slice 与主代理隔离（`prompt.ts:4995-5035`）。
- 重试：`session/retry.ts`，按 phase/kind 分预算（request 4 次/30s、stream 5 次/10min、server 8 次/15min、rate_limit 5 次/35min、network 无限），支持 `retry-after`/文本里的 “try again in Ns”、host registry 分类、`x-should-retry`、安全终止类（auth/overflow 等）。每 provider 可配置（`config/retry.ts`）。
- 循环检测：`try-best-detector.ts` 三类（edit_repeat / bash_retry / action_streak），processor 在每次工具结算后 `consume`，命中后 `ctx.blocked=true`、写 synthetic text、发 `TryBestDetected` 事件（`processor.ts:393-430`）；另有“最近 3 步同样调用”的 loop-streak 提醒与 crop（`prompt.ts:5374-5397`）；流式文本 n-gram 重复由 `prompt/text-ngram-detection.ts` 在流中切断。
- 超长输出：只在 `finish="length"` **且没有工具调用**时注入继续提示（`prompt.ts:4410-4437`）。
- 空回复/文本式工具调用：`dropEmptyAssistant`（有上限）、`autoRetryTextToolCall`（有上限，丢弃坏 turn 并补 synthetic user），见 `prompt.ts:4585-4700`。
- 最佳候选：`max-mode.ts` 是内置 `max` agent 的路径，并行 5 个 propose-only 候选，再由 judge 选一个执行；judge 失败默认取 0（`max-mode.ts:349-420`，`prompt.ts:6055-6115`）。候选与 judge 的花费不计入上下文。

**MCode**（`session/runner.ts`）

- `for (let step = 0; ; step++)`（`runner.ts:3019`），每步先 `await steering.written`、重新读盘、按计划模式切换 agent（`runner.ts:3033-3070`）。
- 步数上限：`stepLimitFor(config.maxSteps, this.isLocal(session))`（`runner.ts:2958`，`steps.ts:1-44`）：用户设置优先；本地/自建 provider 默认 32 步；云模型默认无限。到达上限时注入 `maxStepsPrompt(limit)`（明确要求只用文本总结、禁止工具），并在下一步硬 `break`（`runner.ts:3022-3032, 3165-3175`）。
- 终止：靠 `continuationFor` 的返回（`reminders.ts:274-324`）和 runner 的 `stop`/`finish` 处理；没有 MiMo 的 `classifyAssistantStep` 六分类，但有等价分支：流中断续写、长度续写、文本式工具调用解析/重试、空回复提醒、announced-only 提醒。
- 子代理：`actor` 的 `run` 是阻塞的；`spawn` 是后台，后台子代理有 stall watchdog、每 10s 心跳、`children` 集合用于 Stop 级联（`runner.ts:402-408, 822-855, 4620-4645`）。**父 turn 不会像 MiMo 那样在结束时等待所有后台子代理**。
- steering：`steering` Map + `waiting`/`written`，每步开头等待写入完成，step 边界 `markDelivered`/`openSteeredTurn`；Stop 后不再接受新 steering（`steer-join.ts`、`runner.ts:1945-1969, 3033-3043`）。
- 重试：`session/retry.ts` 与 MiMo 同预算（stream 5 / server 8 / rate_limit 5 / network ∞ / unknown 8 / request 4），额外做 provider 级 rate-limit cooldown、`wakeWaiters`、可中断等待、retry 行倒计时（`retry.ts:32-62, 349-391`）。
- 循环检测：`LoopMonitor` 四类（same-call / edit-repeat / bash-retry / action-streak）、`WanderWatch`（一直探查但不改项目）、跨步 `stepDigest` 检测整步重复、`applyCrops` 把重复段从请求里裁掉（`loop-health.ts:1-495`）。命中后**弹问题**让用户选 once/always/reject；reject 以 `PermissionDenied` 形式回给模型（`runner.ts:4280-4395`）。`repeatsCall` 的 same-call 阈值是 3 次，与 MiMo 的 3 步同调用一致。
- 文本重复：`createLoopMonitor` 在流式输出中按 400 字符检查 n-gram，命中即切断并标记 `LOOP_FINISH`（`reminders.ts:32-147`）。
- 断线续写：`INTERRUPTED_FINISH` → `INTERRUPTED_NOTE`，把新文本**按字符追加**到未完成的回复（`reminders.ts:197-233`）；MiMo 没有这条“不重写已有内容”的追加续写，只把中断当失败重试。
- 空回复/纯思考：`EMPTY_NOTE`、`THOUGHT_LENGTH_NOTE`（思考吃满输出上限时要求直接行动）、`ANNOUNCED_NOTE`（长思考后只说“我来写”而不调用工具），`continuationFor` 都有独立计数（`reminders.ts:232-324`）。
- 恢复：启动时孤儿 turn 结算、`resume` 说明与 `CONTINUATION_LIMITS`（`runner.ts:3461-3495`、`reminders.ts:110-120`）。

### 2.2 判定

- **一致项**：无限步为默认；`toolChoice:none` + 最后一步提示；step 边界接收 steering；按 kind/phase 的重试预算；same-call 三次检测；文本 n-gram 流内切断；长度续写；空回复重试；子代理 Stop 级联；目标模式的 judge 门（`session/goal.ts` 两边都有，`MAX_GOAL_REACT=12`）。
- **MCode 缺失**：
  1. **无 `max` 最佳候选模式**（MiMo `max-mode.ts` 5 候选 + judge）。后果：同一难题只有一次生成机会，遇到模型首次方案很差时只能靠用户点重试。
  2. **无父 turn 等待后台子代理**的机制（MiMo `waitForSubagents`）。MCode 的 `spawn` 是“发起即走”，父 turn 可能先结束，后台子代理的失败/结果只能靠通知或之后的 turn 发现。
  3. **无 checkpoint rebuild/resume boundary** 那套（MiMo `session/checkpoint.ts`）。MCode 的 compaction 仍会丢细节，恢复靠“上一轮未完成，继续”的提示，不是可重建的检查点。
  4. **steering 只有单 lane/简单等待**：MiMo 的 inbox claim/lease、按 agent 隔离、输入 revision 能让子代理与主代理各自领取消息；MCode 只有 `waiting[]`。多子代理并发时，MCode 的 steering 目标更粗。
- **MCode 差异但不吃亏**：
  - 本地模型默认 32 步 + 明确的 `maxStepsPrompt`：比 MiMo 的无限步更能防止小模型烧钱/死循环；云模型仍无限，不牺牲长任务。
  - 循环命中时问用户（once/always/reject）而不是直接 pause：用户可给文字反馈，模型能收到“用户说……”的拒绝理由（`runner.ts:4350-4395`）。MiMo 更像“暂停 + handoff 对话”。
  - `WanderWatch` 能发现“一直在读/搜但从不改代码”的空转，MiMo 没有这一类。
  - 断线续写的“只追加缺失后缀”比 MiMo 的整段重试更省 token，也更不容易重复半句话。
  - MCode 的 retry 有全局 rate-limit cooldown 与等待唤醒，多个会话不会各自撞同一个 429。
- **明确弱于 MiMoCode**：
  1. **最佳候选（max mode）缺失**：在“架构选择/疑难 bug 修复”这类一次生成质量波动大的任务上，MiMo 的 5 选 1 + judge 明显提高一次成功率；MCode 只能靠模型单次发挥。
  2. **后台子代理结束不被父 turn 等待**：父 turn 可能在子代理还没回来时就总结“已完成”，造成“看起来完成、实际子任务失败”的假完成；MiMo 的 `waitForSubagents` 从循环层面避免这一点。
  3. **无 checkpoint rebuild**：长会话压缩后，MiMo 可从 checkpoint.md 重建工作状态；MCode 压缩后只能依赖摘要，细节与未完成事项更易丢。
  4. **多代理 steering 粒度更粗**：并行 explore/general 子代理同时运行时，MCode 的 steering 不能像 MiMo 的 per-agent lane 那样精确投递，用户中途指令可能只被其中一个代理看到。

## 3. 编辑工具匹配策略

### 3.1 两边实际做的事

**MiMoCode**（`tool/edit.ts`）

- 默认**只做精确匹配**：`replace()` 先 `content.indexOf(oldString)`，找不到就抛带“closest match”提示的错误；`MIMOCODE_ENABLE_FUZZY_EDIT` 未开时，模糊替换器一律不参与落盘（`tool/edit.ts:616-640`）。
- 精确匹配下：多处匹配且 `replace_all=false` 直接报错，给出匹配次数与整段 `old_string`（**不给行号**）；`replace_all=true` 走 `String.replaceAll`（`tool/edit.ts:624-640`）。
- 打开 `MIMOCODE_ENABLE_FUZZY_EDIT` 后走 9 级替换链：Simple → LineTrimmed → BlockAnchor（Levenshtein 相似度，单候选 0.0 / 多候选 0.3 阈值）→ WhitespaceNormalized → IndentationFlexible → EscapeNormalized → TrimmedBoundary → ContextAware → MultiOccurrence（`tool/edit.ts:640-680`）。**模糊链一旦命中就直接落盘**；若命中不唯一则继续找，最后仍不唯一才报“multiple matches”。
- 找不到时的提示由 `findClosestMatch()` 生成，截到 2000 字符，但**不带行号**（`tool/edit.ts:679-706`）。
- 行尾：读入后检测 CRLF 并把 old/new 都转成文件的行尾，写回保持（`edit.ts:22-34, 129-132`）。
- 没有“先读再改”的会话级校验；写前也没有“文件在等待审批期间变了”的二次校验。
- 写完调用 `lsp.touchFile` + `lsp.diagnostics`，把该文件的 LSP 错误拼进结果（`edit.ts:167-179`）。

**MCode**（`tool/edit.ts`）

- 默认走**分级模糊匹配**：`trailing-whitespace` → `trim` → `unicode`（弯引号/全角空格）→ `normalize`（unicode+trim）→ `indentation`（按公共缩进重排，并把 `new_string` 重新缩进）；每一级都要求唯一；`replace_all` 时要求所有命中区间不重叠（`edit.ts:333-420, 434-503`）。
- 明确拒绝“混合行尾”的文件做模糊匹配（`mixedEndings`，`edit.ts:183-186`）：宁可报精确未找到，也不猜。
- 精确匹配优先；精确多处匹配且未 `replace_all` 时，报错里给**行号列表**（`edit.ts:424-437`）。
- 模糊命中后输出 `matched lines X-Y after ignoring <tier>`，并把 `matchTier/ranges/reindented` 写进 metadata（`edit.ts:827-856`）。`new_string` 会按目标块缩进重排（`replacementLines`，`edit.ts:373-397`）。
- 找不到时 `closestMatch()` 依次试 7 个匹配器（不含精确与 MultiOccurrence），并给出**带行号的原文块**，截 2000 字符（`tool/edit.ts:161-180, 508-520`）。
- 写前硬校验：`wasRead`（未读不许改）、`checkFresh`（mtime/size/hash 变了不许改）、`guardPlanWrite`（plan 模式只许写计划文件）、`unchangedSince`（等待审批期间文件变了就放弃）、`locked`（同文件串行）（`edit.ts:658-671, 826-843`）。
- 写完：`postEditCheckDetailed`（对 TS 跑 tsc / 对 JS 跑 `node --check` 等）+ `lspDiagnostics`；若本轮有失败测试，`rerunAfterEdit` 自动重跑；连续问题轮次进入 `verify-loop` 并在输出里给“下一步做什么”（`edit.ts:800-825`，`post-edit-check.ts`、`test-memory.ts`、`session/verify-loop.ts`）。
- 写文件工具（`write`）同样有 wasRead/checkFresh/unchangedSince，并且对已存在文件不给“盲覆盖”（`edit.ts:658-700`）。

### 3.2 判定

- **一致项**：精确替换为主、未找到即失败、多处匹配报错、`replace_all` 语义、CRLF 保持、同文件锁、diff 进 metadata、写后 LSP 诊断、失败时给“最接近的原文”提示。
- **MCode 缺失**：MiMo 的可选 `BlockAnchor` 整块相似替换（允许 old_string 与文件块行数不同）；`EscapeNormalized` / `ContextAware` 在 MiMo 的可选模糊链里是可落盘的替换器，MCode 只把它们用于“提示”。
- **MCode 差异但不吃亏**：
  - MCode 默认就容忍尾随空白/缩进/unicode 引号，MiMo 默认不容忍（需环境变量）。对模型常犯的空白错误，MCode 首次成功率更高，且仍要求唯一，不会静默改错位置。
  - MCode 不做整块相似度落盘，避免了 MiMo 模糊链“相似就改”的误改风险；代价是 old_string 少/多行时只能重试。
  - MCode 的行尾规则更保守（混合行尾不做模糊），失败可预期。
- **明确弱于 MiMoCode**：无明显弱项。相反，MCode 在编辑链路整体**强于** MiMo：
  1. **未读/已变校验**：MiMo 没有，模型可能基于旧内容覆盖别人的修改；MCode 直接拒绝并提示重读（`edit.ts:660, 831`）。
  2. **写前二次校验**：审批期间文件被格式化/别的工具改动时，MiMo 仍按旧 diff 写入；MCode 放弃写入（`unchangedSince`）。
  3. **写后自动验证**：MiMo 只有 LSP 诊断；MCode 还会跑 tsc/node --check、重跑失败测试、累计 verify-loop 轮次并给具体修复建议。后果：MCode 更容易在一步内发现类型错误/回归，减少“改完看起来成功、实际坏了”的情况。
  4. **失败反馈可操作性**：MCode 给行号范围与匹配层级；MiMo 只给原文块。对长文件，MCode 的重试定位更准。

## 4. 上下文管理

### 4.1 压缩（compaction）

| 方面 | MiMoCode | MCode |
|---|---|---|
| 触发 | 计数：`usable()` = 有效窗口 × 0.9（`session/overflow.ts:100-108`）；错误：provider 报 context overflow | 计数：`usableContext()` = 窗口 × 0.9（`session/overflow.ts:117-124`）；错误：同一组 overflow 文案 |
| 预留 | `reserves()` = min(33k, maxOutput) + min(maxOutput, 20k)（`overflow.ts:24-36`）；`max_context` 可按模型覆盖 | 没有输入侧预留；输出侧用 `fitOutput()` 把“prompt + 请求输出”压进窗口（`overflow.ts:96-110`） |
| 摘要执行者 | 独立 `summary`/`compaction` agent，`toolAllowlist: []`，专用 prompt（`agent/agent.ts` 的 summary/compaction 项） | 会话自己的模型 + 会话自己的 system/tools，禁止调用工具（`runner.ts:1595-1650`），用 `smallRequest` 压低推理预算 |
| 保留尾部 | `COMPACTION_TAIL_BUDGET = 40_000` tokens，按 API round 保留，单条工具结果超过 8k 就替换为“已省略，重跑”提示（`compaction.ts:49-50, 154-208`） | `RECENT_KEEP = 15_000` tokens 原文保留（`summary.ts:260`），其余先汇总；汇总后拼 `<recent-context>`（`summary.ts:232-258`） |
| 文件清单 | `buildFileManifest()`：最近 5 个文件，带读过的行范围/写/编辑事件（`compaction.ts:88-152`） | `touchedFiles()`：最近 5 个文件 + “read/edit”事件（`summary.ts:183-230`），不带行范围 |
| 失败处理 | 摘要为空/不是模板/调工具 → 回滚，不改变会话（`compaction.ts:497-517`） | 先 nudge 一次；仍失败则按 `SHRINK_STEPS=[0.7,0.5,0.35]` 缩小重试，最多三次；仍溢出才报错（`runner.ts:1660-1710`） |
| 自动继续 | `compaction.autocontinue` 可按配置在压缩后继续（`compaction.ts:551-584`） | 压缩标记为 `automatic/provider-overflow/manual`，由下一次请求的 `continueNote` 继续（`summary.ts:364-373`） |
| 重建 | **checkpoint rebuild**：达到阈值时 checkpoint-writer 写 `checkpoint.md`；溢出时从 checkpoint + 重建 tail 恢复，而不是直接丢历史（`session/checkpoint.ts`、`session/tail-digest.ts`、`prompt.ts:6604-6700`） | 无 checkpoint rebuild；压缩就是摘要 + 最近上下文 |

### 4.2 裁剪（prune）

- **MCode 在一个 turn 开始时决定一次 `pruneLevel`**：缓存冷（超过 5 分钟/1 小时 TTL）且压力 ≥50% 才裁剪；压力 ≥85% 用 level 2（`session/prune.ts:60-106`）。裁剪是**仅请求侧**：`prunedHistory()` 把旧工具结果软裁剪到头 1536 + 尾 1536 字符，或在 level 2 清空；保留最新 40k tokens 工具输出、`skill` 结果永不裁剪（`prune.ts:35-46, 133-225`）。存储的历史保持完整。
- **MiMo 当前源码里没有这套请求侧软裁剪**：`session/prune.ts` 实际是 checkpoint 阈值调度（`prune.ts:139-360`），旧工具结果的“清理”只在压缩时通过 `compacted_tool_calls` / `[Old tool result content cleared]` 发生（`session/message-v2.ts:1244`）。也就是说，**一轮内反复读大文件时，MCode 会更早把旧结果裁掉，MiMo 会一直重发直到压缩/重建**。

### 4.3 Prompt cache

- **MiMo**：`provider/transform.ts` 按 provider 生成 `cache_control`/`cachePoint`/`copilot_cache_control`/`cacheControl`，并支持 `promptCacheKey=sessionID`（`transform.ts:258-268, 518-523, 1362-1442`）；`session/prefix-snapshot.ts` 把 system + tools + permission 的哈希持久化到 `SessionPrefixSnapshotTable`，重启后仍能复用同一前缀；`session/llm-request-prefix.ts` 让父与 checkpoint fork 用完全相同的函数构建前缀，保证 byte-equal（fork 缓存）。
- **MCode**：每个 provider 适配器都打 cache 标记（`provider/anthropic.ts:280-320`、`provider/openai.ts:220-258`），OpenAI 用 `prompt_cache_key`（`provider/sampling.ts:63`、`provider/chatgpt.ts:279`）；system 前缀按会话冻结（`runner.ts:1452-1500`），记忆/goal 放在 `systemTail` 不进缓存前缀。**但冻结在内存 Map 里，重启后重新生成**；也没有 tools/permission 的快照哈希。
- 两边都注意“工具顺序稳定以保前缀”（MCode `tool/registry.ts:24-30` 的注释与实现；MiMo 的 `GPT_TOP_LEVEL_TOOLS` 过滤）。

### 4.4 判定

- **一致项**：0.9 触发比、按工具结果大小裁剪/缩短、尾部保留、压缩后“继续”提示、provider 级 cache 标记、system 前缀与会话私有内容分离、旧工具结果清理标记。
- **MCode 缺失**：
  1. **checkpoint rebuild**（MiMo 的 checkpoint-writer + fork + tail digest）。后果：长会话一旦压缩，MiMo 能从结构化 checkpoint 重建“做过什么、哪些文件、哪些未完成”，MCode 只有摘要，细节和未完成项更易丢。
  2. **checkpoint rebuild 时自动注入 checkpoint/项目 MEMORY/会话 notes/全局 MEMORY**（MiMo `checkpoint.ts:588-650, 1400-1416`，各 6k-11k token 预算；注意这是 rebuild 边界时的注入，不是每轮）。MCode 没有任何 rebuild 路径，只在 system 里给“记忆文件在哪、可搜索”的提示（`prompt.ts:41-63`、`reminders.ts:356-372`）。后果：MCode 的记忆是“按需检索”，MiMo 在压缩重建时会把结构化记忆推到眼前，跨会话经验利用率 MCode 更低。
  3. **持久化前缀快照**（MiMo `prefix-snapshot.ts`）。MCode 重启后第一次请求会重算 system，可能丢掉一次前缀缓存命中；影响成本，不影响正确性。
  4. **独立 summary/compaction agent 与工具隔离**：MiMo 的摘要 agent 零工具、system 更短；MCode 用完整会话 system+tools 发摘要请求，摘要请求本身更贵，也更容易被工具 schema 挤占窗口。
- **MCode 差异但不吃亏**：
  - 请求侧裁剪（`prune.ts`）比 MiMo 当前实现更积极，且明确只在缓存冷时做，避免“为了省 token 把热缓存打掉”；在单轮读多个大文件的场景，MCode 的上下文压力更小。
  - `fitOutput()` 把请求输出压进剩余窗口，避免 vLLM/llama.cpp 这类“prompt+输出一起算”的服务器提前 400；MiMo 用固定预留 33k/20k，对本地小窗口更保守。
  - 压缩用的 nudge + 0.7/0.5/0.35 三段收缩，比 MiMo 的“失败即回滚”更愿意救回一次压缩。
  - `RECENT_KEEP=15k` 原文保留 + `<recent-context>`，比 MiMo 的 40k 尾部预算小，但保证“最近说过的话”逐字在，适合连续小步编辑。
- **明确弱于 MiMoCode**：
  1. **压缩后状态恢复能力**：没有 checkpoint rebuild，压缩后模型只能看摘要，容易重复已完成工作、忘记未完成事项；MiMo 能用 checkpoint 精确恢复文件清单与活动日志。
  2. **长期记忆没有自动推送**：MiMo 在 checkpoint rebuild 时把 checkpoint/项目记忆/会话笔记按预算推到模型眼前，并且自动 checkpoint 保证这些内容新鲜；MCode 只给路径提示，需要模型主动 memory/read，实际使用中模型经常不问，导致“上次说过的规则”被忽略。
  3. **摘要请求成本更高**：MCode 用会话自己的完整 system+tools 做摘要，长 system/多 MCP 工具时摘要请求可能自己就接近窗口上限；MiMo 的 summary agent 是空工具、短 prompt。
  4. **前缀缓存跨重启不连续**：MCode 进程重启后第一轮全价，MiMo 有 DB 快照可恢复前缀（成本差距，非能力差距）。

## 5. 权限模型

### 5.1 MiMoCode

- 规则形状：`{ permission: string, pattern: string, action: "allow"|"deny"|"ask" }`（`permission/index.ts:41-50`）；求值 `findLast`，**后写的规则覆盖先写的**，`permission` 与 `pattern` 都支持 wildcard（`permission/evaluate.ts:1-14`）。
- 配置表达力：`config/permission.ts` 里每个 kind 可以是字符串或 `{ pattern: action }` 对象，且特意保留用户 JSON 的 key 顺序（`ZodPreprocess` + `__originalKeys`），所以可以写：
  `bash: { "git status": "allow", "npm test": "allow", "*": "ask" }`。
  已知 kind 覆盖 read/edit/glob/grep/list/bash/task/actor/external_directory/question/webfetch/websearch/codesearch/lsp/doom_loop/skill，并允许任意新 key（`Schema.Record(Schema.String, Rule)`）。
- 强制询问：`FORCED_ASK = {bash_delete, computer}`（`permission/index.ts:205`）。这两类**不能被 `"*": allow` 或已持久化的 always 预授权**，只能显式 deny（`index.ts:236-257`）。`bash_delete` 的 `always` 为空，删一次问一次；临时目录内的删除豁免（`tool/bash.ts:416-431`）。
- 持久化：按 project 存 `PermissionTable`（`permission/index.ts:215-220`），"always" 写入后会让同项目内已被它覆盖的等待请求一并放行（`index.ts` 的 reply 逻辑）。
- 子代理继承：`permission-forward-ref` + `AskInput.inherit`，父会话已持有的 grant 可以自动允许后台子代理（`index.ts:300-345`）；`interactive:false` 的调用在无人可问时直接 `DeniedError`，不会挂死（`index.ts:347-355`）。
- 等待：支持 `abortSignal` 竞速、超时（`permissionAskTimeoutMs`）、用户 `CorrectedError` 带反馈（`index.ts:360-430`）。
- 其他：`skipAll` 自动放行普通询问但**不越过 forced**；`autoApproveDelete` 单独控制删除；`bash` 用 tree-sitter 解析命令，扫出外部目录、写入模式、删除目标（`tool/bash.ts:390-431`）。

### 5.2 MCode

- 三档访问级别：`ask` / `auto`（帮我审批）/ `full`（`shared/access.ts:10-16`）。每档把 9 个 bucket（read/edit/glob/grep/list/bash/webfetch/outside/mcp，`shared/protocol.ts:1218-1264`）映射到 allow/ask/deny。
- 规则表达力：配置里只有 `kind -> action` 的**扁平 map**（`shared/access.ts:65-82`），没有用户可写的 per-pattern 规则；per-pattern 只来自运行时 "always" 保存的 wildcard 规则（`permission.ts:376-390`），按 project 持久化（`RULES_KEY`，`permission.ts:164-200`）。
- 中间档 `auto`：`autoAllows()` 先放行 edit/outside 与不危险的 bash；其余交给**模型审阅**（`CommandReviewer`，8 秒超时，只有一次 `permission_verdict` 且 `APPROVE` 才算通过），审阅失败/超时/含糊一律回到用户（`permission.ts:68-110, 306-330`）。含密钥形状的命令不送给审阅（`looksSecret`）。
- 危险命令：`command-risk.ts` 把命令拆成 piece，识别 delete/reset/elevate/kill/rights/system/publish；`LOST_WORK = {delete, reset}` 每次都问；**full 档是唯一例外**（`permission.ts:442-470`，见下）。`readOnlyCommand()` 维护只读命令白名单，纯读命令直接放行；命名 `.env` 的命令会额外询问（`namesAskingFile`）。`bash-scan.ts` 还负责收集写目标、拒绝应用自身数据目录、拒绝 Windows ADS（`tool/bash.ts:566-590`）。
- 后台子代理：`markBackground` 后，只有“中间档本来就会放行”的已记住规则能自动通过；危险命令一律拒绝、无问题可问（`permission.ts:361-370, 470-485`）。
- MCP 单工具规则：每个 server 的 `tools` 规则按工具名匹配 allow/ask/deny，最后一条匹配生效（`mcp.ts:323-324, 1765-1770`）。
- 其他硬边界：plan 模式只能写计划文件（`session/plan.ts` 的 `guardPlanWrite`）；memory 代理只能写 memory/.mcode（`memory/guard.ts`、`fs-util.ts`）；应用数据目录读写拦截（`tool/app-data.ts`）；窗口文件通道二次校验（`file-access.ts`）。
- 审批等待**没有超时**：只靠用户回答或 Stop；后台子代理无审批者时直接拒绝。

### 5.3 判定

- **一致项**：allow/ask/deny 三值；wildcard 匹配；per-project 持久化 "always"；MCP 单工具规则；删除单独强制询问（MCode 在 full 档例外）；外部目录询问；`.env` 读取询问；只读命令放行；后台子代理不能弹问题；plan 模式写限制；危险命令分类。
- **MCode 缺失**：
  1. **用户可写的 per-pattern 规则**（MiMo 的 `bash: {"git *": "allow", "*": "ask"}`、`edit: {"src/**": "allow"}`）。MCode 只能按 kind 全局设，或靠运行时点 "always" 积累。后果：想做到“只允许 npm test 不许其他命令”只能全问或全放，实际使用中用户更容易被逼到 full access，整体安全性反而下降。
  2. **父 grant 向后台子代理继承**（MiMo `inherit`）。MCode 后台子代理遇到未记住的调用直接拒绝，无法复用父会话刚批准的权限。后果：后台 explore/general 子代理在需要写/跑命令时更容易失败。
  3. **审批超时**：MCode 的等待可无限挂起（没有 `permissionAskTimeoutMs` 对应物）；MiMo 的超时会把 `blocked` 清掉并让循环继续。MCode 的拒绝理由已经会通过 `userRefusal` 的 “The user explained: …” 传给模型（`permission.ts:38-44`），这一项不算缺失。
  4. **`doom_loop` / `lsp` / `task` / `actor` / `skill` 等独立 permission 维度**：MiMo 可单独禁 LSP、禁技能、禁循环重试询问；MCode 的 9 个粗桶里没有对应项（MCP 有单工具规则，但内置工具没有这么细）。
- **MCode 差异但不吃亏**：
  - 三档访问级别 + 模型审阅是 MiMo 没有的产品化能力：MiMo 只有 skipAll / forced-ask 的二元开关，没有“帮我审批”这种中间档。
  - `command-risk.ts` 的分类比 MiMo 更细（elevate/kill/rights/system/publish），且专门识别 git 的 pager/textconv/alias 等提权技巧（`command-risk.ts:200-300`）。安全性不弱。
  - `readOnlyCommand` 白名单 + `.env` 额外询问，减少只读命令的打扰。
  - full access 下删除也不问是**明确的产品选择**（`permission.ts:442-455` 注释），与 MiMo 默认每次问不同；这是取舍，不是缺陷。
- **明确弱于 MiMoCode**：
  1. **规则表达力**：MiMo 可按工具 + 路径/命令模式精细授权；MCode 只能整类开关，导致“要么太吵、要么太松”。对高频编码（反复 npm test / git diff / 特定目录编辑）体验与安全都更差。
  2. **后台子代理权限继承**：MCode 的后台代理更容易因“无人可问”而失败；MiMo 能继承父授权，长任务拆分更顺。
  3. **审批无超时**：无人值守或窗口断开时，MCode 的 turn 可能永久停在审批上；MiMo 有超时后继续/拒绝的路径。
  4. **内置工具的细粒度权限维度**：MiMo 可单独设 `lsp`、`skill`、`task`、`actor`、`doom_loop`；MCode 只有 9 个粗桶（`read/edit/glob/grep/list/bash/webfetch/outside/mcp`），不能单独禁“LSP 工具”或“技能加载”。后果：想禁某类内置能力只能关整个 bucket 或全放。

## 6. Provider 与模型处理

### 6.1 传输层与适配器

- **MiMoCode**：基于 AI SDK v6，按 `model.api.npm` 动态加载 **20+ 个官方 adapter**：`@ai-sdk/anthropic`、`openai`、`openai-compatible`、`amazon-bedrock`、`azure`、`google`、`google-vertex`、`google-vertex/anthropic`、`xai`、`mistral`、`groq`、`deepinfra`、`cerebras`、`cohere`、`gateway`、`togetherai`、`perplexity`、`vercel`、`alibaba`、`github-copilot`（`provider/provider.ts:239-261`）。模型目录来自 models.dev，启动后 5 分钟缓存 / 每小时刷新，新增 provider 无需改代码（`provider/models.ts`、`provider/models-catalog.ts`、`models-catalog-reload.ts`）。
- **MCode**：自写 **4 个 adapter**：Anthropic Messages、ChatGPT subscription、OpenAI Responses、OpenAI-compatible（`provider/adapter.ts:1-24`）。`catalog.ts` 内置约 44 个 provider 定义，绝大多数走 OpenAI-compatible baseURL；同时也用 models.dev 目录做模型元数据（`provider/models-dev.ts`），并对未知 provider 从 `/v1/models` 发现模型（`provider/discover.ts`）。
- **没有的**：MCode 没有 AWS Bedrock、Google Vertex、Azure OpenAI、Copilot 的原生 SDK 路径（catalog 里没有这些 id）；Gemini 走 `generativelanguage.googleapis.com/v1beta/openai` 兼容层。

### 6.2 provider 特有转换

**MiMo `provider/transform.ts`（1812 行）处理的事情**（MCode 多数没有）：

- 空 text/reasoning block 清理，覆盖 anthropic / bedrock / vertex-anthropic / openrouter-Claude（`transform.ts:59-79`）。
- assistant prefill：请求若以 assistant 结尾，Bedrock Converse 会 400；MiMo 会补一条最小 user 续写而不是删内容（`transform.ts:285-315`）。
- 全局“消息不得为空内容”不变量：user 空 → 补 “Continue.”；assistant 空 → 删；tool 空 → 保留（`transform.ts:350-390`）。
- cache 标记按 provider：anthropic/openrouter/bedrock/openaiCompatible/copilot/alibaba（`transform.ts:258-268, 518-523`）。
- `promptCacheKey` 按 session（`transform.ts:1362-1442`）。
- OpenAI Responses 的 `strict` 陷阱：默认不要把工具标成 strict，否则 `required` 被扩、`additionalProperties` 被改，模型会在参数半截处停（`transform.ts:1065-1160`）；`json_schema` 的 strict 同样处理（`transform.ts:1159-1180`）。
- reasoning/thinking 选项：models.dev 的 `reasoning_options`（toggle / effort / budget_tokens）、按模型族的 effort 表、anthropic adaptive thinking、gpt-5 各版本、xhigh 等（`transform.ts:997-1160` 以及 `provider/models-schema.ts`）。
- 模型能力：`capability-registry.ts` 同时看 model 能力与 adapter 能否序列化媒体，三态 supported/unsupported/unknown，供 MCP sampling 选模型（`capability-registry.ts:1-368`）。

**MCode**：

- `provider/history.ts` 处理未完成工具调用、空 user、assistant 结尾补 “Continue.”、思考被截断的摘要（`history.ts:1-120`）。
- `provider/tool-schema.ts` 只修 Gemini 与 Kimi 两族（enum→string、required 收敛、数组 items、去掉 anyOf 旁的 type）（`tool-schema.ts:1-141`）。
- `provider/variants.ts` 把 MiMo 的 effort 决策函数**局限在三种 kind**，并明确说不复制 Bedrock/Vertex/Copilot/Gateway（`variants.ts:1-30`）。
- `provider/sampling.ts` 按模型族给 temperature/topP/topK 与 OpenRouter `usage.include`（`sampling.ts:1-120`）。
- `provider/stall.ts` 检测流停住并报错；`provider/interleaved.ts` 把交错 reasoning 还原；`provider/chatgpt.ts` 处理订阅端 SSE 与账户 id。
- `provider/error.ts` / `session/error-map.ts` 做 HTTP/流错误归类；`provider/refresh.ts` 刷新 OAuth token。

### 6.3 判定

- **一致项**：models.dev 作为模型元数据来源；OpenAI 兼容与 Anthropic 两条主路径；按 family 的 temperature/topP/topK；reasoning effort 按模型选择；cache 标记；`prompt_cache_key`/`promptCacheKey`；工具 schema 的 provider 适配；流式 SSE；OAuth 刷新；图片压缩后发送；未完成工具调用的请求侧修补。
- **MCode 缺失**：
  1. **Bedrock / Vertex / Azure 原生 adapter**。后果：企业环境里只能走自建 OpenAI-compatible 代理；无法用 IAM/ADC 认证，也无法使用这些平台的原生 thinking/cache/tool 模式。
  2. **MiMo 的全局空内容/prefill/`strict` 不变量**。MCode 只修了两族 schema、补了 prefill；对 Bedrock/Vertex 转发的 OpenAI-compatible 端点或某些网关，仍可能发出空 block / strict 工具而被 400。MCode 目前不支持这些端点，所以问题被“不支持”掩盖，而不是被解决。
  3. **MCP sampling 的模型能力选择**（`capability-registry.ts`）：MiMo 能在多模型中选择能接受该媒体的模型；MCode 的 MCP sampling 只按会话模型（`provider` 层无同等 registry）。后果：MCP server 请求图片/音频/视频采样时，MCode 更容易直接失败。
  4. **目录更新后的 provider 实例重建**（`models-catalog-reload.ts`）：MCode 的 `models-dev.ts` 会定时刷新并通知订阅者（`models-dev.ts:64-92`），但没有 MiMo 那样“订阅更新 → dispose 空闲实例 → 下次启动重建 provider 列表”的完整链路，新 provider/新 api 字段的生效更依赖下次连接。
  5. **原生 Gemini 能力**：MCode 走 OpenAI 兼容层，Gemini 的 `thinkingConfig`、context caching、原生 function calling 模式都用不上。后果：Gemini 上的推理控制与缓存命中弱于 MiMo。
- **MCode 差异但不吃亏**：
  - OpenAI-compatible 覆盖了中国区大量 provider（小米、DeepSeek、Moonshot、智谱、DashScope、火山、MiniMax、阶跃、混元、千帆、硅基流动等），对国内用户开箱即用程度不比 MiMo 差。
  - `fitOutput()` + LM Studio 原生 context window 探测（`discover.ts:66-90`）对本地小窗口模型比 MiMo 的固定预留更准。
  - `variants.ts` 明确只实现三种 kind 的 effort，避免复制无法验证的分支；这是“少而正确”。
  - `stall.ts` 对流停住的检测是 MiMo 没有的独立机制，弱网下更快失败/重试。
- **明确弱于 MiMoCode**：
  1. **provider 广度与原生保真度**：缺 Bedrock/Vertex/Azure，Gemini 走兼容层，Copilot 完全没有支持。后果：换模型/换云时 MCode 的 tool calling、thinking、cache 行为更容易退化，尤其在企业代理/网关环境。
  2. **工具 schema 与消息形状的兼容层太窄**：MiMo 花大量代码处理各家 400（空 block、prefill、strict、json_schema strict），MCode 只覆盖 Gemini/Kimi。后果：接非主流 OpenAI-compatible 网关时，MCode 更容易整轮失败而不是单工具失败。
  3. **能力选择（MCP sampling/媒体）**：MCode 没有“模型 × adapter”能力矩阵，媒体输入只能靠会话模型硬扛。后果：带图片/音频的 MCP 工具在 MCode 上可用性更低。
  4. **目录热更新**：MCode 新模型/新 provider 的发现与生效更依赖重启，MiMo 可热重载。

## 7. 持久记忆与自我改进

### 7.1 真实机制（源码核实）

**MiMoCode**

- 存储布局：`<data>/memory/<scope>/<scope_id>/<key>.md`，scope = `global` / `projects` / `sessions` / **`cc`**；`cc` 直接索引 Claude Code 的 `~/.claude/projects/<slug>/memory/*.md`，并从 YAML frontmatter 的 `metadata.type` 识别 feedback/project/reference/user（`memory/paths.ts:3-125`）。
- 索引：SQLite FTS + BM25，搜索前 `reconcile()`（按 size+mtime 增量索引、删除已消失文件），支持 scope/scope_id/type/limit，分数低于最高分 15% 的结果丢弃（`memory/service.ts:21-148`）。后台 migration 分批回填 `body_idx`，可断点续跑（`memory/migration.ts:1-84`）。
- 搜索工具：`memory({operation:"search", query, scope, scope_id, type, limit})`（`tool/memory.ts:9-16`）。
- 写入：模型通过普通 `write/edit` 写 markdown；`memory-path-guard.ts` 限定路径形状与 sandboxed agents（checkpoint-writer 只能写 memory 树；dream/distill 可写 memory + `<worktree>/.mimocode`）；`memory/write-gate.ts` 的 `memory.disable_write` 一键禁写（读不受影响）。
- 自动写入（真正的“自我改进”）：
  - **checkpoint-writer**：每个会话按上下文窗口 20%/40%/60%/80%（>200k 为 10% 阶梯，>500k 为 5% 阶梯）触发，fork 父会话的完整前缀（system+tools+历史）写 `sessions/<id>/checkpoint.md`；只读 memory 树、工具白名单限制（`session/prune.ts:35-130, 139-360`，`agent/agent.ts` 的 checkpoint-writer，`tool/memory-path-guard.ts`）。
  - **auto-dream**：新会话第 1 步检查，默认每 **7 天**一次，建标题 `Auto Dream` 的系统会话，让 `dream` agent 用 memory + 原始 trajectory DB 做整合（`session/auto-dream.ts:1-80`，`prompt.ts:5298-5320`）。
  - **auto-distill**：默认每 **30 天**一次，建 `Auto Distill` 会话，回看一个月会话，找重复工作流并创建缺失的 skill/agent/command（`auto-dream.ts:40-60`，`prompt.ts:5310-5320`）。
  - 两者受 `memory.disable_write` 控制，且有 10 秒最小间隔、系统会话标题识别。
- 注入时机：**checkpoint rebuild 时**（`renderRebuildContext`）把 checkpoint.md（默认 11k token）、项目 MEMORY（10k）、会话 notes（6k）、全局 MEMORY（6k）按预算读入，并配合活动日志/文件清单（`session/checkpoint.ts:588-650, 1400-1416`，`budgeted-read.ts` 支持 section-aware 截断）。不是每轮都发。

**MCode**

- 存储布局：`<data>/memory/{global,projects,sessions}/.../<key>.md`，项目按 repo 身份（`memory/project-id.ts`，含 worktree 归并）；类型从 key 推断 memory/checkpoint/progress/notes/free（`memory/paths.ts:1-71`）。**没有 `cc` scope**。
- 索引：`MemoryIndex` 每次 search 前 `reconcile()`（size+mtime 指纹），SQLite FTS BM25，分数低于最高分 15% 丢弃，最多 10 条（`memory/index.ts:1-126`）。
- 搜索工具：参数与 MiMo 相同（`tool/memory.ts:29-41`）；explore 子代理被拒绝（`tool/memory.ts:45-46`）。
- 写入：普通 `write/edit` + `memory/guard.ts`（只允许 `<scope>/.../<key>.md`；`memory.disableWrite`；dream/distill 可写 memory + `.mcode`；任务子代理只能写自己任务的 `sessions/<id>/tasks/<T>/...`）。另有 `fs-util.ts` 的 memory 写检查在所有写工具前执行。
- 自动写入：**没有 checkpoint-writer，也没有 auto-dream/auto-distill 定时器**。`/dream` 与 `/distill` 是**手动 slash 命令**（`command-builtin.ts:183-195`），prompt 在 `session/prompts.ts:400-520`，写项目 MEMORY.md / 会话 notes.md，并要求 200 行 / 10KB 上限。
- 注入时机：没有 rebuild，也没有自动注入；只有 `recallHint()` 告诉模型“记忆在哪个文件夹、用 memory/read/task 查”，不把内容推进上下文（`reminders.ts:356-372`，`runner.ts:779-787`）；`memorySection()` 也是路径与写规则的说明（`session/prompt.ts:41-63`）。
- 额外：任务进度 `progress/notes` 有强制 section 检查与 `MAX_PROGRESS_REACT` 重提醒（`session/task-progress.ts`），用于让子代理把任务状态写进记忆。

### 7.2 判定

- **一致项**：markdown 记忆布局、BM25 FTS、scope/type/limit 过滤、15% 分数地板、`memory.disable_write`、memory 写路径沙箱、dream/distill 两个整合 agent 的 prompt 与工具限制、explore 子代理禁用 memory、任务 progress/notes 文件。
- **MCode 缺失**：
  1. **`cc` scope（Claude Code 记忆导入）**。MiMo 能直接检索 `~/.claude/projects/*/memory/*.md` 并按 frontmatter 类型过滤；MCode 完全不看这些文件。后果：从 Claude Code 迁过来的用户，既有记忆在 MCode 里不可见。
  2. **自动 checkpoint-writer**。MiMo 按上下文阈值自动把“正在做什么、改了哪些文件、未完成什么”写进 `checkpoint.md`，并可据此重建上下文；MCode 没有任何自动记忆写入，`checkpoint` 只是撤销快照（`session/snapshot.ts`），不是语义记忆。
  3. **auto-dream / auto-distill 定时器**。MiMo 每 7/30 天自动整合记忆、把重复工作流沉淀为 skill/command；MCode 只有用户手动输入 `/dream`、`/distill`。后果：MCode 的记忆会随会话增长而变脏、技能不会自动积累，长期使用“越用越懂你”的效果弱。
  4. **重建时的记忆注入**（见第 4 节）。MCode 依赖模型主动检索；MiMo 在 checkpoint rebuild 时把 checkpoint/MEMORY/notes 推到眼前，且自动 checkpoint 保证内容是最新的。后果：MCode 的长期记忆实际利用率低，模型经常重复问已知信息。
  5. **记忆索引后台回填/迁移**：MiMo 有分批、可恢复的 migration；MCode 只在 search 时同步 reconcile，大记忆库首次搜索更慢（性能差距，不是能力差距）。
- **MCode 差异但不吃亏**：
  - MCode 的 `/dream`、`/distill` prompt 写得很具体（明确的 MEMORY.md 章节、200 行/10KB 上限、notes 清空规则，`prompts.ts:400-520`），手动执行时产出质量不低。
  - `memory/project-id.ts` 有独立的 repo + worktree 归并与迁移逻辑，至少不弱于 MiMo 的 `resolveProjectId(absRepoPath)`。
  - 任务 progress/notes 的强制 section 检查是 MiMo 没有的（MiMo 有 progress 类型，但没有同样的“缺 section 就重提醒”机制）。
  - memory 写沙箱比 MiMo 更结构化（任务子代理只能写自己的 task 文件夹）。
- **明确弱于 MiMoCode**：
  1. **没有自动记忆沉淀与自动技能化**。MiMo 会自己写 checkpoint、定期 dream/distill；MCode 不会。后果：长项目跨会话的“经验”主要靠用户手动 `/dream`，否则记忆质量随时间下降，重复工作不会被沉淀成 skill。
  2. **没有 checkpoint 可重建的语义记忆**。MCode 的压缩摘要不可结构化重建；MiMo 的 checkpoint.md 是“工作状态 + 文件清单 + 下一步”的可恢复记录。
  3. **Claude Code 记忆不可见**。迁移用户损失既有资产。
  4. **记忆不自动推送**。即使文件存在，MCode 的模型也可能整轮不去搜；MiMo 在 checkpoint rebuild 时把预算内的记忆推到眼前，命中率更高。

## 8. 按编程效果影响的差距清单（由大到小）

排序依据：这条差距在真实编码任务里造成“做错/做不完/重做”的概率与成本，而不是代码量。

### 1) 缺少自动 checkpoint-writer 与 checkpoint 重建

- **后果**：长任务压缩后只剩摘要；MiMo 能从 `checkpoint.md` 重建“工作状态、文件清单、下一步”，MCode 容易重复已完成工作、忘记未完成项，长会话后段明显变差。
- **改造建议**（MCode）：
  - 新增 `src/server/session/checkpoint.ts`：按上下文窗口 20/40/60/80% 阈值触发（照 `mimo session/prune.ts:35-130` 的阶梯），写 `memory/sessions/<id>/checkpoint.md`。
  - 在 `src/server/session/runner.ts` 每步结束处检查阈值；用独立的只读/只写 memory 子代理（可复用 `tool/subagent.ts` 的 `general` + 工具白名单），或最小实现：用当前模型 + 专用短 prompt + 禁用其他工具。
  - 溢出/压缩时，在 `src/server/session/summary.ts` 的 `compactedText()` 里优先从 checkpoint 重建，而不是只放摘要；保留 `src/server/session/tail-digest.ts` 类似的活动日志。
  - 写入校验放进 `src/server/memory/guard.ts`（只 allow `sessions/<id>/checkpoint*.md`）。
  - 先做“手动 `/checkpoint` + 压缩时读取”也能拿到大部分收益，风险低于全自动。

### 2) 权限规则表达力不足（无 per-pattern 用户规则、无后台子代理继承）

- **后果**：高频命令只能全问或全放；用户为了不被烦到会切 full access，反而更危险。后台子代理因“无人可问”失败，长任务拆分受阻。
- **改造建议**：
  - 扩展 `src/shared/access.ts` / `src/shared/protocol.ts` 的 `permissions`：允许 `{ "bash": { "git *": "allow", "*": "ask" } }` 形式，保留 JSON key 顺序（参考 `mimo config/permission.ts` 的 `__originalKeys` + `findLast`）。
  - 在 `src/server/permission.ts` 的 `action()` / `allowedByRules()` 里按 `kind + pattern` 匹配，替换现在“只有 kind 桶”的判断；`ask()` 的 `patterns` 已经存在，可直接复用。
  - 后台子代理：把父会话已授予的规则集传进 `markBackground` / `ask()`，允许 `inherit`；危险命令仍一律拒绝（保留现有 `backgroundRefusal`）。
  - 给 `ask()` 加超时（默认不超时，可配置），超时按拒绝处理并让循环继续。

### 3) provider 原生适配与消息兼容层太窄（Bedrock/Vertex/Azure、Gemini 原生、strict/prefill/空 block）

- **后果**：企业环境用不了；Gemini 的 thinking/cache 退化；接非主流网关时整轮 400 的概率更高，工具调用更容易失败。
- **改造建议**：
  - 在 `src/server/provider/adapter.ts` 增加 `bedrock`、`vertex`、`azure` 三个 kind；`catalog.ts` 增加对应 provider 定义与认证方式。
  - 新增 `src/server/provider/transform.ts`（移植 `mimo provider/transform.ts` 的关键不变量）：空 text/reasoning 清理、assistant prefill 补 user、user 空内容补 “Continue.”、Responses/tool 的 `strict:false` 处理。优先覆盖 `openai.ts` / `chatgpt.ts` / `anthropic.ts` 三个现有 adapter。
  - Gemini：在 `provider/tool-schema.ts` 之外，增加 `thinkingConfig`、`cachedContent` 的原生字段（若坚持 OpenAI 兼容层，至少把 `reasoning_effort`/`extra_body` 映射补齐）。
  - MCP sampling：新增 `src/server/provider/capability.ts`（照 `mimo capability-registry.ts`），在 MCP sampling 选模型时按“模型能力 × adapter 能力”过滤。

### 4) 缺少 `exec` 脚本化编排、`codesearch`、`mcp_tool_search`

- **后果**：多文件/多请求任务步数与 token 成本高；外部 API/库文档只能靠记忆；MCP 工具多时上下文被 schema 占满、模型选错工具。
- **改造建议**：
  - `exec`：在 `src/server/tool/` 新增 `exec.ts`（Node `vm` 沙箱或受限 worker），暴露 `tools.*`、`ALL_TOOLS`、`files`、`console`；权限检查复用 `permission.ask()`；结果截断复用 `tool/truncate.ts`。在 `tool/registry.ts` 的 `TOOLS` 末尾追加（保持前缀缓存顺序）。
  - `codesearch`：接 Exa `get_code_context_exa`（MCode 已有 `websearch`/网络权限，可复用）。
  - `mcp_tool_search`：在 `src/server/mcp.ts` 建立工具目录 + FTS/embedding 检索，`tool/registry.ts` 按需只注入命中的 MCP 工具 schema；避免一次注入全部 MCP 工具。

### 5) 子代理生命周期与 steering 粒度

- **后果**：父 turn 可能先结束，后台子代理失败被漏掉；多子代理并行时用户的中途指令只被一个代理看到；自定义子代理不易被发现。
- **改造建议**：
  - 在 `src/server/session/runner.ts` 的 turn 结束判定前，加入“等待本会话所有非系统后台子代理结算”的步骤（照 `mimo prompt.ts:4819-4905`），带 stall 检测与超时；已有 `children` / `workers` / `subagentGate` 可复用。
  - steering 从单 `waiting[]` 改为按 `{sessionID, agentID}` 的 lane；`markDelivered` 按 lane 过滤（`runner.ts:1945-1969`）。
  - `tool/registry.ts` 的 actor 描述动态拼接可用子代理类型与工具（照 `mimo registry.ts:describeTask`），并在 `shared/protocol.ts` 允许自定义子代理被发现。

### 6) 记忆不自动推送 + 无自动 dream/distill + 无 cc scope

- **后果**：长期记忆利用率低；重复工作流不会沉淀；Claude Code 迁移用户丢记忆。
- **改造建议**：
  - 在 `src/server/session/runner.ts` 的 `compactNow()` 之后（以及会话第一次请求时可选）按预算把 `memoryFiles().project/notes/global` 的内容推进 `systemTail`（放 tail 不进缓存前缀），预算参考 MiMo 的 11k/10k/6k/6k；文件读取复用 `readBudgetedSectionAware` 的 section-aware 截断思路（MCode 可新建 `memory/budget.ts`）。
  - 新增 `src/server/session/auto-dream.ts`：在 `runner.ts` turn 第 1 步检查 `lastRun`（标题 `Auto Dream`/`Auto Distill` 的会话），默认 7/30 天，满足则创建系统会话并跑 `dream`/`distill` agent；受 `memory.disableWrite` 控制。
  - `src/server/memory/paths.ts` 增加 `cc` scope 与 frontmatter 类型解析，在 `memory/index.ts` 的 reconcile 中索引 `~/.claude/projects/*/memory/*.md`。

### 7) 缺少 max mode（5 候选 + judge）

- **后果**：疑难任务首次方案质量波动大时没有第二次机会；对高价值、低频率的难题，MiMo 一次成功率更高。
- **改造建议**：
  - 新增 `src/server/session/max-mode.ts`：复用现有 `adapter.stream` 的 propose-only 路径，并行 N（默认 3-5）个候选（不执行工具），再用一次无工具 judge 选择；只执行 winner。
  - 在 `src/server/session/runner.ts` 的模型调用处按 agent（`max`）分支；`shared/protocol.ts` 增加 `max` agent 与设置开关（默认关，避免成本意外）。
  - 计费与上下文：候选与 judge 的 usage 记入 `background-usage.ts`，不进入会话历史。

### 8) bash 输出没有噪声清洗

- **后果**：ANSI/进度条/超长行/密钥样式内容直接进上下文，浪费 token、干扰模型、增加泄密面。
- **改造建议**：
  - 新增 `src/server/tool/bash-clean.ts`，移植 `mimo bash_token_efficient_pipeline.ts` 的 4 个 plugin（progress/ansi/redact/longline）与 never-worse 守卫；在 `tool/bash.ts` 组装输出后、截断前调用。
  - 增加 `# raw` / 环境变量旁路，避免用户明确要原始输出时被清洗。

### 9) 摘要请求成本与 compaction 细节

- **后果**：MCode 用完整 system+tools 发摘要，长 system/多 MCP 时摘要请求本身接近窗口；文件清单没有读过的行范围，重建后要重新读整文件。
- **改造建议**：
  - 在 `runner.ts:compactNow()` 里给摘要请求使用“空工具 + 短 prompt”的专用请求（可复用现有 adapter，但 `tools: []`，system 只保留摘要模板）；避免把完整工具 schema 塞进摘要请求。
  - `summary.ts:touchedFiles()` 增加 read 的行范围（照 `mimo compaction.ts:readLabel`）；`MANIFEST_FILES` 现在已是 5，可与 MiMo 一致或提到 8。

### 10) prompt cache 跨重启不连续

- **后果**：重启后第一轮全价；对高频重启/多窗口用户成本更高。
- **改造建议**：
  - 把 `runner.ts` 的 `prefixes: Map` 持久化到会话存储（system + tools + permission 的哈希），启动时按 `profileKey` 恢复；参考 `mimo session/prefix-snapshot.ts`。

## 9. MCode 领先项

以下均以源码核实，且对**编程效果**有实际影响，不只是产品功能。

### 9.1 编辑链路（最明显）

- **读后写 + 陈旧检测**：`read-tracker.ts` 记录 mtime/size/hash，`edit/write` 在 `wasRead` 失败或 `checkFresh` 失败时拒绝，并给出“先读/重读”的可执行错误（`tool/edit.ts:658-671, 826-843`）。MiMo 没有这层保护。
- **写前二次校验**：`unchangedSince()` 在等待审批期间文件被格式化/别的工具改了时放弃写入（`tool/edit.ts:557-590`）。MiMo 会按旧 diff 直接写。
- **写后自动检查 + 测试重跑**：`postEditCheckDetailed` 对 TS 跑 tsc、JS 跑 `node --check`；`rerunAfterEdit` 重跑本轮失败的测试；`verify-loop.ts` 累计问题轮次并给“下一步”建议（`tool/edit.ts:800-825`、`post-edit-check.ts`、`test-memory.ts`、`session/verify-loop.ts`）。MiMo 只有 LSP 诊断。
- **分级模糊匹配且默认开启**：尾随空白/缩进/unicode 引号/混合空白都能命中，但要求唯一；模糊失败给带行号的原文块（`edit.ts:150-180, 333-519`）。在模型常犯的空白错误上首次成功率高于 MiMo 的默认精确匹配。
- **`write` 不盲覆盖**：已存在文件必须先读，且审批期间变化就放弃；MiMo 的 write 只靠 diff 让用户判断。

### 9.2 权限与安全

- **三档访问级别 + 模型审阅**：`ask` / `auto`（帮我审批）/ `full`，`auto` 下把不确定命令交给模型审阅（8 秒、只接受单个 `permission_verdict` 且 `APPROVE`）（`server/permission.ts:68-110, 306-330`）。MiMo 没有这种中间档。
- **更细的危险命令分类**：delete/reset/elevate/kill/rights/system/publish，并识别 git 的 pager/textconv/alias/config 提权技巧、ripgrep `--pre`、Windows ADS（`command-risk.ts:1-343`）。MiMo 的删除/外部目录分析也强，但分类粒度与 git 攻击面覆盖不如 MCode。
- **`.env` 读取额外询问 + 只读命令白名单**：`readAsks` + `readOnlyCommand` + `namesAskingFile`，既减少打扰又堵住 `type .env` 绕过（`permission.ts:112-126, 456-460`）。
- **多层硬边界**：plan 只写计划文件、memory 代理沙箱、应用数据目录拦截、窗口文件通道 realpath 校验（`session/plan.ts`、`memory/guard.ts`、`tool/app-data.ts`、`file-access.ts`）。

### 9.3 循环与续写

- **断线续写**：`INTERRUPTED_FINISH` + 只追加缺失后缀，避免整段重试与重复半句话（`reminders.ts:197-233`）。MiMo 没有这条路径。
- **思考被输出上限截断时的 `thoughtDigest`**：把思考开头+结尾作为文本放回请求，并用 `THOUGHT_LENGTH_NOTE` 要求直接行动，而不是重新规划（`provider/history.ts:34-58`，`reminders.ts:218-233`）。MiMo 无同等处理。
- **announced-only 检测**：长思考（≥2000 字符）后只写 ≤200 字符“我来做”且无工具调用，会被识别并要求立刻执行（`reminders.ts:239-249, 314-317`）。这是本地小模型的常见失败模式，MiMo 没有。
- **WanderWatch**：发现“连续读/搜但不改项目”的空转（`loop-health.ts:348+`），MiMo 的 try-best 只看重复/失败，看不到这类无效探索。
- **循环命中时让用户裁决**：once/always/reject，并把用户的文字反馈作为拒绝理由回给模型（`runner.ts:4280-4395`），比 MiMo 的“暂停 + handoff”更直接。

### 9.4 上下文与成本

- **请求侧裁剪只在缓存冷时做**：`pruneLevelFor` 用 cache TTL（5m/1h）判断，避免为了省 token 把热前缀打掉（`session/prune.ts:60-106`）。MiMo 当前没有请求侧软裁剪。
- **`fitOutput()` 适配本地服务器**：把 prompt + 请求输出一起压进窗口，避免 vLLM/llama.cpp/LM Studio 提前 400（`session/overflow.ts:96-110`）；MiMo 用固定预留，小窗口更保守。
- **压缩三段收缩 + nudge**：`SHRINK_STEPS=[0.7,0.5,0.35]` 与一次摘要 nudge，比 MiMo 的“失败即回滚”更愿意救回压缩（`runner.ts:1660-1710`）。
- **本地模型默认 32 步 + 明确 maxStepsPrompt**：防止小模型死循环烧钱（`session/steps.ts`）。

### 9.5 桌面/产品能力（MiMo CLI 源码里没有对应工具）

- `fanout`：最多 16 个并排单发生成请求、并发最多 8，支持共享 system/system_file、`must_contain`、自动重试（`tool/fanout.ts:12, 46-71`）。MiMo 没有“并排生成多份候选文件”的工具（max mode 是选下一步，不是写多份产物）。
- `verify_page`：一次性浏览器 profile 打开页面做验证（`tool/verify-page.ts`）。
- `app`：通过 DevTools 端口操作正在构建的应用（`tool/app.ts`）。
- `present_files` / `pdf_locate`：把产物呈现给用户、在 PDF 中定位（`tool/present.ts`）。
- 会话互聊与外部会话读取：`contacts` / `talk_to_session` / `create_session` / `update_session` / `list_external_sessions` / `read_external_session`（`tool/session-chat.ts`、`tool/external-session.ts`）。
- `speak`（语音反馈开启时）与桌面设置工具（`tool/speak.ts`、`tool/desktop-settings.ts`）。
- 这些工具对“纯写代码”影响有限，但对 MCode 作为桌面产品的多会话协作、产物交付、页面验证是 MiMo CLI 不具备的。

### 9.6 其他

- **bash 的 Windows 编码与交互处理**：控制台代码页探测、UTF-8/GBK 流式解码、`interactive:true` 立即拒绝并给替代写法、后台进程 EXIT_DRAIN（`tool/bash.ts:20-160, 543-549`）。MiMo 的 `interactive` 依赖真正的终端交接，桌面端没有。
- **任务进度强制 section**：`session/task-progress.ts` 对子代理的任务 progress 文件检查缺失 section 并重提醒（`MAX_PROGRESS_REACT`），MiMo 有 progress 类型但没有同等强制。
- **重试冷却与唤醒**：`noteRateLimit` / `cooldownLeft` / `wakeWaiters` 让多个会话共享 rate-limit 等待，并在网络恢复/用户操作时提前唤醒（`session/retry.ts:349-391`）。
- **`fitOutput` + `promptSince` 的请求大小推算**：对中文密集文本用 1.15 余量估计增长，历史变短时用“上次报告 - 减少量”而不是整段重估，减少对本地模型的误判（`session/overflow.ts:112-150`）。
