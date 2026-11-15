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
