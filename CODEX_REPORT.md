# CODEX runner 拆分报告

基线：`e5590f8`。严格先 Phase A、再 Phase B；没有 push。未修改 i18n.ts、tool/registry.ts 或 node_modules；`finishTurn` 已与基线逐字比较，一致。

## 提交与提取范围

- `99a5c81 test(session): cover failure closing and stranded turn finalization`：增加三个特征场景，每个场景一个组合断言，仅检查 store、busySessions、transcript、queued、bus 的公开可观测行为。失败场景由 fake provider 返回 HTTP 400；失败呈现在 assistant 的 finish/error 上，而不是要求额外的 session.error。stranded 场景通过公开 store.update 边界，在释放 claim 前送入消息，使窗口确定发生，不读取 runner 私有字段。关闭场景使用独立 runner，因为 closeTurns 是终态。
- `ae3eaf4 refactor(session): extract initial turn preparation`：原样提取 run 开头的 write-ahead claim、会话/命令覆盖设置、MCP readiness、provider/adapter/token/config 与 system/systemTail 初始化，成为 prepareTurn。run 保留原有 lead、启动压缩和 pruning 顺序。
- `2cfc1a1 refactor(session): extract settled stream tool part assembly`：原样提取 stream 收到最终 outcome 后的工具参数/part 组装为 settleToolCalls。已有 part 填入 input，缺失 part 经原 announce 回调发布，inputError 仍写入原 WeakMap。原块仅改变缩进与调用位置；去掉空白后已比较一致。

没有新增跨步骤的 per-turn context。prepared 只是准备阶段的返回值，未把循环状态装入共享容器。

## 参数与跨界状态

| 单元 | 名称 | 读写方向与用途 |
| --- | --- | --- |
| prepareTurn 输入 | sessionID | 读；store 和实例 map 的键 |
| prepareTurn 输入 | controller | 读 signal；MCP trust 检查 |
| prepareTurn 返回 | planning | 输出，run 只读；原始 plan 模式 |
| prepareTurn 返回 | session | 输出，run 后续读写；命令覆盖后的会话视图 |
| prepareTurn 返回 | definition、adapter、tokens、config | 输出，run 只读；原有 provider 请求配置 |
| prepareTurn 返回 | system、systemTail | 输出，run 后续读写；后续 plan 转 build 时仍按原逻辑更新 |
| prepareTurn 实例状态 | restartResumes | 读并删除 |
| prepareTurn 实例状态 | store | 写 claim，读会话 |
| prepareTurn 实例状态 | turnOverrides | 读并删除 |
| prepareTurn 实例状态 | turnAgents、workingIn | 写入当前 agent / 工作目录 |
| prepareTurn 实例状态 | loopWatches | 删除上一回合记录 |
| prepareTurn 服务 | config、auth、mcp、ensureMcpTrust、systemFor | 原顺序读取/调用；systemFor 内部副作用不变 |
| settleToolCalls 输入 | assistant | 读 parts、写既有 part.input；announce 将新 part 追加到同一 assistant |
| settleToolCalls 输入 | outcome | 只读 toolCalls 与 call.inputError |
| settleToolCalls 输入 | announce | 调用；沿用 stream 闭包，对外发布原 message.part.updated |
| settleToolCalls 实例状态 | inputErrors | 写入原 part → inputError 映射 |

原有局部变量名、类型标注和逻辑保持；新方法只添加必要参数与返回值封装。

## 变异红绿证据

每个新断言分别做一次变异。为遵守禁止碰 finishTurn 的约束，变异只应用于 esbuild 生成的完整测试 bundle；每次从同一未变异 bundle 复制，运行真实 runner，不修改 runner.ts。三个变异运行均退出 1。

| 新断言 | 故意改错的条件 | RED 实际输出 | GREEN 恢复后 |
| --- | --- | --- | --- |
| a failed turn reports an error and retains its queue without sending it | 去掉自动续发条件中的 `!failed` | BAD 同名断言；FAILED with 1 problem(s) | ok |
| closing preserves the claim and queue while releasing busy state | 释放 claim 的 `if (!this.closing)` 改成 `if (true)` | BAD 同名断言；FAILED with 1 problem(s) | ok |
| a stranded message resumes without an intermediate idle or duplicate transcript entry | `const stranded = waiting.length > 0 && !controller.signal.aborted` 改成 false | BAD 同名断言；另有原断言 a turn is started for it / and the model is given what was said 变红；FAILED with 3 problem(s) | ok |

变异期间 `git diff -- src/server/session/runner.ts` 为空；删除所有变异 bundle，正常 sessioncheck 重新构建未变异 bundle。恢复后的 Phase A sessioncheck 退出 0，三个新断言均为 ok。每个场景只新增一个组合断言，所以三个变异逐条覆盖全部新增断言。没有修改 finishTurn 实现来做变异。

## 每段验证与非零条目检查

运行环境：

```sh
export PATH=/opt/homebrew/opt/python@3.11/libexec/bin:$PATH
export TMPDIR="$PWD/tmp-local"
export GIT_CEILING_DIRECTORIES="$PWD/tmp-local"
mkdir -p tmp-local/.git
printf '%s\n' '{"type":"commonjs"}' > tmp-local/package.json
npm run -s typecheck && npm run -s sessioncheck && npm run -s turncheck && npm run -s smoke
```

所有临时数据均置于仓库内 tmp-local；最终已删除。临时 package.json 避免测试生成的 require() 脚本继承根目录 ESM 类型；GIT_CEILING_DIRECTORIES 避免“非仓库”fixture 误认祖先仓库；空 .git 边界避免搜索 fixture 继承仓库 `*.log` 忽略规则。这些都是测试环境隔离，未更改产品或测试原断言。

首轮未加隔离时，旧 shell fixture 因 require 不可用失败；补 CommonJS 隔离后，非仓库 fixture 仍误认祖先仓库；再设置 git ceiling 后恢复。smoke 首轮因祖先 `*.log` 忽略导致 0 匹配并抛 TypeError；增加临时 .git 搜索边界后通过。没有带这些环境红灯提交。

| 阶段（提交前） | typecheck | sessioncheck | turncheck | smoke |
| --- | --- | --- | --- | --- |
| Phase A | exit 0 | exit 0；190 条 ok | exit 0；17 passed, 0 failed | exit 0；74/74 checks passed |
| Phase B 准备段 | exit 0 | exit 0；190 条 ok | exit 0；17 passed, 0 failed | exit 0；74/74 checks passed |
| Phase B 工具组装段 | exit 0 | exit 0；190 条 ok | exit 0；17 passed, 0 failed | exit 0；74/74 checks passed |

检查 session-check.ts 后确认本次相关场景直接驱动真实 runner，不依赖 runner 源码正则；同时核对 smoke 的 runner 源码扫描位置。搬移后仍保留 toolCalls 循环与原锚点，全部检查实际执行；sessioncheck 190、turncheck 17、smoke 74 的数量各段一致，三个新断言各段均执行，未出现 green zero-entry。

## 保留的部分与原因

- 回合启动后的 lead 执行、compactIfCrossed、pruneLevelFor：lead 有提前返回，压缩会替换 session，system 构建又必须在它们之前；将它们统一搬入准备方法需要额外返回中止状态。单独搬 pruning 两行收益低，保留原位置。
- 每步历史整形：依赖当前 session、stored、delivered、continuing、notes、attachmentData、step，并伴随 openSteeredTurn 与 checkpoint 副作用。当前保留能直接看到消息交付与历史读取顺序。
- stream 的实时 emit/append/blocks：共享 cut、streamed、taken、dirty、blocks、carried、inner、monitor；这些值又被重试恢复与 finally 使用。提取整个闭包需要很大的共享 context，收益不足，因此仅提取最终工具组装块。
- 每步继续/续写/压缩/中止决策：交错更新 rescued、continuing、afterCut、compactedAt、continued、notes、repeated、digests、textLooped、session、system/systemTail，并使用 break/continue/return。纯搬移需要显式控制流结果与大范围状态参数化，未为拆而拆。

## 最终代码提交记录与 diff

以下是代码完成、报告提交前的 `git log --oneline -6`；报告随后单独以 docs(session) 提交，不包含用户预置的未跟踪任务文件。

```text
2cfc1a1 refactor(session): extract settled stream tool part assembly
ae3eaf4 refactor(session): extract initial turn preparation
99a5c81 test(session): cover failure closing and stranded turn finalization
e5590f8 Merge branch 'runner-split': extract finishTurn from launch
4719022 refactor(session): extract turn finalization from launch
975544f Merge branch 'quickwins': capability-alignment quick wins (6 items + i18n)
```

`git diff --stat e5590f8..HEAD`（代码提交，不含本报告）：

```text
 scripts/session-check.ts     | 70 ++++++++++++++++++++++++++++++++++++++++++++
 src/server/session/runner.ts | 55 ++++++++++++++++++++--------------
 2 files changed, 103 insertions(+), 22 deletions(-)
```

清理前另做了 git diff --check；通过。工作区原有未跟踪 SPLIT1_REPORT.md、TASK_CODEX.md、node_modules 符号链接均保留，不纳入提交。
