# Context rebuild report

基线：63a7618，分支 ctx-rebuild。按 A → B1 → B2 → B3 执行，不 push，无新增依赖。

## Phase A

新增真实 runner 的公开行为断言：新建 SessionStore 能读回相同压缩边界和摘要；压缩前后持久 transcript 完全一致。结合原有断言覆盖手动压缩替换历史、首轮请求的摘要/新问题、provider 溢出重试、90% count 的触发时序。原 count 特征明确：结束回合越线后未压缩，下一回合开始才压缩。

变异仅作用于 esbuild bundle，未改变产品源码：
- 把 compacted.summary 持久化为 lost：退出 1，`compaction checkpoint survives a fresh store` 红（另有三条已有断言红）。
- 在 compactNow 保存前把第一条历史 text 改为 lost：`compaction preserves the durable transcript` 红，退出 1。

恢复后 typecheck / sessioncheck / turncheck / smoke 全部退出 0；turncheck 17 passed，smoke 74/74。临时运行使用工作树 tmp-local，TMPDIR 和 GIT_CEILING_DIRECTORIES 均指向它，内置 CommonJS package.json 和空 .git 隔离 fixture。node_modules 符号链接未动。

## 参考与约束

已依次阅读 CAPABILITY_DIFF 第 7 节第 3 项、MIMO_CAPABILITY_DIFF 重建相关第 1 项及源码、context.ts / overflow.ts / checkpoint-migrate.ts / patch-checkpoint.ts、main:CODEX_REPORT.md 和 opencode core compaction。

CAPABILITY_DIFF 实际第 3 项描述“同步现状 + 后台预生成优化”，并非断言当前异步。opencode 当前 compaction.ts:344–405 是后台预生成并持有摘要，未找到独立 pre-compact 持久笔记冲刷；本任务的笔记步骤是新增实现，不能声称逐字复刻参考。MiMo checkpoint.ts:588 是接口说明，实际 renderRebuildContext 从 1311 起，依 watermark 注入最近 snapshot、learnings 与活动；本次对齐结构化恢复语义。

runner 纪律：不重构每步历史整形、继续/续写/压缩/中止决策、stream 实时 emit/append/blocks；必要钩子每处不超过 10 行。checkpoint-migrate 是文件 undo blob 迁移，patch-checkpoint 是本地模型催促 edit，均非会话重建 checkpoint。

## Phase B1 — pre-compaction memory

新增 compaction-memory.ts。已知窗口到 80% 时，在下一次正常请求组装前，使用当前已落盘历史做一次静默、零工具的 JSON 笔记回合；每个压缩周期成功后只做一次。80% 比现有 90% 压缩线早 10 个百分点，为笔记与工具输出留余量；未知窗口不按比例触发。手动/automatic 压缩可强制补写；provider-overflow 不再发送一个可能再次溢出的笔记请求，使用已有笔记。

笔记字段：goals / constraints / decisions / files / lastAction / nextSteps；按字段限长，持久化在 session info 的 compactionMemory，含 epoch、boundary、时间。不追加 assistant/message.part 事件或聊天消息，费用归 compaction 后台用量。输入仅包含有限长纯文本记录，已知窗口进一步收缩输入，输出至多 2048 tokens。无效 JSON、空笔记、工具调用、拒绝、截断、异常、中止均不覆盖旧笔记。失败可在后续请求重试。回滚/提交回滚/删除笔记边界时清除旧笔记，fork 不继承它。

摘要 instruction 明确要求吸收笔记；通过摘要验证后再附上 Durable session notes，保证笔记不会随模型摘要漏写而丢失。原摘要和 recent 的投影顺序保持。

真实 runner 新断言全部 green：静默笔记由新 store 读回且不增加 transcript；摘要请求和保存摘要含笔记；80% 时三轮仅冲刷一次且尚未压缩。bundle 三项独立变异（失败时立即 exit 1）：保存 notes.goals 为 lost → 持久化断言红；禁止向摘要附笔记 → 摘要吸收断言红；把阈值改为 200% → 80% 断言红。首轮 typecheck 发现 TurnSession.agent 类型比 SessionInfo 宽，改为字段级 Pick 后通过。

runner 调用点：compactNow 在边界裁剪后、split 前调用 flush（1 行）；循环读取 stored 后、markDelivered 前调用 flush（1 行）。新增独立 flush 方法，不移动受保护段；另在既有回滚/删除入口清除笔记（各 1 行）。

B1 最终版本提交前：typecheck、sessioncheck、turncheck、smoke 均 exit 0；turncheck 17 passed，smoke 74/74，git diff --check 通过。

## Phase B2 — structured rebuild

压缩边界冻结 rebuild snapshot（来自持久笔记）；旧 checkpoint 无 snapshot 时从已有摘要 Objective / Requirements / Decisions / Work State / Next Move 和 files 恢复。块含 Session goals、Established constraints、Decisions、Key files、Last action、Unfinished work，空项明确 unknown。历史快照仅作数据，要求更新的用户消息与当前指令优先，操作前核验文件，避免旧笔记升级成新指令。

组装顺序：context.ts 的 runtimeContext/sessionNote 仍随原用户消息保存；runner.contextFor 先生成 summary + recent + boundary 后消息，再保留原有 crop/prune/headers/skills/attachment/forWire 次序。最后请求组装才加入独立 developer 字段，OpenAI wire 为 system → developer rebuild → 投影历史；Responses 在 input 起始放 developer 消息，instructions 不变；Anthropic 没有 developer 角色，在 system 的缓存前缀和 memory/goal tail 之后追加不标缓存的等效文本块。重建文本计入 requestTokens 与 fitOutput。

首轮正常请求成功返回 outcome 后才持久化 compacted.rebuildDelivered；失败/中止未交付，重试仍有重建块；新压缩边界重新触发。后续正常请求不重复，不增加 transcript。runner 仅加 snapshot 字段、请求组装的 developer 变量/字段、成功后确认钩子（各处≤2行），不搬移或拆分决策与 emit 段。

B2 新增四个公开行为断言均 green：首轮 structured developer 块与顺序、持久交付标记与仅一次、Anthropic system tail 顺序、Responses developer 位于历史前。四项独立 bundle 变异均 exit 1 且对应断言 BAD：删除 OpenAI developer splice；把 rebuildDelivered 写成 false；删除 Anthropic rebuild system block；删除 Responses developer input。最终 typecheck / sessioncheck / turncheck / smoke 均 exit 0，turncheck 17 passed，smoke 74/74，diff --check 通过。
