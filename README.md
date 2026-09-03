# MCode

以键盘和命令面板为中心的 AI 编码助手,做成 Electron 桌面应用。

这是把 [opencode](https://opencode.ai) 桌面端的设计、交互与行为在另一套技术栈上重新实现一遍 ——
**Electron 38 + Vue 3 + Node + WebSocket**。参考实现是被**测量**出来的,不是猜的:它的 asar 会被解包用来提取
CSS、字符串和控制流;而当它的样式表和运行中的应用**说法不一致**时,以运行中的应用为准 ——
例如它设置页的标签列表在 CSS 里写着 `gap: 0`,实测却是 4px。

opencode 是 MIT 许可;这里是新写的代码,不是它的移植。

## 设计

界面颜色不是手挑的十六进制值,而是由**主题引擎**从调色板派生:每个主题给出一组基础色,引擎按固定规则算出
41 个 token。内置 37 个主题,其中 OC-2 是参考实现自己的那一套。

这件事的可信度由一条检查守着:`npm run themecheck` 会用引擎重新生成 `tokens.css`,并要求与仓库里那份
**逐字节一致**。改动引擎而破坏了参考配色,检查就会红。

几个贯穿全局的约定:

- **文字是四级刻度** —— `strong` / `base` / `weak` / `weaker`。正文默认是 `base`,`strong` 留给强调和对话内容,
  界面外框(标签、说明、页脚)往下降一到两级。
- **填充色永远相对于它所在的底色**,不能写死。这一条是踩出来的:同一类错误在一次会话里犯了四次 ——
  一个填充色和它背后的平面算出同一个值,控件就在某一个主题下彻底隐形(选中的标签页、禁用的发送按钮、
  选中的设置项、权限控件里选中的那一段)。所以现在要么用叠加层(`--surface-selected` 这类,它混在任何底色上
  都成立),要么用 `color-mix` 混入文字色 —— 让明暗方向由主题自己决定,而不是由一个固定的白色决定。
- **逻辑属性优先**(`padding-inline` 而非 `padding-left`),因为界面要在阿拉伯语下整体镜像。`themecheck`
  会拦住写成物理方向的样式。

## 架构

```
Electron 主进程
├─ 窗口 / 菜单 / IPC 桥                 src/main
├─ preload(contextBridge,22 个方法)    src/preload
└─ Node 后端                            src/server
   ├─ WebSocket 服务(127.0.0.1:0)      index.ts          请求/响应 + 事件广播
   ├─ 事件总线                          bus.ts            运行时从不直接碰 socket
   ├─ 会话存储                          session/store.ts  每条消息一个 JSON 文件
   ├─ 智能体循环                        session/runner.ts 手写的流式循环
   ├─ provider 适配                     provider/         Anthropic / OpenAI / ChatGPT + 目录与探测
   ├─ 工具                              tool/             read write edit list glob grep bash
   │                                                      todowrite webfetch question apply_patch
   ├─ 权限闸门                          permission.ts     把工具挂起,直到用户回答
   └─ 终端                              shell.ts          真实 pty(node-pty + ConPTY)

渲染进程(Vue 3 + Pinia)               src/renderer
├─ 带类型的 WS 客户端                    lib/client.ts
├─ store                                stores/app.ts
└─ 组件                                 components/
```

**为什么数据走 WebSocket 而不是 Electron IPC。** 后端是一个纯 Node 模块,不 import 任何 Electron 的东西。
这让智能体运行时可以无头测试 —— `npm run smoke` 驱动真实 socket,屏幕上不需要窗口 ——
也让特权的 preload 桥保持在可以逐条审的规模。

**为什么手写智能体循环**而不用 SDK 的 tool runner:每一步都必须可观测。每个文本增量、每次工具状态变化、
每个权限询问都在发生的当下就发布出去,这样界面能在一个回合**还在跑**的时候就渲染它,中止也能落在工具执行中间。

**为什么终端是真 pty。** 早期版本用管道接 shell,结果是没有提示符、没有回显、`vim` 和 `top` 之类根本跑不起来。
现在用 `@lydell/node-pty` 的 ConPTY 预编译二进制(N-API,不需要编译工具链)。打包时这些 `.node` 文件必须放在
asar **外面**才能加载 —— 放进去的结果就是终端打开后什么都没有。

## 运行

```bash
npm install
npm run dev
```

在**设置**(`Ctrl+,`)里填 API 密钥,或者启动前导出 `ANTHROPIC_API_KEY`。密钥以仅属主可读的权限存在应用数据目录,
过网时只以 `configured: true` 这样的标志出现 —— 渲染进程从不拿到密钥本身。

```bash
npm run smoke       # 244 项后端检查,走真实 socket,不需要 API 密钥
npm run typecheck   # 渲染进程 + node
npm run build
npm run package     # electron-builder
```

## 检查

除类型检查外还有 11 项窄检查,守的是类型系统看不见的东西。**每一项都必须能失败** ——
信任一条检查的唯一办法,是故意把它覆盖的代码改坏、看它变红。

```bash
npm run themecheck    # 引擎逐字节重现 OC-2;每个主题可解析;只允许逻辑属性
npm run wiringcheck   # 菜单通道、组件事件、命令 id 都要落到实处;
                      # 以及后端的每个请求都要能被界面触达
npm run i18ncheck     # 18 种语言的表一致,且与参考实现自己的字符串相符
npm run mcpcheck      # MCP 服务的生命周期
npm run mdcheck       # markdown 渲染器:模型写的东西不能变成标记
npm run sandboxcheck  # 路径穿越的拒绝
npm run toolcheck     # 工具,按一个回合驱动它们的方式驱动
npm run sessioncheck  # runner、权限、撤销与回滚
npm run shellcheck    # 终端要开在真实 pty 上,有提示符、有回显
npm run promptcheck   # 系统提示词的组装
npm run providercheck # provider 目录与模型解析
```

`wiringcheck` 里那条"后端请求都要能被界面触达"是有来历的:`workspace.remove` 在协议里声明过、服务端也实现了,
但界面从来没有调用它 —— 工作区能建不能删,而且没有任何东西会报错。类型检查看不出来,因为两半各自都是对的,
错的只是**缺一个调用方**。

## 快捷键

| 键 | |
|---|---|
| `Ctrl+K` | 命令面板 —— 一切都能从这里到达 |
| `Ctrl+N` / `Ctrl+O` | 新建会话 / 打开项目目录 |
| `Ctrl+M` | 切换模型 |
| `` Ctrl+` `` | 终端抽屉 |
| `Ctrl+B` | 侧边栏 |
| `Ctrl+.` / `Esc` | 停止当前回合 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |
| `Y` `A` `N` | 权限询问中:允许一次、始终允许、拒绝 |

`Esc` 只在输入框为空时停止回合。回合进行中恰恰是最容易下意识按 `Esc` 的时候,而那会把已经打出来的字扔掉。

## 权限

只读工具(`read`、`glob`、`grep`、`list`、`todowrite`)直接跑,不问。任何写文件、执行命令或访问网络的操作
都会先询问,并把**确切的命令**或**改动的统一 diff** 摆出来。"始终允许"按会话记住、只活到进程结束,
故意不持久化 —— 一次放行不该悄悄地比应用活得更久。

少数几类命令 —— 递归强删、直写磁盘、fork 炸弹、关机重启 —— 直接拒绝而不是询问。
询问框会训练人无脑点确认,而智能体本来也没有理由主动去碰这些。

## 尚未实现

opencode 是个大仓库,这里覆盖的是它的核心运行时,不是它的全部表面积。以下确实没有:

- **LSP、插件、skills。** 三者都没有对应子系统,所以本该列出它们的面板是**刻意不做**,而不是做成空的 ——
  一个只写着"不支持"的标签页比没有这个标签页更糟。
- **子会话。** 没有 `task` 工具,一个回合无法把工作交给子会话。
- **自定义智能体。** Build 和 Plan 两个预设就是全部。
- **会话分享、云同步、Web 与 TUI 客户端。** 分享是服务端托管的能力;参考实现在
  `config.share === "disabled"` 时自己也不显示它。
- **WSL 支持。** 参考实现能把一个 WSL 发行版当作服务器(检测发行版、往里面装、在 Linux 侧跑智能体),
  这是架构级功能,不是打磨项。
- **自动更新。** 只做版本检查(读 feed、比对、通知),不下载不安装 —— 没有真实发布通道的更新器没有意义。

## 验证

`npm run smoke` 会把后端拉起来、走真实 WebSocket,检查会话生命周期、重启后的持久化、每个工具、
路径穿越的拒绝、权限往返(允许 / 拒绝 / 始终)、diff 渲染、glob 语义,以及 provider 的历史转换 ——
尤其是每个 `tool_use` 块都要有对应的 `tool_result` 应答,重放历史的 bug 通常就藏在那里。

界面层面的行为不靠读代码确认,而是**驱动真实应用**去测:用 Electron 打开窗口、注入探针、发真实按键、
读回计算样式和 DOM,必要时直接对打包后的 exe 走 devtools 协议。这样才抓得到只在打包后才出现的问题 ——
比如原生模块被塞进 asar 后终端开在了虚无上。

不需要 API 密钥就跑不到的只有一处:provider 调用本身。
