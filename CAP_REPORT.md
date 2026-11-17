# TASK_CAP 工具输出帽审计

## 盘点与前后值

以下区分工具内部帽与 runner 的共享兜底；字节均按 UTF-8 计算。原先 read/search 并非完全无帽。

| 工具/路径 | 修改前单次上限 | 修改后默认上限 | 获取更多内容 |
| --- | --- | --- | --- |
| bash | 30,000 近似 token = 120,000 字节正文；head+tail；自行标记后跳过共享帽 | 6,000 近似 token = 24,000 字节正文，另有截断/状态标记 | 原有 `max_output_tokens` 保留；全量仍落盘并返回路径；无保存服务或保存失败时提示加大参数重跑 |
| read 文本 | 默认 2,000 行；每行 2,000 字符；正文 51,200 字节，未计行号/指令 | 编号正文默认 24,000 字节；整个格式化结果 ≤25,000 UTF-16 字符单元；行帽不变 | `offset` 逐行续读；新增 `max_output_chars` 加大帽（最小 4,000）；源文件保持完整 |
| read 目录/附加指令 | 目录默认 2,000 项，目录走共享帽；附加指令无内部总字符帽 | 整个结果 ≤25,000 字符；目录在完整条目边界分页 | `offset` 续读；超大格式化结果经 toolOutputs 全量落盘，提供路径及加大帽提示 |
| grep | 100 条；每条最多 2,000 字符后加省略号；已有总命中数及缩小范围提示 | 保留更紧的 100 条上限（未放宽到建议的 200） | 缩小 pattern/path/include；已有 bash rg 入口保持原样 |
| glob | 100 条路径；只探测前 101 条，无法给真实总数 | 保留 100 条；遍历计数并提示共 N 条及缩小范围；仅保留 100 条路径在内存中 | 缩小 pattern/path；超时仍明确提示结果不完整 |
| webfetch | 响应体最多 5 MiB，超出拒绝；文本再走共享帽；图片以附件返回 | 不变 | 共享帽截断时返回全量保存路径，可 read/grep |
| 共享 ToolOutputs | 2,000 行 / 51,200 字节；压力下 1,000 行 / 25,600 字节，另加标记 | 不变 | 完整输出落盘，标记包含路径和 read offset/limit 用法 |

bash 的模型级 `context.maxOutputTokens` 覆盖入口保留（reasoning 模型原有 10,000）；显式参数仍优先。遵照禁区，静态工具描述与已有 schema 描述的实际文本保持原样，因此旧描述里的 30,000 未随运行时默认值调整。没有修改静态系统提示词。

## 红测试提交

`3503363 test: add red tool output cap and transcript fixtures`，先于实现提交。

```text
FAIL bash default cap and full output
FAIL read cap and offset continuation
FAIL glob count cap and narrowing marker
ok grep count cap and narrowing marker
fixture fat before=300146 after=300146 reduction=0.00%
FAIL fat transcript >=50% smaller; short transcript byte identical
```

现有 grep 帽本来就满足要求，其保护性测试在红阶段通过。

## fixture 度量

fixture 使用五次真实 BashTool.execute，每段输出 60,000 字节（按本工具四字节近似口径约 15K token），经 bash 格式化及 JSON tool 转录序列化。基线显式使用旧帽 `max_output_tokens: 30000`，新值使用默认参数。`MCODE_BASH_RAW=1` 排除重复行清洗的干扰，单独测量输出帽。全量文件内容另作逐字节断言。

| 转录 | 修改前字节 | 修改后字节 | 降幅 |
| --- | ---: | ---: | ---: |
| fat，5 段 | 300,146 | 121,136 | 59.64% |
| short | 44 | 44 | 0%，字节级相等 |

保存路径有随机后缀，但固定长度，fixture 字节统计稳定。此数据证明 fixture 降幅，不等同于已复跑竞技场；30.2K → ≤18K 的真实 prefill 目标仍需同条件竞技场复测。

## 验证

所有临时文件、日志、测试 HOME、git fixtures 均放在本 worktree 的 `tmp-local/`，未使用 /tmp，未安装依赖或修改 node_modules 链接。检查所需隔离：TMPDIR/TMP/TEMP 指向 tmp-local；tmp-local/package.json 设置 commonjs，避免合成 `.js` fixture 继承项目 ESM；GIT_CEILING_DIRECTORIES 阻止 git 发现父仓；本地 Node preload 在 worker 中延续 fenced-home 的祖先 .git 隔离。初次未隔离的失败已定位并在隔离后重跑。

运行新增测试：

```sh
mkdir -p tmp-local
TMPDIR="$PWD/tmp-local" npm run capcheck
```

最终输出摘录（JS fallback 与原生 ripgrep 两条路径均通过）：

```text
ok bash default cap and full output
ok read cap and offset continuation
ok read explicit larger cap and directory continuation
ok glob count cap and narrowing marker
ok grep count cap and narrowing marker
fixture fat before=300146 after=121136 reduction=59.64%
fixture short before=44 after=44
ok fat transcript >=50% smaller; short transcript byte identical
```

既有 npm 检查脚本全部通过（最终退出码均为 0）：

| 命令 | 最终结果/输出摘录 |
| --- | --- |
| `npm run build` | `✓ built in 30.55s`（已有依赖 use client 等构建警告不影响退出码） |
| `npm run typecheck` | vue-tsc 与 tsc 完成，无诊断 |
| `npm run smoke` | `74/74 checks passed`; `smoke passed` |
| `npm run roundscheck` | `119 modules, 6366 checks passed, 0 failed, 0 modules not clean` |
| `npm run fanoutcheck` | Python 3.11 下 `123 passed, 0 failed` |
| `npm run snapshotcheck` | `undo records inside git and stays out of everything else.` |
| `npm run toolcheck` | `A stopped command takes its children with it, an ambiguous edit is refused, and a question survives a reload.` |
| `npm run sessioncheck` | `Undo covers what the shell changed ...`; `Rolling a conversation back moves the transcript and the project together ...` |
| `npm run promptcostcheck` | `characterization GREEN`; `output characterization: 7 assertions GREEN (read, bash, shared edit cap)` |
| `npm run androidtheme` | `58 constants, no light-in-dark twins, all text over 4.5:1` |
| `npm run gencheck` | `src/server/remote/cockpit-html.ts is current (42518 chars)` |
| `npm run themecheck`, `mcpcheck`, `i18ncheck`, `mdcheck`, `sandboxcheck`, `remotecheck`, `wiringcheck`, `promptcheck`, `shellcheck`, `providercheck`, `pathscheck`, `turncheck` | 全部退出码 0 |
| `git diff --check` | 无输出，退出码 0 |

完整日志保留在本地 tmp-local/*.log。复测的通用隔离环境：

```sh
export TMPDIR="$PWD/tmp-local" TMP="$PWD/tmp-local" TEMP="$PWD/tmp-local"
export GIT_CEILING_DIRECTORIES="$PWD/tmp-local"
export NODE_OPTIONS="--import=$PWD/tmp-local/fence-workers.mjs"
export PATH="$PWD/tmp-local/bin:$PATH" # python3 指向机器已有 Python 3.11
```

roundscheck 原有规则跳过 14 个需真实窗口/设备/浏览器或特定外部程序的模块；未改变跳过规则。首次 roundscheck 同时发现构建早于源码，最终重建后全套重跑通过。没有将环境失败隐藏为通过，也没有为通过检查修改无关产品行为。

CAP_DONE
