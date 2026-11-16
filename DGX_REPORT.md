# DGX 代码库理解报告

> 仓库:`/Users/wyatt/MCode`(Electron + Vue 3 的 AI 编码助手桌面应用)

## 1. 项目结构与模块职责

### 1.1 规模与顶层目录

仓库共约 529 个 `*.ts` / `*.vue` 源文件、约 21 万行代码。顶层职责划分清晰:

- `src/main/` —— Electron 主进程:窗口、菜单、IPC、更新器、预览服务器、本地网络、安全存储、Office 视图支撑等(46 个文件)。
- `src/preload/` —— 单文件 `contextBridge` 桥,只暴露窗口真正需要的特权能力;当前 `api` 对象约 102 个方法,远超 README 写的 22 个。
- `src/server/` —— 纯 Node 后端(194 个 `.ts`),不 import Electron,可由脚本无头驱动。
- `src/renderer/` —— Vue 3 + Pinia 界面(117 个 `.vue`、124 个 `.ts`)。
- `src/shared/` —— 前后端共享的协议、权限模型、模型目录、路径/会话工具等。
- `scripts/` —— 176 个检查/构建/探测脚本,是"可失败的检查"这一工程方法的主要载体。

### 1.2 主进程与 preload

`src/main/index.ts`(2,121 行)负责应用生命周期与所有原生能力:创建 `BrowserWindow`、绑定菜单、处理 `ipcMain`、更新检查/安装、崩溃恢复、电源与托盘等。窗口安全设置集中在这里:`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`(`src/main/index.ts:806` 起),并对新窗口与导航做白名单限制。

`src/preload/index.ts` 是唯一特权面。它刻意保持"薄":会话、文件、智能体全部走 WebSocket,preload 只处理对话框、剪贴板、更新、窗口控制、系统语言等必须以主进程身份完成的事情。注释明确说明这是为了"小到可以一眼审计"。

### 1.3 Node 后端

`src/server/index.ts`(505 行)是启动编排:`Storage` → `Bus` → `Config` → `AuthManager` → `Permissions` → `SessionStore` → `SessionRunner` → `Shells` → `McpServers` → `ArtifactStore`,再启动 history 索引、cron、automation、模型目录刷新、checkpoint 整理与崩溃后回合续跑。它把后端绑定在 `127.0.0.1` 的随机端口上,通过 preload 把端口和启动密钥交给渲染进程。

核心模块:

- **事件总线** `src/server/bus.ts`(29 行):只做同步 fan-out。运行时从不直接碰 socket,WS 层只是订阅者,因此智能体循环可以脱机测试,多窗口也能观察同一会话。
- **请求分发** `src/server/handlers.ts`(2,042 行):一个巨大的 `switch`,覆盖会话、项目、权限、配置、provider、MCP、git、语音、artifact 等约百个请求类型。
- **会话存储** `src/server/session/store.ts`(894 行):一条消息一个 JSON 文件,流式时只重写当前 assistant 消息;另有历史/undo 的 snapshot 结构、`messageIDs` 的全量读取语义和“坏消息不拖垮整段会话”的容错。
- **智能体循环** `src/server/session/runner.ts`(5,440 行):`SessionRunner` 手写流式循环,负责请求构造、provider 调用、流事件归一、工具执行、权限闸门、重试/压缩/循环检测、子智能体、目标判定、steering、队列消息等。
- **provider 适配** `src/server/provider/`:统一 `TurnEvent` 流(`types.ts`),`adapter.ts` 按 kind 选择 Anthropic Messages、OpenAI Responses、ChatGPT 订阅或 OpenAI-compatible;`sse.ts` 是自写的 SSE 读取器;`history.ts` 负责三种 wire 格式共享的历史整形。
- **工具层** `src/server/tool/`:`registry.ts` 固定工具顺序以保护 prompt cache;`read/write/edit/patch/bash/search/webfetch/websearch` 等基础工具之外,还有 task/actor/fanout、skill、memory、history、cron、automation、lsp、app、present、notebook 等。
- **权限闸门** `src/server/permission.ts`(821 行):三档访问级别(`ask` / `auto` / `full`)、按项目/会话持久化的 always 规则、危险命令强制询问、后台子智能体不可询问、以及“让模型先审一遍”的 `CommandReviewer`。
- **终端** `src/server/shell.ts`:真实 pty(`@lydell/node-pty`),而不是管道。
- **其他子系统**:MCP(`mcp.ts` 等)、LSP(`lsp/`)、memory(`memory/`)、history/SQLite 索引(`history/`)、artifact 存储、Office 渲染、remote 网关(`remote/`)、定时任务(`cron/`)、自动化(`automation/`)。

### 1.4 渲染进程

`src/renderer/src/App.vue`(4,880 行)是总编排层:视图切换、侧栏/信息栏/右侧面板、终端抽屉、命令面板、全局快捷键、菜单命令、草稿、主题、更新提示、搜索、批注等都在此处接线。Pinia 的 `stores/app.ts`(2,659 行)承担主要应用状态与 WS 事件归并。

组件按三层组织:

- `components/` 根级:大页面与大对话框,如 `Composer.vue`、`SettingsDialog.vue`、`Sidebar.vue`、`MessageStream.vue`、`RightPanel.vue`。
- `components/parts/`:消息流内部的可复用部件,如 `TextPart.vue`、`ToolPart.vue`、`DiffView.vue`、`MarkdownBody.vue`、`PermissionRow.vue`、`QuestionCard.vue`。
- `components/right/`:右侧面板的文档查看器与标签页,如 `PdfView.vue`、`DocxView.vue`、`XlsxView.vue`、`PptxView.vue`、`RpDiff.vue`、`RpTerminal.vue`。

`lib/` 下有大量按职责拆分的纯逻辑模块:`client.ts`(带类型的 WS 客户端)、`markdown.ts`、`theme-engine.ts`、`i18n.ts`、`keys.ts`、`find.ts`、`diff-view.ts`、`voice.ts` 等。`styles/tokens.css` 保存主题引擎派生出的颜色 token。

### 1.5 构建与检查脚本

`electron.vite.config.ts` 除了标准三段构建,还包含三个值得注意的自定义插件:

- `languageChunks()`:在编译期把 18 种语言表从 `i18n.ts` 中切出来,除 `zh-CN`/`en` 外按需加载。
- `pdfjsAssets()`:把 pdf.js 的 cmaps、字体、wasm、icc 与批注图标复制到构建产物。
- `fluidsynthVendor()`:把 FluidSynth 的 wasm 与许可证作为独立文件放在 asar 外。

`scripts/` 中既有 `theme-check.ts`、`wiring-check.ts`、`i18n-check.ts` 这类结构检查,也有 `session-check.ts`、`tool-check.ts`、`provider-check.ts` 这类真实驱动后端的检查,以及 101 个按回合累积的 `smoke-round*.ts`;`rounds-check.mjs` 负责把它们逐模块、限时、隔离地跑起来。

## 2. 技术亮点

### 2.1 可观测的手写智能体循环

`SessionRunner` 没有使用 SDK 的 tool runner,而是手写流式循环(`src/server/session/runner.ts:2697` 的 `launch`,主循环在 `:3019`)。每一步都通过 `runTool()`(`:3969`)显式推进:文本增量、reasoning、工具状态、权限询问都即时 `bus.publish`,因此界面能在回合仍在运行时渲染,中止也能落在工具执行中间。这是整个项目最核心的架构选择,README 的“每一步都必须可观测”在代码里有对应实现。

循环内部还处理了很多真实世界问题:

- 每个回合只决定一次 pruning 级别(`:2966` 附近),避免逐 step 反复改写 prefix 导致缓存失效。
- 溢出压缩、输出上限续写、思考被截断后的续跑、空回复续跑、文本形式的工具调用解析等,都有独立模块(`overflow.ts`、`text-tool-parse.ts`、`retry.ts`)。
- `loop-health.ts` 用四种探测器识别“卡住”的回合:重复调用、近似重复编辑、失败命令重试、连续无进展动作,并可在请求中裁掉重复区间。

### 2.2 WebSocket + Event Bus 的后端边界

`bus.ts` 只有 29 行,却把“运行时”和“传输”彻底解耦:后端发布事件,WS 只是订阅者。`src/server/index.ts` 负责把随机端口与启动密钥交给窗口;`src/server/socket-guard.ts` 同时校验 Host、Origin 与握手 subprotocol 中的 32 字节随机密钥,并用哈希后的 `timingSafeEqual` 做常量时间比较。这个设计既让 `session-check` 能在没有 Electron 的情况下驱动真实后端,也避免了“localhost 端口被任意网页连接”的常见漏洞。

前端 `src/renderer/src/lib/client.ts` 是带类型的 RPC 客户端:请求按 id 关联 Promise,事件走订阅者;断线时请求进入队列,重连后补发,超时 30 秒才失败,并在关闭时区分“已发送的请求失败”和“未发送的请求继续排队”。

### 2.3 Provider 适配层的归一化

`src/server/provider/types.ts` 定义了统一的 `TurnEvent`(`text.delta`、`reasoning.delta`、`tool`、`reasoning.signature` 等),把 Anthropic 的 block index、OpenAI 的 choice delta、ChatGPT Responses 的 item 流统一到一条事件流。`adapter.ts` 用穷举 switch 选择适配器,避免调用方各自判断 provider kind。

细节质量很高:

- `sse.ts` 不是简单的 `data:` 行读取器,而是按 SSE 规范处理空行分派、多行 data、注释/keep-alive、CR/LF/CRLF、末尾无换行的 flush;注释里记录了每一个偏差曾经造成的真实故障。
- `history.ts` 统一处理“未完成 tool call 必须有 tool_result”“空 user 消息变成 Continue.”“以 assistant 结尾时补 Continue.”“只思考被截断时把思考摘要发回模型”等跨 provider 规则。
- `stall.ts` 用 480 秒 chunk 超时 / 300 秒响应头超时保护流,并在系统休眠恢复时主动切断已死流,交给重试阶梯处理。

### 2.4 分层的权限与沙箱

权限模型不是简单的“询问/不询问”:

- 三档访问级别 `ask` / `auto` / `full`(`src/shared/access.ts`),`auto` 会先让模型做一次受约束的审批,失败/超时/含糊都回落到询问用户(`permission.ts:301` 的 `reviewed`)。
- 写文件、执行命令、访问项目外路径、MCP 调用会各自提问,并展示确切命令或 diff;`SELF_ASKING_KINDS` 明确列出“工具自己会问”的桶(`src/shared/protocol.ts:1275`)。
- 删除、`git reset --hard` 等“丢失工作”的命令被强制每次询问,即使所在桶是 allow;full access 是唯一例外(`permission.ts:455` 附近)。
- 持久化规则按项目/会话保存,写回时先重读磁盘再合并,避免两个实例互相覆盖;读不懂或来自更新版本的规则文件不会被覆盖(`permission.ts:682` 起)。

路径沙箱同样做了真实路径校验:`resolveInsideReal()` 先做字面路径检查,再用 `realpath` 判断符号链接/junction 的真实落点(`src/server/tool/fs-util.ts:90` 起);`resolvePath()` 对项目外路径走权限询问,并额外保护应用数据目录、memory 目录和 Windows alternate data stream。

### 2.5 持久化的原子性与崩溃恢复

`src/server/storage.ts` 的 `writeAtomic()` 先写临时文件、`fsync`、再 rename;对 Windows 的 `EPERM/EACCES/EBUSY` 做了等待重试;无法解析的文件会被 quarantine 而不是直接覆盖。会话侧一条消息一个 JSON,流式写入只重写当前消息,避免整段 transcript 反复序列化。

更强的恢复能力在 `SessionRunner.resumeClaimed()` 和 checkpoint 机制:应用被杀死/崩溃后,未完成回合可以继续;undo 的文件内容放在项目级 checkpoint store,而不是塞进会话 JSON;启动时还会迁移旧格式、清理临时文件、清扫孤立 store。这些都属于“真实桌面应用才会遇到”的工程细节。

### 2.6 主题引擎与可失败的检查

`src/renderer/src/lib/theme-engine.ts` 从 10 个种子色出发,在 OKLCH 空间生成 12 级色阶,再映射成语义 token;`theme-palettes.ts` 的 `MCODE_THEME` 是当前唯一调色板。`scripts/theme-check.ts` 用引擎重新生成 `tokens.css` 的三个 block 并逐 token 比对,同时检查:

- 只用逻辑属性(`padding-inline` 等),拦住 RTL 下会错位的物理方向样式;
- 没有 `var(--x)` 指向未定义的 token;
- 终端 ANSI 16 色表完整且真的传给了 xterm;
- `:hover` / `:focus-visible` / `:active` 不改变几何属性,避免焦点环把控件“reshape”;
- scoped style 中没有会被 Vue 编译成裸 `:global` 或丢失 scope 属性的选择器。

`wiring-check.ts` 则守类型系统看不见的“接缝”:菜单命令 → preload → 渲染端 handler 三段是否闭合;组件 `emit()` 是否有父组件绑定;协议里每个请求是否真的有界面调用;每个 config 字段是否真的被读取;每个 preload 方法是否被渲染进程调用;CSP 是否只允许本机 socket。这些检查的共同点是:它们都能因为一个具体缺陷而变红,而不是“看起来在检查”。

### 2.7 错误恢复与“不丢工作”的默认值

`retry.ts` 按失败类型给不同预算:网络错误无限重试、限流最多等 35 分钟并尊重 provider 自己给出的 `retry-after`、服务端错误 8 次/15 分钟、请求类调用 4 次/30 秒。`overflow.ts` 区分“按 token 数触发压缩”和“provider 报上下文溢出再压缩”,并给输出 token 数设了上限与地板。

`session/store.ts`、`turn-revert.ts`、`patch-checkpoint.ts`、`snapshot.ts` 一起保证 undo/redo/rollback 的语义:不可读的文件、被回滚的回合、已被丢弃的 undo 深度都有明确记录,不会静默恢复到一个“从未存在”的状态。

### 2.8 界面工程

渲染层不是简单堆组件:

- 大页面全部 `defineAsyncComponent` 懒加载(`App.vue:18` 起),终端、设置、预览、插件页各自成 chunk。
- 键盘优先:`lib/keys.ts`、命令面板、菜单加速器、`Esc` 分层处理;`wiring-check` 还检查菜单/快捷键对应的 command id 是否真实存在。
- 18 种语言、RTL 镜像、四级文字刻度、相对填充色约定,都有对应 token 或检查。
- 文档查看器(`right/`)覆盖 PDF/DOCX/XLSX/PPTX,并带版本历史、批注、差异与终端标签页,说明渲染进程的职责远不止聊天。

### 2.9 检查文化

除了 `typecheck` 与 `smoke`,仓库有 20 多个 `*check` 脚本。`session-check.ts` 用真实 HTTP 假 provider 驱动真实 runner/store/handlers/bus;`tool-check.ts` 按回合方式驱动工具;`provider-check.ts` 检查目录与模型解析;`sandbox-check.ts` 专门验证路径穿越拒绝。`rounds-check.mjs` 进一步把 101 个 `smoke-round*.ts` 逐模块隔离运行,带超时、并发上限和“需要真实窗口/设备则跳过”的标记。这种“检查必须能失败”的自觉,是这个仓库最突出的工程特征。

## 3. 代码质量观察

以下问题都指向具体位置,按“对后续维护/正确性的影响”排列。

### 3.1 README 与代码已经严重脱节,且脱节处正好是架构入口

README 仍是理解项目的第一入口,但多处描述与当前代码相反:

- README:35 写 preload 有“22 个方法”;`src/preload/index.ts` 的 `api` 对象实际约 102 个方法。
- README:15 写“内置 37 个主题”;`src/renderer/src/lib/theme-palettes.ts` 只有 `MCODE_THEME` 一个调色板,`scripts/theme-check.ts` 甚至显式禁止 `App.vue` / `SettingsDialog.vue` 读取 palette(说明运行时已不再跑主题引擎)。
- README:84 写“11 项窄检查”;`package.json` 里已有 `themecheck`、`wiringcheck`、`i18ncheck`、`mcpcheck`、`mdcheck`、`sessioncheck`、`snapshotcheck`、`sandboxcheck`、`remotecheck`、`toolcheck`、`promptcheck`、`shellcheck`、`providercheck`、`pathscheck`、`turncheck`、`roundscheck`、`fanoutcheck`、`gencheck` 等 20 余项。
- README:130-142 的“尚未实现”列表与代码冲突:仓库已有 `src/server/lsp/`、`src/server/skill.ts`、`src/server/tool/skill.ts`、`components/PluginsView.vue`;已有 `tool/task.ts`、`tool/subagent.ts`、`tool/fanout.ts`;已有 `global-agents.ts`;已有 `src/server/remote/`;自动更新也已有 `src/main/updater.ts`、`update-transaction.ts` 与 preload 的 `installUpdate()`,并非“只做版本检查”。

这不是普通的文案过期:新成员会按 README 建立错误的心智模型,审计者也会漏掉 LSP、skills、subagents、remote、updater 这些真实攻击面。

### 3.2 `SessionRunner` 是超长文件 + 超长方法的组合

`src/server/session/runner.ts` 共 5,440 行,`SessionRunner.launch()` 从 `:2697` 一直延伸到约 `:4289`,接近 1,600 行,其中主循环从 `:3019` 开始。这个单一方法同时承担:

- 回合前的 MCP 信任、provider/adapter 选择、system prompt 构建、subtask lead 处理;
- 每步的历史裁剪、压缩、续写、steering、队列消息、plan 切换;
- 流事件累积、工具调用并发控制、权限监听、工具结果截断;
- 子智能体、fanout、goal、loop health、错误映射。

它导致两个直接后果:一是定位一个行为需要在一个巨型作用域里追踪大量 `let` 状态;二是很难对单个阶段做单元测试,现有 `session-check` 只能端到端覆盖。对这个文件做任何重构都缺少“细粒度安全网”。

### 3.3 权限“自问”契约依赖约定,而不是强制

`Permissions.check()`(`src/server/permission.ts:550`)对 `SELF_ASKING_KINDS`(edit/bash/webfetch/outside/mcp)只检查 Deny,然后直接 `return`,把“是否真的向用户提问”完全交给工具自己实现。这个契约在现有工具里成立,但对新工具很危险:一个工具只要声明 `permission: "edit"`,却忘记调用 `permissions.ask(...)`,就会在非 Deny 档位下静默执行,类型系统和现有检查都很难发现。

更稳妥的设计是让 runner 在 `tool.execute()` 前记录“本次调用是否发生过 ask”,或在 `ToolDefinition` 上增加 `asksForItself: true` 并在 `runTool` 中做兜底断言。

### 3.4 根级 Vue 组件体量过大,行为检查覆盖不到

`Composer.vue` 6,273 行、`SettingsDialog.vue` 6,149 行、`App.vue` 4,880 行、`Sidebar.vue` 3,344 行、`MessageStream.vue` 3,222 行。它们混合了 UI 模板、键盘处理、持久化、i18n、拖拽、异步加载、权限/问题 dock 等职责。

`wiring-check.ts` 能发现“组件 emit 了但没人监听”,但无法发现“一个 6,000 行组件内部的状态分支写错”。这类组件一旦需要改动交互,回归风险远高于后端模块。建议优先把 `Composer` 的附件/语音/菜单/草稿逻辑、`SettingsDialog` 的各设置分区拆成 composable 或子组件,再用现有检查守住事件接线。

### 3.5 源码注释出现“错位/悬空”,会误导后来者

`src/server/tool/fs-util.ts:62-67` 有一段完整的文档注释,描述“解析模型路径并在越界时询问用户”,但它实际挂在 `memoryReal` 变量上;真正实现该行为的 `resolvePath()` 在 `:167`,反而没有这段说明。`:69` 又紧接着另一段 `/** The memory folder's real location... */`。同文件 `:97-100` 的 “`access` says what the caller will do...” 也与下面的 `insideReal()` 函数不对应。

这类注释错位在大型代码库里会直接造成误读:读者会以为 `memoryReal` 负责权限询问,或以为 `insideReal` 会写应用数据目录。建议把文档注释与函数声明对齐,并把“行为说明”集中在真正执行该行为的函数上方。

### 3.6 `package.json` 的 `allowScripts` 与 Electron 版本不一致

`package.json:77` 安装的是 `electron: "42.11.18"`,但 `package.json:97-101` 的 `allowScripts` 仍写着 `"electron@41.10.7": true`。仓库自己的 `scripts/smoke-round14-packaging.ts:278-283` 会断言 `allowScripts` 中必须恰有一条 `electron@<当前版本>`,因此这条检查在当前树上应当失败;更实际的风险是 Electron 的 postinstall 下载脚本可能没有被允许执行,导致全新安装拿不到可用的二进制。

### 3.7 大量“源码正则检查”脆弱,重构容易让检查静默失效

`scripts/wiring-check.ts` 通过 `appSource.indexOf("const menuCommands")`、`indexOf("const MENU_COMMAND_IDS")`、`"\n}"` 切片来解析 `App.vue`;`scripts/theme-check.ts` 用正则从 CSS/TS/Vue 中收集 `--token` 定义与 `var()` 使用;`scripts/i18n-check.ts` 用正则解析 `i18n.ts` 的 18 张表。代码注释本身也多次承认这类检查“曾经匹配不到、于是对缺陷视而不见”。

现状下这些检查仍然有价值,但它们与代码格式强耦合:一次格式化、一次把对象字面量改成 `satisfies`、一次把表拆成多行,就可能让扫描范围变成空集合。建议至少为每种扫描增加“扫描到的条目数下限/锚点存在性”断言,长期则迁移到 TypeScript AST 或显式的注册表清单。

### 3.8 巨型 i18n 单文件与构建期字符串切割

`src/renderer/src/lib/i18n.ts` 约 2.7 MB、44k 行,包含 18 种语言表;`electron.vite.config.ts` 的 `languageChunks()` 用正则定位 `TABLES` / `LOADERS` 并在编译期切割。这个方案在运行时是合理的(按语言懒加载),但源文件对编辑器、diff、合并和类型检查都不友好,而且构建插件对文件形状极度敏感:一旦表头格式变化就直接 `throw`,虽然能快速失败,但维护成本高。

### 3.9 事件总线的监听器异常被吞掉

`src/server/bus.ts` 的 `publish()` 用 `try/catch` 包住每个 listener,失败只 `console.error`。这对“一个坏订阅者不能拖垮其他订阅者”是对的,但当订阅者是窗口/权限/持久化链路时,异常会被静默吞掉,没有计数、没有健康状态、也不会让检查失败。建议至少记录失败次数并在诊断页/`storage.problems` 一类通道暴露。

### 3.10 检查很多,但没有 CI 把它们变成门禁

仓库没有 `.github/workflows` 或等效 CI 配置,只有 `electron-builder.yml`。20 多个 `*check`、`typecheck`、101 个 round 模块,目前完全依赖开发者记得手动跑。`rounds-check.mjs` 甚至要求“先跑一次 build”,而 `package.json` 的 `smoke` 默认只跑 `smoke.ts`(368 行)。这使“检查必须能失败”的文化停留在本地:一个长期不被执行的检查,与没有检查没有区别。

## 4. 改进建议(按风险排序)

### P0 — 会直接影响安装/安全/核心正确性

1. **修复 `allowScripts` 与 Electron 版本漂移,并让打包检查进入门禁。**
   依据:`package.json:77` 为 `electron@42.11.18`,`package.json:97-101` 仍允许 `electron@41.10.7`;`scripts/smoke-round14-packaging.ts:278-283` 明确要求两者一致。
   行动:把 `allowScripts` 改成 `"electron@42.11.18": true`,并在 CI 中至少运行该检查;同时审查 `@lydell/node-pty` 等原生依赖的安装脚本策略。
   收益/成本:消除“全新安装后 Electron 二进制缺失/打包检查必红”的问题,成本极低。

2. **把权限“工具自问”从约定变成强制。**
   依据:`src/server/permission.ts:550-598` 对 `SELF_ASKING_KINDS` 只执行 Deny 后放行,实际询问由工具自行完成;`src/shared/protocol.ts:1275` 列出了这些桶。
   行动:在 `runTool()` 中记录本次调用是否发生过 `permission.ask`,或给 `ToolDefinition` 增加显式 `asksForItself` 标记;若声明为自问却未提问,直接拒绝并记录诊断。为新增工具加一条 `toolcheck` 断言。
   收益/成本:堵住未来工具“声明了 edit/bash 却静默执行”的绕过路径,中等成本、高安全收益。

3. **拆分 `SessionRunner.launch()` 的巨型方法,先补特征测试再动手。**
   依据:`src/server/session/runner.ts:2697-4289`(约 1,600 行)、主循环 `:3019`。
   行动:按“回合准备 / 单步请求构建 / 流式消费 / 工具调度 / 收尾与恢复”切成私有方法或独立协作者;每一步先用 `session-check` 覆盖现有行为(尤其是 steering、压缩、abort、子智能体、重试)。
   收益/成本:降低核心路径的回归风险,是后续所有运行时改动的前提;成本高,但优先级高于任何新功能。

### P1 — 会持续误导维护者或放大回归

4. **重写 README 的架构与“尚未实现”章节,以代码为准。**
   依据:README:15(37 个主题)、README:35(22 个 preload 方法)、README:84(11 项检查)、README:130-142(称 LSP/skills/subagents/remote/自动更新未实现),与 `src/server/lsp/`、`src/server/skill.ts`、`src/server/tool/subagent.ts`、`src/server/remote/`、`src/main/updater.ts`、`src/preload/index.ts` 的实际内容冲突。
   行动:把 README 缩减为“稳定承诺 + 指向 docs/源码的入口”,并增加一条“文档中的数量/能力清单必须能被脚本核对”的检查(类似 `wiringcheck`)。
   收益/成本:避免新人和审计者建立错误心智模型,成本中等。

5. **建立最小 CI 门禁:typecheck + themecheck + wiringcheck + sessioncheck + toolcheck + providercheck + sandboxcheck + smoke。**
   依据:仓库无 `.github/workflows`;`package.json` 有 20 余项检查,`rounds-check.mjs` 需要先 build;目前完全依赖手动执行。
   行动:先固定一组“必须绿”的快速检查,再把 `roundscheck` 作为夜间任务;失败时保留日志与失败的模块名。
   收益/成本:把“检查能失败”转化为“合并前必须绿”,成本中等、长期收益最高之一。

6. **逐步拆分根级巨型 Vue 组件。**
   依据:`Composer.vue` 6,273 行、`SettingsDialog.vue` 6,149 行、`App.vue` 4,880 行、`Sidebar.vue` 3,344 行、`MessageStream.vue` 3,222 行;`wiring-check` 只能验证事件是否有绑定,无法覆盖内部状态分支。
   行动:先把 `Composer` 的附件/语音/草稿/菜单逻辑抽成 composable,把 `SettingsDialog` 按设置分区拆成子组件;每次拆分只移动代码,并用现有事件/菜单检查防止接线断裂。
   收益/成本:显著降低 UI 改动回归率,成本高、可分阶段进行。

7. **让源码扫描检查具备“锚点失效即失败”的自检,长期迁移到 AST。**
   依据:`scripts/wiring-check.ts` 依赖 `indexOf("const menuCommands")` 与 `"\n}"` 切片;`theme-check.ts`、`i18n-check.ts` 大量使用正则解析 TS/Vue/CSS;注释中已记录多次“正则没匹配到、检查静默通过”的历史。
   行动:为每个扫描增加最小条目数/锚点存在性断言;把菜单命令、命令 id、i18n 表等关键清单改为显式导出或 JSON,让检查读取数据而不是猜源码结构。
   收益/成本:防止重构后检查静默失效,中等成本。

### P2 — 可维护性与可观测性

8. **拆分 `i18n.ts`,把构建期字符串切割改为稳定的数据源。**
   依据:`src/renderer/src/lib/i18n.ts` 约 2.7 MB、44k 行;`electron.vite.config.ts` 的 `languageChunks()` 用正则定位 `TABLES`/`LOADERS`,格式变化即 `throw`。
   行动:按语言拆成 `i18n/zh-CN.ts` 等文件,由构建脚本生成索引;保留 `i18ncheck` 对“组件用到的 key 必须存在”的检查。
   收益/成本:改善编辑/合并/类型检查体验,降低成本中等。

9. **修正 `fs-util.ts` 的错位注释,并对全仓做一次“文档注释是否紧邻其实现”的抽查。**
   依据:`src/server/tool/fs-util.ts:62-69` 的路径解析说明挂在 `memoryReal` 上;`:97-100` 的 `access` 说明挂在 `insideReal` 上。
   行动:把注释移动到 `resolvePath()`(`:167`)和真正使用 `access` 的函数上方;可加一个轻量脚本,报告“连续两个 `/** */` 块之间没有声明”的位置。
   收益/成本:消除阅读误导,成本低。

10. **给事件总线增加失败计数与诊断出口。**
    依据:`src/server/bus.ts` 的 `publish()` 只 `console.error` 吞掉 listener 异常。
    行动:记录每个事件的失败次数、最后错误与时间;通过 `storage.problems` 或诊断页暴露;在检查中注入一个抛错 listener,确认计数可见。
    收益/成本:让“界面没更新/权限状态丢失”这类问题可定位,成本低。

11. **收敛 `smoke-round*.ts` 的数量与保留策略。**
    依据:`scripts/` 下有 101 个 `smoke-round*.ts`,加上其他检查共 176 个脚本;`rounds-check.mjs` 会全量发现并运行,命名按回合累积。
    行动:按子系统归并到少数模块,或建立“回合检查 → 正式检查”的晋升规则;对超过一定时间未改动/未失败的模块做归档。
    收益/成本:降低检查维护与运行成本,成本中等。

### P3 — 打磨项

12. **统一检查脚本的命名与入口说明。**
    依据:`package.json` 中既有 `mcpcheck`、`mdcheck`,也有 `pathscheck`、`gencheck`;README 只列了 11 项,实际 20 余项。
    行动:在 README 或 `CONTRIBUTING` 中给出“检查矩阵”(检查名 → 覆盖范围 → 预计耗时 → 是否 CI 必跑),并让 `npm run` 的输出可发现。
    收益/成本:降低新成员的选择成本,成本低。

13. **评估 `handlers.ts` 的 `switch` 是否适合按域拆分。**
    依据:`src/server/handlers.ts` 2,042 行、约百个 `case`,同时包含语音、Office、provider、git、session 等差异很大的逻辑。
    行动:先按域抽出 handler 函数并保留单一 `switch` 作为路由表,再评估是否需要注册表;不要一次性重写。
    收益/成本:降低单文件认知负担,成本中等,风险低于 runner 重构,可排在其后。
