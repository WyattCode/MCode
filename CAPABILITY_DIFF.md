# 编程能力对比:MCode vs opencode 上游

> 左侧 `MCode`: `/Users/wyatt/MCode`(Electron + Vue3,后端在 `src/server`)。
> 右侧 `opencode`: `/Users/wyatt/opencode-src`(Bun monorepo,核心在 `packages/core/src`)。
> 本文只以代码为准,README 的"尚未实现"清单已过期,不作为依据。

## 1. 工具集与工具描述提示词

两边都不是"只给模型一把 bash"的形态:opencode 的内置工具在 `packages/core/src/tool/plugin/`(read/write/edit/patch/glob/grep/shell/question/todo/subagent/skill/webfetch/websearch,另有 `opencode.ts` 的命名空间工具、`artifact.ts`、`schedule.ts`、`image-generate.ts`),由 `packages/core/src/tool.ts` 统一注册与执行;MCode 的工具集中在 `src/server/tool/`,由 `src/server/tool/registry.ts` 固定顺序输出。

### 一致项

- **基础读写改齐全,参数语义基本同源。** `read`:opencode `tool/plugin/read.ts:20-29`(path/offset/limit,文件/目录/图片/PDF),MCode `tool/read.ts:316-325`(file_path/offset/limit,文件/目录/图片/PDF/音视频)。两者都逐行加 `N: ` 前缀、都支持 offset/limit 分页、都在读文件时顺带上溯发现 `AGENTS.md`(opencode `read.ts:131-156`,MCode `read.ts:120-163` 且还认 `CLAUDE.md`/`CONTEXT.md`)。
- **write / edit / patch 三件套。** opencode `tool/plugin/write.ts:17-22`、`edit.ts:23-33`、`patch.ts:23-27`;MCode `tool/edit.ts:642-649`(write)、`edit.ts:739-748`(edit)、`tool/patch.ts:63-68`(patchText)。两边都按模型族切换:opencode 在 `patch.ts:292-305` 的 session hook 里对 `gpt-*`(排除 gpt-4/oss)拿掉 edit/write 换上 patch,MCode 在 `registry.ts:115-124` 的 `usesPatch`/`forModel` 做同一件事。
- **glob / grep 走同一条 ripgrep。** opencode `tool/plugin/glob.ts:19-30`、`grep.ts:18-39` 的参数与 `Ripgrep` 服务;MCode `tool/search.ts:127-172`(glob)、`search.ts:197-259`(grep),同样使用随应用附带的 ripgrep,并有 JS 回退实现(`tool/search-fallback.ts`)。输出都按文件分组、限制 100 条并明确告知被截断。
- **question 几乎逐字同源。** opencode `tool/plugin/question.ts:12-25`(questions[] 含 header/question/options/multiple,自动追加"自己输入"行);MCode `tool/question.ts:246-338` 的说明与 schema 是从参考实现抄下来的,连"不要自己加 Other 选项"的提示都在。
- **skill 都已实现。** opencode `tool/plugin/skill.ts:12-24`(id → 载入指令+文件);MCode `tool/skill.ts:74-107`(name),且额外有 `skill_search`(`skill.ts:195-229`,BM25 + 自动载入)。
- **子智能体、webfetch/websearch 都存在且参数接近。** opencode `subagent.ts:29-43`、`webfetch.ts:24-32`;MCode `tool/subagent.ts:130-185`(actor)、`tool/webfetch.ts:190-194`。webfetch 两边的 format(markdown/text/html)、timeout、重定向逐跳权限检查都做了(opencode `webfetch.ts:80-109`,MCode `webfetch.ts:231-283`)。
- **工具描述本身都写得足够长、带"何时不要用"的负向指导。** 典型如 MCode `read.ts:298-314`、`edit.ts:720-737`、`bash.ts:467-496`;opencode `edit.ts:271`、`read.ts:51`、`shell.ts:39-50`。这一项没有明显短板。
- **工具输出上限一致。** opencode `tool-output.ts:13-14`(2,000 行 / 50 KiB,全文落盘 7 天);MCode `tool/truncate.ts:19-20`(同值,全文落盘 7 天)。

### MCode 缺失

- **没有独立的 `todowrite`。** opencode `tool/plugin/todo.ts:12-29` + `tool/todowrite.txt`:整表替换、四种状态、摘要回执。MCode 用 MiMo 的 `task` 工具(`tool/task.ts:183-251`)代替:create/list/get/start/block/unblock/done/abandon/rename/plan,T1/T2.1 层级、跨重启保留、`plan` 一次提交整份计划。**这是超集,不是缺口**,但对只被训练过 `todowrite` 的模型是一处 schema 迁移摩擦(模型容易照 todowrite 的 `todos[]` 写法调用,然后被 `operation` 形状拒绝)。
- **没有 `models` 工具。** opencode `tool/plugin/opencode.ts:44-92` 让模型按 query/provider/type 分页查模型目录,subagent 描述里明确要求"用 models 工具查,不要猜 ID"。MCode 只有 `actor` 的 `models` action(`tool/subagent.ts:104`、`216`),粒度是"能跑子智能体的模型",不能查价格/上下文/变体。
- **没有 CodeMode 的默认覆盖。** opencode 在 `tool.ts` 里 `codemode` 默认 true:核心文件工具仍走原生调用(`read`/`grep`/`glob`/`edit`/`write`/`shell` 都显式 `codemode:false`,见各 `tool/plugin/*.ts` 的 `options`),但 **MCP 工具、`opencode.*` 命名空间、artifact、schedule、mcp-resource 默认折进 `execute`**,模型可写一段 JS 串行/并发调用(说明见 `codemode/instructions.ts:11-26`)。MCode 的 CodeMode 只在 MCP 层、按服务器开关(`src/server/mcp.ts:1728`、`1786-1790`),默认关闭;内置工具两边一样不可编排。
- **没有 worktree 工具。** opencode `tool/plugin/opencode.ts:180-260` 的 `worktree_create/list/remove`、`session_move`。MCode 有 `src/server/session/worktree.ts` 与会话侧 worktree,但没有暴露成模型工具。
- **没有 `list` 工具。** 两边都用 read 读目录代替(opencode `read.ts:337-348`,MCode `read.ts:353-373`),不算缺口。
- **没有 memory / lsp 工具的对应物**(这是反向缺口,见下节)。

### MCode 差异但不吃亏

- **MCode 多出一整套 opencode 没有的编程辅助工具,且都带明确的 permission 桶:** `lsp`(`tool/lsp.ts:18-89`,diagnostics/definition/references/hover,`permission: "read"`)、`memory`(`tool/memory.ts:14-73`)、`history`(`tool/history.ts`)、`notebook_edit`(`tool/notebook.ts`)、`fanout`(`tool/fanout.ts`)、`verify_page`、`app`、`present_files/pdf_locate`、`plan_exit`、`speak`、session-chat 系列。opencode 上游 core 里 **没有 LSP 运行时**(`edit.ts:251-254` 与 `write.ts:27-30` 仍是 "TODO: Add LSP notification and diagnostics after LSP runtime exists"),也没有 memory 工具,`grep -rln lsp packages/core/src` 只命中注释与 models.dev 快照。
- **MCode 的基础工具走"工具自问权限"契约。** `ToolDefinition.permission`(`tool/types.ts`)声明桶,runner 在 `permission.ts:550-597` 统一 `check()`;opencode 则由每个 leaf 自己 `permission.assert`(`tool/AGENTS.md` 明确"registry 不做执行授权")。设计取向不同,不是能力差。
- **MCode 的 patch 是 JSON 参数,opencode 是 freeform lark 语法。** opencode `patch.ts:68` 用 `freeform: { type: "lark", grammar: GRAMMAR }` + `tool/patch-grammar.txt`,模型直接吐原始 patch,不用 JSON 转义;MCode `tool/patch.ts:63-68` 要求 `{"patchText": "..."}`。对长补丁,opencode 少一层转义风险;但 MCode 的差别只在长 patch 上才显形,且 GPT 模型两边的 patch 语法本身是一致的。
- **MCode 的 bash 参数多两个语义位。** `interactive`(`bash.ts:513-517`,声明交互式命令直接拒绝并给替代方案,而不是等 120s 超时)、`max_output_tokens`(`bash.ts:508-511`,按 token 预算裁中间而不是尾部)。opencode 的 shell 用 `background` + 作业通知(`shell.ts:29-30`、`61-64`、`135-167`),MCode 没有 background 作业模型,但 `bash.ts:41-58` 用 `EXIT_DRAIN_MS`/窗口探测解决"命令后台留管道"问题。
- **MCode 的 read 会按模型能力降级媒体。** `read.ts:194-232`:模型不能看图/PDF/音频时,回一条"如何换模型或走 skill/ffmpeg"的可执行提示;opencode 在 `model-request.ts:145-173` 把不支持媒体替换成一句 ERROR 文本。两者都避免硬失败,但 MCode 的下一步更具体。

### 明确弱于 opencode

1. **没有 `todowrite` 语义的最小面:** 对只在 todowrite 上训练过的模型,MCode 的 `task` 需要一次 schema 学习;`task` 的 `plan` 虽有"一次提交整份计划",但 `list` 默认隐藏终态、默认只列非归档(`task.ts:74-85`、`38-50`),模型看不到"已完成"的全貌,容易重复创建任务。**后果:** 长任务的计划维护多一次往返,或在计划里重复条目。
2. **没有 `models` 工具 = 子智能体选模型只能靠猜。** opencode 的 subagent 描述直接要求"不要猜 ID,用 models 工具查"(`subagent.ts:36-39`),MCode 的 `actor` 只给了 `models` action 的列举能力(`subagent.ts:104`、`216`),但描述里没有把"先查再传"写成硬规则,且返回的是精简列表而非带 variant/价格的目录。**后果:** 用户说"用 opus 跑这个子任务"时,模型更容易传错 `provider/model` 被 `control.run` 拒绝,浪费一步。
3. **MCP/扩展工具默认不进 CodeMode。** opencode 默认把 MCP、`opencode.*`、artifact 折进 `execute`,模型可在一个脚本里"并发查 5 个 MCP 资源 → 汇总";MCode 需要用户逐服务器打开 codemode(`src/server/mcp.ts:1728`),默认每个 MCP 调用都是一次独立往返。**后果:** MCP 重的项目(数据库、issue tracker、云 API)里,MCode 的步数与延迟更高;纯文件编程影响不大。
4. **没有 worktree 工具。** opencode 能在会话内创建/列出/删除 worktree 并把会话移进去(`opencode.ts:180-260`,带 `authorizeExternal`)。MCode 只能靠 bash 手敲 `git worktree`,没有任何路径/权限校验与目录切换语义。**后果:** 并行开发/隔离实验场景下,MCode 的模型更容易在错误目录里改文件。

## 2. 智能体循环(步进 / 中止 / steering / 重试 / 续写 / 循环检测)

opencode 的循环被拆成"调度层 + 单步层":`packages/core/src/session/runner/llm.ts` 的 `drain()`(63-225)负责边界与输入投递,`runStep()`(237-387)负责一步的策略;`runner/step.ts` 的 `attempt()`(77-333)负责一次真实请求 + 工具执行。MCode 是单个巨型方法:`src/server/session/runner.ts` 的 `run()`(2863-3603),主循环在 `3019`,单步流在 `3632` 的 `stream()`,工具执行在 `3969` 的 `runTool()`。

### 一致项

- **都是一步一次显式 LLM 调用、从磁盘重读历史后再构建请求。** opencode `llm.ts:196-224` 每次 `advanceToStep()` 后 `runStep`;MCode `runner.ts:3056`(`store.messages`)→ `3078`(`prunedHistory`)→ `3093`(`forWire`)。
- **都有中止(Stop)且都能落在工具执行中间。** opencode `step.ts:106-117` 的 `stopTools`/`cancel.trigger()` 协作停止 + 5s 宽限(`COOPERATIVE_STOP`)再强杀;MCode 用 `AbortSignal` 贯穿 `runTool`(`runner.ts:4158`),`bash.ts` 在 abort 时 `killTree`(`kill-tree.ts`),权限问题由 `permission.ts:662-669` 的 `rejectAll` 一并拒绝。
- **默认都是"steering":运行中的新消息并入当前回合,而不是排队。** opencode `AGENTS.md`「Prompts steer by default」、`session/inbox.ts` 的 `delivery`/`promote`;MCode `runner.ts:1786-1828`(未指定 `delivery` 时 `join()`,只有 `delivery:"queue"` 才 `enqueue`)。
- **都有"排队消息在回合结束后自动发出"的语义。** opencode `llm.ts:177-190`(idle 边界重新检查 inbox);MCode `runner.ts:2750-2756`(`sendQueued()`)与 `2843-2861`(失败回填队列)。
- **都有输出上限续写。** opencode `llm.ts:346-376`(`OutputLimit`,连续 3 条 assistant `finish=length` 就判 `output-limit` 失败);MCode `reminders.ts:197`(`CONTINUATION_LIMITS.length = 3`)与 `runner.ts:3498-3520`。
- **都有"step 上限"语义。** opencode `runner/max-steps.ts` + `llm.ts:261-282`(`toolChoice:"none"`,但保留工具定义以护住缓存);MCode `runner.ts:2958`(`stepLimitFor`)、`3022`(`lastStep`)、`3155-3176`(以 user 角色注入 `maxStepsPrompt`,而不是 assistant prefill——注释说明了 Anthropic prefill + thinking 会 400)。
- **都有按失败类型分级重试。** opencode `runner/retry.ts` + `core/model-retry.ts`:2s 起、10s 封顶、10 次;`retry-after` 上限 15 分钟;不可达网络单独预算 1 小时;超时尝试最多 3 次。MCode `session/retry.ts:26-59`:stream 5 次/10 分钟、server 8 次/15 分钟、rate_limit 5 次/35 分钟、network 无限、unknown 8 次;`request` 预算 4 次/30 秒。
- **都有断流/崩溃后的续跑。** opencode `step.ts:237-243` 的 `RecoverFull`(transport `retry-full` 且尚未出输出)+ `llm.ts:381-386`;MCode `runner.ts:2870-2872` 的 write-ahead `claim`、`resumeClaimed` 恢复、`RESTART_PROMPT`/`RESUME_PROMPT`(`3177-3189`)。
- **工具调用并发执行。** opencode `step.ts:145-159` 每个 tool call 一个 fiber,按来源顺序发布;MCode `runner.ts:3572-3577` `Semaphore(STEP_TOOL_LIMIT)` 限流后 `Promise.all`。

### MCode 缺失

- **没有 `RecoverFull` 意义上的"整步重来一次"。** opencode 在 provider 明确说 `recovery: "retry-full"` 且尚未产出任何输出时,把这一步整体重放(`step.ts:237-243`),连 reasoning 元数据都能保住;MCode 的重试只在 `stream()` 内部按请求重发(`runner.ts:3851`、`3875`、`3901`),不重新 `prepare` 上下文,模型/指令在这期间发生变化时不会重新解析。
- **没有 provider 侧的 WebSocket 传输。** opencode `session/model-transport.ts` 支持 `webSocket: "session"`、连接复用/轮换/污染降级、idle-timeout、请求过大回退 HTTP。MCode 只有 SSE(`provider/sse.ts`),靠 `provider/stall.ts` 的 480s chunk / 300s 头超时兜底。
- **没有"后台作业"模型。** opencode `Job.Service`(`job.ts`)+ `shell.ts:135-167` 的 `notify`:后台命令结束会以 synthetic 消息回到会话,回合可以结束再被唤醒。MCode 的 bash 没有 background 参数(`bash.ts:503-522`),长命令只能占用回合或靠超时。

### MCode 差异但不吃亏

- **MCode 的续写分类更细。** `reminders.ts:197` 区分 length(3)/textTool(2)/empty(2)/interrupted(5),`continuationFor`(`274-330`)还处理"只被截断的思考"(`provider/history.ts:39-43` 的 `thoughtDigest`)、"工具调用被写成散文"(`session/text-tool-parse.ts`)、"只说不做"(`announcedOnly`)。opencode 只有 length 续写(`llm.ts:346-376`),`recoverContinuation` 只针对 transport。
- **MCode 的 step 上限处理更防"本地服务不听话"。** `runner.ts:3023-3032` 除了 `toolChoice:"none"`,还在 `step > limit` 时硬 break,并记录注释说明某些 OpenAI-compatible shim 根本无视 `tool_choice`,正是这处导致过"计费到用户按 Stop";同时 `3229-3230` 对本地模型**不**发 `toolChoice:none`,避免 chat template 重排导致缓存全失。opencode 只发 `toolChoice:"none"`(`llm.ts:280`)。
- **MCode 的 steered 消息有专门的"回合"语义。** `runner.ts:1042-1086`、`3056-3058`、`openSteeredTurn`:一条 steer 到达时在磁盘上开一个新 turn,undo/redo 才能只回滚被 steer 之后的部分。opencode 的 inbox 也有 durable admission,但撤销语义只到 session revert(`session/revert.ts`),没有按 steer 切 turn。
- **MCode 有 `goalGate`(追求目标)。** `runner.ts:3537-3545` 在回合本该结束时让一个 judge 读记录,判定目标未达成则续跑(有 `MAX_GOAL_REACT` 上限)。opencode 没有对应的"目标判定"环节。

### 明确弱于 opencode

1. **没有循环检测的实现。** 这是最大的差距。在整个 `packages/core/src` 里检索 `repeat|loop|stuck|ngram` 只命中注释、`run-coordinator` 的调度循环与 `packages/ai/src/loop.ts` 的"待执行调用"工具;`doom_loop` 只作为 `packages/core/src/v1/config/permission.ts:27` 的遗留配置键存在,core 里没有读取它的代码——opencode **不检测**模型重复同样的工具调用、重复同样的编辑、反复重跑同一条失败命令、连续四个只读动作、或整段文字复读。MCode 有完整的四类探测器:`session/loop-health.ts:17-47`(重复编辑的 3-gram Jaccard 相似度 `EDIT_WINDOW=12`/`EDIT_SIMILARITY=0.8`、同类动作连续 4 次 `ACTION_STREAK=4`、同一命令失败 3 次 `BASH_RETRIES=3`、`WanderWatch` 只看不改)、`reminders.ts:106-115` 的 n-gram 复读(`NGRAM_BLOCK=4`/`REPEAT_THRESHOLD=20`/`WINDOW_TOKENS=500`,两次提醒后 `text_loop` 结束回合)、`runner.ts:3390-3410` 的流中切断、`3428` 的 `cropStreak`(把重复区间直接从请求里裁掉)。**对编程效果的具体后果:** 模型卡在"改一版、跑测试、还是错、再改回上一版"时,opencode 会一直烧 token 直到步数上限/用户 Stop;MCode 会主动提示并裁剪,并在两次无效后结束回合。这直接影响长任务的成本、成功率与"能否自己跳出死循环"。
2. **没有"整步重放"和 WebSocket 传输。** 一次传输层失败(长思考期间连接被中间设备掐断)在 MCode 里只能按 chunk/header 超时判定后重发请求;opencode 的 websocket 会话复用与 `retry-full` 能保住已产出的 reasoning 元数据。**后果:** 长上下文/长思考场景下 MCode 更容易"重来一遍并且把之前的思考丢掉",对需要长链推理的重构任务影响明显。
3. **单文件巨型方法使行为难验证。** `runner.ts` 5,440 行、`run()` 从 2863 到 3603 约 740 行、`launch()` 从 2697 到 2758 又承担收尾/续跑/排队三件事;opencode 把"边界调度(`llm.ts`) / 单步策略(`llm.ts:237`) / 单步执行(`step.ts`) / 重试(`retry.ts`) / 上限(`max-steps.ts`)"分成了五个文件。**后果:** MCode 这里任何新行为都只能靠 `session-check` 端到端覆盖,steering/压缩/中止交错时的回归风险高于 opencode。
4. **后台命令缺失。** opencode 的 `background` 参数 + 完成通知让"启动 dev server 然后继续干活"成为一步;MCode 只能让回合挂着等(或超时),模型在等待期间无法做别的工具调用。**后果:** 前端/服务端联调类任务,MCode 的有效并行度更低,回合更长。

## 3. 编辑工具匹配策略(精确匹配 / 模糊容错 / 失败反馈)

opencode:`packages/core/src/tool/plugin/edit.ts`。MCode:`src/server/tool/edit.ts`。两边都把"模型引用的文本来自 read 的带行号输出"写进了工具描述(opencode `edit.ts:271`,MCode `edit.ts:726-731`)。

### 一致项

- **都先做逐字节精确匹配,并要求唯一。** opencode `findOccurrences`(`edit.ts:52-60`)+ `replaceAll !== true` 时多命中即失败(`331-335`);MCode `replaceIn` 先 `indexOf`(`edit.ts:453-465`),`replace_all` 未设时多命中即失败并列出命中行号。
- **都有 unicode 归一化层。** opencode `normalizeForMatch`(弯引号、破折号、不间断空格,`edit.ts:45-50`);MCode `normalizeUnicodeLine`(`edit.ts:219-226`,还多处理省略号)。
- **都有"行尾空白"容错层。** opencode `findLineOccurrences`(`edit.ts:62-98`);MCode 的 `trailing-whitespace` 层(`edit.ts:278-291`)。
- **都处理 CRLF/LF 而不破坏文件。** opencode 在 LF 视图上匹配再把偏移映射回原文,并按最长公共子序列复用原区块的换行(`matchView` `164-184`、`withRegionEndings` `114-158`);MCode 用 `endingOf`/`replaceIn` 把引文换成文件自身换行,`mixedEndings` 时禁用模糊层(`edit.ts:170-178`、`472-475`),`applyLineMatches` 保留原换行(`371-386`)。
- **replaceAll 都存在且语义一致**(opencode `edit.ts:29-32`,MCode `edit.ts:745`)。
- **失败时都给出可执行的下一步。** opencode `332-334`(多命中 → "加更多上下文或 replaceAll")、`327-329`(未命中 → 精确匹配要求 + hint);MCode `433-439`(模糊多命中 → 列出候选块前 3 行)、`508-516`(未命中 → 编号的最近文本)。
- **都做同文件串行化。** opencode `fileMutation.withLock`(`edit.ts:351`);MCode `locked()`(`edit.ts:29-42`)。

### MCode 缺失

- **没有"这次编辑可能已经应用过"的识别。** opencode 的 `missHint` 第一条就是:若 `newString` 已在文件中(≥20 字符,归一化后),回 "newString is already in the file, so this edit may already be applied."(`edit.ts:195-199`)。MCode 的 `closestMatch` 七个匹配器(`edit.ts:161-168`)**只比较 old_string**,不比较 new_string,模型在"重试一次已成功的编辑"时只会拿到 old_string 的近似文本,于是常常改成"把已经改过的地方再改一遍"或放弃。**后果:** 重试/断线续跑后,重复编辑浪费一步甚至改坏文件。
- **没有"oldString 为空必须用 write"的硬约束。** opencode 直接拒绝空 oldString 并指路 write(`edit.ts:281-285`);MCode 把空 oldString 当作"写整个文件"(`edit.ts:776-820`)。这是有意为之(对齐 MiMo),但对从 opencode 迁移的模型,`edit("", ...)` 在 MCode 会**覆盖整个文件**而不是报错——一旦模型本意是追加,会丢内容。

### MCode 差异但不吃亏

- **MCode 的模糊层更多(5 层 vs opencode 3 层)。** `trailing-whitespace` → `trim` → `unicode` → `normalize` → `indentation`(`edit.ts:477-505`),`trim`/`normalize` 层会先排除"只是缩进不同"的命中,避免与 `indentation` 层重复计数(`295`、`327`);`indentation` 层在替换时会把 `new_string` 按原块缩进重排(`352-369`)。opencode 只有 exact → unicode → trailing-whitespace(`edit.ts:172-175`),**没有缩进容错**。对"模型引用了一段缩进错位的代码"的场景,MCode 成功率更高。
- **MCode 有"先读过再改"和"改前未变"两道闸。** `read-tracker`(`tool/read-tracker.ts`)记录每会话读过的路径 + mtime/size/sha256,`edit.ts:660-668`/`779-786`/`827-834` 拒绝未读或已被外部改动的文件,`unchangedSince`(`edit.ts:557-568`)在拿到用户批准后、落盘前再校验一次。opencode 不做这两件事,依赖精确匹配失败来兜底。**对编程效果:** MCode 更不容易把用户/格式化器/另一个工具的改动覆盖掉;代价是模型从记忆里写信手开文件时会多一步(而 `edit-recover.ts` 会在同一条错误里把当前内容贴回来并计为已读,把这一步的代价压到最小)。
- **MCode 编辑后接一串真实检查。** `post-edit-check.ts`(项目自身的 tsc/lint/test 记忆)、`lspDiagnostics`(`lsp/index.ts`)、`verify-loop.ts`、`test-memory.ts` 的重跑,都会拼进工具结果;opencode 只在 `fileWrite.commit` 后跑 `Formatter`(`edit.ts:343-345`),没有诊断回灌。**这是 MCode 的明确优势**,对"改完即知对错"影响很大。
- **opencode 的换行处理更精确。** 混合换行文件里,opencode 用 LCS 只改动真正变化的行(`edit.ts:108-158`);MCode 在混合换行时直接放弃模糊层、走精确匹配。**结论:** opencode 在"混合换行 + 模糊引文"这一交叉场景更强;MCode 在"纯 CRLF/LF + 模糊引文"更强。
- **失败提示的窗口不同。** opencode 的 `missHint` 给"最近的 12 行、带行号、每行最多 200 字符"(`edit.ts:186-237`);MCode 的 `numberedHint` 给 `closestMatch` 命中的整段,上限 2,000 字符(`edit.ts:423-431`、`510`)。opencode 更省 token,MCode 的窗口更大、有时一次就能看到足够上下文。

### 明确弱于 opencode

1. **重复编辑/已应用编辑的恢复能力弱。** 缺 `newString` 已存在的检测(见上)。**后果:** 长任务中断后重试、或模型自信地"再改一次"时,MCode 会退化成"未找到"错误 + old_string 近似文本,模型往往选择重读文件再猜,平均多 1-2 步。
2. **没有 `patch` 的 freeform 输入。** opencode `patch.ts:68` 用 lark 语法让模型直接写补丁;MCode `tool/patch.ts:63-68` 要求 JSON 包裹 `patchText`。**后果:** 大补丁的 JSON 转义错误率更高,且模型必须在一次调用里正确输出一个巨大的 JSON 字符串。
3. **空 oldString 走全量覆盖而不是报错。** MCode 的分支(`edit.ts:776-820`)仍会做未读/过期检查、算 diff、走 `permissions.ask`(`edit.ts:763-774`),所以不是"静默"覆盖;但它是**一次成功的写**,而 opencode 会让这次调用失败并指路 `write`(`edit.ts:281-285`)。**后果:** 对把 `edit` 当 `write` 用的模型,MCode 会照做并让用户看一个"整文件替换"的 diff;用户若习惯性批准,就丢掉了"这是一次异常调用"的信号。

## 4. 上下文管理(压缩 / 裁剪 / prompt cache 保护)

opencode 的压缩全在 `packages/core/src/session/compaction.ts`(1,274 行),由 `runner/llm.ts:253-260`(每步前试自动压缩)、`step.ts:198-209`(provider 报太长时压缩重试)、`llm.ts:129-176`(手动压缩)三处驱动。MCode 的压缩在 `session/summary.ts`(456 行)+ `session/runner.ts` 的 `compactIfCrossed`/`compactForOverflow`/内联溢出处,裁剪在 `session/prune.ts` + `tool/truncate.ts`。

### 一致项

- **压缩模板与"滚动压缩"同源。** 两边都用同一份 `## Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important Context` 模板与同一套 rules(`compaction.ts:173-247` vs `summary.ts:33-72`);都保留最近一段原文(`<recent-context>`),只总结更早的(`splitConversation` MCode `summary.ts:319-361`;opencode `session/recent-text.ts` + `history.ts:241-280` 以 `metadata.keepID` 引用重建)。
- **都有"总结请求过大就逐级缩"的阶梯。** opencode `SHRINK_STEPS=[0.85,0.7,0.5,0.35]`、`TRANSCRIPT_LEVELS`(裁输出 → 去输出 → 只留用户 → 全省)、`UNKNOWN_WINDOW=200k`(`compaction.ts:127-171`);MCode `SHRINK_STEPS=[0.7,0.5,0.35]`、`flattenOldest`(去推理/媒体、裁长结果、按交换丢弃)、`UNKNOWN_WINDOW=200k`(`summary.ts:416-456`)。
- **都区分"按 token 数触发"与"provider 报溢出再压缩"。** opencode `estimatePrompt` + `compact({reason:"auto"})`,溢出走 `isContextOverflowFailure`(`step.ts:200`);MCode `isOverflowByCount`(90% 可用窗口,`overflow.ts:152-159`)+ `isOverflowError`(含 413、`context_length_exceeded`、以及一长串厂商措辞,`overflow.ts:180-255`)。
- **都用"保留工具定义"的方式压最后一步,护住缓存。** opencode `llm.ts:279-280`(`toolChoice:"none"` 但工具定义仍在);MCode `runner.ts:3224-3230`(远端模型发 `toolChoice:"none"`,本地模型只靠指令、不发 `none` 以免 chat template 重排)。
- **压缩边界都会告知模型"刚压缩过,别重复"。** opencode 的 checkpoint 包装文本(`to-llm-message.ts:298-309`);MCode `summary.ts:364-371` 的 `continueNote`(overflow 时还提醒附件被丢下)。
- **都有 prompt cache key / 亲和性。** opencode `model-request.ts:330-338` 的 `promptCacheKey` + `x-session-affinity`/`X-Session-Id` 一整套头,加上 `packages/ai/src/cache-policy.ts` 的自动断点策略(最后一个工具、首尾 system、消息尾,4 个断点预算);MCode 在 `provider/anthropic.ts:289-323` 手动打 `cache_control`(最后工具 + system + 会话尾,支持 `ttl:"1h"`),在 `provider/sampling.ts:151` 与 `provider/chatgpt.ts:280` 对 openai/xai/openrouter/chatgpt 发 `prompt_cache_key`。
- **工具输出上限一致**(50 KiB / 2,000 行,全文落盘 7 天):opencode `tool-output.ts:13-16`,MCode `truncate.ts:19-20`、`62`。

### MCode 缺失

- **没有后台预压缩(precompute)。** opencode 在回合将尽时就在后台生成摘要,并**持有**它等真正到期才换入——换入会重写前缀、丢掉缓存,所以不能在未到期时提前用(`compaction.ts:344-393`,还按 `cache.ttl` 与 `PRECOMPUTE_LEAD=60s`/`CACHE_MARGIN=30s` 决定何时启动)。MCode 只在压缩被触发的那一刻同步做(`runner.ts:2933`、`1535`),压缩本身是一个阻塞的模型往返。**后果:** 长任务的"压缩停顿"更明显,且压缩请求与正常请求不能共享同一份缓存前缀。
- **没有 provider 原生压缩(native compaction)。** opencode 支持 provider 侧压缩窗口并把 `native.messages` 存下来,**只有产出它的模型能重放**(`history.ts:34-53`,跨模型时回退到本地摘要)。MCode 的 `CompactionTrigger` 只有 `manual | automatic | provider-overflow`(`summary.ts:19`),没有"让 provider 自己压"的路径。
- **压缩用的模型不能单独指定。** opencode 通过 `compaction` agent 解析模型,可在模型不支持原生压缩时另选一个模型(`compaction.ts:278-300`);MCode 固定用当前会话模型(`runner.ts:1535-1573`)。
- **没有 `InstructionState` 级别的指令增量。** opencode 把 AGENTS.md/技能等指令做成带 hash 的"指令源",变更时以增量消息注入而不是重写 system 前缀(`session/instruction-state.ts`、`context.ts:159-176`)。MCode 的 `systemFor` 虽然也冻结前缀并 `syncInstructions`(`runner.ts:1464-1510`),但增量机制在 `session/` 里没有 opencode 那么完整(没有 per-source hash、没有 epoch/baseline 的严格合并规则)。

### MCode 差异但不吃亏

- **MCode 有回合内裁剪(opencode 完全没有)。** `session/prune.ts` 在回合开始时决定一次裁剪级别(`runner.ts:2943-2944`),仅在缓存已冷时执行(`isCacheCold`,5m/1h TTL),软裁 4,096 字符以上的旧工具输出(保留头尾各 1,536),2 级时直接清除可回收 >20k 的旧结果并剥掉旧推理/媒体,`PRUNE_PROTECT=40k` 保护最新输出。opencode 只在压缩时处理,回合内旧输出一直全量重发。**对编程效果:** 同一任务 MCode 更晚触发压缩(也就是更少丢上下文)、每步 token 更省;opencode 的单步请求会持续膨胀到压缩线。
- **MCode 的截断更"懂失败"。** `truncate.ts:137-150`:输出尾部 2KB 若像失败(error/failed/exception/traceback/panic/exit code),保留 70% 头 + 30% 尾,错误行不会被切掉;opencode `tool-output.ts:95-137` 只保留开头,溢出部分落盘。**对编程效果:** 一次失败构建的末尾错误信息是模型下一步最需要的东西,MCode 直接给到,opencode 要模型再去读落盘文件。
- **MCode 在接近压缩线时缩小工具输出。** `truncate.ts:31-43` 的 `pressureCaps`(≥70% 可用窗口时行/字节减半),opencode 没有这种"压力态"。
- **MCode 的单步压缩有防"压了也没用"的保护。** `runner.ts:3006-3018` 的 `futile()`:若上一个 step 刚压缩过又溢出,直接以 `error.contextTooSmall` 结束并报告"模型窗口太小 / MCode 固定开销约 X token",而不是无限压缩重问(注释记录了本地 Qwen 6 分钟被压 30 次的实测)。opencode 只有 `recoverOverflow` 一次(`llm.ts:319-325`)。
- **MCode 在压缩前先把过大的工具结果"瘦身"再发总结请求。** `summary.ts:166-180` 的 `shrinkLargeToolResults`(>8k token 的结果替换成一行说明),避免"最需要总结的请求恰好是最大的请求"。

### 明确弱于 opencode

1. **没有缓存感知的后台预压缩。** 见上。**后果:** 每次跨过压缩线都要现场付一次"读全量历史 + 写摘要"的完整往返,且在摘要生成期间会话是停住的;对 20 万 token 级的长重构,这是分钟级停顿,而 opencode 可以把这段成本摊到"回合尾部"并复用缓存。
2. **压缩模型与被压缩模型绑死。** 用一个 32k 窗口的小模型开会话时,MCode 只能用同一个模型做摘要,摘要本身很容易再次溢出(虽有 `futile` 保护,但代价是直接报错结束);opencode 可以切到 compaction agent 指定的大模型。**后果:** 小窗口模型下 MCode 的"压缩成功率"更低。
3. **没有指令源的增量与 baseline/epoch 语义。** MCode 在前缀里冻结 system,这是对的;AGENTS.md 在会话中途被改时,MCode 会经 `instructionValues`(`session/prompt.ts:89-140`)→ `instructionUpdate`(`prompt.ts:142-168`,只分 standing/project/skills 三类,不是逐文件 hash)→ `syncInstructions`(`runner.ts:2605-2623`)把整类新文本作为 `reminder` 挂到**最后一条用户消息**上。opencode 的 `InstructionState` 是逐源 hash、把更新作为 durable 事件发布,并在 `history.ts:224-238` 按 compaction epoch 过滤。**后果:** 用户在会话中途改 AGENTS.md 时,MCode 的更新依赖"最后一条用户消息还在",一旦这条消息被撤销/压缩掉,更新就丢了;而"project"类整体重贴也会让模型收到与 system 前缀重复的一段。
4. **回合内裁剪依赖"缓存已冷"的假设,跨 provider 不稳。** MCode 的 `isCacheCold` 只看本地上次 assistant 完成时间与模型声明的 TTL(`prune.ts:61-64`);对于不声明 TTL、却实际有隐式缓存的网关(OpenAI-compatible 代理、部分中转),裁剪会**悄悄破坏**它们的前缀缓存而没有收益。opencode 的 cache-policy 是按协议声明"是否尊重内联断点"(`cache-policy.ts:56-70`),判断更保守。**后果:** 在第三方网关下,MCode 的成本可能反而上升。

## 5. 权限模型(档位 / 工具自问契约 / 危险命令处理)

opencode:`packages/core/src/permission.ts`(388 行)+ `packages/schema/src/permission.ts`(规则是 `{action, resource, effect}` 的通配规则集)+ `permission/saved.ts`。MCode:`src/server/permission.ts`(821 行)+ `src/shared/access.ts` + `src/shared/protocol.ts`(9 个固定桶 + 三档访问级别)。

### 一致项

- **都是"deny 优先,其次 ask/allow",并且都能被"always"持久化。** opencode `permission.ts:176-189`(先 `denied()` 再逐资源求值)、`savedRules()`(`159-167`,按 projectID 存);MCode `permission.ts:429-468`(Deny 优先)、`remember()`/`allowedByRules()`(按项目/会话写入)。
- **都会向用户展示确切命令或 diff。** opencode `Request.metadata`(`schema/permission.ts:38-44`)由各工具填入 `diff`/`command`;MCode `permission.ask({ preview })`,`edit.ts:672-682` 传 `unifiedDiff`,`bash.ts:579-590` 传命令。
- **被拒绝时都告诉模型"别再重发"。** opencode `CorrectedError`(带用户反馈时)→ 该 leaf 转成 `ToolFailure`,模型继续(`tool/AGENTS.md` 的 Permissions 段);MCode `userRefusal()`(`permission.ts:38-43`)明写"Do not make the same call again ... carry on another way"。
- **中止时都会清空挂起请求。** opencode `permission.ts:144-156` 的 `close()` 逐个 `DeclinedError`;MCode `permission.ts:662-669` 的 `rejectAll()`。
- **都有"无人值守时不能问"的处理。** opencode `Unattended` 规则(`permission.ts:60-65`、`199-209`):没人时只允许规则里 allow 的,其余直接 deny 并说明;MCode 后台子智能体的 `backgroundRefusal`(`permission.ts:130`)。
- **都在项目外路径上单独提问。** opencode `file-access.ts:120-158` 的 `authorizeExternal` + `authorizeRead`;MCode `fs-util.ts:167` 的 `resolvePath` + `guardAppData` + `resolveInsideReal`(realpath 校验符号链接落点,`fs-util.ts:85-130`)。

### MCode 缺失

- **没有通配的 `{action, resource, effect}` 规则集。** opencode 的策略是任意 `action` × 任意 `resource` 的通配匹配(`permission.ts:94-108`、`Wildcard.match`),因此可以表达"允许 `read` 落在 `docs/**`,其余读要问"、"允许 `webfetch` 访问 `https://example.com/*`"、"允许 `bash` 前缀 `git status*`,但 `git push*` 要问"。MCode 只有 9 个固定桶(read/edit/glob/grep/list/bash/webfetch/outside/mcp,`protocol.ts:1218-1228`)× 3 个动作,外加 bash 的"命令前缀"与 `.env` 的特例(`permission.ts` 的 `readAsks`/`patterns`)。**对编程效果的具体后果:** 用户要么把 `bash` 设成 allow(过宽,危险命令只能靠 `bash-scan` 兜底),要么被"每一条 `npm test` 都问一次"磨到关掉权限;无法做到"这个项目的测试命令免问、发布命令必问"。
- **没有插件可介入的 `permission.evaluate` 钩子。** opencode 在 `evaluateInput` 里触发 `hooks.trigger("permission", "evaluate", ...)`(`permission.ts:190-198`),插件可以整体改判;MCode 的判定是纯内部函数。
- **"工具自问"仍是约定,不是强制。** MCode 的 `check()` 对 `SELF_ASKING_KINDS`(edit/bash/webfetch/outside/mcp,`protocol.ts:1275-1281`)只执行 Deny 然后 `return`(`permission.ts:573-578`),真正的提问靠工具自己调 `permissions.ask`。opencode 是同一个"leaf 自己问"的形状,但它的拒绝是**以 defect 隧道穿出**、在 `SessionModelRequest.executeTool` 处统一还原(`model-request.ts:441-462`),因此一个忘记处理拒绝的工具有兜底;MCode 里一个声明 `permission:"edit"` 却忘了 `ask()` 的新工具,在非 Deny 档位下会静默执行(DGX_REPORT 3.3 已指出)。**后果:** 新增工具是权限绕过的真实入口。

### MCode 差异但不吃亏

- **MCode 有三档访问级别(ask / auto / full)+ 模型审批。** `shared/access.ts:10-52` 定义档位并支持"会话自选";`permission.ts:64-77` 的 `autoAllows` 让 auto 档直接放行 edit/outside 和无危险命令的 bash;`permission.ts:79-110` 的 `CommandReviewer`(`REVIEW_TIMEOUT_MS=8s`、只认一个 `permission_verdict` 的 APPROVE、含 `looksSecret()` 拒绝把凭据发给审批模型)。opencode **没有档位概念**,只有规则集,因此没有"中间档 = 模型先审一遍"的能力。对编程效果:auto 档显著降低确认疲劳,同时比"全 allow"更安全。
- **MCode 有命令风险分类,并对"丢失工作"强制每次询问。** `command-risk.ts:18-46`(delete/elevate/kill/rights/system/publish/reset,`LOST_WORK = ["delete","reset"]`,还识别 `env rm -rf`、`xargs rm` 这类包装器)、`permission.ts:429-455`(forced 询问、full 档除外、forced 永不记住 always)。opencode 的 `shell/parse.ts` 只负责把命令拆成 permission 资源(`parse.ts:17`、`170-245`),**不判断危险程度**;`rm -rf` 只要命中一条 allow 规则就直接跑。**后果:** 防"一次误操作毁掉未提交工作"这件事,MCode 明显更强。
- **MCode 的拒绝会让模型在同回合继续。** opencode 的普通 reject 以 `DeclinedError` 结束这一步(`step.ts:262-280`、`321-324`),靠"回合结束"阻止绕过;MCode 把拒绝写成工具错误、并明确指示改道(`runTool` 的 catch,`runner.ts:4224-4233`)。两种取向各有道理:opencode 更"硬",MCode 更"能继续干活"。**风险:** MCode 的模型可能连续尝试替代方案,把同一个拒绝问出三四次。
- **MCode 的 `.env` 读取会单独提问。** `readAsks()`/`namesAskingFile()`(`permission.ts` 中),`.env` 问、`.env.example` 不问,且 bash 命令行里出现 `.env` 也算。opencode 无此特例。

### 明确弱于 opencode

1. **策略表达力不足(详见"缺失")。** 这是权限维度最实质的差距。**后果:** 在真实项目里,用户面对"要么全放行、要么每条命令都问"的二选一;两个方向都对编程效果有损——全放行让 `bash-scan` 成为唯一防线,每条都问则打断模型的连续动作,长任务里用户会开始无脑点"允许"。
2. **没有统一执行边界的兜底。** 见上。**后果:** 任何新工具/插件工具只要忘了 `ask`,就是一个静默绕过;这类缺陷在测试里很难暴露(需要构造"新工具 + 非 Deny 档"的用例),而 opencode 在 `executeTool` 边界统一还原拒绝,结构上保证 leaf 吞不掉"no"。
3. **权限与模型审批的耦合只在 MCode 内部,外部无法复用。** opencode 的 `permission.evaluate` 钩子让插件/托管策略可以统一改判;MCode 的 auto 档审批是写死的 `CommandReviewer`(`permission.ts:79-110`),第三方无法替换策略。**后果:** 企业/团队场景下,无法实现"公司策略覆盖个人设置"这类需求。

## 6. provider 与模型处理(协议归一 / 模型目录 / 历史整形)

opencode 的协议层在 `packages/ai/src/`(`protocols/` 约 60 个文件、`providers/` 约 50 个 provider、`route/`、`cache-policy.ts`、`provider-error.ts`),由 `packages/core/src/model.ts`/`model-resolver.ts`/`models-dev.ts` 与 `session/model-request.ts`/`runner/to-llm-message.ts` 接起来。MCode 的适配层在 `src/server/provider/`:`adapter.ts` 按 kind 选四种 adapter(`anthropic`/`openai-compatible`/`chatgpt`/`openai-responses`),加 `sse.ts`(自写 SSE)、`stall.ts`、`history.ts`(历史整形)、`tool-schema.ts`、`sampling.ts`、`variants.ts`、`catalog.ts`/`discover.ts`/`models-dev.ts`。

### 一致项

- **都有统一内部事件流,adapter 只做出口归一。** opencode 的 `@opencode/ai` `LLMEvent`(text-delta/reasoning/tool-call/finish 等,见 `packages/ai/src/schema/` 与 `loop.ts`);MCode 的 `TurnEvent`(`provider/types.ts:236`,`text.delta`/`reasoning.delta`/`tool`/`reasoning.signature` 等),`adapter.ts:24` 穷举切 kind。
- **都覆盖 Anthropic Messages 与 OpenAI 的 chat / responses 两大族,并把它们归一到同一内部事件流。** opencode `openai-chat.ts`/`openai-responses.ts`/`anthropic-messages.ts` 等;MCode `anthropic.ts`/`openai.ts`/`chatgpt.ts`(Responses)/`openai-responses.ts`。两边都处理 SSE 的多行 data、注释、CR/LF、末尾无换行(MCode `sse.ts:1-153`,注释逐条记录偏差造成的故障)。
- **模型目录都以 models.dev 为基础并带快照+刷新。** opencode `models-dev.ts`(snapshot.txt + `kv` 缓存 + etag 拉取 + v1→v2 转换 + 逐条容错解码);MCode `provider/models-dev.ts`(shipped snapshot + 5 分钟新鲜窗 + 每小时刷新 + 原子写缓存 + 失败只记日志)。
- **都会为"无法识别的模型"做发现。** opencode `models-dev.ts:193-240` 跳过不认识的条目而不是整体失败;MCode `discover.ts` 从 `/v1/models` 发现,并额外读 LM Studio 原生端点补上下文长度。
- **都只在同一模型下回放推理签名。** opencode `to-llm-message.ts:181-205`(`sameModel` 才带 `providerMetadata`,跨模型只保留可读 reasoning 文本);MCode `anthropic.ts:84-98`(签名只回给签名它的模型)。
- **都有工具 schema 的家族修正。** MCode `tool-schema.ts`(Gemini 的 enum/required/items、Kimi 拒绝 `type` 与 anyOf 并存);opencode 在各 protocol/provider 里做等价处理。
- **都有 prompt cache 的 key/亲和性。** opencode `model-request.ts:330-338`;MCode `sampling.ts:151`(`prompt_cache_key` 给 openai/xai/openrouter)、`chatgpt.ts:280`。
- **都有"输出上限"随窗口收缩。** opencode `outputLimit()`(`model-request.ts:95-104`);MCode `fitOutput()`(`overflow.ts:85-90`)。

### MCode 缺失

- **协议与 provider 的覆盖面差一个数量级。** opencode 有 `gemini`、`google-vertex`、`bedrock-converse`、`alibaba-*`、`meta-*`、`xai-*`、`zai-*`、`mistral`、`cohere`、`azure`、`openrouter`、`vercel-ai-gateway` 等原生协议,以及 `providers/*` 里按 provider 的包/路由/认证/兼容层;MCode 只有 **4 种** kind。凡是"有自己一套 wire 语义"的 provider(Gemini 的 functionCall/thought signature、Bedrock 的 Converse、Vertex 的 toolConfig、Cohere 的 tool_plan),MCode 只能落到 OpenAI-compatible 近似上。
- **没有按 provider 的压缩原生能力(`Provider.Compaction`)。** opencode `session/runner/model.ts:67-76` 的 `Resolved` 携带 `compaction?: Provider.Compaction`、`transport?: Provider.Transport`,是 provider 级能力协商;MCode 的 `CompactionTrigger` 只有本地三种,provider 端没有"原生压缩/原生传输"这一层。
- **没有 provider 包/插件的动态加载。** opencode `model-resolver.ts` 有 `ProviderPackage`/`Npm`/`Integration`/`Credential` 一整套,可以按 provider 动态加载实现;MCode 的 provider 是编译期固定的 4 个 adapter + 目录里的内置清单。
- **没有按 provider 的 `providerMetadata` 统一回放。** opencode 把每个 provider 的 native 元数据(reasoning 加密块、Gemini thought signature、hosted tool 结果)统一挂在 `providerMetadata[providerMetadataKey]` 上,并规定"只有产出它的模型能回放 call-side 元数据"(`to-llm-message.ts:202-211`);MCode 只在 Anthropic adapter 里保存 `signature`(`anthropic.ts:88-98`),OpenAI 系(GPT-5 encrypted reasoning / `reasoning_content` 原样回放)与 Gemini 的签名没有统一通道。
- **没有媒体能力的系统化降级。** opencode `model-request.ts:145-173` 的 `unsupportedParts` 会按 `model.capabilities.input` 把不支持的图片/音频/PDF 替换成 `ERROR: Cannot read ...` 文本,并对 xAI 的图片 mime 有例外表;MCode 在 read 时按 `model.inputs` 拒绝(`read.ts:194-232`),但对历史里**已经存在的**附件,`provider/attachment-parts.ts` 只做压缩,没有按目标模型能力替换。

### MCode 差异但不吃亏

- **MCode 的工具调用 id 归一集中在一处。** `wire-ids.ts:1-59`:Claude 只接受 `[A-Za-z0-9_-]`、Mistral 只收前 9 位字母数字且不接受"工具结果紧跟用户消息",MCode 会为 Mistral 插一条短 assistant。opencode 在 `packages/ai/src/protocols/mistral-chat.ts:295`/`311` 有等价的 `normalizeID`,但分散在各 protocol 里;MCode 是请求前的一次性整形。
- **MCode 的 provider 目录有"按端点匹配 models.dev"的能力表。** `catalog.ts:136-300`、`706-709` 把内置 provider 的模型映射到 models.dev 记录(含 `over200K` 分段价格、`cacheTTL`、`interleaved` 字段),这些是 opencode 也会读的字段,但 MCode 把它们编码进自己的 `ModelEntry` 并在 UI 里用(`over200K` 成本计算等)。
- **MCode 的 reasoning 请求更"按模型分档"。** `anthropic.ts:171-283` 按 adaptive/Claude 4.6/Opus 4.5/Kimi 分别决定 `thinking` 与 `output_config.effort`;`variants.ts` 把参考实现的 per-model effort 列表逐条搬过来(含 GPT-5 Pro 只有 `high`、GPT-5 Codex 3+ 有 `none`)。这比"一个全局 effort 字段"精细。
- **MCode 有 `stall.ts` 的休眠恢复切断。** `provider/stall.ts`(480s chunk / 300s 头超时,系统休眠恢复时主动切断死流),opencode 的 websocket idle-timeout(`model-transport.ts:417-424`)覆盖的是另一类场景,两者互补。

### 明确弱于 opencode

1. **provider 覆盖面直接决定"能用什么模型编程"。** 用户在 Gemini / Vertex / Bedrock / Azure / Cohere / 企业网关下,MCode 只能走 OpenAI-compatible 近似:工具调用格式、reasoning/thinking、图片与 PDF 输入、finish reason 的归一都更差;遇到 provider 拒绝时的错误信息也更难被 `isOverflowError`/重试分类识别。**后果:** 非 OpenAI/Anthropic 系模型的编程成功率与稳定性明显低于 opencode。
2. **原生元数据回放缺失导致长链推理与模型切换退化。** GPT-5 的 encrypted reasoning、Gemini 的 thought signature 在 MCode 里没有保存/回放通道;一次"换模型继续"或"压缩后继续"就可能丢掉模型的推理链,严重时会被 provider 以"reasoning item 缺失/无效"拒绝。**后果:** 多模型协作(planner 用 A、coder 用 B)与长任务续跑时,MCode 更容易出现"模型忘了刚才怎么想的",而 opencode 的 `to-llm-message` 明确区分"call-side 元数据只给产出模型""hosted tool 结果同 provider 可回放"。
3. **没有 provider 级能力协商(compaction/transport)。** opencode 的 `Provider.Compaction`/`Provider.Transport` 让"某些 provider 支持原生压缩/WebSocket"成为数据;MCode 把这些写死在本地逻辑里。**后果:** 新 provider 的原生能力无法被利用,只能退化到通用路径。
4. **没有 `Unattended`/策略插件式的模型选择与默认模型兜底。** opencode 在 `model-resolver.ts` 与 `managed-policy.ts` 里能在模型不可用时给出结构化错误与替代提示(如 azure 弃用提示);MCode 只有 `error.noModel`(`runner.ts:1559`、`2079`、`2888`)与 `error-map.ts:80-98` 的 `modelTimeout`/`modelUnavailable` 一类编码错误。**后果:** 企业环境下"默认模型不可用"时,MCode 的提示对用户与模型的下一步都不够具体。

## 7. 按编程效果影响的差距清单(影响从大到小)

排序标准:这条差距在"真实编程任务(读代码 → 改代码 → 验证 → 继续)"里多久出现一次、出现时损失多少成功率/步数/成本。只列 **MCode 弱于 opencode、值得对齐** 的项;MCode 领先的项(循环检测、回合内裁剪、LSP 回灌、危险命令强制询问、失败尾部保留)不在此列。

1. **provider 协议覆盖面 + 原生元数据回放。(影响最大)**
   - 现状:opencode 有约 60 种协议、约 50 个 provider 与 provider 级 `compaction`/`transport` 能力(`packages/ai/src/protocols/`、`providers/`);MCode 只有 4 种 kind(`src/server/provider/adapter.ts:24`),推理原生元数据只在 Anthropic 里保存(`src/server/provider/anthropic.ts:88-98`)。
   - 后果:非 OpenAI/Anthropic 模型(尤其 Gemini/Vertex/Bedrock)工具调用与 thinking 退化;换模型或压缩后续跑容易丢推理链。
   - 改造:(a) 在 `src/shared/protocol.ts` 的 `AssistantPart` 上增加通用 `native?: Record<string, unknown>`,`src/server/provider/history.ts` 的 `forWire` 按"产出模型 == 目标模型"决定是否回放,对齐 `packages/core/src/session/runner/to-llm-message.ts:181-211`;(b) `src/server/provider/adapter.ts` 增加 `gemini` / `bedrock-converse` 两种 kind,先做只读工具与 thinking 的最小实现;(c) `src/server/provider/types.ts` 的 `AdapterRequest` 增加 `capabilities` 与 `transport` 字段,让 `src/server/session/runner.ts:3217-3267` 的调用按能力选择 WebSocket/HTTP。
   - 成本:高;收益:决定"非 Anthropic/OpenAI 用户能不能用 MCode 编程",优先级高于任何工具层改造。

2. **权限策略表达力 + 工具自问强制。(影响安全与自动化程度)**
   - 现状:MCode 是 9 个固定桶 × 3 档(`src/shared/protocol.ts:1218-1235`),没有 `{action, resource, effect}` 通配规则;`SELF_ASKING_KINDS` 只判 Deny 就返回(`src/server/permission.ts:573-578`),工具忘问即静默执行。
   - 后果:用户只能在"全放行"与"每条都问"之间选,长任务被确认打断;新增工具是权限绕过入口。
   - 改造:(a) 在 `src/shared/protocol.ts` 增加 `PermissionRule { action, resource, effect }` 与 `rules?: PermissionRule[]`,在 `src/server/permission.ts` 的 `action()` 之前按 `wildcardMatch`(`permission.ts:194`)逐条求值,优先级为"规则 > 桶 > 档位";(b) 在 `ToolDefinition`(`src/server/tool/types.ts`)加 `asksForItself?: boolean`,并在 `src/server/session/runner.ts:4135-4144` 的 `permissions.check()` 与 `tool.execute()` 之间记录"本次是否真的发起过 ask"(`Permissions` 增加一个 `asked(callID)` 计数),声明自问却未问则直接拒绝并记诊断。
   - 成本:中;收益:直接减少确认疲劳、堵住未来工具的绕过路径。

3. **缓存感知的后台预压缩 + 压缩模型可指定。(影响长任务是否"卡住")**
   - 现状:MCode 压缩是同步的、用当前模型(`src/server/session/runner.ts:1535-1573`、`2933`);opencode 会在回合尾部后台生成摘要并**持有**到真正到期,且可用 compaction agent 换模型(`packages/core/src/session/compaction.ts:344-393`、`278-300`)。
   - 后果:20 万 token 级重构每次跨线都要停一次完整往返;小窗口模型下摘要本身可能再溢出(只剩 `futile` 保护直接报错)。
   - 改造:在 `src/server/session/runner.ts` 的回合收尾(`~3520-3546`,即判定不再续跑处)启动 `precomputeSummary(session, boundary)`,结果按 `{ sessionID, compactedID }` 存在 runner 上;`compactNow`(`runner.ts:1535`)先取 held 摘要,命中则只做"应用"而不发请求;配置层(`src/server/config.ts`)增加 `compactionModel`,在 `compactNow` 里用它构造 adapter 请求。缓存条件参考 `src/server/session/prune.ts:61-64` 的 `isCacheCold`。
   - 成本:中高;收益:长任务停顿从"分钟级"降到"一次应用",且压缩成功率不再被小模型绑死。

4. **缺少 `models` 工具,子智能体选模型靠猜。(影响多模型工作流)**
   - 现状:MCode 只有 `actor` 的 `models` action(`src/server/tool/subagent.ts:104`、`216`);opencode 有独立 `models` 工具并让 subagent 描述硬性要求"先查再传"(`packages/core/src/tool/plugin/opencode.ts:44-92`、`subagent.ts:36-39`)。
   - 后果:用户指定"用某个模型跑子任务"时,模型容易传错 `provider/model` 被拒,浪费一步;也无法按价格/上下文/vision 选型。
   - 改造:在 `src/server/tool/registry.ts` 追加 `ModelsTool`(放在末尾以保护既有前缀),复用 `src/server/provider/catalog.ts` 的目录与 `src/server/provider/variants.ts` 的变体信息,输出 `provider/model` + 价格 + 上下文 + 变体;同时把 `src/server/tool/subagent.ts:145` 的 `model` 描述改成"必须先调用 models 工具确认,不要猜"。
   - 成本:低;收益:多模型/子智能体场景的首次成功率。

5. **没有后台命令作业。(影响联调/长构建)**
   - 现状:MCode 的 `bash` 没有 `background`(`src/server/tool/bash.ts:503-522`),长命令只能占住回合;opencode 有 `background` + `Job` + 完成通知(`packages/core/src/tool/plugin/shell.ts:29-30`、`135-167`)。
   - 后果:启动 dev server / 长构建时,模型无法并行做别的事,回合被超时切割。
   - 改造:在 `src/server/tool/bash.ts` 增加 `background?: boolean`,进程注册到现有 `live` 集合(`bash.ts:343-351`),把输出继续写入 `ToolOutputs`;结束时通过 `src/server/session/runner.ts` 发一条 synthetic user 消息(类似 `runner.ts:3168-3189` 的 resume 注入),让回合在新一轮继续。
   - 成本:中;收益:前端/服务端联调类任务的有效并行度。

6. **没有"整步重放"与 WebSocket 传输。(影响长思考/长上下文稳定性)**
   - 现状:MCode 失败只在 `stream()` 内重发同一请求(重试在 `src/server/session/runner.ts:3851-3906`);opencode 有 `RecoverFull`(重新 `prepareContext` 后整步重放,`packages/core/src/session/runner/step.ts:237-243`、`llm.ts:381-386`)与 WebSocket 会话传输(`session/model-transport.ts`)。
   - 后果:长时间思考期间连接被中间设备掐断时,MCode 更容易"重来并丢掉已产出的 reasoning"。
   - 改造:在 `src/server/session/runner.ts` 的主循环里,捕获 `stream()` 抛出的"传输类 + 尚未产出任何 part"的失败(`src/server/provider/stall.ts` 已有分类基础),`continue` 回到循环顶部重读 `store.messages` 并重新 `systemFor`;把 `rescued` 那种"每步只救一次"的预算同样套用。传输层先在 `src/server/provider/adapter.ts` 预留 `transport?: "sse" | "websocket"`,实现可延后。
   - 成本:中(整步重放低、WebSocket 高);收益:长任务断线恢复的成功率。

7. **编辑失败缺"可能已经应用过"的识别。(影响重试/续跑后的步数)**
   - 现状:MCode 的 `closestMatch` 只比较 old_string(`src/server/tool/edit.ts:161-168`);opencode 的 `missHint` 先判断 newString 是否已在文件中(`packages/core/src/tool/plugin/edit.ts:195-199`)。
   - 后果:断线重试或模型自信重发同一次编辑时,MCode 回"未找到",模型往往重读文件再猜,多 1-2 步。
   - 改造:在 `src/server/tool/edit.ts:508` 生成 hint 之前加一条:若 `newString.trim().length >= 20` 且归一化后 `newString` 已出现在文件中,直接返回"newString 已存在,这次编辑可能已经应用过",并给出命中行号。成本极低。
   - 成本:极低;收益:中(所有重试路径都受益)。

8. **指令更新只到"类别"粒度,且挂在最后一条用户消息上。(影响会话中途改 AGENTS.md)**
   - 现状:MCode `instructionUpdate`(`src/server/session/prompt.ts:142-168`)只比较 standing/project/skills 三类,`syncInstructions`(`src/server/session/runner.ts:2605-2623`)把整类新文本追加到 `asked.reminders`;opencode 是逐源 hash + durable `instruction-updated` 事件 + `epochStart` 过滤(`packages/core/src/session/instruction-state.ts`、`history.ts:224-238`)。
   - 后果:更新依赖"最后一条用户消息还在",撤销/压缩掉它之后模型就按 system 里的旧指令继续;整类重贴也与前缀重复。
   - 改造:把 `instructionValues` 的每个来源(每份 AGENTS.md/CLAUDE.md/远程 URL/skills 列表)算出 hash,存进 `src/server/session/store.ts` 的 `instructions.sources`;`instructionUpdate` 改成按来源生成只含变化项的 reminder;在 `runner.ts` 压缩时把当前 epoch 写进 `compacted`,请求构建时(`runner.ts:3078` 附近)按 epoch 过滤旧更新——与 `history.ts:228-238` 对齐。
   - 成本:中;收益:中。

9. **MCP/扩展工具默认不进 CodeMode。(影响 MCP 重的项目)**
   - 现状:opencode 默认把 MCP、`opencode.*`、artifact、schedule 折进 `execute`(`packages/core/src/tool.ts` 的 codemode 默认、`codemode/instructions.ts:11-26`);MCode 需逐服务器开启(`src/server/mcp.ts:1728`、`1786-1790`)。
   - 后果:"并发查 5 个 MCP 资源 → 汇总""列出所有 artifact → 读其中 2 个"这类操作,MCode 要 N 次往返,opencode 一次脚本。
   - 改造:把 `src/server/mcp.ts:1786` 的 `execute` 默认打开(至少对只读 MCP 工具),并复用 `src/server/codemode/catalog.ts` 的目录生成方式,在 `src/server/session/prompts.ts` 加一段 CodeMode 说明。
   - 成本:中;收益:中低(纯文件编程无影响)。

10. **没有 worktree 工具。(影响隔离实验/并行开发)**
    - 现状:MCode 有 `src/server/session/worktree.ts`,但没有暴露给模型;opencode 有 `worktree_create/list/remove` + `session_move`(`packages/core/src/tool/plugin/opencode.ts:180-260`)。
    - 后果:模型只能靠 bash 手敲 `git worktree`,没有路径/权限校验,容易在错误目录改文件。
    - 改造:在 `src/server/tool/registry.ts` 末尾注册 `worktree_create`/`worktree_list`/`worktree_remove`,内部调用 `src/server/session/worktree.ts`,路径经 `src/server/tool/fs-util.ts:167` 的 `resolvePath` 校验。
    - 成本:低;收益:中低(取决于用户是否常做 worktree 开发)。

11. **`patch` 不是 freeform 输入。(影响大补丁)**
    - 现状:MCode `patchText` 是普通 JSON 字符串字段(`src/server/tool/patch.ts:63-68`);opencode 用 lark freeform(`packages/core/src/tool/plugin/patch.ts:68`)。
    - 后果:大补丁更容易出 JSON 转义错误。
    - 改造:在 `src/server/provider/tool-schema.ts` 与 `src/server/provider/anthropic.ts`/`openai.ts` 的请求构造处支持"单字段工具走自由文本参数"(Anthropic 无原生 freeform,可退化为把 `patchText` 作为唯一必填字符串 + 提示"直接输出补丁,不要 JSON 包裹",由 `src/server/tool/arg-repair.ts` 兜底解析裸补丁)。
    - 成本:中;收益:低到中。

12. **历史中的媒体不按目标模型能力降级。(影响换模型后继续)**
    - 现状:MCode 只在 read 时按 `model.inputs` 拒绝(`src/server/tool/read.ts:194-232`);opencode 在请求构建时对**历史里所有**不支持的媒体做文本替换(`packages/core/src/session/model-request.ts:145-173`)。
    - 后果:会话中途切到不支持图片/PDF 的模型,旧附件可能导致整次请求失败。
    - 改造:在 `src/server/provider/history.ts` 的 `requestHistory` 之后增加一遍 `unsupportedAttachments(messages, modelEntry)`,按 `inputs` 把不支持的 `attachments` 换成一行"该模型不能读取此附件"的文本,并清空 `byPath` 数据。
    - 成本:低;收益:中低(只影响换模型场景,但失败是硬失败)。

13. **`todowrite` 兼容别名。(影响只被 todowrite 训练过的模型)**
    - 现状:MCode 用 `task`(`src/server/tool/task.ts:183-251`);opencode 用 `todowrite`(`packages/core/src/tool/plugin/todo.ts`)。
    - 后果:模型按 `todos[]` 调用会被 `operation` 形状拒绝,浪费一步。
    - 改造:在 `src/server/tool/task.ts` 的 `execute` 里识别 `input.todos` 数组(没有 `operation` 时),把它映射成 `plan` action(或逐个 create/start/done),保持 `task` 的输出不变。
    - 成本:极低;收益:低(一次性迁移摩擦)。
