# MCode 2.0 交接文档

给接手的人（或下一个会话）看的现状说明。每完成一轮就更新一次。

- 分支：`v2.0`，2026-09-22 起推到 GitHub `WyattCode/MCode`（私有仓库，跟踪 `origin/v2.0`）；拉取请求 https://github.com/WyattCode/MCode/pull/4 已于 2026-09-22 合并进 `main`（合并提交 `76b86ed`）；0.3.8 已发布为预发布版 https://github.com/WyattCode/MCode/releases/tag/v0.3.8
- 目标：在界面和功能上 1:1 复刻 Xiaomi MiMo 桌面端，MCode 保留自己的名字、图标和字标
- 对照清单（逐项实测，含百分比）：https://claude.ai/code/artifact/f149a5d1-857e-4bae-80be-ca03265d9f83
- 最近更新：2026-09-23（第二十二轮 L1，版本 0.4.1）
- 第二十二轮 L1（2026-09-23）：把第二十一轮 F1 留下的清单扫完——两个 opencode 阴影按用途换成 MiMo 的四个、半像素边框统一 --border-input、--color-txt 改用 --text-body、dim/mut 按种类而非尺寸归位、tooltip 宽度与几处死代码。见下方「第二十二轮 · L1」一节；报告在 scratchpad r22l1-*.json / *.png
- 第十二轮（2026-09-19/20）：三个新的只读角度（数据生命周期与版本升级、主进程与界面的通信契约、失败与空状态）的审计已做完，34 项全部完成并合并入 `v2.0`，见下方「第十二轮」一节。报告在 scratchpad `round12-lifecycle.md` / `round12-ipc.md` / `round12-failure-ux.md`
- 第十三轮（2026-09-20）：键盘与焦点、多实例与窗口生命周期、大数据量三个只读角度，37 项全部完成并合并入 `v2.0`，见下方「第十三轮」一节。报告在 scratchpad `round13-keyboard.md` / `round13-instances.md` / `round13-scale.md`
- 第十四轮（2026-09-20）：网络与代理、本地化格式与从右到左、打包安装与自动更新三个只读角度，16 项全部完成并合并入 `v2.0`，见下方「第十四轮」一节。报告在 scratchpad `round14-network.md` / `round14-locale.md` / `round14-packaging.md`
- 第十五轮（2026-09-20，用户要求「二次复核所有代码，检查BUG，包括界面细节」）：六路只读复核 + 七路修复，34 条缺陷全部修掉并合并入 `v2.0`，见下方「第十五轮」一节。报告在 scratchpad `round15-main.md` / `-server-core.md` / `-tools.md` / `-renderer-state.md` / `-ui-chat.md` / `-ui-settings.md`
- 第十六轮（2026-09-20/21）：**编码能力整体改为 MiMo 的路子**（对话方式、代码处理、编码界面），五路完成并合并入 `v2.0`，见下方「第十六轮」一节。只读对照报告 scratchpad `round16-conversation.md` / `round16-code.md` / `round16-ui.md`
- 第十七轮（2026-09-21）：文档查看器、语音与媒体、版本控制与工作流三个角度，三路完成并合并入 `v2.0`，见下方「第十七轮」一节。报告 scratchpad `round17-viewers.md` / `round17-media.md` / `round17-workflow.md`
- 第十八轮（2026-09-21）：**对照基准改为 MiMo 26.920**（用户让 MiMo 自动更新）；截图实测差异配色 + 26.914→26.920 版本差异，五路完成并合并入 `v2.0`，见下方「第十八轮」一节。报告 scratchpad `round18-mimo920.md` / `round18-visual-measured.md`
- 第十九轮（2026-09-21/22）：逐页重新对照 26.920（四块只读审计 + 逐条复核，确认 28 条），A 设置与弹窗 14、B 右侧面板与侧栏 10、C 对话滚动（发送后停靠、跟随规则、暂停与重钉、入场动画、定时任务两行截断）5；另做性能：切回长对话 438→124–188ms、入口 5.90MB→2.14MB。用户定：删首启导入弹窗、新建项目位置行、「导出为对话文件」。`provider.custom.field.providerID.label` / `…providerID.exists` 的简繁中文经用户 2026-09-22 同意连同 `reference-strings.json` 一起改成 MiMo 的「供应商 ID」「该 ID 已被占用」。另修：本机动态端口从 1024 起，端口 0 可能落在浏览器拒绝的端口（5060、6000 等），后端 socket（`server/free-port.ts`）与预览服务改为避开这些端口，检查脚本的服务器由 `scripts/safe-listen.ts` 挪开（原「bad port」偶发失败）。合并后 smoke 6134 全过；合并版真窗口复测停靠 135.1（目标 136.8）。见各「第十九轮」小节。

## 第二十二轮 · L1：把 F1 交接的清单扫完（2026-09-23）

第二十一轮 F1 只能改到 token 文件本身，剩下的散在各组件里。本轮按它留的清单逐条做完，全部重新拿 MiMo 26.920 的 `renderer/assets` 核过。

- **两个 opencode 时代的阴影没了**：MiMo 的浮层壳只有一套 `gC` = `z-[1000] rounded-[16px] border-[0.5px] border-input-border menu-glass p-[5px] shadow-composer`，弹出层（Radix popover）和下拉内容都用它；它自己的 `.menu` 类（@ 菜单与斜杠菜单）是 12 圆角 + 1px `--color-line` + `--color-bg` + `--shadow-menu`；对话框是 16 圆角 + line + `bg-bg` + `--shadow-pop`；`.spine-preview` 与 `.info-panel-card` 又回到 `--shadow-composer`。所以 `--shadow-lg`（19 处）与 `--shadow-overlay`（12 处）按用途分给了四个 token，对话框的 `--surface-raised` 改成 `--surface-page`。`--shadow-xs-border` 无人使用，删掉。
- **例外（已实测，不要"修"回去）**：图片预览、视频预览、服务商选择下拉这三处 MiMo 挂的是 Tailwind 的 `shadow-pop` **工具类**，而工具类把浅色值烤死（`--tw-shadow:0 12px 40px var(--tw-shadow-color,#00000024)`），不随深色翻转；这三处保留字面值。对话框上 MiMo 既有工具类又有自己的 CSS 规则（`.np-card` 在样式表里靠后），CSS 规则胜出，所以对话框用 token。
- **半像素边框**：MiMo 样式表里 9 条半像素规则 + 标记里 2 个半像素类，11 个全是 `--color-input-border`，它从不用别的颜色画半像素。15 处 `0.5px solid var(--border-weak)` 与 2 处字面 `#151c130f` 改成 `--border-input`。两个不算：@/斜杠菜单（MiMo 是整像素 line，顺带把玻璃底改成 `--surface-page`，因为 MiMo 的 `.menu` 写在 `.menu-glass` 之后），以及设置页行分隔（MiMo 是 1px `--color-set-line` 的伪元素，左右各缩 16）。
- **`--text-body`**：69 条写死的 `#151c13cc` 改成 token（加上 F1 已经在 base.css 里用掉的 9 条，全仓共 78 处），只写深色那一半的 50 条规则（120 行选择器）随之删除。剩下还写着的不是这一对（浅色是 `--text-strong` 或 `--text-base`，深色才是那个墨色），留着。MCP 失败药丸的红改用 `--text-critical`；`ConnectDialog` / `CustomProviderForm` / `ProviderCloneDialog` 里的红是 Tailwind red-400/red-500，不是 `--color-err`，不动。
- **dim / mut**：**按尺寸分不出来**。数 MiMo 自己：12px 上 mut 93 次、dim 25 次，13–14px 上 mut 62 次、dim 13 次。真正的规律是"按种类"——dim 归：菜单/侧栏/设置导航的空状态（`at-empty`、`conv-empty`、`proj-empty`、`sn-empty`、`sim-empty`）、分组标题（`at-group-label`、`sn-group`）、列表行的元信息（时间、分支、子代理胶囊）、`confirm-queue`、等宽路径；mut 归其余所有安静的东西：各种尺寸的图标按钮、菜单的段标题（`mi-section`）、对话框的标签与正文、提示、注记、加载行、消息自己的时间（`user-time`）。照此改了 52 处（含五个各自重画 `.dialog-close` 的对话框关闭按钮），更新气泡的三种墨色按 MiMo 拆开。匹配到 dim 那一类的本来就对，一个没动。
- **其余**：`.app-tip.card` 的 `max-width: 388px` 删掉（MiMo 的 tooltip 内容两种变体共用 `max-w-[420px]`）；`MenuItem.iconColor` 与 `.tinted` 删掉（F3 拿走了最后一个调用方）；`App.vue` 的 win32/linux 覆盖里 `--surface-hover` / `--surface-selected` 删掉（MiMo 那一段确实写了，但它的根上已经是同样的 `#f1f0ec` / `#eeedec`）；终端标签关闭改用 `--overlay-hover`；终端与插件页各自重画的 `.icon-btn` 改回共用的；插件页与技能详情的开关改成 MiMo 的 32×18 与 `--color-switch-on/off`。
- **检查**：`scripts/smoke-round22-l1.ts` 59 条。拿 v2.0 那一版渲染层跑，47 条失败；本轮跑完 59 条全过。另外把 12 条旧检查里钉死旧值的地方（`#151c13cc`、`--shadow-lg`、`0 12px 40px #00000024`、`#00000014`、`#d23f3f`、`.thread-loading` 的 dim）改成 token 名。
- **真窗口探针**：`scratchpad/r22l1-probe.cjs`，浅深两套、一次性配置目录、`win.isVisible() === true`、截了侧栏/输入框/菜单/右键菜单/tooltip/文件页/对话框。改动前后各跑一遍（前者临时把渲染层 checkout 到 v2.0 再 build），差异只有预期的那些：菜单阴影由三层带环的 `--shadow-lg` 变成 `--shadow-composer`、边框由 `#f0ebe5` 变 `#151c130f`、对话框底色 `#ffffff`→`#fffefd`、阴影→`--shadow-pop`、关闭与副标题由 `--text-weak`（0.4 / `#777`）变 `--text-base`（0.6 / `#b8b8b8`）、卡片 tooltip 388→420、`--shadow-lg` / `--shadow-overlay` 解析为空。输入框的边框与阴影前后完全一致，证明那几处字面值换 token 是等值改写。

### 没能对上的（留给以后）

| 位置 | 为什么 |
| --- | --- |
| `SettingsDialog.vue` `.line` 的 `border-bottom: 0.5px var(--border-weak)` | MiMo 对应的是 `.sr:after` —— 1px `--color-set-line` 伪元素，左右各缩 16，不是 input-border；换过去会更错 |
| `InfoBranchMenu.vue` 的 12 圆角 | 同族的 `InfoCommitCard` 有 `w-[300px] gap-[6px] p-[10px]` 直接对得上 `gC`（已改成 16），这一个没有同样硬的证据 |
| `MediaCoverflow` / `MediaStrip` 的 meta 行 | MiMo 是 `text-11 text-txt`，MCode 是 12px 的安静灰；尺寸和墨色都要改，超出本轮范围 |
| `.boot-msg`、`AppMenu` 的 `.brand`、`ArtifactsView` 的 `.chip-count`、`InfoSection` 的 `.count`、`SettingsDialog` 的 `.keys-desc` / `.total-name` / `.day-name` | MiMo 没有对应元素，或它那一处颜色是继承来的，分不出 dim 还是 mut |
| 约 90 处没写 `font-size` 的 `--text-weak`（图标、字形、占位符） | MiMo 的字形有三种墨色：菜单行里是 `--color-icon`，图标按钮上是 mut，小的行内标记是 dim；要逐个截图才分得清 |

## 第二十一轮 · F1：颜色 token 与共用控件（2026-09-23）

用户本轮解除了「不许新增 CSS token 名」的禁令（仅限这项工作）。MiMo 值全部重新从 `renderer/assets/index-BcVtFvOi.css` 与同目录 JS chunk 里核过。

- **生成层（`theme-palettes.ts` → `theme-engine.ts` → `tokens.css`，`themecheck` 仍绿）**：悬停 / 选中改 `#f1f0ec` / `#eeedec`（原来是自动化页的中性 `#f1f1f2`）；线 `#f1f1f1` / `#2e2e2e`，软线 `#0000000d` / `#ffffff12`；`--surface-sunken` 由「黑 35% 压 bg-deep」改成实测 `#f8f7f5` / `#2e2e2e`（原深色 `#0d0d0d` 差了好几档）；`--icon-base` = `--color-icon` `#5c5c57` / `#d0d0d0`；`--text-weaker` 不再指向背景档 `bg-layer-04`（浅色 `#dbdbdb`，白底上等于看不见），改成 `--color-send-empty` `#bbbbb6` / `#5a5a5a`；链接蓝两套都为 `#3295fb`（MiMo 从不翻 `--color-link`）；scrim `#00000061`。
- **新 token（MiMo 有、MCode 缺）**：`--surface-page`（`--color-bg`，所有浮层的底）、`--surface-glass`、`--text-body`（`--color-txt`）、`--text-critical`（`--color-err`，此前被 20 条规则引用却无定义）、`--text-destructive`（`--color-del`）、`--border-input`、`--border-button`、`--ring`、`--shadow-menu/pop/tip/composer`、`--shadow-xs`、`--motion-fast/base/slow`、`--overlay-hover`。删掉 15 个无人使用的死 token。
- **`themecheck` 新规则**：任何 `var(--…)` 在全仓找不到定义就失败（这正是 `--text-critical`、`--overlay-hover`、`--motion-fast` 长期没被发现的原因）。定义从全仓收集（含 `:style="{ '--rw': … }"` 与 `setProperty`），使用只看样式块，两边都先去注释。
- **共用控件照 MiMo 重画**：焦点环换成 `--color-ring`（墨色 / 白）；`kbd` 换成 MiMo 的 11px 边框小帽（原来是 mono 填充键帽）；`.icon-btn` 30/7；`.btn` 8 圆角 / 500 / 真边框 / shadow-xs / 按下 .97 / 填充态 hover 用 `bg-primary/90`；`.field` 用 `--color-btn-border` 真边框、无填充、聚焦只压深边框；`.dialog` 16 圆角 + 1px 线 + `--shadow-pop`；`.dialog-close` = `.u-modal-close`（28/8/16px 字形/按下 .96）；工具菜单换成 MiMo 自己的配方（glass + 0.5px input-border + shadow-composer）；SelectMenu 保持 MiMo 设置页那一版（menu 壳 + glass + shadow-menu）。
- **真窗口探针**（`scratchpad/r21f1-probe.cjs` / `r21f1-probe2.cjs`，win32、浅深两套、一次性配置目录、`win.isVisible() === true`）：30 个 token 全部按 MiMo 值解析；菜单 `#fffefd`/`#f1f1f1`/12 圆角/shadow-menu、行 `#151c13cc`、字形 `#5c5c57`；快捷键帽 11px/mut/5 圆角/1px 5px；tooltip 与 MiMo 的 `rounded-[8px] border-line bg-bg px-8 py-5 text-12 shadow-tip` 完全一致；`.btn` 28/8/500/13、主按钮 `#151c13`+白字（深色 `#ececec`+`#0d0d0d`）；`.field` 28/6/`#e3e3e0`（深 `#3a3a3a`）；焦点环浅色 `rgb(21,28,19)`、深色 `#fff`，按钮自绘 3px 半透明光晕。
- **留给其他路**：见报告里的清单（composer 需要 `--surface-composer`、7 个对话框仍写 `--surface-raised` + `--shadow-overlay`、19 处 `--shadow-lg` 与 12 处 `--shadow-overlay`、dim/mut 反用的清扫、0.5px 边线换 `--border-input`、`App.vue` 里已冗余的两行 win32 覆盖、`TerminalDrawer` 的 `--overlay-hover`）。

## 第二十一轮（2026-09-23）：其余页面照 MiMo 26.920 校准 + 全局配色

用户要求继续补齐与 MiMo 的差异。四路只读对照（首页/搜索/产物中心/通知、设置、右侧面板、全局 token 与通用控件）共约 150 条，加一路修停靠。用户四个决定：MiMo 自己写坏的地方**不复刻**（保留 MCode 的正常写法并记入有意差异）；**全局配色整体换成 MiMo 的，本轮解禁新增 CSS 变量名**；**删掉命令面板**（MiMo 无）；**首页字标区补足高度并自画背景装饰**。

- **F1 配色与通用控件**：`--surface-hover/-selected` 改 MiMo 的暖灰 `#f1f0ec`/`#eeedec`，`--border-weak` `#f1f1f1`/`#2e2e2e`，`--surface-sunken`、`--icon-base`、`--text-weaker`（原是背景档却被约 40 处当文字用）、`--text-accent`、`--scrim` 全部取实测值；新增 `--surface-page`/`--surface-glass`/`--text-body`/`--text-critical`/`--text-destructive`/`--border-input`/`--border-button`/`--ring`/四个 `--shadow-*`/三个 `--motion-*`/`--overlay-hover`，删 15 个死 token。**themecheck 新规则：任何 `var(--…)` 找不到定义即失败**（`--text-critical` 被 20 条规则引用却从未定义，设置里所有红色状态和连接失败点都是坏的，就是这样漏掉的）。通用控件（按钮、输入框、菜单、select、弹窗、tooltip、键帽、图标按钮、焦点环、按下动画）照 MiMo 重做。
- **F2 设置页 25 项**：暗色选中分段（近黑压近黑不可读）、外观图标网格（4 列 60px 卡片，另修 PNG 图标被撑到 140px 的 bug）、导航列尺寸与实心图标（12 个自绘）、卡片与页面节奏、模型页卡片/按钮/输入框/悬浮保存栏、模型下拉改为目录+探测合并（原先必须先测试连接才有内容）、快捷键页与归档页配色、MCP 与环境页细节、文案照 MiMo。
- **F3 右侧面板 41 项**：约 40 处次要文字升一档、子智能体记录不再被限死 320px、版本历史弹窗尺寸、代码底色在暗色不再反向、地址栏占位符、文件页 Markdown 排版、+ 菜单补子智能体、图片预览与错误条配色、五处硬编码线条。实测纠正了清单两处算错（底部终端标签高度 38/28 是对的；浏览器缩放按钮在 MiMo 大字号下会切字，保留 MCode 做法）。
- **F4 首页/搜索/产物中心/通知 58 项**：首页 hero 按 MiMo 的 527×299 几何重排并加 MCode 自绘的蓝图装饰（问候语实测 195.84，目标 195.8）；浅色输入框卡片改纯白；搜索浮层五处不可见的灰色、类型徽标、无对话的项目也能搜到、放大镜重画；**删除命令面板**（连同 14 个键 ×18 表、死路径 `file.list`）；产物中心页面内缩、图标、hover 阴影、空态节奏，并新增 `artifact.changed` 事件（开着页面删对话即时刷新，不再靠轮询）；通知列以正文区为中心、距顶 24、最新在最上、超限排队不再丢弃、点亮铃铛 `#3295fb`；侧栏勾选框、标题色、完成点等。
- **P1 停靠**：问题停靠只测一次且无人看守，加上漏抄 MiMo 的 `overflow-anchor: none`，以及停靠自身滚动被误判成「读者滑到底」导致跟随恢复。修好后长/短会话、编辑中发送在动画开与减少动画下都稳定在目标位（偏差 <0.3px）。
- 验证：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck、toolcheck、sessioncheck、build 全过，smoke **6812 全过**；各路新检查都在旧代码上证明会失败（F1 49 条、F2 106 条里 105 条、F3 78 条里 72 条、F4 78 条里 69 条、P1 13 条）。界面项均在真窗口（一次性配置、窗口可见）深浅色实测并看过截图。

## 第二十轮（2026-09-22/23）：二次复核代码 + 对话页照 MiMo 校准

用户要求「二次复核代码」，随后发来 MCode 与 MiMo 26.920 同一对话页的截图，要求界面、写代码 Agent 的逻辑、文案思路与表达全部统一向 MiMo 学习；并说明**顶部蓝色光条保留**（记为有意差异）。另注意：用户截图里的 MCode 处于 120% 页面缩放（Ctrl+0 复原），比较以 CSS 数值为准。

- **复核**（第十五轮 `f5c0229` 之后的 157 个文件，五路只读）：确认 35 条，修 33 条（清单 scratchpad `r20/review-findings.md`）。A 引擎：三种死循环检测永不触发、压缩后续写粘进旧消息、目标在判定期间被改后写回、截断提示残留、续写越过插话；另修 Anthropic 上目标判定必被拒（`goal.ts` `judgeTranscript`）。B：AI 标识改写的 `$` 展开、定时任务 30 秒租约导致跳过/重跑、外部会话路径大小写、搜索超 500 项报错、HTML 标识插进脚本、端口选取竞态（后端改为自己监听 0 并避开禁用端口，`free-port.ts` 删除）。C：发送停靠的四个边界（滑入中释放地板、编辑框 hold 否决、新对话首问、超高问题）、首页切换追求目标误改上一对话、目标达成提示漂移、深色下粘性行透光、停侧聊误停主朗读。D/E：目标栏跨对话覆盖、模型字段 Enter 加错、收起预览遇菜单消失、若干表单与 RTL 细节、旋转 PDF 的批注/文字层、Markdown 相对资源按错目录。未改：C-8 误报；E-3、E-4 与 MiMo 一致。
- **写代码逻辑**（`r20/agent-logic.md`）：语言注入、读取上限、叙述规则与 MiMo 一致；首句英文是模型未遵守。补 read/write/grep/bash 说明里 MiMo 的建议，任务清单与冒号示例改中文，删无 MCP 时的英文说明，最后一步改为带工具 + `tool_choice: none`（照 MiMo，局域网 qwen38 实测通过）。
- **对话页校准**：V1 消息流 28 项（回合头 26.4px、文字/步骤统一 12px、工作指示器挪进回合、气泡与时间 8px、MiMo mut 对应 `--text-base` 的一整类颜色、代码块/行内代码/粗体 600/嵌套列表/表格/删除线、复制与分支图标、流式淡入 .32s）；V2 标题栏与输入框 13 项（「打开位置」仅 macOS、标题起点 18、+/麦克风去边框、上下文圆环、9px 停止方块、描边发送箭头、无聚焦光环、权限图标）+ **标题栏单击就地重命名**（侧栏行仍弹窗，同 MiMo）；V5 侧栏（用户定）：搜索与铃铛移到字标行右端、底部改为 MiMo 形状的一行（28px 头像 +「本机」+ 设置菜单，删「深色」行）、字标行 52px、气泡加号图标、16px 文件夹、列表边线；顺修长列表不滚动与 ContextMenu 定位差 4%。
- **文案**（`r20/copy.md`，用户定：锁定值一并改、用词完全照 MiMo）：约 200 键 / 2000+ 值；「追求目标」全套、报错一句式、供应商 / API Key / 引擎 / 聊天 / 会话、单个「…」；修复制按钮「复制回复 / 已保存」与下载失败显示「检查更新失败」；`smoke-wording.ts` 的「一律对话」规则删除。
- **违规记录**：写代码逻辑审计代理为查原因读取了用户真实数据目录下那条对话（只读）。已向用户说明，并记入记忆 `subagents-never-read-real-profile`：以后每个代理的提示都要写明禁止读取真实数据。
- 验证：typecheck、i18ncheck、wiringcheck、themecheck、promptcheck、toolcheck、sessioncheck、mdcheck、build 全过，smoke **6453 全过**；各路新检查都在旧代码上证明会失败，界面项都在真窗口（一次性配置、窗口可见）实测并看过截图。

## 当前状态（2026-09-22，第二十轮之前）

- **对照基准**：MiMo 26.920（第十八轮起）。第十九轮逐页重新对照后确认的 28 条差异、两项性能遗留、交接文档记着的遗留项都已做完；目前没有已知的、未决的差异。
- **版本**：0.3.8（`4f5120e`，`dist\MCode-0.3.8-x64.exe`，225.7 MB）已静默装到 `D:\Apps\MCode` 并验证能启动；此后代码没改过，不需要重新打包。
- **验证**：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、sessioncheck、build 全过，smoke **6143 全过**。
- **GitHub**：`v2.0` 已推到 `origin/v2.0`；2026-09-22 开拉取请求 #4 并按用户要求合并进 `main`（合并提交 `76b86ed`，保留全部提交历史），并把 0.3.8 安装包、blockmap、`latest.yml` 发布为预发布版 `v0.3.8`（标签指向 `v2.0` 当时的 HEAD）。自动更新地址仍是占位 `updates.invalid`，所以发布不会触发任何更新。
- **仍与 MiMo 不同、且不算缺口的**：用户定的有意差异（见「与 MiMo 故意不同的地方」和记忆 `mcode-deliberate-differences`）；第十九轮我定、已告知用户的两处——PDF 文内链接可跳转（MiMo 的点击拦截让它失效）、「（AI生成）」按界面语言翻译（MiMo 全语言写死中文）；依赖小米账号 / 服务的功能；需要 Linux、macOS 真机才能核对的细节；需要新 token 名的 V10。
- **2026-09-22 用户截图报告**：产物中心列出 8 个对话早已删除的文件，点「进入对话」报「找不到对应的对话」。原因是第七轮 S5 按「文件比对话活得久」删对话只解除关联、保留记录，而 MiMo 删对话会连产物记录一起删。**用户改为照 MiMo**：`detach` 删掉该对话的来源（别的对话也写过的文件留在那个对话下）；产物库升到版本 3，打开旧库时清掉此前留下的无主来源；启动时 `forgetMissing` 清掉「对话已不存在但没通知到产物库」的来源（读不出的对话算存在，L12-11）。磁盘文件一律不动。产物中心仍无删除按钮（MiMo 同样没有）。检查 `smoke-artifact-forget.ts`，`smoke-storage.ts` 相应改写。
- **仍未在真窗口验证的**：拖选时暂停跟随（探针的合成拖拽选不中文字，只用「选区留在对话里」间接验证）；批注发光的两种新入口（需真实发送，只有 smoke）。
- **下一步可做**：见文末「下一步建议」。

## 现在到哪了

对照 MiMo 26.912.121036：第一轮（原清单 69 项 + 截图对照 13 项 + 清单外审计）**合计 134 项，全部完成**。

**第二轮全面对照（2026-09-14 起）：四个只读审计代理分别对照输入框与首页、对话视图、侧栏与面板、设置与弹窗，去重后合计 74 项，已全部完成（C18 核实后不适用；C13 / G9 / G10 与其他项重复）。** 每项做之前再核实一次，做完用探针验证并在 HEAD 上确认失败。

对话视图（C）：
- C1 [已完成] 回复 Markdown：KaTeX 公式（行内 / 块 / ```math、\(\) \[\] 改写、红色错误，字体本地打包）；mermaid 图（流式时保持代码块、正在渲染图…、图/代码、缩放 25–300%、放大、复制图片、「…」下载到本地 / 下载为图片 / 复制代码 / 查看代码、换主题重绘、strict + DOMPurify）；可点链接（蓝色下划线、系统浏览器打开、裸网址自动链接、脚注；mailto 不可点，主进程只放行 http/https）；文件路径芯片（点击用默认程序打开，main/paths.ts 拒绝约 60 种可执行扩展名，相对路径先解析再进文件标签或定位，右键 打开文件 / 复制图片 / 复制路径 / 在…中显示）；图片（远程 420 / 图片链接 240，CSP img-src 加 http: https: blob:；本地图片卡 320、加载中 / 无法加载；本地视频音频播放器）；表格、代码行号、段内换行、嵌套列表、任务列表、删除线、标题字号、引用 3px、分隔线 1px；```svg 与原始 <svg> 画成图解。与 MiMo 仍差：本地 .svg 文件是普通图片卡、音频用原生播放器、预览无从原位放大动画。探针 mcode-round2-markdown.cjs 16 项全过
- C2 [已完成] 步骤行：工具 14px 图标（lib/tool-meta.ts + parts/StepIcon.vue）、按状态动词（已读取 / 正在读取… / 读取失败 / 已拒绝 / 未执行：读取，失败红字、跳过删除线），运行中闪烁
- C3 [已完成] 分组摘要：lib/step-rows.ts 按连续同类分组，「已读取 N 个文件 · 已运行 N 条命令 …」（lib/plural.ts），含失败步骤标记「本组包含失败步骤」，运行中展开、出现正文后自动折叠
- C4 [已完成] bash 展开上格「# 描述 + 命令」下格输出，MCP 工具上格 JSON 入参，标题提示「⌘/Ctrl+点击打开」
- C5 [已完成] 编辑 / 写入行标题带 +N −M：照 MiMo `hs-diffstat`——标题后 12px，等宽 14px，「+N」用 `--diff-add`、「-M」用 `--diff-delete`，为 0 的一侧不显示、两者之间一个空格；数字按 `metadata.diff` 各 hunk 的增删行数计（MiMo 的 `Tce` 同样只数 hunk 内的行）。（C2 重做步骤行后，箭头照 MiMo 紧跟文字后，不再留在行尾）——探针 mcode-step-diffstat.cjs 6 项全过，HEAD 上 5 项失败（「读取行无统计」本就成立）
- C6 [已完成] 回合头：照 MiMo harness-head——运行中是「已处理」加扫光（TextShimmer）和每秒递增的计时；完成后用过工具的回合整行是一个按钮（文字 + 时间 + 12px 半透明 chevron，展开时转 90°，aria-expanded），没用工具的只是文字；时间格式照 MiMo `SMe`：「12s」「1m 5s」，不随语言变。探针 mcode-turn-head.cjs 4 项全过（完成回合是按钮、点整行折叠展开、无工具不是按钮、运行中计时递增），HEAD 上 4 项全败
- C7 [已完成] 提问表单停靠在输入框上方（QuestionDock.vue + lib/confirm-queue.ts）：与权限请求同一队列按到达顺序，「1/N」合计；第 N 题（单选/多选）、‹ N / M ›、放弃（发空答案，记录里显示已取消，错误码 `question.dismissed`）、数字键选项、单选自动下一题、跳过 / 下一题 / 橙色提交、自定义输入禁用单选、无 Esc、每页上浮淡入 0.18s；有提问时输入框发送的纯文本回答第 1 题。与输入框同列 712、同底色 `--surface-menu`、信息卡打开时同样让位。另加审批引导卡「想减少审批提示吗？」（手动确认 3 次后出现：本任务放行 / 帮我审批 / 保留手动审批）。计划模式文案跳过（MCode 没有计划工具）。探针 mcode-round2-dock.cjs 18 项全过
- C8 [已完成] 已回答提问显示答案、已取消提问卡「需要你确认 · 已取消」（parts/QuestionCard.vue），不进工具分组
- C9 [已完成] 已决定的权限留一行（parts/PermissionRow.vue：已允许(本次) / 已拒绝并反馈 …，`part.metadata.permissions`）；拒绝（含「拒绝并说明」，按用户决定）即停止回合，理由留在权限行和工具结果里，随下一条消息给模型；MiMo 本身只有直接拒绝才停
- C10 [已完成] 回复下方操作行：原悬停页脚（智能体 · 模型 · 强度 · 耗时 · 时间）换成 MiMo 的 `msg-actions`——常显，先「复制」后「分支」（侧聊无分支），26px 圆角 7、12px 图标、间距 2、上边距 -2（紧跟改动文件卡时 10），按下缩到 .96；完成时间在竖线后，仅悬停/聚焦时显示；复制改为吐司「已复制」；时间格式同 MiMo（中文「M月D日 HH:MM」，跨年加「YYYY年」）。新键 `stream.replyCopy/replyBranch/replyCopied`，删去 `stream.fork`、`effortName`、`modelName`——探针 mcode-reply-actions.cjs 6 项全过，HEAD 上 6 项全失败
- C11 [已完成] 回到底部按钮：34px 圆形描边带阴影、距底 14、居中于阅读列，文案「回到底部」（新键 `stream.jumpToBottom`，`stream.jump` 是参照镜像键不能改值）——探针 mcode-jump-bottom.cjs 5 项全过，HEAD 上 4 项失败
- C12 [已完成] 分支出来的对话顶部「从对话中派生」标记：照 MiMo ForkRow——两侧 1px 细线、中间 13px 链接色按钮带分支图标、距第一问 26；点击回到源对话并提示「已回到源对话」，源对话已删则提示「源对话不存在」并留在原处；分支时提示「已从此处创建分支」。`SessionInfo.forkOf` 由 `SessionStore.fork` 写入；新键 `stream.forkedFrom/backToSource/sourceNotFound/branchedFromHere`——探针 mcode-fork-row.cjs 5 项全过，HEAD 上 4 项失败（第 5 项「原对话无标记」本就成立）
- C13 [已完成] = S10（标题栏菜单「复制」子菜单）
- C14 [已完成] 信息卡：InfoPanel / InfoSection / InfoSubgroup，环境与分支（切换有未提交改动时确认）、提交 / 推送卡（服务端 git summary/commitState/commit/push/commitMessage）、任务计数、产物「更多 / 中间产物」、参考「用户上传 / 项目文件」、计数增加自动展开、窄窗浮层
- C15 [已完成] 对话内查找：照 MiMo ThreadView 的查找栏重画 FindBar.vue（距对话区顶 54、右 20，圆角 10、1px 边、阴影 0 4 16 .14，15px 放大镜、180 宽 13px 输入框、42 宽 11px 居中计数、22px 上一个 / 下一个 / 关闭），文案新键 `stream.find.*`（`ui.fileSearch.*` 是参照镜像键不能改）。计数照 MiMo：`cur/total`，搜不到显示「无匹配」，有折叠步骤里的匹配时显示「cur/total(未展开 N)」——新文件 lib/find-folded.ts，MessageStream 注册计数器，统计不在页面上的工具行（回合步骤未展开，或查找类分组未展开）的标题匹配，ToolPart 根节点加 `data-tool-part`；上一个 / 下一个只在可见匹配间移动。探针 mcode-find-bar.cjs 6 项全过（样式位置、折叠计数、无匹配、展开步骤后分组仍折叠、全部展开后 1/4、Esc 关闭），HEAD 上 6 项全败
- C16 [已完成] 回合内「正在重新连接 N」行（parts/RetryRow.vue，服务端 session/retry.ts）和内联错误步骤「错误：…」（parts/ErrorStep.vue）
- C17 [已完成] 只有思考没有回答时的提示：照 MiMo `thinkOnlyNoAnswer`，回合结束、没有正文和工具、但有思考内容时，显示错误卡片（带重试）「(模型只输出了思考过程，没有给出正式回答。…)」，不再显示「（无内容返回）」；什么都没有的回合照旧。新键 `stream.thinkOnlyNoAnswer`（18 张表，14 种取自 MiMo 自带翻译）。探针 mcode-think-only.cjs 3 项全过，HEAD 上关键项失败
- C18 核实后不适用：MCode 没有「空对话」界面，没消息时就是首页
- C19 [已完成] 工具参数错误被拦截（server tool/validate.ts）显示「未执行：…」加删除线
- C20 [已完成] 用户消息下方：照 MiMo `user-meta`——气泡下 2px，时间在前、复制 / 编辑（仅最后一问）在后，时间与按钮隔 6、按钮间 2，按钮同回复行 26px 圆角 7、12px 图标；时间和按钮平时透明且按钮不接收点击，悬停或聚焦时出现；提示「复制」「编辑」，复制改为吐司「已复制」（去掉勾号切换与 `copied` 状态）。`stream.copyAsked` 18 张表改为各语言的「复制」；旧 `.footer` / `.copy` / `.user-footer` 样式删除——探针 mcode-user-meta.cjs 5 项全过，HEAD 上 5 项全失败

输入框与首页（I）：
- I1 [已完成] 录音胶囊：圆形麦克风展开成胶囊，启动中（转圈）/ 录音中（5 条波形 + ×）/ 转写中（转圈 + ×），× 丢弃录音或待转写内容
- I2 [已完成] 附件：换行排列，图片 / 视频 54px 缩略图点开预览，文件胶囊带 ×；顺序 附件 → 技能芯片 → 批注
- I3 [已完成] @ 菜单按目录浏览：「文件」头、‹ 工作区 / 面包屑、每个文件夹「引用」和 ›、当前目录内 150ms 搜索、加载中 / 无法读取 / 搜索失败 / 截断提示、无项目「选个项目后可引用文件」；Tab 引用文件夹、空查询 Backspace 返回上级（服务端 file.listDir / file.search）
- I4 [已完成] 技能芯片：斜杠菜单或加号菜单「技能 ›」（可搜索）选中后成芯片，发送时以 `/name` 前缀发出，由服务端加载技能正文（第十轮更正）
- I5 [已完成] 加号菜单：更多 / 添加照片和文件、分隔线、终端常驻（首页打开底部终端）、去掉计划模式开关、编排模式文案，靠近窗口底部时向上翻
- I6 [已完成] 中断回合的「继续」：上一回合被停止、失败、未完成或无回复且输入框为空时显示播放按钮，服务端 session.resume（runner.resumeTurn，不写用户消息），无法继续时提示「当前回合无法继续」
- I7 [已完成] 压缩上下文中：输入框锁定、占位「正在压缩上下文…」、发送位转圈；输入或菜单 /compact 按 MiMo 的前置检查与提示
- I8 [已完成] AI 免责声明：首条回复前隐藏但占位，文案「内容由 AI 生成，请注意核实」，浮动对话里不显示
- I9 [已完成] 输入区：有内容时字重 500；窗口 ≥2000px 时最小高 70、停靠区 1000 宽（保留 MCode 的 52px 下限而非 MiMo 的 44，52 才对得上此前实测的 103px 卡片）
- I10 [已完成] 加号 / 麦克风 30px 圆按钮带细边，空态发送不禁用、提示「请输入内容」，按下缩到 .96
- I11 [已完成] 占位文字随 计划 / 编排 / 压缩 模式变化，附件不再清空占位
- I12 [已完成] 粘贴代码自动包围栏：≥5 行且为合法 JSON 或 ≥3 行符合语言特征
- I13 [已完成] Ctrl/Cmd+Enter 换行；快捷键表加「发送消息」，改绑也不会吞掉全局 Enter
- I14 [已完成]（用户 2026-09-14 定：照 MiMo 改）运行中的停止键：照 MiMo 输入框 `l8e` / `c8e`——对话运行中，单独按 Esc 直接停止，框里有草稿也停、草稿留着；只按 Ctrl+C 且框内没有选中文字时停止，有选中时照常复制；带 Shift / Alt / Meta 不算；@ 或斜杠菜单开着时 Esc 只关菜单。原来「只有空框时 Esc 才停」的保护去掉——探针 mcode-stop-keys.cjs 6 项全过，HEAD 上两项核心检查失败（带草稿 Esc、Ctrl+C），其余 4 项保护检查改前改后都成立
- I15 [已完成] 上下键翻历史时暂存草稿、回到末尾恢复
- I16 [已完成] Backspace 整个删掉 @提及
- I17 [已完成] 拖入项目内文件变成相对路径 @提及（文件夹只写名字不附加）
- I18 [已完成] 斜杠命令在文本里的高亮底块（SlashPill.vue）
- I19 [已完成] 输入栏分左右两组，两组不在同一行时权限 / 模式芯片去掉文字，栏宽 <480 时隐藏用量圆环（JS 测量，不用容器查询以免影响子菜单定位）
- I20 [已完成] 上下文用量卡：不计推理 token、MiMo 文案与一位小数百分比、有缓存读取时显示「缓存命中率」
- I21 [已完成] 批注与引用芯片：AnnotationChips.vue（「N 条注释」悬停列表、最多 3 个编号引用芯片后「+N 条引用」、删除 / 清空、已发送消息下的只读版本，提交 56fc6aa / 015e670），框内顺序在 I2 改为 附件 → 技能芯片 → 批注
- I22 [已完成] 首页建议区：选了项目才显示三条，模型生成（server/home-suggest.ts，MCode 自己的提示词，15s 超时，按项目和语言缓存 30 分钟、失败 2 分钟），点击填入输入框，无可用模型时留空
- I23 [已完成] 零散文案：发送 / 停止 / 加号 / 权限 / 模型提示、完全访问确认标题和按钮、无可用命令、compact 说明（完全访问确认正文沿用 MCode 原句）

（输入框另做的清单外差异 X1–X10：发送键按下缩放、占位随模式、斜杠在任意行触发并原位插入、斜杠菜单高度随上方空间且去掉 8 行上限（无加载 / 失败状态，命令列表没有加载状态）、每个会话各自保留草稿（首页草稿存盘）、宽窗托盘、模式芯片合一且提示加「回到构建模式」、语音「检测到指令 · 发送」提示 420ms（只有发送口令）。探针 mcode-round2-composer.cjs 22 项。）

侧栏与面板（S）：
- S1 [已完成] 右侧面板标签页（前几轮已做）
- S2 [已完成] 提示框：顶部居中胶囊、分级配色、链接式操作，同一提示替换、悬停保持（lib/toast.ts）
- S3 [已完成] 会话行菜单：在资源管理器中显示、标记为已读 / 未读（stores/app.ts markRead）
- S4 [已完成] 「移动至项目」子菜单：搜索、无匹配、移出项目（session.moveOut）、新建项目…（ContextMenu 支持子菜单）
- S5 [已完成] 移除项目确认（ConfirmDialog 按 MiMo 尺寸重画，`danger` 变体）
- S6 [已完成] 项目区「+」弹「新建空白项目 / 使用现有文件夹」
- S7 [已完成] 项目批量管理：多选、批量归档、批量移除
- S8 [已完成] 会话批量选择栏：两行卡片、全选、归档 / 删除，删除确认文案
- S9 [已完成] 项目行在同名项目间显示 git 分支名
- S10 [已完成] 标题栏「…」菜单「复制 ›」子菜单与分隔位置
- S11 [已完成] 关闭用过的终端先确认（前几轮已做）
- S12 [已完成] 删除单个对话确认文案带标题
- S13 [已完成] 产物中心：无匹配提示、分类「全部 / 文档 / 应用 / 其他」（ArtifactsView.vue）
- S14 [已完成] 「最近」菜单排序改为子菜单
- S15 [已完成] 原生应用菜单五个菜单（main/menu.ts），preload 去掉不再用的接口

设置与弹窗（G）（审计代理拼出的 MiMo zh 文案表：scratchpad 的 aud-zh-settings.txt / aud-zh-general.txt / aud-zh-sidebar.txt）：
- G1 [已完成] 常规页分节：常规（默认打开目标、默认新建项目位置、语言、托盘）/ 权限 / 浏览器 / 语音功能 / 声音，其后 系统通知 / 显示 / 对话 / 高级 / 按工具授权 / 重置
- G2 [已完成] 确认弹窗打开时焦点在确认按钮（尺寸样式此前已对齐）
- G3 [已完成] 重命名对话 / 项目统一走 RenameDialog（430 宽、「保持简短且易于识别」、×、80 字按码点截断、输入法组字时回车不保存）；标题栏原地编辑删除；项目菜单「重命名项目」下加「项目图标与颜色」。标签页双击仍原地改名
- G4 [已完成] 更新：删掉模态，侧栏底部「更新 / 更新中… / 重试」胶囊 + 气泡（更新说明来自更新源 notes，稍后 / 立即重启更新）；MiMo 气泡插图未做
- G5 [已完成] 已归档页：标题行「批量管理」、行说明「已归档 · 项目「x」 · 时间」、恢复 / 红色幽灵删除、空状态卡片、18px 复选框；「已关闭的项目」保留在下方
- G6 [已完成] 外观页：主题卡片（跟随系统 / 浅色 / 深色）→ 应用图标 → 其余行；MCode 调色板行改名「主题配色」
- G7 [已完成] 语音：智能编辑（推荐）/ 快速输入，说明随模式；智能编辑由服务端一次模型调用（MCode 自己的提示词）按口述指令改写草稿并定位光标，校验失败退回光标处插入；「用法详情」示例弹窗（打开不抢焦点）；语音输入改为插在光标处
- G8 [已完成] 托盘开关开启时关闭最后一个窗口隐藏到托盘（macOS 始终如此），托盘 / 应用菜单 / 窗口菜单退出仍真正退出；单击 / 双击托盘打开窗口；托盘菜单 打开 MCode / 配置切换 / 退出 MCode（MCode 没有配置组，「配置切换」列出可选模型）
- G9 [已完成] = S12 / S8（删除对话确认文案）
- G10 [已完成] = S5（移除项目确认）
- G11 [已完成] 语言选择 LanguageMenu：固定「自动检测」、搜索「搜索语言」、按名称排序、「未找到匹配的语言」
- G12 [已完成] 自定义模型「高级配置」：图片输入三态、输入 / 输出上限（预设，K=1024），服务端校验并用于上下文压缩和 max_tokens
- G13 [已完成] 环境页有未保存改动时，切换导航 / 搜索跳转 / 返回 / 关闭 / Esc / 点遮罩先弹非危险确认「放弃未保存的改动？」
- G14 [已完成] 环境页移除项目确认：非危险按钮、MiMo 两行文案
- G15 [已完成] 语音控制发送确认：430 宽、警示图标、浅红按钮「我已了解风险，开启」、打开不抢焦点
- G16 [已完成] 设置搜索：也匹配关键词、输入时自动跳页、匹配行高亮 1.6 秒、「无匹配设置」
- G17 [已完成] 设置导航底部去掉 MCode Desktop / 版本号
- G18 [已完成] 浏览器分节文案「Browser 插件」与描述
- G19 [已完成] 原生应用菜单「关于 MCode」在所有平台弹 MiMo 样式消息框（版本 / Electron / Chrome / Node.js）

（2026-09-14 修复用户报的 bug：侧栏折叠后顶部「切换边栏 / 后退 / 前进 / 搜索」点不动。原因：这排按钮浮在主栏开头，而主栏自己的顶部条——首页的 `.drag` 和会话头 `.head`——是窗口拖拽区，Electron 按文档顺序计算拖拽区，排在后面的 drag 覆盖了侧栏按钮的 no-drag，Windows 把点击当成拖动标题栏。修法：App.vue 模板最末放一块 `.rail-no-drag`（fixed，top 13、start 65、120×24，pointer-events: none，app-region: no-drag，只在侧栏折叠时渲染）。探针 mcode-rail-click.cjs 检查首页和会话页四个按钮中心最后生效的区域都是 no-drag，HEAD 上两处都失败；并在真实开发版窗口里亲手点击，折叠后点切换按钮侧栏展开、点搜索浮层打开。注意：用 WM_NCHITTEST 测不出这个问题——HEAD 上也返回 HTCLIENT，这项检查无效。）（MCP 一条拆成已完成的三块和未完成的「导入 / 授权」），剩下的都在下方「待办：清单之外的只读审计结果」里没有标 [已完成] 的条目。

（合并设置分支时另修两处：外观页用 Esc 关主题下拉框会连设置窗口一起关掉——SelectMenu 的按键监听改为捕获阶段；语音用法 / 语音发送确认两个弹窗改为打开不抢焦点（modal 指令加 `data-modal-keep-focus`）。探针 mcode-round2-settings.cjs 23 项全过。）


**提示（Tips）对齐 MiMo（2026-09-15，用户要求「所有 Tips 标签效果保持跟 MiMo 一致」）**：审计（scratchpad round2-tips.md）测得 MiMo 只有一个 Radix 式提示组件，许多次要按钮直接用原生 `title`。
- 组件 `lib/tip.ts` + `styles/base.css`：默认在上方、距控件 6、距窗口边 8，放不下翻到对侧；200ms 出现、每次关闭后 300ms 内相邻控件立即出现（点击后也保留）；聚焦立即出现；Esc / 失焦 / 点击 / 按下别处关闭；只有包含控件的容器滚动才关闭，窗口缩放时重新定位；触屏不出；新选项 `disabled`（控件自己的菜单打开时压住）、`pinned`（上下文用量卡点击后常显）、`trigger: "hover"`（菜单项说明只悬停出）；浅色 #fffefd 底 1px #f1f1f1 边、深色 #181818 底 #2e2e2e 边，z-index 1000，行高 1.6，最宽 420 后换行；淡入加 0.95 缩放 150ms、原点朝向控件、关闭反向；快捷键写成纯文本「返回 Ctrl+[」，去掉键帽；信息卡边框阴影对齐。在弹窗或菜单里悬停出提示时按 Esc 只关提示，不关下层。
- 各处 60 项：缺的提示补上（模型 / 权限按钮、会话行「更多」「置顶」等）、文案（「返回」「发送」「停止」「停止语音输入」等）、该用原生 `title` 的换回（输入框拖拽条、文件面板、产物页、注释标签、置顶标记），附件缩略图去掉提示，上下文用量圆环改用组件的卡片（原 `.ctx-card` 删除）。
- 删除键：`title.back`、`term.hide`、`composer.permTip`（与 `composer.accessTip` 相同）；`wrap` 选项删除。
- 探针 mcode-round2-tips.cjs 18 项。
- 随后清理：删掉 107 个没人再用的界面文案键（`stream.count.*` / `stream.explored` / `stream.ran`、旧侧栏 / 首页 / 设置遗留等，d8d6f9a）；其中 `set.mcpForm.type_*` 和 `set.theme*` 五个是拼出来的键名，已放回（9a30913）。以后删键要以 i18ncheck 通过为准，它会查拼接前缀。


**第三轮对照（2026-09-15）：已完成。** 四路只读审计（再各拆子审计）逐项核对了此前没细查的区域，规格在 scratchpad：`r3-part-A..F.md`（右侧面板：外壳与侧边聊天 23、审查与文件 38、浏览器 25、终端 20、Office 10、PDF/网页/视频 14）、`round3-global.md`（全局 33）、`round3-part-P1..P6.md`（对话：遗留 9、12 种语言的 MiMo 译文、停靠栏与卡片 15、回复渲染 10、错误/停止/侧聊/分支 20、首页与模型菜单 18）、`r3p/part-*.md`（整页与设置：常规外观 21、模型 19、快捷键与服务器 16、MCP 5、环境与弹窗 20、产物与导出 18；插件页因用户要求隐藏而跳过 PL1–PL11）。共约 330 项，实现规则与决定见 `round3-rules.md`。

用户 2026-09-15 的决定（第三轮）：
- 一律跟 MiMo，包括去掉 MCode 独有、MiMo 没有的界面：计划清单停靠栏与已回滚消息停靠栏、「显示推理摘要」、回复代码默认换行、快捷键页的主题/语言行、搜索浮层上下键、终端额外按键（Ctrl+点击链接、Ctrl+Shift+C、Ctrl+Alt+T、中键关闭、退出红点）、模型页 Smart 区块与模型开关；PDF 重载缩放回 100%；网页缺失显示「无网页」。
- 编辑 / 重试之前的消息只删后面的消息，不再回滚项目文件。
- 做子智能体（后端工具 + 对话行 + 右侧「子智能体」面板），等第一波合并后单独做。
- Ctrl+W 关闭窗口；普通文字和链接右键用系统原生菜单。
- 仍保留：侧栏顶部靠左（**2026-09-21 扩展到收起状态**：非 macOS 下收起后的切换 / 新建任务按钮也在 x=18，标题栏让到 72、全屏标签让到 82、防拖拽补丁跟随；macOS 仍照 MiMo 75 避开红绿灯；R18-U13，smoke-round18-shell 两项）、内容下移 4px、首页静态字标、四个圆点、两种拒绝都停止回合（**第十八轮已撤销**：MiMo 26.920 改为拒绝后继续，MCode 照改）；托盘「配置切换」列模型但照 MiMo 的呈现（MiMo 这一版其实已在导航里关掉了配置切换页）。

实现分 11 个并行任务：右侧面板外壳与侧聊、审查与文件、浏览器、终端、文档与媒体预览、全局外观与行为、输入框首页与模型菜单、对话流与卡片、回复渲染与媒体、设置页与弹窗、产物页与导出；之后是子智能体和 12 种语言译文。

合并进度（2026-09-15）：11 个实现分支和一个跨负责人交接整合分支（`App.vue` / 右侧面板 / 设置 / 输入框的交接项）已全部合进 `v2.0`，12 种语言译文已补（c93bb0b）；子智能体已合并（3d28125）：`task` 工具（`description` / `prompt` / `subagent_type` = explore 只读按 Plan、general 按 Build），每个子智能体是独立子会话（名称按类型编号，不嵌套，不出现在侧栏 / 搜索 / 产物页，删父对话一并删除），同一回复的多个调用并行，父对话 Stop 级联停止，子智能体改的文件记入父回合，权限与提问进同一停靠栏并标出子智能体头像名；对话里是 MiMo 的子智能体胶囊行（高 30、最宽 240，「开始工作 / 已完成」），右侧「子智能体」标签页有概览（已开启 · N / 完成 · N）与每个子智能体的执行记录（「初始任务」「处理中」）；带 `subtask` 的斜杠命令交给子智能体执行。与 MiMo 的差别：只做了阻塞式一种（MiMo 的 actor 另有后台 spawn / status / wait / send 与停滞看门狗），数据来自消息与推送事件而非每 2 秒轮询，头像是 MCode 自绘圆脸（选色规则同 MiMo）。合并后 typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck 54、smoke 929 全过。合并与复验中另修：
- **严重**：「差异标记」默认「颜色」时整窗空白。scoped 样式里 `:global(X) .y` 被 Vue 编译成裸 `X`，于是 `html[data-diff-marks="color"]{visibility:hidden}`；同一写法还让差异 / 文件标签的暗色变量落到 `:root`、浮动输入框的紧凑规则落到 `#float-dock`。全部改成普通 scoped 选择器（5e9d665），问答表单 `:root[...] :is(...)` 暗色规则展开成逐条选择器（34d95ae），themecheck 新增守卫，已用故意写坏的组件证明会失败（b284b06）。
- 设置分支快捷键页多一个 `</div>`，vue-tsc 放过、vite 构建失败，交接整合分支修掉（ececd03）。
- 快捷键命令改名后，旧自定义按键在读配置时迁到新 id（a0ef60b）。
- 空输入框右键菜单缺「全选」（Chromium 对空框报 canSelectAll=false），主窗口与浏览器页一并修，smoke 改用真实标志（5049715）。
- 版本历史备注提示按自身 300px 宽度夹紧（13b2831）。
- 回复代码块一直不着色：`highlight()` 以 `id NUL code` 存缓存、`cachedHighlight()` 以 `id 空格 code` 取，永远取不到且每帧重排；改为共用键（4bbcd37）。
- 输入框右键菜单改为 MiMo 顺序：剪切 / 复制 / 粘贴 / 全选（db65863）。
- 在产物页点侧栏里当前那个对话会离开产物页（92fd1ba）。
- 快捷键页列表无法滚动（第 8 行以后够不到）：表格在 `overflow:hidden` 里、页面本身不滚动，而 `.keys-list` 滚动规则没有元素使用；包进 `.keys-list`（a9851cd）。
- 连续关闭三个用过的终端时 Electron 偶发段错误（探针 4 次里 2 次，终止于三个 ConPTY 背靠背 kill）；shell 改为逐个 kill、间隔 400ms，`closeAll` 等待上限随队列延长（3753858）。原因未完全证实，最终探针连跑三次终端验证。
- 右侧面板展开后浮动输入框沿用主输入框的 44px 高度（A18）；输入框移入 / 移出浮动位置时重新适配高度。
- 第三轮探针核对的共同根因（不是应用 bug）：`showInactive()` 的探针窗口约 9 秒后会被外部最小化，最小化后每秒约 1 帧、鼠标事件迟到、过渡动画停在首帧、`setSize` 无效；所有探针已加「被最小化就重新 showInactive」守卫并改为等待事件真正到达。另：对可拖动元素做合成拖动会进入 Windows 系统拖动循环、阻塞主进程直到真实鼠标松开，探针需要在该手势里取消 `dragstart`。
- 快捷键页没有加 MiMo 的「插件 Ctrl+Shift+P」行（插件页按用户要求隐藏）；「新建任务」行不显示 MiMo 的「开始一个无项目任务」说明（对 MCode 不成立，`desc: false` 为有意）。
- **最终验证（aecd3d7 之后的构建）**：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck 54、smoke 929 全过；第三轮探针 previews 25、panel 25、artifacts 15、terminal 29（连跑三次无崩溃，其中一次 `D11_clampedAt640` 偶发未过、另两次通过）、browser 24、files 37、reply 29、global 19（G19 仅 macOS 跳过）、stream 34、composer 31、settings 38、handoffs 13、subagents 12，第二轮 tips 18、sidebar 23、info 23、dock 18、steps 23、composer 22、markdown 16、settings 23，convo-card 8、find-bar 6、right-panel 12，全部通过。F14（批注输入框里的「添加到对话」实心图标）探针够不到跨域页面框架，标 n/a，源码已是实心图标。
- 各分支自带探针此前从未运行，由三个核对任务逐项区分探针问题 / 负载 / 待交接 / 真 bug；探针修正都在 scratchpad，带 "Triage" 注释。

（审计中发现并已修：删无用文案键时误删的 `time.*` 相对时间文案导致已归档页显示键名，a8ced00 放回；原生菜单文案列表去掉 21 个主进程不再使用的键，74ea932。）


**第四轮对照（2026-09-15）：已完成并验证。** 最终（7c722bc 之后的构建）：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、smoke 1161 全过；第四轮探针 projects 10、leftovers 11、subagents 10、voice 21、small 21、tools 12、feedback 26、crosschat 10、rich 18 全过；回归 round3-stream 34、round3-subagents 12、round3-reply 29、round3-global 18（控制台那一条是探针故意抛出的出错兜底，G19 仅 macOS）全过。冒烟里子智能体 Stop 的四项此前偶发失败（`task` 调用停在 pending）：这组检查共用的项目已积累数百个文件，每轮开始的项目快照在同一把 git 锁下排队，偶尔超过 10 秒；现在改用自己的小项目目录，并在失败时打印步骤、子会话、待批权限和忙碌会话。 前三轮按界面区域逐块对照；这一轮换角度，把 MiMo 界面上约 2800 条文案逐条找 MCode 的对应物，找从未对照到的功能 / 状态 / 提示（三路只读排查：常规与设置 `round4-strings-settings.md`、对话与输入框 `round4-strings-convo.md`、右侧面板与各页及主进程文案 `round4-strings-panel.md`）。同时实现已知遗留：
- 子智能体照 MiMo 的 actor：后台运行、查状态、等待、取消、给子智能体发消息、模型列表、卡住检测；
- 项目独立存在：持久化项目列表，添加文件夹不再需要先建对话（DL9 / DL15）；
- 文案排查结果（设置侧 18、对话侧 9、面板与页面侧 9）：操作后的提示与撤销（归档、删除、切换模型 / 权限 / 模式、附件、排序、项目改名 / 改位置、应用图标、设置保存失败重试、更新启动失败看门狗、Linux 显示服务器）、语音报错分类与麦克风隐私设置、替换上一轮时拦截发送、信息卡拉取请求行、首页欢迎语「和 MCode 一起探索无限可能」、网页标签批注上限提示、项目文件夹对话框标题与默认位置；以及新工具 `pdf_locate`、`present_files`（交付文件卡片）、桌面设置工具、跨对话工具与侧栏状态、回复里的 ABC 乐谱和视频平台卡片。
- 用户 2026-09-15 第四轮决定：做跨对话工具与侧栏状态，但不做把本机 Claude Code 当外部联系人（不运行第三方 CLI、不读其记录）；新增依赖 abcjs（已装，b7515c0）；视频平台卡片照 MiMo 内嵌这 14 个平台的播放器（CSP 只放行这些播放器地址）；桌面设置工具照 MiMo 直接修改、不弹权限。
- 项目独立存在已合并（c283be1）：持久化项目列表（`config.projects`，一次性迁移 `projects-list`），添加文件夹不建对话，空项目照 MiMo 显示，「暂无项目」行，添加 / 移除提示。
- 上两轮未完成的小项：旧格式快捷键兼容（KS6）、标题栏服务器弹层（KS15）、分支选择器（DL17 / DL18）、文件菜单图标颜色与最小宽度（B23）、模型页说明的其余语言（MO4）、完全访问确认文案（I23）、更新气泡插图（MCode 自绘，G4）、终端 Nerd Font 字体栈等。
- 已合并：遗留小项、后台子智能体、语音报错与替换拦截、小项（欢迎语 / 批注上限 / 项目文件夹对话框 / 拉取请求行，f0d75f7）、内置工具（pdf_locate / present_files / 桌面设置，d211117）、操作提示与撤销（9054257）、P5-5 失败轮无头部（7d58cf8）、跨对话工具（97bcd14；子智能体拿不到这四个工具，c96b0c6）、ABC 乐谱与视频平台卡片（4a21814）。
- 探针核对中发现并已修（18d6097）：没有打开任何对话时（首页、刚归档当前对话后），侧栏对话行右键菜单的重命名 / 归档 / 删除是灰的——行菜单借用了「当前是否打开对话」的命令条件。现在行菜单只看这一行是否存在（标题栏菜单仍按原条件），归档和删除直接作用于这一行、不先打开它。其余第四轮探针失败均为探针问题（通知原地替换、`:has()` 样式延迟、响应式代理不能克隆、挂起的对话框 promise 死锁等），已在草稿区修正。
- 第四轮探针（18d6097 构建）：projects 10、leftovers 11、voice 21、small 21、tools 12、feedback 26、crosschat 10 全过；rich 18 项中 `quiet` 未过——播放器 iframe 同时写了 `allow` 里的 fullscreen 和 `allowfullscreen`，Chromium 控制台告警，已删掉后者（7c722bc，待重建复核）；subagents 10 项中 R1/R3/R4/R5/R6 未过，核对结果全是探针问题（回合结束后步骤收进回合头、步骤组头仍关着、展开后没等 Vue 画出就读、读到了没有摘要的「可能停滞」通知），修正探针后 10 项全过，无 app bug。回归：round3-stream 34、round3-subagents 12 通过。注意：此前的汇总脚本只数布尔判定，`{pass, got}` 形式的判定被当成通过，之前记的「subagents 10 项通过」不成立；草稿区 `verdicts.cjs` 两种形式都认。
- 乐谱与视频卡片与 MiMo 的差异：播放用 MCode 自己的 Web Audio 合成（MiMo 用内置 FluidSynth 音色库；abcjs 自带合成要从外网拉音色，CSP 不放行），声音较朴素，`abc.playFailed` 用自己的句子；MiMo 的播放地址表只有哔哩哔哩和 YouTube，所以只有这两个内嵌播放（`frame-src` 只加这两个地址），其余 12 个平台用系统浏览器打开；卡片挂在每段文字下方而不是整条消息下方；封面直接 https 加载、不带平台 referrer（失败时退回平台底图）。回复里出现这类链接时会向平台请求标题 / 封面（和 MiMo 一样，没有关闭开关）。

**第五轮对照（2026-09-15 / 16）：已完成并验证。** 最终（b08699a 构建）：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck 54、shellcheck 全过，smoke 1931 全过，26 个探针全部通过（第五轮 13 个 + 第四轮 9 个 + 第三轮 4 个回归）。两路核对的十三项探针失败全部是探针自身问题或过期预期，**没有发现应用缺陷**，仓库源码在核对阶段一行未改。 前四轮看界面区域和界面文案；这一轮换到界面背后：主进程与桥接接口（IPC、生命周期、窗口、托盘、通知、更新，`round5-main.md`）、引擎与工具（工具清单与限制、回合循环、模式、提供商、MCP、权限、存储，`round5-engine.md`）、渲染层状态与规则（持久化偏好及默认值、设置项选项、键盘与焦点、空 / 加载 / 出错状态、时间常量与上限，`round5-renderer.md`），以及前几轮记下但用户没选择保留的差异（`round5-recorded.md`）。本机 MiMo 已自动更新到 26.914.142245（前四轮对照的是 26.912），另加一路找这一版新增或改动的界面功能（`round5-newbuild.md`）。五路只读排查，报告在草稿区。
- 主进程报告（22 项）已出，先开工不需要用户拍板的：M1 回合进行中阻止系统休眠、M2 自动检查更新并后台下载、M3 安装更新前的系统通知、M4 原生主题跟随应用主题（防启动闪白）、M5 全屏时的退出全屏按钮、M6 主进程未捕获异常只记录不弹框、M8 按天写日志文件（保留 15 天）、M9 硬件加速开关（「性能」分节）、M10 显示器变化后把窗口拉回屏幕、M11 唤醒 / 解锁 / 还原后重绘、M12 关机注销算作退出、M13 录快捷键时暂停菜单加速键（先用探针确认会不会误触）、M14 从托盘显示时恢复窗口位置、M17 macOS Dock 图标跟随应用图标。
- 用户 2026-09-15 第五轮决定：
  - M7 崩溃 / 卡住照 MiMo 静默重建窗口（去掉对话框和导出日志）；M21 会话链接跳转保留（故意不同）；M22「新建窗口」删掉。
  - 技能：做技能工具（`skill` / `skill_search`、`/技能名` 自动加载、附 Office / PDF 时提示）+ MCode 自己写的内置技能。
  - 视频卡片完全照 MiMo：14 个平台都在应用内浏览器标签打开，删掉第四轮做的哔哩哔哩 / YouTube 内嵌播放；封面图照 MiMo 由主进程带平台来源头代理（限定图片服务器白名单）。
  - 计划模式完全照 MiMo：计划文件、退出计划模式批准、切换提醒、命令按权限询问、跨对话工具可用。
  - 放宽安全照 MiMo：首装默认「帮我审批」并允许完全访问；应用内浏览器接受本地文件路径；项目命令模板里的 !`命令` 调用时执行。
  - 新依赖与后台功能都做：乐谱真实音色（FluidSynth + 音色库，不用小米服务器，先调研许可与分发）、历史与记忆检索（优先用 Electron 自带 Node 的 `node:sqlite`）、定时任务。
- 进行中的构建（各自工作树）：主进程（M1–M6、M7、M8–M14、M17、M22）、引擎工具 / 权限 / MCP（E2、E20–E27、E30、E33–E38、E43、E45–E49）、回合循环 / 提供商 / 提示词（E1、E6–E19、E40–E42、E44、E50、R27）、技能与 `actor` / 任务登记（E3、E4、E28、E39、E51）、渲染层状态与侧栏（R1–R8、R11、R13–R15、R17、R18、R28、R29，含 N2 八种提示音）、键盘 / MCode 独有设置与快捷键 / 已记差异（R9、R10、R19–R22、R24–R26、D1–D11、D19）、历史 / 记忆 / 定时任务（E29、E31）、26.914 界面变化（N3–N8）；调研乐谱音色方案。等这批合并后再做：视频卡片改应用内浏览器与封面代理、计划模式、首装默认权限、浏览器本地文件、命令模板执行命令。
- 已合并：
  - 主进程 16 项（分支自测 smoke 1232、探针 29 项全过）：`power.ts` 阻止休眠、`updater.ts` 自动检查更新（启动 5 秒后、每 3 小时，后台下载）、`install-notice.ts` 安装前通知、`boot-prefs.ts`（主题与硬件加速，窗口创建前读取）、全屏退出按钮、未捕获异常只记日志、`renderer-health.ts` 静默重建窗口（对话框与导出日志已删）、`log-file.ts` 按天日志（15 天，写入前脱敏）、`displays.ts` / `work-area.ts`、关机算退出、托盘恢复位置（修了分数缩放下每次放大 1px）、Dock 图标、删「新建窗口」。M13 经探针确认录快捷键时菜单加速键不会误触，未做。与 MiMo 仍不同：缓存安装包只在更新源给了 sha256 且一致时复用；安装通知不承诺自动重开（NSIS 安装程序不会）。
  - 键盘 / 设置 / 已记差异 22 项（分支自测 smoke 1183、探针 16 项全过）：R9、R10、R19–R22、R24，R25 删掉常规页 MCode 独有行（保留语音模型行，服务端 `app.reset` 一并删除），R26 删掉 MiMo 没有的默认快捷键（迁移 `keybind-retired-r5`，Ctrl+1–9 MiMo 有、保留），D1–D11、D19。与 MiMo 仍不同：本地媒体路径只预览项目目录内的（MiMo 任何路径）；MCP 改动「下个对话生效」的记录不存盘，重启后重新记录。合并时 SettingsDialog 冲突：保留「性能」分节，去掉已删的行。
  - 渲染层状态 18 项（分支合并 v2.0 后 smoke 1274、探针 18 项全过）：R1 输入框草稿连附件 / 技能标签 / 批注存盘到 `userData/storage/composer-input.json`（300ms 与关窗时写，旧 localStorage 首页草稿迁入）、R2 八种提示音默认晨曦（自合成加混响，迁移 `chime-r5`）、R3 访问级别按会话存（`SessionInfo.access`、`session.access`，首页改默认值）、R4 立即切换并显示加载中、R5 侧栏拖宽 160–420、R6 收起栏悬停「新建任务」出最近对话卡片、R7 / R8 折叠状态记忆、R11 错误边界带重试并拆分输入区 / 信息面板 / 设置、R13 思考强度改全局默认「中」（删会话级强度与「默认强度」行）、R14 无可用模型提示并刷新、R15 音频附件格式与 10 分钟上限检查、R17 聚焦刷新文件树、R18 搜索高亮 1.2 秒淡出、R28 最近排序不再存、R29 加载更多状态。与 MiMo 仍不同：草稿附件连数据存（MiMo 只存路径）；音频检查在渲染层做。R11、R29 未经探针在窗口里验证。
  - 技能与 actor（分支合并 v2.0 后 smoke 1341、探针 round5-skills 9、round4-subagents 10、round3-subagents 12 全过）：技能来源照 MiMo 桌面端（内置、数据目录、项目 `.mcode` 向上到仓库根；不再读 `.claude` / `.agents`），自写 frontmatter 解析；`skill` / `skill_search` 工具、系统提示技能清单、`/name` 自动加载（最多 3 个）；`resources/skills` 16 个 MCode 自写内置技能（docx / xlsx / pptx / pdf 等，脚本只用标准库，pdf 脚本依赖 pypdf）并随安装包发出，附 Office / PDF / 表格时提示；子智能体工具改名 `actor`（旧对话里的 `task` 调用读取时映射，磁盘不改写），`todowrite` 换成 `task` 任务清单（T1、T1.1，信息卡读它）。（第十轮更正：E39 当时只做了 `task_id` 的校验与记录，没有自动开始任务、也没有完成闸门，第十轮 T10-16 补上。）与 MiMo 仍不同：不支持 `skills.paths` / `skills.urls`；任务存 JSON（MiMo 存 SQLite），无跨会话任务参数；内置技能未做依赖 MCode 没有的能力的那几个。
  - 首装默认权限与浏览器本地文件（探针 23 项全过）：只有 config.json 不存在时默认「帮我审批」且允许完全访问（已存配置不改）；地址栏接受绝对路径与 `file://`（编码规则同 MiMo），本地页可跳本地与网页，网页不能跳 file。比 MiMo 严：网络路径（`\\server`、`file://host/`）拒绝，`javascript:` / `data:` 等不打开，本地页弹窗开 file 拒绝。用户 2026-09-16 决定：本地页面脚本能读本机任意文件（Electron 默认，MiMo 同样）照 MiMo 不加限制。
  - 26.914 界面变化（探针 25 项全过）：浏览器标签显示网页图标与标题（主进程 `page-favicon-updated`）、信息卡任务清单隐藏已放弃 / 已取消、「更多模型」平铺、Windows 顶栏图标 12px 用 `--text-strong`、重试行显示原因（顺带修了首个请求重试时整行不出现、暗色下铃铛亮起颜色不对）、设置导航按词前缀匹配。未做：@ 提及过滤（MCode 走后端搜索）。
  - 命令模板（探针 6 项全过）：`command.expand` 在发送时代入参数后并行执行 `` !`cmd` ``（MCode 配置的 shell、会话目录，只取 stdout，无超时无上限，同 MiMo），`@file` 变附件，命令文件夹按 MiMo 顺序向上查找，档位名映射默认模型。与 MiMo 不同：在会话目录执行（MiMo 在引擎进程目录）；MCP 提示词与技能参数不执行命令；命令指定的 agent / model 仍未带到回合。
  - 视频卡片（探针 round5-video 16、round4-rich 14 全过）：14 个平台点开都进浏览器面板标签（`rightPanel.openBrowser(url, {reuse})`，不看浏览器开关，同 MiMo）；删掉内嵌播放器、倍速、错误面板、播放器相关主进程规则与 CSP `frame-src` 地址；封面走主进程 `mcode-media://proxy/?u=`（26 条主机后缀白名单、平台 referer、Chrome UA，照 MiMo），比 MiMo 严：重定向逐跳校验最多 3 次、拒绝带端口 / 账号的地址、不收 SVG、5MB 上限、15 秒超时。
  - 历史 / 记忆 / 定时任务（分支合并 v2.0 后 smoke 1547、探针 10 项全过，含局域网真实模型：模型自己做了历史搜索、记忆查询并设了 60 秒 loop 真的触发回合）：用 Electron 自带 Node 的 `node:sqlite`（FTS5，无新 npm 包，启动时有一行 ExperimentalWarning），索引在数据目录 `index/search.db`（JSON 仍是原始记录，启动比对补齐，损坏重建）；`history` 工具 search / around / get；`memory` 工具对 `<数据目录>/memory/{global,projects/<目录哈希>,sessions/<id>}/*.md` 做 BM25，提示词告诉模型维护项目 / 全局 MEMORY.md 与本会话 notes.md；`cron` 工具（schedule / loop / list / get / delete / rename，持久任务存 `<项目>/.mcode/scheduled_tasks.json` 带锁文件）与 `automation_update`（无管理页，同 MiMo 正式版）；修了后台触发的回合不显示运行中、不发完成通知。与 MiMo 不同：应用内搜索仍是子串扫描（MiMo 浮层也不走索引）；`history get` 不能把附件媒体交给模型；每个会话各自调度；任务自带的推理强度只保存不生效（MCode 强度已改全局）。
  - 回合循环 / 提供商 / 提示词 19 项（分支合并 v2.0 后 smoke 1729、探针 4 项全过，局域网真实模型实测标题生成、语言与工作目录、9.4MB 项目外文件按路径附件、工具循环、强制小窗口自动压缩均正常）：E15 最大输出、E9 90% 触发压缩、E11 用量与费用、E14 按错误分类重试并遵守 Retry-After、E17 中断的工具调用保留、E16 执行中消息的说明、E13 同一调用连续 3 次询问、E12 截断 / 空回复自动继续、E6 生成标题（≤48 字）、E19 采样参数与强度映射、E7 回复语言与工作目录、E10 提示缓存（稳定前缀，记忆段放在缓存块之后）、E1 / R27 / E44 按路径附件（不再 base64 塞进文本、去掉 8MB 上限）、E8 压缩摘要与续接、E42 思考回放与调用 id 清理、E41 自定义服务商可选 Anthropic 协议、E50 指令文件向上找到仓库根、E40 首次改主工作区的 worktree 提示。E18 修剪未做（MiMo 桌面版未启用）。与 MiMo 不同：标题用会话本身的模型；执行中消息 / 自动继续的提示只在请求里不落记录；循环检测没有文本 / n-gram 检测；不压缩图片；指令文件不抓取网址、不读 `~/.claude/CLAUDE.md`、保留 `.mcode/rules.md`；通过 bash 改动时检测不到 worktree 提示。
  - 乐谱真实音色（分支 smoke 1563、探针 round5-abc 13 项全过）：`libfluidsynth-2.4.6-with-libsndfile.js` 原样放 `out/renderer/vendor/` 并 `asarUnpack`（LGPL 可替换），js-synthesizer 懒加载，`%%MIDI program` 预处理、二进制 MIDI、单通道轨道 Program 修补、4096 帧分块渲染每 8ms 让出、最长 600 秒，失败退回原振荡器合成；音色库经主进程 IPC 读取（先校大小与 sha256），`scripts/soundfont.mjs` 在 `package*` 前放置（已有文件 / 本地缓存 / OSUOSL 镜像，校验不符即失败），`resources/soundfont` 不入库；CSP 只加 `'wasm-unsafe-eval'`；关闭了 FluidSynth 每次加载 1248 行的 stub 日志；新增「第三方许可」入口（MiMo 没有，因 LGPL 义务）。安装包约 +40MB。
  - 引擎工具 / 权限 / MCP 22 项（分支合并后 smoke 1880、探针 8 项全过，局域网真实模型实测 glob / grep / bash 大输出截断 / MCP 改名调用）：E2 按 `.gitignore` 且任意层级匹配、E20 工具名与参数名修复、E21 统一输出上限并把完整输出存到 `tool-output`、E22 / E23 bash 与命令分析、E24 / E25 read 与 edit、E26 webfetch、E27 去掉 apply_patch、E30 notebook_edit、E33 / E34 「帮我审批」规则与只读命令免询问、E35 「始终允许」按项目记、E36 读 `.env` 要询问、E37 后台子智能体的权限请求直接拒绝、E38 explore 工具集、E43 流停滞超时、E45–E49 MCP 名称 / 目录 / 传输 / 结果 / 采样。顺带修了工具参数改名后 worktree 提示与压缩文件清单读旧字段而失效的问题。与 MiMo 仍不同：read 的媒体只给说明不作附件；MCP 结果不带图片；「帮我审批」没有模型探测回退；MCP 资源未开放（MiMo 桌面端也没有入口）。
  - 计划模式完全照 MiMo（分支合并 v2.0 后 typecheck / i18ncheck / wiringcheck / themecheck / mdcheck / promptcheck 54 / shellcheck / sessioncheck / smoke 1926 / build 全过，探针 round5-plan 8 项全过）：计划智能体不再靠「少给工具」，而是保留全部工具（bash、write / edit / notebook_edit、跨对话四件、MCP 工具都在），只用 MiMo 那条硬规则兜底——除计划文件外一律拒绝写入，且在询问之前就拒绝；命令照常走权限级别询问。计划文件是用户能留存的普通 markdown：仓库里放 `<项目>/.mcode/plans/<创建时间>-<两词别名>.md`，不是仓库就放数据目录 `plans/`（两个目录里的 `.md` 都可写，同 MiMo）；`SessionInfo` 新增 `slug`（建会话时定，旧会话回退用 id）。每轮带提醒（存在用户消息的 `context` 里，不进转录）：首轮长文说明只读范围并给出路径，之后每轮一行，计划切到构建的那一轮说明已可改文件、并在计划文件存在时补一句去执行它。新增 `plan_exit` 工具（无参数；提问卡「是 / 否」，可打字反馈；「是」把会话 `agent` 改为 build 并写入一条 `synthetic: true` 的用户消息——模型读得到、转录不画；「否」与反馈都留在计划模式；构建模式下调用只回一句不报错；子智能体拿不到）。（第十轮更正：「回合按开始时的模式判定、同 MiMo 的 ctx.agent」这个前提不成立——MiMo 按步取最新用户消息的智能体。T10-14 按用户决定改为：批准后同一次运行的下一步就以 build 的提示词和工具表继续动手；`tool.err.planApproved` 只剩「与 plan_exit 同一步里的写入」这一种情况，文案改为「下一步起生效」。）界面：带计划文件的提问卡改用 18 张表的 MiMo 文案（「计划已完成（{path}），是否切换到构建模式开始实施？」、是 / 否及各自说明、「查看方案」打开计划文件），停靠栏与转录卡片共用同一套规则，`plan_exit` 画成提问行而不是工具行。与 MiMo 仍不同：两词别名用的是 MCode 自写的词表（MiMo 的 slug 词表不抄）；没有 `plan_enter`，进入计划仍是用户的手势（按用户决定）。计划模式里派出的子智能体：explore 只读，其余按构建模式（L15，用户 2026-09-16 决定，与 MiMo 一致）。
  - 第三方许可补全（smoke 1885 全过）：用户 2026-09-16 批准下载后，`resources/licenses/musescore-general.txt` 收录 MuseScore_General 上游许可全文与必须保留的致谢（Frank Wen、Michael Cowgill、S. Christian Collins、Ethan Winer、Michael Schorsch），`xiph-codecs.txt` 换成 libogg / libvorbis / libFLAC / libopus 四份上游原文与各自版权年份；版本按随包 wasm 自报核实，libogg 无版本串，如实写作未知。
  - 计划模式（分支 smoke 1931、探针 8 项全过，局域网真实模型跑通：计划轮只读探索并写出计划 → plan_exit → 批准 → 下一轮真正改文件并跑测试）：照 MiMo 保留全部工具，改为「除计划文件外一律拒绝写入、在询问之前就拒绝」；计划文件 `<项目>/.mcode/plans/<创建时间>-<两词别名>.md`（非仓库放数据目录 `plans/`），`SessionInfo` 新增 `slug`；首轮长提醒 / 之后每轮一行 / plan→build 切换提醒都只进请求不画进转录；新工具 `plan_exit`（是否卡、可打字反馈，「是」切到构建并写入 `synthetic` 批准消息，子智能体没有）；问答卡与「查看方案」用 MiMo 文案（9 键 × 18 表）。删掉了 `MUTATING` 过滤、计划模式不给 MCP / 不拍快照的分支和旧 PLAN 提示词段。与 MiMo 不同：两词别名词表自写；无 `plan_enter`（按用户决定）。计划模式派出的子智能体：explore 只读、其余按构建（L15）。（第十轮 T10-14：批准后同一次运行直接开工，不再等下一轮。）
  - 全部合并后的验证（b08699a 构建）：smoke 1931 全过（此前两次的跨对话排队 / 子智能体看门狗失败经空闲重跑确认只是负载）；26 个探针里 14 个直接全过（含计划模式 8、主进程 29、访问 23、新版界面 25、回合循环、工具、跨对话、语音、消息流、回复、项目、子智能体）。第一路核对的五项失败全是探针问题、仓库未改：更新流程移到主进程后探针仍桩已删的 `mcode:check-updates` / `download-update`（S4_16 两项、G4）；PR 行失败改为显示禁用行是第五轮有意改动（V4_5）；「新建窗口」删除后多窗口缩放一条不再适用（G7_zoom）；round5-state 不是崩溃，是第二阶段在独立进程里跑、命令已先返回（现在会写占位 JSON 并留里程碑日志）。DL17 / DL18 也是探针问题：种子配置只覆盖了 `directory` 没覆盖 `projects`，把用户真实项目列表带进一次性配置，而第五轮首页选择器改读项目列表（03060d0），列表第一个目录不是 git 仓库，分支芯片按设计不显示。补上 `projects` 后 11 项全过。第二路的六项也都是探针问题：乐谱探针把正则字面量写在模板字符串里，`\n` 变成真换行导致正则未闭合、整步抛异常并留下控制台报错（`licenses` 与 `quiet` 同一个根因）；命令模板 C5 与技能 K4 都是用 `.find()` 取到了生成标题那次请求（附件还是绝对路径，`includes("notes.md")` 永远不成立）；历史 H3 在消息到达后才读运行状态，此时桩的回合已结束；第三轮子智能体 S10 用的 `echo probe` 在只读命令白名单里，根本不会弹权限卡。视频卡片与富文本的 `noNetwork` 是标签页自己请求 `/favicon.ico`，按 N3 属于既定行为（只放行用户已打开的站点），判定改为只允许该来源。
  - 合并冲突：`browser.ts` 导入两边合并；`right-panel.ts` 标签字段两边都保留。合并后 smoke 有 2 项子智能体看门狗检查失败（高负载时），待负载降下后复核。
- 乐谱真实音色（用户 2026-09-16 决定）：js-synthesizer 1.13.0（与 MiMo 同一份 FluidSynth 2.4.6 wasm，已加为开发依赖 2b1c535）+ MuseScore_General.sf3（MIT，39,900,972 字节）打进安装包（约 +38MB），CSP 加 `'wasm-unsafe-eval'`；LGPL 内核保持独立可替换文件，附许可文本并新增「第三方许可」入口；不做 MiMo 把乐谱音频发去审核的行为。音色库已从 MuseScore 官方镜像下载，自行计算 sha256 后固定。
- 用户 2026-09-16 提供局域网测试模型（OpenAI 兼容，`http://192.168.10.212:8888/v1`，key `EMPTY`，`qwen38-nvfp4`，上下文 262144，输出 16384），只在一次性测试配置里用于真实模型端到端验证，桩服务检查仍是判定标准。
- 不照搬：M20 MiMo 关闭了 GPU 沙箱（削弱进程隔离）。Linux / macOS 专属的 M15 自绘标题栏按钮、M16 macOS 红绿灯（与前几轮记录不一致，需在 Mac 上确认）、M18 托盘单色图、M19 AppImage 桌面入口放到后面。

**第六轮对照（2026-09-16）：已完成并验证。** 最终：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck、shellcheck 全过，smoke **2200 全过**，build 通过，**31 个探针全部通过**；核对到的探针失败全部是探针自身问题，未发现应用缺陷。 前五轮看界面区域、界面文案、界面背后（主进程 / 引擎 / 渲染层状态）。这一轮换四个角度，四路只读排查：画出来的样子（颜色、尺寸、字体、动效、RTL 与缩放，`round6-visual.md`）、前五轮留下的所有「仍不同 / 未做」项逐条复核与收口方案（`round6-leftovers.md`）、出错与极端情况（提供商失败、本地文件失败、超长对话与超大文件、并发与停止、崩溃后恢复，`round6-failures.md`）、完整使用流程逐步对照（首次运行、开始工作、审阅改动、附件、面板、子智能体、整理、设置生效时机，`round6-flows.md`）。- 用户 2026-09-16 第六轮决定：安全四项全照 MiMo（计划模式子智能体不受限、MCP 提示词模板与技能参数里的 `` !`命令` `` 执行、回复里的本地媒体任意路径都预览、指令文件按配置拓到 glob 与网址并读 `~/.claude/CLAUDE.md`）；语音反馈改成模型主动调用 `speak`（本机语音合成），删掉原来的后台完成自动播报；定时任务改为归项目、不再随对话消失；补内置技能、画 MCode 自己的 macOS 单色托盘图；**不做**「帮我审批」的模型探测回退、任务自带推理强度；右侧面板标签名保留 MCode 的 18 语言本地化（记为故意不同，MiMo 是写死中文表）；开源引擎链接行暂缓——仓库 remote 已是 `https://github.com/WyattCode/MCode.git`，但该地址目前公开访问 404，等可公开访问再加。
- 已合并：画面 12 项（工作区改为齐平单面板、阅读栏断点改 2000px/996、右键菜单胶囊行与 .18s 动画、只有搜索浮层模糊、Windows 浅色暖色调、焦点环统一、删死规则；V5/V8 经实测证明审计有误、维持原状，V10 需新 token 名故留待决定）、流程 6 项（移动至项目只改分组标签并新增 `SessionInfo.group`、撤销改走 git 并在非仓库拒绝、技能来源说明改成实际扫描的三处、MCP 保存提示补「下一个对话生效」、全新 profile 不再把启动目录写成项目、底部终端跨首页与对话不再重建）、已决定的遗留项 8 项（L13/L15/L16/L18/L19/L21/L22/L23）。
- 前三条合并后的验证（c744bb5）：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck、shellcheck 全过，smoke **2012 全过**；再并入出错前 10 项与流程剩余项后（96cf7e2）快速检查全过、smoke **2105 全过**；并入遗留项 L1–L12 后（7f19d1d）快速检查全过、smoke **2155 全过**。
- 出错与极端已合并前 10 项（9db7a0b，分支 smoke 2061 全过）：**F1**（真缺陷）改为每当该目录有回合起止就拍照，把回合切成独占段与共享段，工具点名的归对应回合、无人点名的归跑过 shell/MCP 的那个，仍无法归属则判争议、整个回合不可撤销；另建账本，别的对话此后写过同一文件即拒绝撤销（用户自己和本对话的后续改动不受影响）。**F2/F3/F4** 统一规则：读不出的文件一律改名隔离、绝不覆盖——坏 `automations.json` 隔离后空任务启动（无法隔离则拒绝一切写入）、坏 `config.json` 回退默认值且不当作首次安装（否则会悄悄把权限调成「帮我审批+完全访问」）、坏 `info.json` 只跳过该条不再让整个对话列表失败。**F10–F13、F41**：流在句子中间断掉时仍可重试、带 JSON 正文的 413 判为溢出并压缩重放、404 只对 OpenAI 兼容系重试、补 409 与 unknown 预算、过载判定改读解析后的正文。**F28** 后端断线提示改用既有 `error.network`（与 MiMo 同文案，未新增键）。
- 流程剩余项已合并（391b31e，分支 smoke 2056、探针 18 项全过）：**J2 首启导入**（`server/import.ts` 只读扫描 Claude Code / Codex / OpenCode 三处，OpenCode 用 `node:sqlite` 只读、列名逐个探测；去重键 =（来源、来源内键、来源 mtime），未变跳过、变了重同步、没见过才新建；错误只记文件名与失败类型，不含内容；配置 `importOnboarded` + 迁移 `import-prompt-r6` 把已存在的 profile 标为已问过）、**J1 删掉整屏首配向导**（MiMo 全新 profile 直接落首页）、J4 未命名对话、J5 标题生成模型设置（**第九轮 S9-4 更正**：当时只凭文案表判断 MiMo 有这一行，实际 MiMo 的常规页并不渲染它，整个包里也没有引用；该行已删除，`titleModel` 保留为只能在配置文件里写的键，相当于 MiMo 引擎的 `small_model`）、J6「不使用项目」不再被遗忘、J7/J11 统一差异渲染并记住横向位置、J8/J17 路径与附件文件名、J9 点卡片文件走面板、J12 审阅随窗口聚焦重读、J13 删掉 MiMo 没有的 JSON 导出、J14/J15/J16 附件三项（只有项目内且 <256KB 的文本变 @提及；粘贴的图片写进 `<userData>/attachments/images`，目录 0700 文件 0600，按路径附加）、J18 项目外附件进文件标签、J21/J22/J24/J25。J19 这次在窗口里驱动成功（改点首页底部面板按钮，Ctrl+\` 有守卫）。合并冲突 `server/config.ts`：坏配置隔离与首启导入标记两边都保留，且**读不出的配置算作已存在的 profile**，否则会既误判首次安装又弹导入窗口。
- 遗留项 L1–L12 已合并（7f19d1d，分支 smoke 2155、探针 10 项全过）：**L2** 工具结果可携带附件（`ToolResult`/`ToolPart` 新增 `attachments`；read 按路径挂媒体、MCP 图片音频按字节挂、`history get` 交出媒体；Anthropic 直接放进 `tool_result`，chat / responses 线路图片跟在结果后单独发一条），模型终于能看到自己读的图；L1 n-gram 复读检测（4 词一块、连续 20 次、只看最后 500 词）；L3 命令的 agent / model 只作用于这一轮；L4 bash 改动也触发工作树提示（只采信 exit 0 的命令扫描）；L5 MCP 清单随会话存盘且不顶起侧栏排序；L6 草稿只存路径不存字节（主进程上限 64MB→16MB）；L7 @ 提及改为列一次目录后本地按词前缀过滤，删掉后端搜索与两行文案；L8 新建空白项目可选存放位置（零新增文案）；L12 发图前按最严上限缩放（解码在桌面进程，纯 node 下原样通过）。**L9、L10 核实为已经一致**（模型页配置行、SVG / 音频 / 预览动画），HANDOFF 旧记录过期已销案；L11 是验证缺口，已在真实窗口补验。与 MiMo 仍不同：chat / responses 的工具结果图片要单独成条；缩放统一用最严上限、GIF 不动、PNG→JPEG 丢透明；重启后恢复的按路径图片显示为文件胶囊。
- 出错与极端剩余项已合并（9217384，分支 smoke 2200、探针 6 项全过）：**F16** 停止失败改为 3 次×400ms 重试并提示「停止失败，请重启应用」、**F17** 提问作答与本次放行失败都提示、**F18** 被杀在流式中的回合画出「回合已中止（未能继续）」、**F19** 掉线 400ms 后提示「连接正在恢复」并在重连后撤下、**F20** 只新增这 5 个真正有触发点的错误码文案（其余约 18 个留给对应条目一起做，避免造孤儿键）、**F5** 每个自动化保留最近 20 条运行记录（开跑即写、结束结算、强杀后下次启动结算并按策略通知）、**F7** 退出时清扫 bash 起的进程树、**F8** 渲染崩溃后终端置为无主并给 15 秒宽限供替补窗口认领（不回归孤儿 shell）、**F9** 跨对话队列持久化到 `chat-queue.json`，重启后未开始的照常投递、在跑的回灌说明、超 24 小时不投。**F6 实测推翻审计**：周期任务本来就会补跑一次，未改代码、改加 5 条回归检查锁住。
- 六条分支全部合并后的验证（9217384 构建）：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck、shellcheck 全过，smoke **2200 全过**，build 通过。31 个探针里 **27 个直接全过**：第六轮五个新探针（visual 24、journeys 7、decided 10、leftovers 10、failures 6）、第五轮 13 个（main 29、keys 16、skills 9、access 23、newbuild 25、commands 6、video 16、history 10、tools 8、abc 13、plan 8 等）、第四轮 8 个与第三轮 3 个回归。另 4 项核对后**全部是探针问题、无应用缺陷、仓库未改**，修正后 31 个探针全过：round5-loop `T2`（第六轮 J17 有意让已发送文件片只显示文件名，探针仍比对整条路径；附件链路本身正常）、round4-leftovers `KS15`（参照色块挂在 `.app` 之外，读到中性 `#ececed` 而非 Windows 暖色 `#f0ebe5`，弹层本身正确）、round3-global `G10_search_rows`（两行状态由 `artifact.list` 驱动，探针挡的是 `search.messages`，且桩必须在浮层打开前装好）、round5-state（前台直接启动时第一阶段把第二阶段 detach 后自己先退出，现在改由调度进程依次跑两段）。两处 `errors=1` 已核实：round3-global 是 G18 故意注入的 `probe boundary`，round6-journeys 是第三方打包块（pptx / mermaid / cytoscape / pdf）的已知报错，`src/` 全树无此引用。
- 第六轮仍未做（留待下一轮）：F14、F15、F21–F27、F29–F40、F42 与 F20 剩余词表（注意并行合入的发图缩放可能已覆盖 F14，需先核实）；V10 菜单底色（需新 token 名，待决定）；L14 开源引擎链接行（等仓库可公开访问）；L17 / L20 用户已明确不做；L24–L27 需 Linux / macOS 实机。（F5–F9、F14–F27 含约 23 个错误码文案、F29–F40、F42）。

**第六轮四路排查**都会先确认 MiMo 是否又自动更新过：本机 MiMo 仍是 26.914.142245（第五轮对照的同一版），没有再更新，因此 `n5-assets\`（473 个渲染块）与 `r5-asar\`（主进程与引擎）里已抽出的文件可直接复用，不必重新解包。

**第七轮对照（2026-09-16）：已完成并验证。** 最终：typecheck、i18ncheck、wiringcheck、themecheck、mdcheck、promptcheck、shellcheck、toolcheck、snapshotcheck、sessioncheck 全过，smoke **2471 全过**（去重后的真实条数），build 通过；43 个探针全部通过。核对出的 13 项探针失败里 12 项是探针自身问题（多为本轮有意改动打翻旧判定：删掉逐字显现、统一差异渲染换了类名、产物库与新增的「导出为对话文件」改了菜单顺序、参照色块挂在 `.app` 外读到中性色、探针服务被别人的 5173 顶掉），**1 项是真缺陷并已修**：空白浏览器标签上 Ctrl+句号既不标注也不切换智能体（`RpBrowser.toggleAnnotate()` 返回的 false 被 `App.vue` 丢掉），现按规格回落为切换智能体。另外 `round3-terminal-diag` 的「NONE COUNTED」确认为良性——它是纯诊断脚本，本来就没有判定项。计时实测（删掉逐字显现后）：画面不再落后模型（原先最多落后 8129 字 → 0），刷新从 74 次碎片变为 4 次整块，回合结束后的尾巴 309ms → 125ms，首个窗口 223ms → 144ms，切回大对话 798ms → 581ms。 一边做掉第六轮明确留下的清单，一边再开三个没用过的角度：
- 构建：出错与极端剩余项（F14、F15、F21–F27、F29–F40、F42 与 F20 其余约 18 个错误码概念，每个都必须接到真实触发点、不造孤儿键；F14 先核实是否已被第六轮的发图缩放覆盖）。
- 只读排查：**模型面**（一次请求里消息与系统块的组装顺序、工具 schema 逐个对比、每次请求的模型参数、回复解析与用量、上下文预算，`round7-model.md`）、**落盘数据**（profile 目录结构、每条记录的字段、迁移与新版本兼容、无界增长与清理、导出导入的可还原性，`round7-storage.md`）、**启动与响应**（启动到可用的顺序与实测耗时、流式刷新节奏、长列表与长对话的虚拟化、空闲开销、重负载时刻，`round7-timing.md`）。
- 三路只读排查都会先确认 MiMo 是否又自动更新过：三路各自核实，MiMo 仍是 26.914.142245，未更新。
- 用户 2026-09-16 第七轮决定：系统提示词先按 Anthropic / GPT / 通用写三份（内容 MCode 自写）；推理展示改为向模型请求摘要版（界面仍不画）；落盘数据四项全做（撤销快照不再存全文并迁移旧数据、影子仓库跟着对话回收、产物建库、对话可导出导回）；「始终允许」改为照 MiMo 按项目存盘（此前记为 MCode 优势，现按用户决定改）；启动与流式四项全做（窗口先画 MCode 自己的字标、窗口不等后端起完、去掉逐字显现、终端按需加载）。
- 已合并：**出错与极端剩余项**（2727ae7，分支 smoke 2288）——13 条新错误文案全部接到真实触发点、read 区分无权限与不存在、工具参数非法有专门说明、网关 HTML 不再当成密钥错误、交互式命令立刻作答不空等、分离 HEAD 有专门状态、存储写入 fsync 并清理临时文件、配置带格式版本且拒绝写入更新版本写过的 profile、标题与 Smart 路由登记为后台工作让「停止」够得到；F14 经核实已被第六轮的发图缩放覆盖，F35 与 MiMo 一致故不动。**模型面**（分支 smoke 2307）——本地 token 估算 + MiMo 的工具输出裁剪（软裁 4096/首尾 1536、保护尾 40000、清除下限 20000、压力档 0.5/0.7/0.85，只改请求不改存档）、补齐 provider 字段（**修好 OpenRouter 从不申请用量导致缓存写入与推理 token 恒为 0、成本算错**）、环境块点名模型自身与默认分支和 git 用户并按天缓存、压缩前裁掉超 8000 token 的工具结果、question / read / bash / actor 四个工具描述提升到 MiMo 覆盖度（措辞自写，逐句比对无重合）、带外请求用便宜档（起标题不再按回合档思考）。合并冲突两处：两边各写了一整个 `smoke-round7.ts`（保留两份，模型面改名 `roundSevenModelChecks` 并在原函数结尾调用）、`runner.ts` 标题请求（保留重试包装，同时换上便宜档）。合并后 typecheck 干净、smoke **2590 全过**。
- **启动与流式已合并**（19b1e12，分支 smoke 2605）：T1 `index.html` 里内联 MCode 自己的缎带 M 字标（淡入 180ms、扫光 2200ms，reduce-motion 与 `data-motion` 两条退让都保留静态标记），HTML 一解析就绘、挂载时替换；T2 窗口不再 await 后端（`startBackend` 改为不 await 的 promise，只有 `mcode:bootstrap` 等它，其余 handler 仍同 tick 注册）；T4 删掉 `stream-reveal.ts` 与 `playingOut`/`revealing`，改为 MiMo 的块级淡入 220ms（挂在外层包装，因流式块每次刷新重建 innerHTML 会不断重启动画），并改正原先错误归因给 MiMo 的注释；T5 终端改 `defineAsyncComponent`（`App.vue` 与 `RpTerminal.vue` 两条静态引用都要改才真正分包）；T6 `ready-to-show` / `did-finish-load` / 3 秒定时器三者取先到。**实测**：窗口出现从「小 166 / 大 223–236」变为「小 147 / 大 150」，**不再随对话数增长**；首次内容绘制 402→382、472–541→397；快速流回合结束后拖尾 413→128ms、最大落后 9230 字→0；入口 chunk 6 220 289→5 603 544 字节（−9.9%），终端独立为 601KB 按需加载。仍不同：入口包 5.60MB 对 MiMo 2.27MB（重型查看器早已分包，其余是外壳自身；2026-09-21 已降到 2.14MB，见「下一步建议」第 6 条）；T1 的那一帧探针够不到（module script 必在 `DOMContentLoaded` 前执行），改由 smoke 静态保证；T3 长对话回切 790ms 未做（2026-09-21 已做，见「下一步建议」第 5 条）。顺带清理了 365 个遗留的冒烟临时目录（当时 C 盘只剩 6.8GB，现 137GB）。
- 合并时两条分支都往 `smoke.ts` 里加了第七轮检查的 import 与调用，整套跑了两遍（去重前 2666）；去重后（e70b7c1）smoke **2471 全过**，这才是真实条数。
- 合并启动与流式后的验证：重建 `out/` 后 smoke **2605 全过**、build 通过（先前那条「终端不在主包里」的失败只是 `out/` 还是合并前的旧构建；重建后主包 index chunk 2 781 938 字节，终端已在独立 chunk）。
- **落盘数据已合并**（分支 smoke 2666，比合并前的 2605 多 61 条新检查）：**S1** 撤销快照不再把文件正文存进对话文档——快照改为「摘要 + 检查点引用」（MiMo 的 `summary_additions/deletions/files` + checkpoint），正文放进该项目本来就有的影子仓库（`hash-object -w`，git 按内容寻址，所以同一文件被二十个回合记录也只存一份），增删行数用 `diff-tree --numstat` 在树还在时一次算出；旧 profile 由 `checkpoint-migrate.ts` 在启动后台迁移（undo / redo / 已回滚回合的两半都搬），三条规则：搬不动的正文原样留着（旧格式一直能读，所以没有任何一个回合会悄悄变得不可撤销）、读不出的文档不动、被中断的迁移下次继续；正文彻底找不到时拒绝并说明，绝不写空文件盖上去。**S2** 删除对话后回收该项目的影子仓库（最后一个用它的对话走了才收），启动时再扫一遍历史遗留的（本机原有 6 个，对应 2 个对话），被回收的仓库同时从内存缓存里丢掉。**S3** 「始终允许」改为按 MiMo 存盘（`storage/permissions.json`，按项目，未指明项目的按对话），设置「权限」里列出每条（模式 / 桶 / 授予位置）并可单条或全部移除——能收回才敢长期保存；损坏的文档隔离另存、更新版本写的只读不写；授予不等落盘（否则工具被磁盘拖住），`flush()` 供需要确认落盘的调用方。**S4** 对话可导出为文件再导回（`shared/convo-file.ts`，`app`+`format` 自报家门，原样带走记录与消息，不带 id 与指向原 profile 的字段），会话行菜单「导出为对话文件」、命令面板「导入对话文件」，`mcode:open-text` 读单个文件上限 64MB；四种拒绝各有说法（非 JSON / 不是 MCode 的 / 更新版本写的 / 没有可导入消息），8 个键 18 张表（MiMo 桌面端没有这两半的文案，自写）。**S5** 产物建库（`storage/artifacts.db`，MiMo `db/artifacts.db` 的形状）：identity_key 去重、deliverable / intermediate（复用信息卡的 `sessionArtifacts`，两处不会打架）、可用性复检、搜索，删除对话只解除关联并保留它当时的标题——产物本来就还在磁盘上；一行只能记一个对话而 MiMo 有 `artifact_source` 可记多个，于是取「最后写它的对话」，这是检查发现的（原先由 reconcile 顺序决定，同样输入两次结果不同）；版本更新的库只读不重建（它是那些对话已被删的文件的唯一记录）。**S15** 核实为早已存在（`.cron-lock` 与两条 smoke 检查），无需改动。**S20/S21** 加 `storage-layout.ts` 布局版本标记（MiMo 引擎同位置的 `storage/migration`），更新版本写过的 profile 直接不跑启动迁移；`imported.json`、`automations.json` 同样带版本且拒绝覆盖更新版本写的（否则降级一次会把所有对话重新导入一遍 / 任务一触发就丢掉新版本加的字段）。另修掉过期的 `toolcheck` 断言「plan gets no way to write at all」——第六轮已改为计划模式保留全部工具、由写工具守规则，断言改为检查行为（保留 edit/write，`guardPlanWrite` 拒绝计划文件以外的写、批准后的同一回合仍只读、构建模式不受限）。验证：smoke 2666 全过、typecheck / i18ncheck / wiringcheck / themecheck / mdcheck / promptcheck / shellcheck / toolcheck / snapshotcheck / sessioncheck / build 全过；探针 `mcode-round7-storage.cjs`（预置旧格式撤销历史 + 已产出文件 + 已记住的允许的一次性 profile）7 项全过、0 报错。每项新检查都在破坏对应代码后确认过会失败（迁移、回收、规则读回各自只失败对应几条）。仍不同：MiMo 的 `artifact_source` 多来源、产物库的 FTS（这里是按路径与标题匹配）、S16 的终端报告日志未做。

**第八轮对照（2026-09-16/17）：已完成并验证。** 一边做掉第七轮留下的清单，一边再开三个没用过的角度：
- 构建：M1 按模型家族拆三份系统提示词（Anthropic / GPT / 通用，内容 MCode 自写）、M3 其余工具描述补到 MiMo 覆盖度、M13 循环检测中断流、M14 首条消息的 MCP 优先策略、M15 计划模式五阶段工作流、M16 附件按 read 工具框定并按 Office 类型分流、M7 `multiedit` 视情况；有余力再做 S16 终端报告日志与 T3 切回长对话仍要重读重绘（150 轮 581ms，小对话约 25ms）。
- 只读排查：**文案与多语言质量**（称谓与语气、同一概念是否同名、长语言下的溢出与截断、占位符与复数与日期数字格式、机翻痕迹、出错与空状态是否说清下一步，`round8-wording.md`）、**无障碍与键盘操作**（控件的角色与名称、运行中与权限请求的播报、焦点顺序与陷阱、纯键盘能否走完主要流程、高对比度与强制颜色与缩放，`round8-access.md`）、**安全与出网面**（MCode 全部出网请求清单及触发条件与可否关闭，CSP 与沙箱与桥接方法逐个、IPC 入参校验、浏览器面板与预览服务器、命令与 MCP 执行路径、密钥是否可能进日志或请求，`round8-security.md`）。
- 三路只读排查都会先确认 MiMo 是否又自动更新过：均核实为 26.914.142245，未更新。
- 排查结果：文案 16 项（最扎眼：图表菜单四个词在 12 张语言表里仍是简体中文；成句英文残留；`Datei(en)` 式括号兜底复数；同一对象多个名字）；无障碍 15 项（**A3 真缺陷**：复制时剪贴板出错会让整个窗口变成错误页，MiMo 会捕获并提示；键盘焦点几乎看不见；权限请求对读屏器无声；审阅文件列表与右侧面板标签只能用鼠标）；安全 22 项加出网清单 22 条（**X1 后端 WebSocket 无认证也不校验来源，任意网页可借此开终端执行命令**；X2 模型能改写 MCode 自己的 `config.json` 从而在下次启动运行任意 MCP 服务器；X4 读写文件不限定在项目内；X5 Office 通道不校验参数；**未发现任何遥测**，MiMo 有三条）。安全排查还复核了一路子排查的两条错误结论：MiMo 引擎里确实有计划模式与 `` !`命令` `` 替换，前几轮据此做的功能不用回退；「始终允许」按项目存盘也与 MiMo 一致。
- 用户 2026-09-16 第八轮决定：首页建议照 MiMo 去掉（不再把目录清单和最近对话标题发给模型）；回复里的远程图片改为点击后才加载（堵住借图片地址外传内容的通道，CSP 不动）；视频卡片取元数据加开关、默认开。
- 用户 2026-09-16 决定：文案 **W5 撤回，照 MiMo 用「分支」**——回复行按钮、会话菜单、分支提示与失败提示在 18 张表里恢复为 W5 之前的值（即 MiMo 各语言的「分支」一词，与 git 分支同词）；W5 改的键名（`stream.replyFork`、`menu.fork`、`stream.forkedFromHere/forkedFromCurrent/forkFailed/forkNeedsMessage`）保留，只改回值；快捷键行 `key.label/desc.fork-chat` 回到 MiMo 原文「分叉聊天 / Fork chat」，W4 的称谓规则把这两键列为 MiMo 原文例外；2026-09-17 用户又决定归档提示 `toast.archivedNConvos` 回到 MiMo 原文「已归档 {count} 个聊天 / Chats archived: {count}」（W4 改过的 zh-CN / en / ru / th / uk 五张表恢复为 W4 之前的值），同样列为例外；`smoke-wording.ts` 的 W5 规则删除。**W3（括号兜底复数改写）保留**，属于与 MiMo 故意不同。
- 无障碍修复原则：**鼠标用户看到的样子不变**——焦点环只在 `:focus-visible` 时出现，名称、角色、播报、键盘操作都不影响画面；MiMo 同样存在的障碍也修，标为超出对标。
- **文案已合并**（b239dba，分支 smoke 2496、探针 15 项全过）：W1 图表菜单在各语言正确翻译；W2 其他语言表里残留的成句英文（信息卡 PR / 分支状态、子智能体状态、浏览器右键菜单 7 项等，共 253 个值）译好；W3 括号复数改为自然写法（21 键 106 值）；W4 面向用户的名称统一为「对话 / 新建任务」（619 值 + 6 新键，锁定键值不动、改调用处）；W6 相对时间只剩一组；W8 查找计数改布局让出空间；W9 紧凑标签显示工具名时可放宽到 160px；W10/11/13/14/15 若干措辞与本地化格式。核对发现审计有 4 处与 MiMo 原文不符：MiMo 的 git / PR 文案在非中文语言里本来就是英文（W2）、德语表原文就是 `Datei(en)`（W3）、回复行与对话菜单都写「分支」（W5）、查找计数同样是长句（W8）。**用户 2026-09-16 决定**：W3 保留新写法（故意不同）；W5 照 MiMo 保留「分支」，回退「派生 / Fork」——直接 `git revert 53d01d4` 与 W4 冲突，改为逐语言把值恢复到 W5 之前（f74b2f1：9 个键 18 张表共 118 个值，保留代码在用的新键名，删掉断言相反的 smoke 规则；快捷键里的「分叉聊天 / Fork chat」与 W4「一个概念一个名字」冲突，核实为 MiMo 快捷键表原文，加入该规则的 MiMo 原文例外名单），smoke 2593 全过。
- **模型面已合并**（24edec1，分支 smoke 2572、探针 9 项全过，局域网模型实测通过）：M1 三份系统提示词（Anthropic 4.1KB / GPT 9.2KB / 通用 6.5KB，`session/prompts.ts`，缓存前缀逐字节不变；Gemini / Kimi / DeepSeek 等仍走通用那份）；M3 其余工具描述补到 MiMo 覆盖度；M13 流式输出时检测重复并当场截断，两次提示后以 `error.replyLoop` 结束本轮（MiMo 终止整个会话，MCode 只结束本轮）；M14 MCP 优先策略（按安全发现 X2 收紧为「只在用户要求时才编辑 config.json」）；M15 计划模式五阶段；M16 文本附件以「read 工具已替你调用」送达，Office 按类型写明打开工具；M7 `multiedit`（全部生效或一处不写，只问一次权限）；S16 定时任务终端报告日志（修掉跑完但未存记录时被杀、下次启动误报失败）；T3 最近 8 个对话的消息留在 store，150 轮对话切回 1227ms → 179ms。
- 两条合并后：各项检查全过，smoke **2597 全过**。合并冲突一处（`smoke.ts` 两边各加检查入口，均保留）。
- **无障碍已合并**（4e7b71b，分支 smoke 2637、探针 20 项全过）：A3 复制失败不再让整个窗口变成错误页（顺带修了连接对话框复制设备码的同样问题，smoke 扫描所有剪贴板写入）；A1 `:focus-visible` 强调色焦点环，输入框按过 Tab 才画（`lib/focus-ring.ts`），分组开关照 MiMo 用 1px 灰环；A2 `lib/announce.ts` 两个不可见播报区，权限 / 提问停靠区改为 `role=alertdialog` 并紧急播报；A4 差异文件列表与文件头可 Tab 与 Enter / 空格操作（顺带修掉在权限卡差异里按 Enter 会被当成「本次允许」）；A5 右侧面板标签按方向键 / Home / End 切换；A6 终端关闭按钮可聚焦；A7 / A8 / A10 补名称；A9 31 处只能鼠标点的目标可用键盘（会话导航条、ABC 音符跳转除外）；A11 回合结束与后台子智能体完成有播报；A13 区域名称与每轮一个不显示的 h2；A14 提示改为 `role=alert` 且可单独聚焦；A12 高对比度下用系统高亮色；A15 缩放与终端输入的无障碍名称本地化。**鼠标用户所见不变**：另建修改前的构建对照，28 个改过的控件在未聚焦时计算样式（24 项属性）完全一致。仍未做：xterm 读屏模式（终端输出不朗读）。**用户 2026-09-16 决定**：Tab 进入底部终端后出不来（xterm 把 Tab 当作 shell 补全），照 MiMo 保持原样，靠 Ctrl+J 关掉终端离开。
- **安全修复已合并**（3636829，分支 smoke 2834、探针 18 项全过；合并后十项检查全过）：**X1** 后端 WebSocket 每次启动生成 32 字节密钥，只经 preload 的 bootstrap 通道交给自己窗口的主框架、放在握手子协议里（不进任何 URL，服务端只回 `mcode`），常量时间比较，Host 只认本端口的 127.0.0.1 / localhost，Origin 只认 `file://`（开发版为开发服务器地址），无 Origin 的本机进程也要带密钥，用户添加的远程服务器拿不到它（`server/socket-guard.ts`、`shared/socket-auth.ts`）；**X2** 写 / 编辑 / multiedit / notebook 与 shell 写入都不能写应用数据目录（按写法与真实路径双重判断，junction 也拦），凭据与 mcp-auth 一律不给读，放行 memory、plans 下 .md、用户 skills、全局 AGENTS.md；**X4** 文件请求改为 `{root, rel}`，rel 按真实路径不得越出 root、不得写 ADS，文件标签页可只读打开项目外文件但不能保存；**X5** `main/office-guard.ts` 给 11 个 Office 通道逐参数校验；**X8** `shared/mcp-redact.ts` 在导入列表、状态错误、日志里遮蔽 MCP 密钥，并（比 MiMo 多一步）在所有发往窗口的配置里遮成 `****`，窗口原样传回时保留磁盘原值；X6 解释器命令的「总是允许」带上脚本名、内联代码只精确记住；X7 只读命令带项目外路径或 `.env` 也要询问；X9 各处按真实路径判断越界；X10 定时任务的创建 / 修改 / 恢复都按「命令」询问（**2026-09-17 用户决定撤回**：MiMo 的 cron 与 automation_update 不弹任何审批，照 MiMo 删去这道询问、`perm.schedule` 及其 18 张表文案；子智能体不能管理定时任务、探索子智能体不能排定时仍保留——第五轮照 MiMo 做的，不属 X10；smoke 改为验证排定时不询问）；X11 存储文档 0600（Windows 上实际隔离靠 %APPDATA% ACL）；X12 日志多遮几类令牌；X14 预览服务加 no-referrer 与 nosniff；**X15 主窗口开启 sandbox，preload 改为 CJS 构建（`index.cjs`）**；X16 MCP OAuth 元数据地址限同主机或公网 https；X17 导入对话的目录只沿用已知项目；X19 拒绝 ADS 路径；X20 浏览器面板重定向走同样的导航规则。**出网三项**：首页建议删除（`home.suggest` 请求、服务端模块、提示词与缓存一并删，首页选中项目后显示三条内置示例）；回复里的远程图片显示「点击加载图片 · 主机名」占位，点击后才加载，SVG 图解里的远程引用一并剥掉；设置「浏览器」分组新增「视频卡片显示标题和封面」开关（默认开，关闭后渲染层与主进程都不取、封面代理直接 404）。保留未改（用户此前决定）：X3 模板 `` !`命令` ``、X13 图片 CSP、X18 webfetch 不拦本机地址、X21 封面 referer、X22 指令文件网址。仍有风险：shell 扫描认不出的写入（如先写脚本再执行）拦不住；skills 与 AGENTS.md 仍可写，是持久化提示注入通道；自定义服务商 baseURL 未遮；MCP OAuth 未防 DNS 重绑定。
- 第八轮全部合并后的验证（387af71 构建）：十项检查全过，smoke **2834 全过**，build 通过。第三到第八轮探针里大部分直接通过（round8-a11y 20、round8-model 9、round8-security 18、round8-wording 15、第七轮与第六轮大部分、第五轮 12 个、第四轮 7 个、第三轮 7 个）。待核对：round5-history H3–H5（疑为 X10 让定时任务先询问权限）、round3-reply `previewWaitsForLoad`（疑为远程图片改为点击加载）、round3-browser 缩放三项（疑为缩放按钮名称本地化）、round3-global `G4_no_focus_ring`（疑为新加的键盘焦点环）与 G11、round3-settings KS1search / PL12、round3-composer p6_2、round3-terminal D1、round4-feedback S4_1d、round4-leftovers I23 / MO4、round6-leftovers R3，以及无障碍排查阶段写的三个测量探针（access / access2 / access3，本来是记录修复前障碍用的）。两个 timing 探针的「NO JSON」是通用循环没给它们需要的参数，属已知。
- 无障碍与文案这一路核对完：**全部是探针问题，仓库未改**——W4 把「会话 / 聊天」统一成「对话」后 round3-terminal D1 与 round3-global G11 的预期过期；A15 把缩放按钮名称本地化后 round3-browser 三项按英文名找不到按钮（C11 是受 C14 残留菜单连带）；G4 用 Tab 聚焦本就该有环，改为按规则测（键盘有环、鼠标点击无环，实测鼠标无环）；三个无障碍测量探针里，access2 从没 attach 调试器、全靠脚本 `focus()`（不会命中 `:focus-visible`），读数无效，已撤下改名 `retired-…`；access / access3 修正了减少动态的计数方式（MCode 把动画缩到 1e-05s 而非删除）与强制颜色的测量位置，并加了对照读数保证能失败。**另发现一处真实布局问题（与第八轮无关）**：窗口约 720–801px 宽且右侧面板开着时，侧栏已收成 62px、对话区保持 `min-width: min(440px, 100%)`、面板下限 300px，合计 802px，面板右侧（含文件面板「刷新」）被截掉 51–52px，100% 缩放下同样发生——已另派一路按 MiMo 在该宽度的做法修。另查到 `SessionTabs.vue` 已无挂载处（随标题栏在 bbda573 删掉），一并删除。
- 安全与设置这一路核对完：**全部是探针问题或负载，仓库未改**——X10 让定时任务先询问后 round5-history H3–H5 停在提问上；远程图片点击才加载后 round3-reply 要先点占位；文案统一后 round4-feedback S4_1d、round4-leftovers I23 / MO4、round3-settings KS1search 的预期过期；X8 遮蔽后 PL12 改为窗口显示 `****`、磁盘仍是原值；首页建议删除后 p6_2 改为检查三条内置示例且从未发出 `home.suggest`；R3、DL18、p6_4 / p6_6 属负载（窗口被最小化失焦、悬停事件丢失、与另一路 Electron 撞上），加固后连跑通过。顺带把 round5-history 默认连局域网真实模型的实测部分改为需显式设 `MCODE_PROBE_LIVE=1` 才跑。
- **用户 2026-09-17 决定**：核实 MiMo 引擎的定时任务工具不弹任何审批，**X10 的定时任务审批照 MiMo 去掉**（「安全修复也可能偏离 MiMo，加门槛前先核实 MiMo」）；归档提示 `toast.archivedNConvos` 改回 MiMo 原文「已归档 N 个聊天」（文案统一时误改，同组「没有可归档的聊天」本就保留 MiMo 原文）。两处连同相关冒烟检查与两个探针的预期一起改。
- **窄窗修复已合并**（分支 smoke 2839、探针 `round8-narrow` 8 项全过，未改的 v2.0 跑出 FAILED(4)）：MiMo 的对话列在 CSS 上没有最小宽度，只由脚本留 480；面板默认 380、下限 300、上限「窗口宽 − 62 − 侧栏 − 480」；放不下时先收窄侧栏（到 160）和面板（到 300），再不够折叠侧栏，刚打开侧栏放不下则关面板，最后让位的是对话列。MCode 的算法原本已一致，病根是对话列从第一个提交起就有的 `min-width: min(440px, 100%)`，改为 0。顺带修了一处不一致：判断要不要折叠侧栏时 MCode 用的是拖出来的面板宽度，MiMo 用实际显示的宽度（约 1002–1082px 窗口里 MCode 会提前折叠侧栏），新增 `panelWidthShown()`（`lib/right-tools.ts`）供 `App.vue` 与 `RightPanel.vue` 共用。超出对标一点：200% 缩放 + 720 窗口时只剩 360 CSS px，面板加 `max-width: calc(100% - 63px)` 让出 MiMo 会溢出的约 2px。1400 宽下布局与修改前逐像素相同。200% 缩放、360–500 CSS px 时对话列顶栏的固定按钮会被列自身边界截掉（不超出窗口），MiMo 同样如此，只记为备注。删除 `SessionTabs.vue`、只有它用的 `tabSessions` / `moveTab` 与 18 张表的 `tabs.close`。
- **两个决定已落地**：删除 `server/tool/schedule-ask.ts` 与 cron（schedule / loop / rename）、automation（create / update / resume）的询问，`perm.schedule` 18 张表各删一行；smoke 改为「命令权限设为拒绝时这六个操作照样执行且不产生询问」，临时换回旧代码 8 条失败 7 条。归档提示五张表恢复 W4 之前的值，`toast.archivedNConvos` 加入 `MIMO_CHAT_KEYS`。
- **第八轮收尾验证**（638418c 构建）：十一项检查全过，build 通过，smoke **2838 全过**（2834 + 窄窗 5 − X10 换成的新检查净减 1）；探针 round8-narrow 8、round5-history 7、round4-feedback 26、round8-security 18、round8-wording 15、round8-a11y 20、round6-visual 24、round5-main 29、round4-small 21 全过；round3-panel `A16_narrowWindow` 失败是期望过时——它在 1180 宽下拖出 500 的面板，旧规则按拖出宽度要折叠侧栏，新规则按显示宽度（424 ≥ 300）只收窄面板，与 MiMo 一致；探针改到 980 宽（低于 62 + 160 + 480 + 300）后 25 项全过。

**第九轮对照（2026-09-17）：已完成并验证。** 一边做第八轮留下的清单，一边再开三个没用过的角度：
- 构建：**按模型家族细分系统提示词**（核实 MiMo 对哪些家族用不同提示词或请求参数、按什么规则匹配，照做；提示词内容 MCode 自写）；**清单**——产物库记录多个来源对话并做全文搜索（MiMo 的 `artifact_source` 与 FTS）、xterm 读屏模式（鼠标所见不变）、第八轮遗留的两处安全风险（自定义服务商 baseURL 未遮蔽、MCP OAuth 未防 DNS 重绑定；不新增 MiMo 没有的询问）。
- 只读排查：**每个设置端到端**（默认值、取值范围、存放位置、是否真的生效、是否即时生效，`round9-settings.md`）、**服务商、模型目录、登录与 MCP 生命周期**（`round9-providers.md`）、**作为 Windows 应用与发行内容**（安装卸载、协议与单实例、任务栏与通知、打包内容、自动更新，`round9-windows.md`）。
- 仍待用户：V10（需要新 token 名）、L14（需要公开仓库地址）、L24–L27（需要 Linux / macOS 设备）。
- **按家族细分提示词已完成**（186411d、6106a9b，分支 smoke 2912、promptcheck 69，局域网模型实测通过）。核实结果：MiMo 引擎（`src/session/system.ts`）按**模型 id** 选十份提示词之一，与服务商无关：id 含 `gpt`（小写比较，但含 `gpt-oss` 的除外）→ GPT；否则依次 `gpt-4` / `o1` / `o3` → o 系列（beast）、`gemini-` → Gemini、`claude` → Anthropic（这三项区分大小写）、再按小写 `trinity` / `kimi` / `deepseek` / `glm` / `minimax`，都不中 → 通用。第八轮的规则有偏差（把服务商拼进去、`codex` 算 GPT、o 系列算 GPT、大小写不敏感），已改正。新写七份（o 系列 6.3KB、Gemini 7.6KB、Kimi 4.9KB、DeepSeek 8.0KB、GLM 3.0KB、MiniMax 7.0KB、Trinity 4.2KB），各自照对应文件的章节顺序、主题与大致篇幅，**文字自写**（与 MiMo 十份逐 6 词比对：新七份 0 处重合）；Trinity 那份照原文要求每步只调一个工具，Gemini / Trinity 带示例对话。请求参数方面，采样表第七轮已一致；本轮补上 MiMo `transform.schema` 的两个家族分支（Gemini：枚举值转字符串、required 只留已声明属性、数组补 items、非对象去掉 properties；Moonshot / Kimi：anyOf / oneOf 旁的 type 下放到各分支，`provider/tool-schema.ts`，两条线路都用，工具自身校验仍用原 schema，主要影响 MCP 工具）与 Kimi K2.5 走 Anthropic 协议时按 high 预算开启思考。**须知**：MiMo 桌面端把自己的一份提示词（claude.txt + desktop-base）写进引擎配置给 build / plan / compose 用，所以在 MiMo 桌面端里所有模型实际读同一份，引擎的按家族选择只对没配提示词的智能体生效；且桌面端设了 `MIMOCODE_CODEX_MODE=false`、未开 `MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT`（按家族的环境块不出现）。MCode 按用户要求照引擎规则每回合都分家族。未做：OpenRouter 上 gemini-3 的 `reasoning.effort=high` 基础值（MCode 总会发用户选的档位，覆盖它）、判别联合展平（与家族无关）。局域网 `qwen38-nvfp4` 属通用家族，一次性 profile 实测：读 README 调用 read 成功、答出暗号、第二轮前缀逐字节相同、只发 `top_p: 1`。每条新检查都在改坏代码后确认会失败（家族规则 7 条、章节 2 条、前缀 1 条、schema 与思考 8 条）。
- **清单三项已做（worktree 分支，eaa4499 / 2835dc2 / 3543c96 / c0c4cf3）**，MiMo 仍是 26.914.142245：
  - 产物库（`server/artifact/store.ts`，库版本 2）：MiMo 的 `artifact` 行按「对话 + 地址」各一行，`artifact_source` 记的是同一产物的多种观测来源，`artifact_fts` 是 `title_search`（文件显示名的 NFC 小写）的 FTS5 trigram 镜像，查询 ≥3 字符走 `MATCH "短语"`、更短走 `instr`，只搜名字；删对话时整行删除并记墓碑。MCode 仍一文件一行（用户此前定的「文件比对话活得久」），新增 `artifact_source`（每个写过它的对话一行）、`title/title_search` + 同形 FTS5 trigram 镜像（Electron 自带 node:sqlite 3.50.4 实测可用）、`artifact_reconcile` 检查点、`artifact_purged_session` 墓碑。删对话只把它的来源解除关联（保留标题）；文件显示在最新的仍存在的对话下，没有则在最新的已删对话下；消息被编辑掉的认领在下一轮对账时删掉，无人认领的行随之删除（同 MiMo）。v1 库在一个事务里迁移，不丢行；更新版本的库仍只读；行上保留 v1 的列，旧版本读新库照样能读。产物页与搜索浮层改为把关键词交给服务端（浮层同 MiMo：150ms 后请求，再在前端做模糊匹配）；**不再按对话标题搜**（MiMo 只搜名字）。另修一个旧缺陷：库非空时启动后新写的文件要重启才出现——现在列表前先对账有变化的对话（消息写入经 `SessionStore.watch` 标脏）。
  - xterm 读屏：MiMo 从不开 `screenReaderMode`。实测（WebGL 渲染器）开关前后终端区域逐像素相同（静止与拖选后），命中元素、光标与 xterm 各元素计算样式不变，读屏层透明且不接收指针；但它每帧重建逐行 DOM，所以只在 `app.accessibilitySupportEnabled` 为真时开，`accessibility-support-changed` 实时跟随（主进程 `mcode:screen-reader`，`lib/screen-reader.ts`）。新键 `term.tooMuchOutput`（18 张表）。
  - 安全两项（MiMo 都没做，这里更严，不改变正常配置的行为，未加任何审批）：`redactUrl` 遮自定义服务商 baseURL 与内置服务商端点覆盖里的用户信息和凭据样查询参数（设置文档、服务商列表、`auth.completed` 事件），原样传回时保留磁盘值（设置保存与自定义服务商表单都是），MCP 地址也加遮用户信息，日志遮任何地址里的用户信息；`server/oauth-fetch.ts` 让 MCP 登录对服务器指定的元数据 / 注册 / 令牌地址逐个解析一次、非公网即拒、连接钉在检查过的地址（TLS 仍按主机名校验），重定向逐跳检查；服务器自己的主机照旧信任，服务器本身在本机或内网时可指向内网其他主机。
  - 验证：十二项检查（含 mcpcheck）全过，build 通过，smoke **2878 全过**（全量里第五轮 E12 / 推理保留两段对本地假模型的请求偶发 0 次，两次出现、重跑即过，与本轮改动无关）；新增 smoke 检查逐个用变异证明会失败；探针 `mcode-round9-backlog-artifacts` 9、`-xterm` 4、`-security` 4 全过，改坏代码后分别失败 8+1、2+1+1、4 项。
- 合并两路后（2cbf424）：十三项检查全过，build 通过，smoke **2954 全过**，探针 round9-backlog 三个与 7 个回归全过。随后升级 **Electron 38 → 41.10.7**（MiMo 用 41 大版本，取 41 线最新补丁）并装入 `electron-updater` 6.8.9、`jsonc-parser` 3.3.1（e8834a3，用户批准），smoke 2954 全过。
- **用户 2026-09-17 第九轮决定**：
  - 设置：S9-1 已删设置行的旧值一次性重置；删掉 37 套主题配色、「服务器」设置页（连同远程后端功能）、权限里的「已保存的规则」列表；「新功能」弹窗删除。
  - 服务商：快速添加只留 MiMo 的 7 家；**保留**（故意不同）预设自动拉 `/models`、自定义表单的「协议」选项、ChatGPT 订阅登录。
  - 系统提示词：MiMo 桌面端实际给所有模型同一份，**改为所有模型同一份**（按家族的工具参数格式与 Kimi 思考属请求层，保留）。
  - 出网与体积：每小时从 models.dev 刷新模型信息（带离线快照）；读取项目里的 MCP 配置与 `~/.claude.json` 的 `mcpServers`；随包带 Python / Node / ripgrep（不带 LibreOffice）；本地崩溃转储（不上传）。
  - MCP：改动在下一个新对话统一生效（照 MiMo）；MCP 工具默认不询问；按项目目录各起一套；配置文件支持 JSONC。
  - 发行：Electron 41；按用户一键安装；改用 electron-updater。
  - 暂缓：N9-7 / N9-19（需要公开服务器）、N9-8（代码签名证书）、N9-20。
- **设置这一路已完成**（S9-1 … S9-14，`round9-settings.md`，worktree 分支 be9843e … d57324a）：
  - 配置读写：`server/config.ts` 新增 `RETIRED_FIELDS`，每次加载（和 `set`）都删掉已退役字段并写回：R25 的七个（通知两个、提示音两个、`pinchZoom`、`expandShell/expandEdits`）、`enabledModels`、`openTabs`、三个字体、`themeID`、`releaseNotes`、`showTerminal`、`serverURL/servers/defaultServer`。一次性迁移 `orphans-r9` 把按工具的 `permissions` 恢复为当前档位对应的表（完全访问 = 全部允许，其余 = 默认表；存下的 deny 一并清掉），删 `accessBefore`，档位和完全访问开关保留。新文件 `server/config-sanitize.ts`：照 MiMo 读时逐项校验（枚举、布尔、字号夹到 10–24 / 9–24 并取整、effort 不认识就 medium、accessLevel 不认识就删、提示音、应用图标、列表 / 映射 / 模型引用、keybinds 只留字符串）；此前 keybinds 里有数字会让后端启动时直接抛错。窗口缩放改用 `lib/font-scale.ts`（MiMo 的 `_T`）。
  - 热重载（S9-11）：`reloadFromDisk` 照 load 判断较新版本（之后 `set` 拒写）、走 `customProviderWrite`（手删的自定义提供商进 `disabledProviders`）、同样清洗；`Config.onReload` 由 `server/index.ts` 挂上，手改 `allowFullAccess` 为 false 时立即 `dropFullAccess()`。
  - 删掉的界面与功能：模型过滤（选择器、托盘、`keepModelsSelectable`）；隐藏标签条（`tabs/track/closeTab/forgetTab/reopenTab/closedTabs` 与 `session.reopenTab` 命令）——Ctrl+1–9、Ctrl+Shift+[ / ]、上/下一个未读改沿 `lib/visible-chats.ts`（MiMo 的 `K3` / `m5e`：置顶在前，其余按侧栏顺序，最近 / 名称两种排序，`recentSort` 挪进 store）；「标题生成模型」行（`titleModel` 仍可在配置文件里写）；三行字体；37 套配色、配色行与 `theme.*` 命令；升级后「新功能」窗（`ReleaseNotesDialog.vue`、`changelog.*`）；只能手写 keybinds 触发的改设置命令（自动接受、默认智能体、配色方案、语言）；权限分节的「已保存的规则」列表及 `permission.rules/forget` 请求（规则照旧存盘，删对话仍会删掉它自己的，`Permissions.forgetSession`）；「服务器」设置页与整个远程后端（`ServersDialog.vue`、`ServerPopover.vue`、切换服务器命令、`Client.useServer`、localStorage 里的地址启动时清除），CSP 的 `connect-src` 收回为 `ws://127.0.0.1:* ws://localhost:*`（后者给开发服务器）。环境页重名改为普通提示（S9-12，名称仍存 `projectNames`，不建 `.mimo` 目录）。共从 18 张表删掉 48 个未锁定键；锁定键（`set.codeFont`、`set.terminalFont`、`set.notifyAgent`、`set.pinchZoom`、`set.themePalette`、`cmd.useTheme`、`cmd.reopenTab`、`cmd.cycleLanguage`、`cmd.autoAcceptOn/Off`、`toast.autoOn/OffTitle`、`cmd.server`、`server.switch`、`set.server`、`set.localServer`、`set.connected`、`srv.*` 中的锁定项、`mcp.empty/enabledCount`）按规则保留。
  - 主题：窗口不再运行主题引擎；`tokens.css` 的 41 个引擎 token 在三个块里都换成 MCode 2.0 生成值（运行时本来就是这些值，画面不变），`lib/theme-palettes.ts` 只剩 `MCODE_THEME`；themecheck 改为三个块逐个比对并禁止 App / 设置读配色。
  - wiringcheck（S9-9）：配置字段只认属性访问（`.x`、`?.x`、`["x"]`）和解构，先抹掉带点的字符串键；改完即在 `showTerminal` 上失败（又用删掉 `spineSound` 读取点验证），随后删掉该字段。CSP 检查改为要求 socket 只到本机。
  - 验证：十三项检查全过，build 通过，smoke **3046 全过**（新 `scripts/smoke-round9-settings.ts` 100 条，另改 smoke-storage / round8-security / round8-access / session-check / smoke.ts 里依赖旧行为的检查）；每组新检查都在改坏代码后确认会失败。探针 `mcode-round9-settings.cjs` 13 项全过、0 报错（截图 general / permissions / appearance / environment），在 v2.0 基线构建上 13 项全失败（`PROBE_TEXT_CHORDS=1` 时各项按各自原因失败，否则基线会被 keybinds 里的数字弄崩键盘）。回归探针 round9-backlog-security 4、round8-security 18、round3-settings 38、round2-settings 23、round5-keys 16、round4-small 21 全过；round2-settings 的 G1 / G6 / G14 预期已按 R25、S9-6、W4 更新（探针问题，仓库未改）。
- **Electron 改锁 41.7.2**（8aad431，MiMo 同一版）：41.10.7 下文件面板在同一文件夹里连续切换文件时主进程卡死（计时器停、调试器也停不下来，属原生代码），round3-files 探针 300 秒超时；同一探针在 38.8.6 与 41.7.2 上跑完，把 `fs.watch` 换成空实现后 41.10.7 也跑完。另：Electron 41 里 `fs.rmSync` 递归删除遇只读文件（git 对象）报 EPERM（系统 Node 24 与 `fs.promises.rm` 不会），MCode 源码只用异步删除不受影响，scratchpad 探针统一加载 `e41-rmfix.cjs`。本机 `%LOCALAPPDATA%\electron\Cache` 有 38.8.6 / 41.7.2 / 41.10.7 等 zip，可解到 scratchpad 对照。
- 设置合并进 v2.0 后（41.7.2）：十三项检查全过，build 通过，smoke **3048 全过**；探针 round9-settings 13、round3-files 37、round3-settings 38、round5-keys 16、round9-backlog-xterm 4、round3-terminal 27、round3-panel 25、round6-visual 24 全过。
- **Windows 发行这一路已完成**（`round9-windows.md` 除暂缓项外全部，worktree 分支 eacbf2a … 5d94c6c；0.2.5 / 0.2.6 两次打包只为量体积，未运行安装包、未改注册表）：
  - 更新（N9-5/1/2/3/4/16）：删掉 MCode 自己的 JSON 更新源代码，改用 electron-updater（`main/updater.ts` 只放规则，库对象由 `index.ts` 按 MiMo 的方式动态加载）。更新源是 electron-builder 的 generic 文件夹（`latest.yml` + 安装包 + `.blockmap`），地址来自设置行或 `MCODE_UPDATE_URL`，两者都空就什么都不请求；只认 https（本机 http 可用于测试）。启动 5 秒后、之后每 3 小时检查；**只有更高版本才算更新**，更旧的只有 `latest.yml` 写了 `rollback: true` 且发布不满 30 天才装（MiMo 按版本号里的日期算，MCode 版本号不含日期，改用 `releaseDate`）；每个文件必须带 sha512（electron-updater 本身也拒绝没有校验值的条目，下载后按 sha512 校验，差量下载同样校验）；staging 用户 id 固定为 `none`。安装：请求时只记事务并退出，**等后端关闭后**先照 MiMo 结束安装目录 `resources\` 下的辅助进程（PowerShell，3 秒上限），再 `quitAndInstall(静默, 重开)`，装在 Program Files 下时不静默（好弹 UAC）；平时退出仍按库默认静默安装已下载的更新（MiMo 同）。更新事务 `userData/updates/update-transaction.json`：下次启动核对，版本已到就删；安装程序启动后仍是旧版、超过 1 小时、或启动失败则算中断，窗口弹一次「更新到 X 没有完成」（新键 `update.interrupted`，18 张表），随即删除记录（MiMo 会每次启动都提示，MCode 只提示一次）；MiMo 的快捷方式修复未做（安装程序带 `--updated` 会保留快捷方式）。启动时（仅打包版）删旧版更新器留在 `%TEMP%` 的 `mcode-x.y.z.exe`，以及版本已不高于当前的 `mcode-updater\pending`；`installer.exe`（差量下载的基准，安装程序每次自己更新它）保留。`electron-builder.yml` 的 `publish` 是 generic + 永远解析不到的 `https://updates.invalid/mcode/`（只为生成 `app-update.yml` 的缓存目录名和 `latest.yml`），`package.mjs` 固定 `--publish never`，不再出现私有仓库名。文案：`set.updateFeedSub`、`update.installHint`、`update.installingBody` 改为「文件夹地址」「会自动重新打开」（顺带把 12 张表里残留的英文 installHint 译好），删 `update.found`。
  - 安装程序（N9-6/N9-10）：`oneClick: true`、`perMachine: false`，无任何页面。`build/installer.nsh`：首次安装的目录用产品名 `%LOCALAPPDATA%\Programs\MCode`（electron-builder 一键默认是小写包名 `mcode`，MiMo 的目录是产品名）；注册表里已有位置或带 `/D=` 时不动。**已装在 `D:\Apps\MCode` 的 0.2.4**：同一个 appId 算出同一个 GUID（`d73894b3-…`，已只读核对 HKCU），一键安装程序读到 `InstallLocation=D:\Apps\MCode` 就原地升级，先静默跑旧卸载程序（带 `--updated`，保留数据和快捷方式，`KeepShortcuts=true`），MCode 正开着会提示关闭；数据仍在 `%APPDATA%\mcode`。真正卸载（非更新）时：`HKCU\Software\Classes\mcode` 的命令指向本安装目录才删；删 `%LOCALAPPDATA%\mcode-updater`；用户数据照旧保留。NSIS 带 `-WX` 编译通过，未实机运行。**核对发现**：MiMo 的安装目录是产品名「Xiaomi MiMo」，而 electron-builder 的一键 + 按用户安装会用包名，说明 MiMo 实际多半是「按用户的向导式」安装程序；按用户决定仍做成一键，另见报告。
  - 随包运行时（N9-12）：`scripts/runtimes.mjs`（`npm run package:win` 自动调用；缓存 `%LOCALAPPDATA%\mcode-build-cache\runtimes`，放到 git 忽略的 `resources/runtimes/win32-x64`）：Node.js 24.18.1 官方 zip（其 npm 11.16.0 与 MiMo 带的相同；MiMo 的 node 是 2MB 的 Electron-as-Node 启动器，不能照搬）、python-build-standalone 3.12.13+20260807 install_only（与 MiMo 同版本同构建族，python312.dll 与 LICENSE.txt 字节数一致）+ 同版本 full 包里的 `licenses/`、MiMo 那 20 个 PyPI 包（同版本，pip `--require-hashes --no-compile --target` 离线装）、ripgrep 15.1.0（只留 rg.exe 与三份许可，同 MiMo）。每个文件按发布方公布的 sha256 和大小校验，不符就拒绝；装完删掉会写死本机路径的启动器与 `direct_url.json`，并扫描整棵树确认不含构建目录、缓存目录或用户目录。不带 LibreOffice、qpdf、github-mcp-server、MiMo 的 node_modules 与 evolve。主进程 `main/runtimes.ts` 在启动时设 `MCODE_NODE` / `MCODE_NPM` / `MCODE_PYTHON` / `MCODE_RIPGREP_PATH`（用户已设的优先）与 `PYTHONDONTWRITEBYTECODE=1`，不改 PATH（同 MiMo）；未打包时找仓库里的那份。五个文档类技能和 Office 附件说明改为优先用 `$MCODE_PYTHON`，html-to-video 提到 `$MCODE_NODE`。第三方许可新增 Node.js、Python、Python 包、ripgrep 四项，文本由脚本从实际打包的文件生成（`--write-licenses`），打包时逐字比对，不一致就失败。
  - 启动环境（N9-11）：`main/shell-env.ts`，模块加载时同步执行（开发服务器模式跳过）。Windows 经 `cmd /c chcp 65001 & reg query` 读 HKLM 与 HKCU 的 Environment（MiMo 直接按 UTF-8 解码 reg.exe 的输出，中文路径会乱码，实测确认），展开 `%VAR%`，PATH 以注册表为先并去重（忽略大小写与结尾斜杠）；macOS / Linux 用 `$SHELL -ilc` / `-lc` 在标记之间打印 `env -0`。只补进程里没有的变量（MiMo 会覆盖，包括 HKLM 里的 `USERNAME=SYSTEM`），3 秒上限，失败不改。
  - 其他：N9-9 `package.json` 加 `productName: "MCode"`，托盘提示、通知兜底标题、macOS 应用菜单用常量；Electron 默认数据目录会随之变成 `MCode`，启动时只在「仍是默认目录」时固定回 `…/mcode`（Windows 上同一目录，Linux 不必迁移；探针或 `--user-data-dir` 指定的目录不动）。N9-14 窗口状态照 MiMo：最后一个窗口关闭 / 隐藏到托盘时和退出时才写，最小化或全屏时不写，不再保存和恢复全屏（旧文件里的 `fullScreen` 忽略）。N9-15 `main/crash-dumps.ts`：`crashReporter.start({ uploadToServer: false })`，转储在 `userData\Crashpad`（启动日志写明位置），启动 10 秒后按 MiMo 的上限清理（最新 10 个、14 天、32 B–128 MB，只动 `.dmp`）。N9-18 三个 xterm 插件改为 devDependencies，其中 `addon-web-links` 没人用，直接删掉；asar 只收 `out/main`、`out/preload`、`out/renderer`（此前检查脚本打出的 `out/*.mjs` 约 11 MB 会被一起打进去）。
  - 暂缓（用户定）：N9-7 / N9-19（公开服务器）、N9-8（签名证书；electron-updater 的发布者校验在 `app-update.yml` 有 `publisherName` 时才生效）、N9-20。N9-17 由另一路删除。
  - 体积（同机、同 v2.0 基线打包）：安装包 148,324,330 → 237,393,303 字节（0.2.5 → 0.2.7），win-unpacked 469,223,699 → 839,248,709，其中运行时 373,068,598（node 105.6 MB / python 263.2 MB / ripgrep 4.3 MB，共 9,963 个文件，逐字节与源树一致）；app.asar 62,426,742 → 60,050,911（去掉 xterm 插件 2.95 MB，且不再收 check 打包文件）。
  - 验证（合并 v2.0、Electron 41.7.2 后）：十三项检查全过，build 通过，smoke **3136 全过**（新 `scripts/smoke-round9-windows.ts` 103 条，删去旧 JSON 更新源的 15 条）；每组新检查都在改坏代码后确认会失败。探针 `mcode-round9-windows.cjs` 8 项全过、0 报错（注册表环境、四个运行时实际运行、本地转储、窗口状态、中断提示、IPC、真实 electron-updater 对本地更新源端到端、退出时的窗口状态），改坏代码后 8 项全部失败。
- **服务商与提示词这一路已完成**（`round9-providers.md` 除 MCP 各项，worktree 分支 8b18f72 … 2c77395），MiMo 仍是 26.914.142245：
  - **所有模型同一份系统提示词**（8b18f72）：核实 MiMo 桌面端把「claude.txt + desktop-base.md」（计划模式再加 `plan-addendum.md`）写进引擎配置给 build / plan / compose，所以桌面端从不按家族选；`session/prompts.ts` 改为一份（通用部分 9.7KB 照 claude.txt 的章节，桌面部分 11.3KB 照 desktop-base 的章节，MCode 没有的内容——交互小组件、随包运行时——换成 MCode 实有的说明；计划模式段 0.8KB 照 plan-addendum），文字自写，与 MiMo 四个文件逐 6 词比对 0 处重合。删掉十份家族提示词、`promptFamily`、`scripts/smoke-round9.ts` 与第八轮的家族断言；请求层的家族差异（Gemini / Kimi 工具参数整形、Kimi K2.5 思考）核实在 MiMo 引擎的 provider 层照常生效，保留，检查移到 `scripts/smoke-round9-providers.ts`。局域网 `qwen38-nvfp4` 一次性 profile 实测：调 read 读 README、答出暗号、两轮前缀逐字节相同、不发 reasoning_effort、只发 `top_p: 1`。
  - P9-1 强度子菜单照 MiMo 桌面的规则（`shared/effort-menu.ts`，按 id + 显示名：Claude 的 3.7 / 4.x / Sonnet 5 / Fable / Mythos 给五 / 四 / 三档，GPT-5 与 Codex 除 chat、5-Pro 外三档，5.2 起加 xhigh，5.6 再加 max；其余一律没有，且回合不发强度，菜单没有的档位就近夹到 medium）。服务端 `variants` 仍只负责把档位翻译成请求参数。
  - P9-2 自定义服务商保存时（和读取已存的）去掉地址末尾斜杠与 `/chat/completions`、`/completions`，模型 id 去掉所有空白；表单失焦时显示整理后的值。
  - P9-3 / P9-4 对话的模型不在了（服务商删除 / 断开、模型从列表消失）时，下一回合改用全局模型，全局模型也不在就按 MiMo 的回落（先 MiMo Pro 类，再第一个；刚连接的服务商优先），一个都没有报 `error.noModel`；窗口里这类对话显示全局模型；出厂默认模型留空，芯片显示「选择模型」。连接后列表为空的服务商不做模型 id 核对。
  - P9-5 快速添加只有 MiMo 的 7 家（Xiaomi MiMo API、MiMo Token Plan、DeepSeek、Kimi / Moonshot、智谱 GLM、千问、MiniMax）+ 自定义；连接弹窗也只列这些，外加 MCode 保留的 ChatGPT 订阅登录；其余内置厂商与本地运行时经「自定义」添加，已连接的照常列在「已添加」。MiniMax 改为 `api.minimaxi.com`（已存的地址覆盖不动）。
  - P9-8 保存自定义模型时，图片输入为默认且 models.dev 里同名条目全都收图，就记为收图（只开不关，显式选择不动）。
  - P9-9 服务商相关报错改为错误码（可带参数），窗口按 18 张表说；回合级 `session.error` 也带码。
  - P9-10 models.dev：照 MiMo 启动即刷新（缓存不足 5 分钟不取）、之后每小时、10 秒超时，下载原子写入 `<数据目录>/cache/models.json`，叠在随包快照上（快照只补下载缺的字段）；失败只记日志。随包快照 `resources/models-snapshot.json`（2.6MB，217 家 7823 个模型，只留 MCode 读的字段；MiMo 把 4.7MB 的快照直接打进引擎，所以这里也提交进仓库，`npm run models-snapshot` 手动更新，打包时按需加载成独立 chunk）。内置服务商按 `MODELS_DEV_IDS` 对应 models.dev 的服务商，上下文、输出上限、价格、能力、输入模态、强度选项以 models.dev 为准，名称仍用自己的表；自定义服务商不套。`MCODE_DISABLE_MODELS_FETCH` 关网（smoke 与探针都设了），`MCODE_MODELS_URL` 换源。新事件 `providers.updated`。
  - P9-12 ChatGPT 续期被拒时发 `auth.expired`，窗口常驻提示「{name} 登录已过期，请重新登录」并带「重新登录」（打开该服务商的连接弹窗）；回合遇到同样情况报同一句。
  - P9-13 使用情况页三块统一为最近 14 天、按本机时区分日；没有价格的用量显示「—」，部分有价时注明；标题、Smart 路由、上下文压缩、命令审查这些后台请求的用量记入 `storage/usage-background.json`，算花费不算回合。
  - 新文案 12 个键进 18 张表。验证（合并 v2.0 的 Electron 41.7.2 与设置一路之后）：十三项检查全过，build 通过，smoke **3075 全过**（`smoke-round9-providers.ts` 115 条；另把 round9-settings 里「坏模型回到默认 claude-opus-5」的预期改为空默认）；每条新检查都在改坏代码后确认会失败。探针 `mcode-round9-providers.cjs` 7 项全过（截图 home-empty / quick-add / custom-form / model-menu / expired-notice / expired-connect / connect-browse / usage），改坏构建后 6 项失败、单改「重新登录」链接后 V6 失败；回归 round8-model 9、round3-settings 38、round9-settings 13 全过。`mcode-round3-composer.cjs` 仍读已在第八轮删除的 `SessionTabs.vue`，中途报错，属探针过期。
  - P9-14 … P9-18 与 MCP 各行见下一条。
- **MCP 生命周期这一路已完成**（M-1 … M-16，即 `round9-providers.md` 的 P9-14 … P9-18 与审计各项，worktree 分支 0dc683d … d7788e7）：
  - **按项目分组**（M-7）：`server/mcp.ts` 按项目目录各有一组连接，本地服务器在该目录启动；回合开始前等本项目的服务器连上（或失败）再给工具；设置页报告的是新对话默认目录那一组。空闲 30 分钟的其他项目组关闭。
  - **来源**（M-6、M-5、M-16，`server/mcp-sources.ts`）：MCode 自己的 `mcpServers`，再按 MiMo 规则合并项目里的 `mcode.json(c)`（从目录向上到仓库根，外层先、近处覆盖）与各级 `.mcode/mcode.json(c)`、`~/.mcode`，最后是 `~/.claude.json` 与 `<目录>/.claude.json` 的 `mcpServers`（跳过 SSE，不覆盖 MCode 自己的同名项，**只读 `mcpServers` 这一个键**）；这些不出现在设置列表里。`{env:名}` / `{file:路径}` 按所在文件的目录替换。没有 type 的条目忽略；未知 type、字符串 command 等报「invalid config: …」失败。检查与探针用 `MCODE_IMPORT_HOME` 指向临时目录，从不读用户真实的 `~/.claude.json`。
  - **下一个对话生效**（M-2、M-1）：保存 / 启停 / 删除只写配置并标记过期；新建对话时（`session.create`）若没有回合在跑就立即重读所有项目组，否则等最后一个回合结束；配置变了的条目（命令、地址、请求头…）断开重连，失败的重试，删掉的关闭，没变的保持。删除了每个对话固定的服务器列表（`SessionInfo.mcpServers`、`store.setMcpServers`）。设置页每次刷新状态时对「已启用但报告里没有」的服务器调 `mcp.register` 立即连接（MiMo 的 mcpRegister），期间整列显示「检测中…」，报告仍没有的显示「未知」。
  - **MCP 调用默认不询问**（M-3）：`mcp` 桶默认 allow，帮我审批同样；一次性迁移 `mcp-allow-r9` 把已走过 S9-1 重置、仍存着旧默认 ask 的文档改为 allow（deny 保留）。MCP 采样（sampling）未设置时仍询问（`patternAsks`，与 MiMo 只看用户规则一致）。
  - **config.json 是 JSONC**（M-4，`server/jsonc.ts`）：注释、尾逗号可读；保存按键修改、保留注释与顺序；磁盘文件解析失败时拒绝写入，报 `error.configUnparseable`（文件名、行、列，18 张表），内存回滚。`CodedError` 带参数到窗口；MCP 表单 / 启停 / 删除的失败提示带原因。文件监视记住本进程最近写出的文本，不把自己的保存当成手改（否则按键写入后键序不同，会把刚加的自定义服务商读回成禁用）。
  - 其余：M-8「工具」按钮独立探测（`server/mcp-probe.ts`，15 秒、无 OAuth、无 SSE 回退、翻页，已关闭 / 失败的服务器也能列）；M-9 `needs_client_registration`（黄色「待授权」+「授权」，`lib/mcp-status.ts` 统一各处状态）；M-10 表单命令不拆分、参数与请求头值去空白；M-11 停止本地服务器：关 stdin → 2 秒 → SIGTERM → 2 秒 → SIGKILL（非 Windows 先按 pgrep 结束子进程），退出时等待；M-12 运行中死掉立即推送状态并撤工具；M-13 stderr 尾部 4096、逐行写日志、启动失败日志（命令打码、退出码、信号），错误形如「原因; exit code N; signal S; stderr」，列工具失败统一一句；M-14 `mcpTimeout`（全局调用超时，服务器自己的 `timeout` 优先）与条目里的 `tools` 规则（按工具名、`*`/`?`、后者优先：false/deny 不提供、ask 每次询问、true/allow 不询问但 MCP 被拒时仍拒）；M-15 列表按配置顺序、配置路径显示为 `~`、导入提示注明下一个对话生效。Windows 上 `.cmd` 仍走 cmd.exe（`server/mcp-launch.ts`）。
  - 验证（合并 v2.0 providers / Windows 之后，4b866ae）：十三项检查全过，build 通过，smoke **3258 全过**（新 `scripts/smoke-round9-mcp.ts` 约 100 条、夹具 `scripts/fixtures/mcp-lifecycle-server.cjs`；删去第六轮 L5「对话固定服务器」一节，mcpcheck 的启停改为下一个对话生效，round9-settings 的默认表改为 mcp allow）；每组新检查都在改坏代码后确认会失败。探针 `mcode-round9-mcp.cjs`（临时 userData、临时 HOME、临时项目，配置从零写出）15 项全过、0 报错，两次改坏构建后对应 8 项失败。一次全量 smoke 里第八轮 M14「首条消息带说明」三条偶发失败，重跑两次都过，属时序偶发。
- 四路全部合并后（MCP 合并无冲突）：十三项检查全过，build 通过，smoke **3258 全过**。27 个探针里 19 个直接通过；8 个待核对：round9-mcp（写的不是 verdict 格式、根目录写死工作树）、round9-settings R2（M-3 后 mcp 默认 allow）、round8-narrow F（基准高 761、现 760，疑为 Electron 41 窗口尺寸）、round8-a11y M / A1（边框 0.57px、焦点环颜色，疑缩放或主题值变化）、round7-storage 两项「始终允许」（S9-13 删了列表）、**round5-plan P1–P5（回合一直 running，可能是真缺陷）**、round5-main M10（移到屏外的窗口没被拉回，可能是 N9-14 回归）与 M2 / M3（旧更新源已换成 electron-updater）。已派一路核对与修复。
- **探针核对结果（2026-09-17）**：只有一处真缺陷，其余都是探针过期或本机环境。
  - 真缺陷（4069262）：终端面板在打开的同一轮事件里被卸载（首页与对话来回切两次）时，xterm 5.5 视口排在零延时定时器上的首次同步读到已拆掉的渲染器，窗口报 `reading 'dimensions'`；现在这种情况下 dispose 排到那次同步之后。round6-journeys 未修复时 1 个报错，修复后 0。该探针两次运行合并到同一文件、报错会累加，旧文件里的报错一直留着——改为不带 MODE 运行时先清文件并先跑 fresh 半场（18 项）。
  - round5-plan：不是回合卡住，而是临时配置没有 `orphans-r9` 迁移记录，S9-1 把按工具权限重置成默认表（写入 = 询问），计划文件的写入停在权限卡上。探针补上迁移记录后 8 项全过。
  - round9-settings R2：M-3 后 mcp 默认 allow，预期已改。round9-mcp：改成 verdict 格式（15 项）并认 `MCODE_ROOT`。
  - round7-storage：S9-13 删了 `permission.rules/forget`，但「始终允许」仍按项目存盘并生效。改为真实回合检查：记住的 `mkdir r7-remembered *` 不再询问并真的执行；未覆盖的命令仍弹权限卡（替换无法再做的「撤回」检查）；种子规则换掉时前者失败。
  - **本机 Electron 41 的显示器问题（环境，需要用户留意）**：此刻本机上 Electron 41.7.2 与 41.10.7 的 `screen.getAllDisplays()` 返回空数组，主显示器是假的 1920×1080、缩放 1，窗口按 100% 渲染（空白脚本、经资源管理器启动、不在代理的作业对象里也一样）；同一时刻 38.8.6、43.2.0、44.1.1 都列出真实显示器、按 175% 渲染。用户昨晚 22:10 启动的 MiMo（同为 41.7.2）窗口仍是 175%。今天所有 41 下的探针截图都是 1 倍（04:48 起）。因此：round8-a11y 的 M（0.571px 对 1px 等）与 A1（2px 对 1.714px）、round8-narrow F（761 对 760）只是缩放不同——两个探针改为按 devicePixelRatio 各存一份基准（dpr1 基准分别由第八轮修复前的 r8a-base-app 与 1921bc8^ 构建录得），A1 按缩放取环宽；round5-main M10 是 Electron 给的显示器列表为空、拉回无处可去（MCode 与 MiMo 都用 `getAllDisplays`，N9-14 没动这段），探针在列表为空时用主显示器代替。若用户那边的 MCode（41）也显示得很小，这是 Electron 41 在本机的问题，重启 MiMo 能否复现可以作为判断。
  - round5-main M2 / M3：改由新探针 `mcode-round5-main-update.cjs` 在单独的 Electron 进程里跑真实应用的 electron-updater（`forceDevUpdateConfig` + 探针自己的 app-update.yml，本机 http 更新源，`quitAndInstall` / `install` 为记录器）：5 秒后自动检查、下载并校验、胶囊显示、手动检查不重下、安装前通知、安装的是下载好的文件（静默 + 重启）且事务记为 installer-started；更新源给旧版本时 5 项失败。
  - 验证：六项检查、smoke 3258、build 全过；round9-mcp 15、round9-settings 13、round8-narrow 8、round8-a11y 20、round7-storage 7、round5-plan 8、round5-main 31、round6-journeys 18、round9-windows 8 全过、0 报错。改过的探针都有 `.pre-r9triage` 备份，改动行标 `// Triage:`。
- **第九轮收尾**：核对那一路合并后（终端面板 dispose 竞态修复 4069262），八个失败探针连同 round6-journeys（18 项）全部通过；除终端面板外都是探针问题（计划模式卡在权限卡上是因为临时配置缺 `orphans-r9` 迁移记录；「始终允许」改用真实回合验证；更新检查改由 `mcode-round5-main-update.cjs` 在独立进程里跑真实 electron-updater）。
- **本机显示器问题已确认是锁屏造成的**：工作站锁屏期间（LogonUI 运行，04:19 起）Electron 41.7.2 / 41.10.7 的 `screen.getAllDisplays()` 返回空、窗口按 100% 渲染；同一时刻 38 / 43 / 44 正常。解锁后 41.7.2 立即读到 175% 的显示器（`scratchpad/r9t-displays.cjs`）。锁屏时跑的像素探针会得到 1 倍读数，round8-narrow / round8-a11y 已按 devicePixelRatio 各存基准。
- 排查结果：工具行为 57 项（高 1：中文 Windows 上 bash 输出切到半个汉字时整段按 GBK 乱码）、git 21 项（高 2：非 ASCII 文件名被滤掉致删除工作树前误判干净；「提交并推送」会把从 origin/main 建的分支推到远端 main）、步骤绘制 16 项（高 1：已完成回合的折叠规则）。对以往报告的更正：MiMo 桌面端不给模型 multiedit、标题工具与 `mcp_tool_search`。
- **用户 2026-09-17 第十轮决定**：
  - 工具安全照 MiMo 放宽：去掉 bash 正则硬拒绝表（删除类命令改走单独询问）、grep include 可命中被忽略文件、整个 git 仓库根算项目内、present_files 可交出项目外文件。
  - 工具行为照 MiMo：删掉 multiedit 与 MCode 独有的 list；批准计划后同一运行直接开工；子智能体不能提问；history get 不自动交附件；read 读到的媒体当场存下；Windows 默认 shell 优先 pwsh；webfetch 用 turndown（新依赖，已装 7.2.4）；交付的网址自动用系统浏览器打开；定时规则周期从纪元起算；返回给模型的文案照 MiMo 用中文的那些改中文。
  - git 照 MiMo：推送固定到 origin 同名分支；工作树 / 子目录对话归入主仓库项目；删掉新建 / 切换 / 删除工作区三条命令；补合并冲突提醒与内置 worktree / merge 技能（文字自写）；提交也设 15 秒超时；撤销按文件所在仓库，含项目外文件。
  - 步骤：插话照 26.914 切成「上一回合 + 普通提问 + 新回合」；步骤脱敏直播和重载都做（超出对标）；加「i」提示行；长串折行照 MiMo（先截图实测）；阿拉伯语补双数复数。
  - 按 MiMo 就近定的：定时任务目标限当前对话或侧栏里未归档、非子智能体的对话（MCode 没有置顶对话），找不到时记 skipped；pdf_locate 接受相对路径照 MiMo；发起方停止时排队的跨对话消息（后改：照 MiMo 不撤回，见下）；同步跨对话等满时转异步保持现状（有意差异）。
- **第十轮 B 部分（bash / 网页 / 执行外壳）已完成**（T10-1～7、T10-34～41，T10-55 按决定保持英文）：
  - bash 输出按流解码，编码每条命令只在第一个非 ASCII 字符处判定一次（UTF-8 或控制台代码页），两个管道共用；头部、尾部、保存文件、实时预览都用解码后的文本，切在字符中间不再整段变 GBK。预览只留最新 30000 字，至多每 100 ms 刷新一次（T10-41）。
  - 超时 / 停止：先结束进程树并等管道关闭（最多 3 秒），之后不再收任何输出；runner 的 progress 只在调用 running 时写。停止时调用记为 `interrupted`，错误为 `Tool execution aborted`，已打印的输出下一次请求按结果交给模型（T10-5）。
  - PowerShell 前缀同时设 `$OutputEncoding`（管道给原生程序的中文不再变 `?`）；cmd 用逐字参数并加 `chcp 65001`；POSIX shell 用 `-c`。默认 shell 照 MiMo：`SHELL`（fish、nu 除外）→ pwsh → powershell → git bash → COMSPEC；设置里的 shell 仍优先。`which` / `gitBash` / `windowsPath` 移到 `server/shell-path.ts`，终端抽屉共用。
  - 删掉正则硬拒绝表（用户决定）；删除类命令仍走原有的单独删除询问（每次询问、不记住、临时目录除外，判定同 MiMo 的 DELETE_COMMANDS 与 GIT_DESTRUCTIVE）。
  - `workdir` 的 `/c/…`、`/mnt/c/…`、`/cygdrive/c/…` 转盘符（POSIX shell 下 `/tmp` 之类问 cygpath），目录不存在时报 `workdir does not exist…`；bash-scan 的参数路径也对所有 shell 做同样转换。
  - git 作者 / 提交者按项目仓库 `git config` 设置（环境里已有则不设，按项目目录缓存）；`description` 改为必填（T10-40，照 MiMo）。
  - 截断提示改为用 actor 工具开 explore 子智能体，且只在本轮确实提供 actor 时这样说；调用不存在的工具时列出本次请求提供的工具名。
  - webfetch：turndown（MiMo 的选项，移到 devDependencies，由主进程构建打包，不再随 node_modules 重复打包）；图片（SVG 与 fastbidsheet 除外）作为附件交给模型；发生跳转时输出第一行写明最终地址；描述去掉「不抓本机」。
  - 验证：`scripts/smoke-round10-bash.ts`（44 条，接在 smoke.ts 里）；草稿区 `r10b-mutate.cjs` 逐项改坏确认会失败；探针 `mcode-round10-bash.cjs`（B1～B6：实时中文、刷新频率、删除卡片、停止后交出输出、图片附件、无报错）。
- **第十轮·文件工具与桌面工具包（A、D 两部分）已完成**（smoke 3390 全过，探针 `mcode-round10-files.cjs` 9 项全过，改坏的构建跑出 F1–F8 失败）：
  - 删除：multiedit（工具、描述、权限、`tool.multiedit` 18 张表、界面映射、检查）与 MCode 独有的 list 工具（explore 只剩 read/glob/grep/bash/webfetch）；渲染层保留 MiMo 自己的 list 文案和 list 权限桶。
  - glob / grep 改走随包 ripgrep（`MCODE_RIPGREP_PATH`；没有时退回 `ignore.ts` 的遍历，规则尽量一致）：Rust 正则、UTF-16/二进制处理、`--glob` 压过 .gitignore（grep include 也照 MiMo 放开）；路径不存在报错；停止时报错而不是返回半截；读不了的路径注明；匹配行去掉换行、非 UTF-8 行解码显示；任何层级都排除 `.git`。
  - 越界判断：会话所在 git 工作树根以内都算项目内（`repositoryRoot`），应用数据目录的保护仍在前。
  - read：先按文件头判断类型（七种魔数，`read-media.ts`；用户附件同样）；只附 MiMo 的媒体，其余提示转换；模型读不了时当场给出替代办法（带视觉模型的 actor、内置 pdf 技能、ffprobe）；上限 50 MB，图片 150 MB 内先压缩；附上的媒体在读取时复制到 `<data>/storage/read-media/<sha>/<文件名>`（`Attachment.copy`，请求读副本，历史固定；副本按内容去重，**目前不清理**）。子目录指令改为从本轮要发送的历史判断（已完成、未被裁剪清空的 read），只有成功的 read 才占用，媒体 read 也带，修正了前缀误判。
  - notebook 带 BOM 可编辑并保留 BOM；write / 空 old_string 的 edit 只把 ENOENT 当新文件；edit 的最接近提示补齐 MiMo 七个匹配器；edit 新建文件在改动卡里算新建。
  - present_files：相对路径先 cwd 后项目；绝对路径可在项目外（卡片预览、打开方式随之支持）；网址去 #/默认端口去重，卡片名取路径末段。每次调用按 MiMo 三道规则降级（卡片、信息卡、自动打开都用；照 MiMo 按完整路径判断 tmp/temp 等目录）。
  - 自动打开改在 store 层（`lib/delivered.ts`：`noteDeliveryUpdate` / `noteDeliveryTurnEnded` / `deliveryShown`，`App.vue` 登记「在显示」）：对所有对话生效；pdf_locate 立即标记段落，对话不在显示时挂起到切过去再开；present_files 在回合结束时只开本回合第一个交付物；图片 / 音频不开，网址用系统浏览器，其余进右侧面板；只认本窗口实时看到的完成。
  - 跨对话四个工具与桌面设置：失败作为结果文本返回（停止仍按停止记）；返回给模型的文案改中文（MCode 自己的措辞），「对方忙、转异步」提示照 MiMo 保留英文；设置快照包成 `{ok, settings}`，接受 浅色/深色/跟随系统、颜色/+/-。
  - automation_update：拒绝 new-task+important-updates、existing-task+all-runs（修改按合并后的结果检查，失败不改动）；去重按 MiMo 十个字段、日程按含义比较；existing-task 目标限当前对话或侧栏里未归档、非子智能体的对话，运行时找不到目标 / 项目目录记 skipped；reasoning 须是该模型支持的档位（默认档位不支持就不带）；update 传空 title/prompt 报错；无 DTSTART 时周期从 1970 起算，按日历整周期搜索下一次；DTSTART 不接受 Z 和非 00 秒，UNTIL 必须带时间（旧格式的任务保留但不运行）；schedule 文案随界面语言出中文，时间去前导 0，label 规则照 MiMo。
  - 保持现状（按用户决定）：同步跨对话等满时转异步（有意差异）、pdf_locate 接受相对路径；「MCode 更好」清单中的字面 replace_all、保留 BOM、Windows 下记忆索引都未动。
  - 未做 / 留意：数值参数自动转换（round7 M6，validate.ts）不在这两部分；read-media 副本没有清理机制；探针截图里无改动回合也显示「已编辑 0 个文件」卡，bash 那一路的截图同样如此，不是本路引入，需另查。
- **第十轮 git 一路已完成**（`round10-git.md` G10-1 … G10-21 全部）：
  - 所有对用户仓库的 git 调用改走 `server/git-process.ts` 的 `runGit`：`-c core.quotepath=false`、`GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`、不弹控制台窗口、默认 15 秒超时（`worktree list` 10 秒、推送 60 秒，提交也是 15 秒，超时的钩子被杀掉，提示「git commit timed out after 15s」）。status / numstat / 提交状态都读 `-z` 输出，中文、带空格的文件名原样进入审查列表、变更行数和提交说明（G10-1、4–7）。
  - 推送固定为 `origin` 的同名分支（有上游时 `push origin b:b`，没有时 `push -u`），ahead / behind 只和 `origin/<b>` 比，卡片的「推送」可用条件照 MiMo（G10-2）。
  - status 失败带 `error`，审查标签显示「读取 git 状态失败」和 git 原话（G10-3）；未跟踪文件夹只算一行、0 行（项目本身在未跟踪文件夹里时才展开）；审查字母照 MiMo 取工作区列、否则暂存区列，U / T 等灰色（G10-11、12）；分支芯片在窗口获得焦点、切换或新建分支后立即刷新，侧栏同步（store 的 `branchNonce`）；`workspace.info` 向上找仓库，分离 HEAD 显示「HEAD」（G10-13、14）；设置工作树行识别 detached / bare（G10-15）。
  - 删除：`git.revert`（含 `git clean -f`）、`git.init`、status / diff 的 branch 范围与 context；新建 / 切换 / 删除工作区三条命令、`workspace.create` / `workspace.remove` 和 12 个 `workspace.*` 文案（G10-9、16）。
  - 撤销编辑卡按每个文件所在仓库处理，项目外文件在某个仓库里就反向应用补丁、未跟踪的新建文件直接删除；无法撤回的计入「项目外」。原来「项目不是仓库就整体拒绝」随之去掉（MiMo 26.914 没有这条），`stream.revertNoRepo` 删除（G10-17）。
  - 快照同步项目的 `info/exclude`，未跟踪文件超过 2MB 不入快照，已被忽略的文件移出影子 index（G10-18）；提交失败保留 git 输出前 300 字（G10-19）；默认分支按 MiMo 顺序推断（G10-20）。
  - bash 执行后若仓库停在合并 / 变基 / cherry-pick / revert 冲突中，结果末尾附内部说明：未合并文件、对应的 `--abort`、用 `talk_to_session` 把冲突交给分支所属对话（`contacts` 查找），不要复述给用户（`tool/merge-conflict.ts`，G10-10）。新增内置技能 `worktree`、`merge`（MCode 自写，结构照 MiMo，G10-21）。
  - **归组规则改了（G10-8）**：新请求 `git.repoRoots`（`server/repo-roots.ts`，5 分钟缓存，存 `storage/repo-roots-cache.json`，过期先用旧值后台刷新，报告已不存在的目录）；渲染层 `lib/session-project.ts` 的 `projectOf` 按「标签 → 目录本身是已列出项目 → 主仓库 → 目录已不存在则无项目」归组，已不存在的项目不显示；新会话收养主仓库为项目（「移动至项目」仍按所选目录）。一次性迁移 `projects-by-repository`：已列出的链接工作树项目移出列表（连同置顶与排序），改列其主仓库；子目录项目保留。
  - 验证：13 项检查、build、smoke **3327 全过**（新 `scripts/smoke-round10-git.ts` 75 条，全部在一次性仓库和本地裸仓库上跑；snapshotcheck 加三条）；每条新检查都改坏对应代码确认会失败。探针 `mcode-round10-git.cjs` 12 项全过、0 报错，在 v2.0 基线（897ee3c）构建上 10 项核心检查全部失败（基线的「推送」确实把 fix 写进了 origin/main）；回归探针 round3-files 37、round4-projects 10、round2-info 23、branch-picker 8（`mcode-branch-picker-r10.cjs` 只是把 ROOT 改成读 `MCODE_ROOT`）全过。
  - 未改：`git diff` 本身会顺手刷新 index（与设置无关，MiMo 的差异请求同样如此），只保证 status 不写 index；撤销时 MCode 仍保留「补丁回不去就 `git checkout --`」的兜底（MiMo 26.914 只靠补丁）。
- **步骤绘制这一路已完成**（`round10-steps.md` K10-1 … K10-16，K10-10 按用户决定跳过——multiedit 由工具一路删除；worktree 分支 9f5ab4d、9e6b033、03a8b6e、8f44b60）：
  - K10-1 已完成回合照 MiMo 分「段」（`lib/step-rows.ts` `stagesOf`）：只有正常结束、且最后一段以文字 / 提问收尾的回合，回合头才是折叠按钮，收起范围是最后一段文字之前的全部（中间说明、较早的提问也收）；停止 / 失败 / 以工具或子智能体收尾的回合头部是纯文字、全部摊开，最后一段没说话时它的工具组默认展开。查找的「未展开 N」也数被收起的文字。
  - K10-2 插话照 26.914（`shared/steer.ts`）：模型接收后插话成为下一回合的普通提问（时间、复制、编辑），上一回合按完成结算（有操作行、不显示「中断」），新回合计时重开；未接收的插话放在回合最底部、工作指示之后，带「已插话 · 会尽快处理」；没有回合在跑时，未接收的插话按普通提问显示。子智能体通知仍留在回合内。runner 在接收插话的那一步把撤销记录一分为二（`openSteeredTurn`），回滚到插话只撤它之后的改动；实时改动胶囊、信息卡任务计数用同一边界；旧记录照常读取（旧快照的多消息记录仍由 revert 的 restoredTo 逻辑处理）。
  - K10-3 子智能体调用单独成组（`actor` 组）：全是运行中 / 已完成的 run/spawn 就合成一排胶囊，否则逐行平铺、不缩进、无摘要。
  - K10-4 工具结果图片（`parts/StepShots.vue`）：read 按路径挂的图经本地预览服务、MCP 的字节直接显示，最高 220、圆角 10，点击从原位打开图片预览；有图的步骤一定可展开（webfetch 也是）。
  - K10-5 **超出对标**：`shared/display-redact.ts`（规则自写）在步骤标题、入参、输出、差异、权限行里遮住 Bearer、JWT、常见密钥前缀、key=value 密钥、通过校验的身份证号和银行卡号、标签后的助记词；直播和重载都做，只改显示，存储和发给模型的内容不变，Ctrl+点击仍用原路径。
  - K10-6 `shared/reply-clean.ts`：代码之外剥掉泄漏的 `<think>` / `<tool_call>` / `<function=…>` / `<parameter…>`，未闭合的开头处截断；直播时藏起末尾半个标记（且不改动换行，渲染器靠换行判断最后一行）；只有省略号的文字不算一步、不打断工具组。复制、查找、「已回答」判断同用。
  - K10-7 skill 输出按 Markdown 画（`.tc-out.md`）；K10-8 完成步骤的「(no output)」按无输出；K10-9 新增 MCode 自绘的 skill（笔）、memory、actor 图标，pdf_locate 用放大镜、present_files 用兜底、contacts 用 actor；K10-11 单独一行的运行中工具不加「…」；K10-12 bash 以 interactive 被拒时组内加「i」提示行（每回合一次，新键 `stepList.interactiveSkipped`，18 张表）；K10-13 待回答的提问 / 计划不进步骤列、不打断分组。
  - K10-14 阿拉伯语：步骤、分组、提问卡与回合头的收起箭头镜像；标题 `dir="auto"`，`+N -M`（步骤、改动文件卡、实时胶囊）固定 LTR 隔离，命令 / 输出框按段落自判方向。K10-15 `buildWorkDisplay.*_two/_zero` 进 18 张表（ar 用双数 / 零的说法，其余照抄 `_other`），`tn()` 认 zero / two，缺形式时回落 `_other`。K10-16 实测：MiMo 的 `tc-out` 只有 pre-wrap、祖先也无 overflow-wrap，长串横向滚动；MCode 改为 `overflow-wrap: normal`（改前 / 改后截图 `scratchpad/mcode-round10-steps-long-before.png` / `-after.png`）。
  - 顺带修正：改动文件卡此前对没有改文件的回合也画「已编辑 0 个文件」，现在照 MiMo 只在有文件时画。因此 round8-a11y 的 M 项（基准录的是带空卡的回合高度 260.9 → 169.8）会报差异；另有 5 项宽度差 1.7px 和 `dbListLine` textAlign left→start 在去掉本改动时同样出现，不是本路引起。
  - 验证（合并 v2.0 897ee3c 后）：十三项检查全过，build 通过，smoke **3308 全过**（新 `scripts/smoke-round10-steps.ts` 48 条；`session-check` 插话回滚改为新边界；smoke 里 locate 图标与直播文本两条旧预期随之更新）。探针 `mcode-round10-steps.cjs` 中文 30 项、阿拉伯语 35 项全过、0 报错；一次性改坏全部修复后分别 25 / 30 项失败，smoke 新增 23 条失败，sessioncheck 插话 3 条失败。回归：round3-stream 34、round3-reply 29（copyFeedback 一次偶发，重跑通过）、round6-visual 24 全过；round8-a11y 19/20（见上）。
- **第十轮 macOS / Linux 一路已完成**（`round10-platforms.md` M10-1 … M10-29，按 2026-09-17 用户决定：M10-7 签名公证架构、M10-8 mac 自动更新、M10-21 mac/Linux 内置运行时、M10-22 deb、M10-27 Linux 托盘兜底**不做**；M10-13、M10-20 做）。没有 Mac / Linux 设备，下面标「未实机」的只按代码实现、用单元检查和假平台探针验证过：
  - M10-1（安全）`server/open-url.ts`：登录地址只放行 http/https，用参数数组启动 `open` / `xdg-open` / `rundll32 url.dll,FileProtocolHandler`，不经 shell；MCP 登录（`mcp-oauth.ts`）与订阅登录（`auth/manager.ts`）都走它，MCP 登录在等回调之前先拒绝非网页地址。smoke 扫描 main / server 不得再有字符串 `exec`。Windows 已验证；mac/Linux 未实机。
  - M10-2 / M10-3：`lib/keys.ts` 按平台记和弦——存储里的 `Ctrl` = MiMo 的 `mod`（mac 上是 Command），`Meta` = 另一个键（mac 上是 Control，Windows 是 Win），旧存储原意不变，无需迁移；`modHeld` / `controlHeld` / `controlChord`。`App.vue` 的 mod 在 mac 上只认 Command，终端（Control+\`）和最近对话（Control+Tab）照 MiMo 用 Control，Alt 组合按键位读（Option 会改字符）；浏览器标签页里的转发（`shared/browser-page.ts`）同样区分。快捷键显示统一经 `shownChord`（提示框、右键菜单、应用菜单、启动器、侧栏提示），平台由 store 启动时设。假 darwin 探针验证（见下），未实机。
  - M10-4 / M10-5 / M10-6：`electron-builder.yml` 顶层 `protocols`（mac 的 CFBundleURLTypes、Linux .desktop 的 MimeType）、`package.json` `desktopName: mcode.desktop` + `linux.syncDesktopName`、`build/entitlements.mac.plist`（默认三项 + audio-input）与 `NSMicrophoneUsageDescription`。smoke 用 app-builder-lib 自己的校验和 .desktop 生成核对；未在 Mac/Linux 上打包。
  - M10-9 / M10-10：兜底 shell 合到 `server/shell-path.ts` 的 `platformShell`（mac zsh，Linux PATH 上的 bash 否则 /bin/sh），终端也用它（`$SHELL` 照 MiMo 原样取，含 fish）；系统提示词的 `Shell:` 报 bash 工具实际选中的 shell（含设置里的）。
  - M10-11 `main/linux-ime.ts`：Linux 上照 MiMo 从 GTK/QT/XMODIFIERS 或 `~/.xinputrc` 的 run_im 识别 fcitx，只补缺的三个变量。M10-12 只加了 `disable-dev-shm-usage`；`no-zygote` 在沙箱开启时 Chromium 会拒绝启动，**等 Linux 实机确认**再定。M10-28 Linux 加 `enable-speech-dispatcher`（未实机）。
  - M10-13：`node scripts/icons.mjs --mac`（完整运行也会做）从 MCode 自己的圆角图生成 macOS 版——824/1024 居中、带柔和阴影（量得 MiMo 的 mac 图可见区域 91–932 × 99–940，约留 9%；MCode 版 87–936 × 97–946），写入 `build/icon.icns` 和 `resources/app-icons-mac/`（只进 mac 包，Dock 用它）。Windows/Linux 的图标不变。未实机看 Dock。
  - M10-14 / M10-15：mac 的窗口菜单用 minimize / zoom 角色（Cmd+M）；应用菜单的设置 / 新任务 / 打开文件夹 / 关闭按当前改绑取快捷键（`main/menu-keys.ts`），快捷键页录制期间不带快捷键（渲染层 `mcode:menu-keys`）。Windows 上仍只显示不注册。菜单与网页谁先收到按键**未实机**。
  - M10-16 / M10-17 / M10-19：mac 打开目标照 MiMo（终端 + 19 个，五个应用目录、多包名候选，TextMate / Antigravity 删除），Linux 列表照 MiMo 为空，Windows 的 Sublime Text 按 `subl` / `sublime_text` 查找；文件卡「打开方式」改为按文档类型列文档应用（`mcode:doc-apps`，仅 mac），**Windows 上现在只剩「文件资源管理器」「下载副本」**（与 MiMo 一致，已在本机验证）。新增 10 个应用名文案键（18 张表），删除 textmate / antigravity 两个键。
  - M10-18：图片预览右上角工具组照 MiMo 放在窗口按钮对侧：Windows/Linux 距左 44，mac 距右 44（本机与假 darwin 都验证）。
  - M10-20 `main/linux-icon-sync.ts`：Linux 换应用图标时照 MiMo 同步——AppImage 只在本应用自己的桌面入口存在且指向那个文件时改 `~/.local/share/icons/<id>.png` 并 touch 入口（MCode 目前不写入口，所以通常跳过）；系统安装的入口按其 Icon 名在用户 hicolor 主题里写同名各尺寸。未实机。
  - M10-23 `server/protected-paths.ts`：项目就是主目录时，文件标签搜索、@ 搜索、文件列表不进 MiMo 的受保护目录（mac 的 Pictures / Library 等，Windows 的 AppData / OneDrive 等）。
  - M10-24 / M10-25 / M10-26（`main/native-dialogs.ts`）：Windows 也读麦克风系统设置，拒绝 / 受限时走引导（本机验证）；原生对话框同一时间只开一个（选目录、打开 / 保存文本共用），mac 上不附着窗口、第二次请求时让窗口失焦（附着规则 Windows 已验证，mac 未实机）；mac 全屏关窗等待隐藏期间重新激活会取消隐藏（未实机）。
  - M10-29：`npm run package:linux`；`scripts/package-target.mjs` 让跨平台打包在改版本号之前就报错并说明去对应系统打。
  - 验证：十三项检查、build、smoke **3829 全过**（新 `scripts/smoke-round10-platforms.ts` 188 条；sandbox-check 的应用表数量、smoke 里 App.vue 快捷键表的正则、round9 打包脚本的正则随之更新）；每组新检查都改坏自己的代码确认会失败。探针：`mcode-round10-platforms-keys.cjs`（`FAKE_PLATFORM=darwin` 9 项：Control+\` / Control+Tab 生效而 Command 不生效、输入框里 Control+K/N 不被抢、Option+字母按键位、提示框 ⌘B、快捷键页 ⌃\` ⌃⇥ ⌃⇧⇥ ⌘K ⌥⌘P、录制 ⌃J / ⌘J；`win32` 9 项行为不变）、`mcode-round10-platforms.cjs`（win32 7 项：文件卡无编辑器、预览角落在左、麦克风设置、菜单跟随改绑与录制、同时只一个对话框；darwin 3 项：预览角落在右）全过，改坏的构建上对应项全部失败；回归 `mcode-round5-keys.cjs` 16 项全过。假 darwin 只改了渲染层读到的平台，主进程仍是 Windows。
  - 未做 / 留意：L24（Linux 自绘窗口按钮）、L25（mac 自绘红绿灯，含 `Sidebar.vue` `.top.mac` 全屏仍留 65px）、L26（AppImage 桌面入口）、L27 仍待实机与决定；`prompts.ts` 里「Windows 上 shell 是 PowerShell」的说明在默认 shell 退到 git bash 时不准确，未改。
- **第十轮第一批已合并四路**（bash 与网页、文件工具与桌面工具包、git、步骤绘制；合并冲突只在 smoke.ts / HANDOFF / bash.ts 的 import，两边都保留，typecheck 与 i18ncheck 通过）。智能体类工具那一路与文件工具那一路都做了定时任务（T10-20/21/22/51/52/53）和跨对话中文文案（T10-49/55），合并冲突落在 automation 与 session-chat 代码里，已交回该路在自己分支上合并最新 v2.0、每项只留一套实现。T10-50：审计称 MiMo 发起方停止时**不**撤回排队消息，MCode 目前撤回，待问用户。
- **用户 2026-09-17 第十轮第二批决定**：斜杠菜单照 MiMo 列出并实现 `/init`、`/review`、`/dream`、`/distill`、`/rebuild`（文字自写）；记忆完全照 MiMo 按仓库分份、非 git 文件夹共用一份（迁移时合并、不删、留备份）；技能详情弹窗与「卸载」照 MiMo；macOS 留边距图标与 Linux 图标同步照做。**暂不做**：M10-7 Mac 签名 / 公证 / 架构、M10-8 Mac 自动更新、M10-21 Mac / Linux 随包运行时、M10-22 deb、M10-27（Linux 无托盘时保持 MiMo 行为）。
- **第十轮·智能体类工具（`r10-part-C.md` 与对应 T10 项）已完成**，检查在 `scripts/smoke-round10-agents.ts`（每项都在改坏代码后确认会失败）：
  - T10-16：带有效 `task_id` 启动的子智能体先把该任务开始并归到自己名下；general 子智能体结束时若手里还有未开始 / 进行中的任务，用隐藏提醒（`synthetic`）最多再跑 2 轮；仍持有未完成任务时状态降为 partial（只剩 blocked 时为 blocked），答复末尾列出「**Unfinished tasks**」，闸门那一轮出错时保留之前的答复并降为 partial。子智能体记录新增 `subagent.reported`。
  - T10-44：`<actor_result>` 总带 status（无状态头为 unknown）和 summary 属性；被外部停止的 run 返回 cancelled 结果（随父回合 Stop 的仍是中断）；失败带 Partial result；status / wait 字段改为 `agent / turnCount / lastTurnTime / lastOutcome / time`，wait 带 `reportedStatus / reportedSummary`；failed / blocked 的通知写「finished and reported …」。子智能体的 worker 在结果落盘后才释放（修掉 wait 偶发读不到 lastOutcome）。
  - T10-45：task、actor 改为 MiMo 的 `{operation:{action,…}}`，仍接受扁平写法；窗口侧统一经 `operationInput` 读取；run / spawn 缺 description、prompt、subagent_type 或类型未知时拒绝，不再默认 general。
  - T10-15：question 不再给子智能体，调用也拒绝；停靠栏不再收子智能体的提问卡（其重复调用确认仍显示）。
  - T10-14：见上方计划模式的更正；`plan_exit` 批准后回复「现在开始执行计划」。round5-plan 相关 smoke 与探针预期随之改为「同一运行里写入成功」。
  - T10-17：`history get` 只列附件定位符（inline:N / tool:N / file:N，2KB 预算），带 `attachment=` 才交出一个；用户附件和只有路径的工具附件一律拒绝并提示用 read。
  - T10-42：会话的记忆目录非空或有过任务时，每步在最后一条用户消息后（只进请求）附上找回提示。
  - T10-43：配置的标题模型失败或结果不可用时，再用会话模型试一次。
  - T10-46：技能文件清单改用搜索工具同一套遍历（遵守 .gitignore / .ignore，含隐藏文件，排除路径含 SKILL.md 的）。
  - T10-20 / 21 / 22 / 51 / 52 / 53（定时任务）与 T10-49 / 55（跨对话中文、失败作为结果）：两路都做了，合并时保留文件工具一路（c85ee99、36b14c4）的实现，本路的重复实现与检查删去；本路的 smoke-round10-agents 只留与之一致的检查（见上方文件工具一路的说明）。
  - 未改：T10-23 同步等满转异步保持现状（有意差异）；T10-47 history 的「本项目」仍按文件夹；T10-4（截断提示里的 actor）由 bash 一路完成。**T10-50（用户 2026-09-17 改为照 MiMo 不撤回）**：同步跨对话调用的发起方被停止时，还在排队的消息不再撤回，照常送达并运行，回复丢弃（`session/chat.ts`；检查 smoke-round10-agents「T10-50」4 项，恢复撤回写法时会失败）。
  - 探针 `mcode-round4-crosschat.cjs` 的假模型改认中文消息头（备份 `.pre-r10c`，改动处标 `R10c`）。
  - 验证（合并 v2.0 cef790a 后）：十三项检查、smoke 3641、build 全过；定时任务与跨对话两处与文件工具一路重复，保留那一路的实现，本路只补上跨对话消息头的中文（MiMo 的注入头是中文）并删掉重复检查；合并前的验证：十三项检查、smoke 3372、build 全过；新探针 `mcode-round10-agents.cjs` 5 项（批准后同一运行写入、完成闸门、子智能体提问进不了停靠栏、包装后的 spawn / wait 绘制、无报错）全过，改坏代码后 A1–A4 全败；round5-plan 8、round4-crosschat 10 全过；round4-subagents 10 项：R5（取消后台子智能体）断续失败（合并后 4 次中 2 次，表现为取消后子智能体仍在跑、没有通知），加了诊断输出（R10c 标记）后连续 12 次全过，未能复现原因，需留意。

- **第十轮·记忆 / 技能 / 斜杠命令一路已完成**（`round10-memory.md` R10-1 … R10-14；检查 `scripts/smoke-round10-memory.ts` 114 条，合并前两次改坏分别有 50、10 条失败；探针 `mcode-round10-memory.cjs` 21 项全过、0 报错，改坏的构建 8 项失败）：
  - R10-6 记忆按仓库：项目 id 是主仓库 `.git/mcode-project-id` 里的随机 UUID（子目录、链接工作树共用；另一份克隆不同；`.git` 在家目录或盘根不算）；所有非 git 文件夹共用 `projects/global`；`.git` 不可写时用主仓库路径派生的 `repo-xxxxxxxx`。history 的「本项目」范围随之改为同一 id（更正 T10-47 的「仍按文件夹」）。一次性迁移 `memory-by-repository`：先把整个 `memory/projects` 复制到 `<数据目录>/backup/memory-projects-<时间>/`，再按已知文件夹（会话目录、项目列表、已关闭项目）把旧的按文件夹哈希目录并入新目录——目标不存在就移动、已有同样内容只留一份、不同内容追加在「## Merged from <文件夹> (日期)」下；认不出归属的旧目录原样保留。
  - R10-5 / R10-13 写入守卫（`memory/guard.ts`，接在 `resolvePath` 的写入分支）：必须是 `<scope>/…/<name>.md`（projects / sessions 须带 id）；`sessions/<id>/tasks/**` 只给绑定该任务的子智能体写自己那份；配置 `memory.disableWrite`（只能手写进 config.json）拒绝一切记忆写入，提示词记忆段改为只读说明。
  - R10-7 找回提示：与智能体工具一路的 T10-42 重复，合并时保留那一路（`recallHint`），本路只留一条真实回合检查。
  - R10-8 历史索引收录压缩摘要（`<会话>/<消息>/summary`，含文件清单，get / around 可读）、工具附件（名称 / 类型 / 路径）和失败回复的 error；CONTENT_VERSION 升到 2，启动时重建。
  - R10-9 搜索浮层按 MiMo 打分（`shared/search-score.ts`，前后端共用）：精确命中 1000 + 近端最多 200 + 词边界 80 / 30；模糊 500 − 段数×40 − 跨度 − 起点，≤0 丢弃，空格不跳过。服务端读正文 + 工具输出（截 20000 字），每个对话取得分最高的一条并按分数排序；只命中消息的对话按该分数，标题命中 +300，项目按路径命中为路径分 −100。仍扫描全部转录。
  - R10-10 全局 AGENTS.md 并入指令列表、排在项目文件之后；找到第一个存在的全局文件就停（空文件也停），所以有全局 AGENTS.md 时不读 `~/.claude/CLAUDE.md`，停用（改名）后才读。提示词段名改为「## Instructions」，全局 AGENTS.md 模板文案同步。
  - R10-11 后备标题和标题请求都去掉消息开头的技能芯片 `/name`。R10-12 新内置技能 `memory-search`（表结构、只读 SQLite、查询模板；技能和 dream / distill 提示词里的查询都在 smoke 里对真实索引跑过）。
  - R10-1 技能开关：配置 `disabledSkills`（MCode 自己的键）；提示词清单、skill / skill_search、斜杠与加号菜单、`/name` 加载统一过滤；插件页技能卡片显示真实状态，已停用的显示 MiMo 的「安装」按钮（点了即启用），否则「…」菜单里是「停用」；切换后吐司「已启用 / 已停用技能」并重取斜杠列表；手改 config.json 同样生效。
  - R10-2 技能详情卡（`SkillDetailDialog.vue`，520 宽 / 圆角 16 / 内距 22，照 MiMo）：图标（frontmatter `icon`，否则按名字取色的拼图）、`locales/<语言>.json` 的显示名与简介、开关、说明（界面简体中文而说明纯英文、界面英文而说明含中文时照 MiMo 不显示）、「查看 SKILL.md 内容」（整文件，最多 20 万字，超出提示）、底部「卸载」「让智能体来配置」「在对话中试用」。**卸载照 MiMo**：不弹确认，只对用户全局技能目录（`<数据目录>/storage/skills`）里的技能显示，文件夹移到 `<数据目录>/storage/skill-trash/<时间戳>-<名字>`，启动时按名字里的时间戳删掉超过 7 天的（第十二轮 L12-12 更正：MiMo 26.914 把卸载项放进 `extension-trash`，启动时删掉超过 7 天的；此前写的「照 MiMo 不清理」有误）；内置技能和项目 `.mcode` 技能没有卸载。「让智能体来配置」开新任务、只挂 `skill-creator` 芯片并预填请求；「在对话中试用」把芯片放进当前对话（没有就放首页）的输入框（`composer-drafts` 的 `addDraftSkill`）。
  - **注意：插件页入口仍按 2026-09-14 的决定隐藏**（`goPlugins` 没有调用者），所以 R10-1 的「…」菜单和 R10-2 的详情卡目前在界面上进不去；探针是在临时加了 `window.__probePlugins` 钩子的构建上跑的（钩子未提交）。是否恢复侧栏「插件」行需用户决定；在此之前可手改 config.json 的 `disabledSkills`。
  - R10-3 斜杠命令照 MiMo：列表开头依次 `/init` `/review` `/dream` `/distill` `/rebuild`（对话里 `/compact` 仍在最前），来源标签「命令」，说明是英文（MiMo 也直接显示引擎的英文说明），文字全部自写（`server/command-builtin.ts`）；同名的用户命令会替换它（`CommandInfo.own` 区分）。`/init` 在对话里写仓库根的 AGENTS.md；`/review` 交给子智能体；`/dream` `/distill` 本回合以自己的智能体运行（`COMMAND_AGENTS` / `TurnAgent`，`prompts.ts` 的 DREAM / DISTILL 提示词，只有 read / write / edit / glob / grep / memory / bash，不给 MCP，写入只许记忆目录和项目 `.mcode`；bash 仍按用户的权限级别询问——MiMo 的 dream 规则里 bash 是 allow，这里没有放宽）；`/rebuild` 由输入框接管，照 MiMo 桌面端（关了 checkpoint）改为压缩，后面的参数忽略。回合中途压缩后仍保持命令指定的智能体和模型。
  - R10-4 斜杠菜单只按名称、逐词前缀匹配（与设置搜索同一 `wordMatch`）；加号菜单的技能子菜单核实过 MiMo 就是名称 + 说明子串匹配，未改。R10-14 frontmatter 解析失败的 SKILL.md 每个文件报一次错误吐司（修好再坏会再报），缺 name / description 的只写日志。
  - 合并 v2.0 时修的：`run()` 的 planning 要从存储里的会话读（否则命令指定 plan 的回合第一步就被切回 build）。十三项检查、build 全过，smoke 全量 3755 全过（round9-providers 的「Smart 路由记为后台开销」有一次偶发失败，单独跑和整体重跑都通过）。
  - 未做：LAN 模型实测 /dream、/distill（可选，未跑）。
- **第十轮全部合并**（智能体类工具在自己分支合并 v2.0 后无冲突合回；记忆 / 技能 / 斜杠、macOS / Linux 两路合并只在 smoke.ts 冲突）。T10-50 用户定为照 MiMo **不撤回**（已改）。「插件」页入口：用户先选恢复、随即改为「继续隐藏」——技能开关与详情卡在界面上点不到，停用技能只能手改 `disabledSkills`（有意差异）。合并后 round8 安全的 PowerShell 环境变量检查因 bash 工具改为照 MiMo 优先 `$SHELL`（从 Git Bash 跑 smoke 时交给了 bash）而失败，已让该检查固定用 PowerShell（72f6423）。
- 全量验证（b8b77d3）：十三项检查全过，build 通过，smoke **3943 全过**。29 个探针里 21 个直接通过；待核对：round10-memory 技能三项（插件页入口隐藏）、round10-platforms 两个（NO JSON，需参数）、round9-windows W4、round8-a11y M（去掉空卡是预期，另有 5 处 1.7px 与 text-align 来源不明）、round8-narrow F、round5-keys R24（Alt+T）、slash-menu 两项、search 两项、round4-subagents（5 次里 1 次整轮失败）。已派一路核对。
- **第十轮失败核对（2026-09-18）**：只有一处是真 bug——`runner.ts` 的 `stream()` 只靠 abort 监听跟随回合信号，准备步骤期间（子智能体刚派出就被取消）已经落下的取消永远到不了请求，子智能体会一直跑到提供方结束、没有通知（即 R5 的间歇失败）；现在信号已落下就立即中止（标题请求同理），smoke 新增 4 项（不修时 2 项失败），smoke 3947 全过。其余都是探针问题，探针改在 scratchpad（`// Triage:`，有 `.pre-r10triage` 备份）：round10-memory 由探针在读渲染包时自行挂 `__probePlugins`（不加入口、不改构建，`R10M_BREAK` 可证明三项能失败）；round10-platforms / -keys 不给 `FAKE_PLATFORM` 时自己跑 win32 与 darwin 两遍并合并 JSON；窗口没有系统焦点时 Chromium 不派发 focus 事件，round5-keys R24 与 platforms-keys 的提示改用 CDP 焦点模拟；round9-windows W4 是窗口被外部最小化（最小化的最大化窗口读作未最大化），加了重新显示；round8-a11y 的 5 处 1.7px 与 text-align 来自 Electron 41 升级（同一 897ee3c 在 38.8.6 下无差、41.7.2 下有差），turn 高度是 9f5ab4d 去掉空卡，两个基准已按当前构建重录并注明原因；round8-narrow F 的 1.75 基准是 Electron 38 录的（视口 1401×761，41 下为 1399.5×760），已用 451a732 在 41 下重录；slash-menu 两项是旧期望（技能选中成芯片、/compact 要求对话非空且无芯片）；search 两项是旧期望（上下键选择 9 月 15 日按用户决定删掉，改为点击结果）。锁屏时可用 `R8A_DPR` / `NARROW_DPR=1.75` 强制比例（在 897ee3c 上与真实 1.75 读数完全一致）。round4-subagents：修复前 26 次、修复后 12 次全过，那次整轮失败未能复现，探针已加请求日志与后端日志摘录，再出现时可查。
- **第十轮收尾**：核对那一路合并后（8f72997），smoke **3947 全过**、build 通过，八个失败探针全部通过。唯一真缺陷：子智能体刚派出、还在准备第一步时被取消，停止信号在监听挂上前已落下，回合照样发出请求、取消要等满 10 秒且没有「已取消」通知（round4-subagents R5 的间歇失败），现已信号先落就立即中止（修复前 26 次里间歇失败，修复后 12/12）。其余为探针问题：技能三项改由探针拦截渲染包自行打开插件页（入口仍隐藏）；两个平台探针结果文件带后缀；无焦点窗口里 Chromium 不派发 focus 事件，改用 CDP 焦点模拟；round8-a11y 的 5 处 1.7px 与 text-align 来自 Electron 41 本身（同一棵树在 38 下 0 差异），与去掉空卡一起重录基准；round8-narrow 的 1.75 基准改用 41 重录；slash-menu / search 是第十轮之前就过期的预期。
- 约定补充：从 Git Bash 跑 smoke 时 `SHELL` 已设，bash 工具会照 MiMo 用它；没有系统焦点的探针窗口收不到 focus / focusin，需要 CDP `Emulation.setFocusEmulationEnabled`；锁屏时 Electron 41 读不到显示器，像素探针可用 `R8A_DPR` / `NARROW_DPR` 强制比例。

**第十一轮对照（2026-09-18）：已完成并合并入 `v2.0`（输入路径 · 并发与长期运行 · 回复解析）。** 三个没用过的只读角度：**输入到回合之间的全部路径**（输入法、粘贴与超大文本、拖放、附件、提及与芯片、发送时机、语音，`round11-composer.md`）、**并发与长期运行**（多回合同时跑、共享资源与锁、后端重启与断网、内存与句柄增长、超大对话与仓库，`round11-concurrency.md`）、**模型回复的解析**（流式事件、工具参数分片与损坏、推理块、重试与续流、用量与中止，`round11-stream.md`）。
- 排查结果：输入路径 52 项（高 3）、并发与长期运行 41 项（高 7）、回复解析 17 项（高 2）。更正两条旧结论：MiMo 的引擎同样在主进程里（只隔了一层本机 HTTP），真正搬出主线程的只有 SQLite（每库一个 worker）；MiMo 26.914 与 26.912 的 @ 提及都是**后端项目级搜索**，第五轮 L7 据错误判读改成了本地过滤。另发现 MCode 有 7 个源文件含裸 NUL，约 900 行对 ripgrep 不可见——前十轮所有基于 rg 的检索都有这个盲区。
- **用户 2026-09-18 第十一轮决定**：附件完全照 MiMo（只内联图片，其余走三段 `[Attachments]` 系统块，不再内联文本、不再直送 PDF / 音视频字节）；回滚 L7、@ 提及改回后端搜索；语音改分段转写；附件胶囊改图标、去掉「内置技能」标签、只有附件时照抄 MiMo 文案；输入框撤销 / 重做保留为「比 MiMo 好」。并发：定时任务做完整队列与租约、消息广播改增量、界面搜索走 FTS、SQLite 进 worker 线程、面板与抽屉终端各用自己的 pty、同仓 git 写操作排队、MCP 当前会话按会话区分、子智能体并发闸门；限流最多等 30 分钟并给倒计时与「不等了」。推理**完全照 MiMo**：请求里要思考（界面仍不画，只用于「只思考没回答」判定），Responses 通道索取并回传加密思考（密文存进对话记录）。
- **并发与长期运行（`round11-concurrency.md` N11-1 … N11-41）已全部完成并验证，已合并入 `v2.0`。** 十一条 N11 提交加 N11-12：定时任务的完整队列与租约、消息广播改增量、界面搜索走 FTS、SQLite 进 worker 线程（新 `src/server/sql-worker.ts`，每库一个，请求 15 秒超时，全部数据库调用变异步、调用点全部 await，`HistoryIndex.close()` 等待尚在飞的 `start()`）、面板与抽屉终端各用自己的 pty、同仓 git 写操作排队、MCP 当前会话按会话区分、子智能体并发闸门、限流最多等 30 分钟并给倒计时与「不等了」。合并后 typecheck / build 通过，smoke **4168 全过**。逐项见下方 N11 段。
- **回复解析（`round11-stream.md` S11-1 … S11-17）已全部完成并验证。** 最终：十三项检查全过，build 通过，smoke **4020 全过**（新增 73 条，`scripts/smoke-round11-stream.ts`，全部服务器都是本地起的假 SSE，没有调用任何真实服务商）；探针 `mcode-round11-stream.cjs` 6 项全过，回归 `mcode-round3-stream` 34 项、`mcode-round8-model` 9 项全过。逐项：
  - **S11-1 / S11-2**（`provider/anthropic.ts` 新增 `anthropicStop`）：停止原因与工具调用不再互相覆盖。原来顺序是 `refusal → max_tokens → 工具`，于是"边写工具参数边撞输出上限"返回 `max_tokens`，回合走进"没有工具要跑"的分支，`continuationFor` 看见消息里有 tool part 又直接返回 `{}`，那次已经宣告的调用永远停在 `pending`，界面只剩一张"输出超长"卡片。现在照 MiMo `mapAnthropicStopReason`：工具优先，`finishReason` 仍带着服务商自己的词。`model_context_window_exceeded` 并入 `max_tokens`（它是 stop_reason 不是错误正文，`overflow.ts` 的正则够不着，原来落到 `end_turn`）。
  - **S11-3**（`session/retry.ts`）：200 流里的错误帧按 `code || type` 分档，`overloaded_error` / `server_is_overloaded` / `server_error` → `server`（八次 / 十五分钟）。这类帧没有 HTTP 状态，原来 `retryKind` 全部落空、一次就红。`insufficient_quota` / `usage_not_included` / `invalid_prompt` 显式列为不重试（**注**：实测它们本来也不匹配下面任何分支，这行是守卫，注释里写明了）。
  - **S11-4 / S11-5**（新文件 `provider/sse.ts`，两条线共用）：按规范——空行派发、多行 data 以换行拼接、`:` 注释不是事件、`field:value` 与 `field: value` 同义（只吃一个空格）、`\r` / `\n` / `\r\n` 都是行尾、结束时冲洗解码器、**尾部没有换行的最后一帧不再丢**（往往正是带 `usage` / `finish_reason` 的那帧）。`onRead` 在**每次 `reader.read()` 返回时、解析之前**调用，静默计时器挂在它上面（MiMo `wrapSSE` 的口径），于是 OpenRouter 的 `: PROCESSING` 注释和 ping 都算"活着"。**实测更正报告一条**：BOM 其实由 `TextDecoder`（`ignoreBOM` 默认 false）吃掉，显式剥离是死代码，已删；相应检查改为守住"BOM 不会吃掉第一个事件"这个行为本身。按模型覆盖超时（MiMo 的 `chunkTimeout` / `headerTimeout`）属于设置，按报告建议不做。
  - **S11-6 / S11-8**（`provider/chatgpt.ts`）：`response.incomplete` 改读 `incomplete_details.reason`——`content_filter` 是 refusal、`max_output_tokens` 才是输出到顶。原来一律当输出超长，于是被内容过滤拦下的回复顶着"输出超长"卡片，`continuationFor` 还照 `LENGTH_NOTE` 让模型"从中断处接着写"。同时补上 `finishReason`（incomplete 原因 / `tool_calls` / `response.status`），`reminders.ts` 的"把工具调用写成正文"和 runner 的内容过滤文案这才能在这条线上生效。
  - **S11-7（用户定：照 MiMo）**：请求加 `include: ["reasoning.encrypted_content"]`；`response.output_item.done` 的 reasoning item 把密文与 item id 存进 ReasoningPart（复用 `signature`，新增 `itemID`）；`toInput` 在同一会话同一模型里按原顺序回传，并照 MiMo 在 `store: false` 时**丢掉没有密文的 reasoning item**。没有摘要文字的 item 也会开一个空的 ReasoningPart 只用来放密文——它 `text` 为空，所以不会被 `thinkOnly()` 误判（探针专门验了这条）。
  - **S11-9**（`provider/openai.ts` `usageOf`）：`completion_tokens_details.reasoning_tokens` 对**所有** OpenAI 兼容服务商都读（DeepSeek / GLM / Qwen / MiniMax 都报）。费用不变（推理与输出同价），但上下文用量卡"不计推理 token"（I20）这才对它们真正生效。`cache_write_tokens` 仍只有 OpenRouter 报，保持只对它读。
  - **S11-10 / S11-16（用户定：完全照 MiMo）**：`TurnRequest.showReasoning` 整个删掉（五个调用点全传 false，等于死设置）。Anthropic `display` 固定 `summarized`（原来是 `omitted`，服务端根本不发思考块）、Responses `summary` 固定 `auto`、chat-completions 的推理增量无条件保留。**界面照旧一点思考都不画**（`turn-end.ts` 的 `stepPart` 把 reasoning 清空，模板也只画 text 行——探针把两处都改坏才画得出来）。有了思考，C17 的"只思考没回答"卡片和 `reminders.ts` 里"GPT 只输出思考算 final"这两条规则才真正可达。循环监视同时吃正文与思考增量（MiMo 的 `checkTextNgram` 在两个分支里都调）。
  - **S11-11**（两个适配器 + `session/runner.ts`）：中断落在两次读之间时，读取器是干净结束而不是抛错，于是半截拼出来的工具调用被当成正常结果派发出去。两个适配器在循环后补上 Anthropic 那条一直都有的 `if (signal.aborted) throw AbortError`；回合循环在派发工具前再加一道闸（MiMo 碰不到这个竞态——它的工具在流里执行，流一断就停）。
  - **S11-12**（`session/reminders.ts`）：`function_call` 与 `tool_calls` / `tool_use` 并列成 `TOOL_FINISH`（自建网关、旧版 vLLM / FastChat 还在用这个收尾词）。
  - **S11-13**（`tool/repair.ts`）：新增 `repairUnicodeEscapes`（MiMo `parseToolInput` 的等价物，自己写的实现）与共用的 `parseToolArguments`，两个适配器各自那份"只 `JSON.parse` 一次"的解析删掉。带中文 / emoji 的路径最容易把 `\u` 写坏。
  - **S11-14**（`shared/models-dev.ts` / `provider/catalog.ts` / `config.ts` / `session/usage.ts`）：models.dev 的 `cost.context_over_200k` 原来在 `trimCatalog` 就被裁掉了；现在读进 `ModelEntry.over200K`，`costOf` 在 `input + cacheRead > 200_000` 时整步换用长上下文单价（MiMo `getUsage`）。Claude 这类过线翻倍的模型，长会话费用原来系统性偏低。**注**：仓库里 `resources/models-snapshot.json` 是旧口径生成的、没有这个字段，本轮不联网所以没有重新生成；线上目录一拉下来就会带上。
  - **S11-15**（`retry.ts` + `runner.ts`）：记一个"这次尝试有没有拿到过事件"的标志（MiMo 的 `hasProviderOutput`），没拿到就用 `RETRY_BUDGETS.request` 的等待曲线（200ms 起、翻倍），档位判定与次数上限仍按失败种类。
  - **S11-17 记为「与 MiMo 故意不同」**（见下方那张表）：不改。
  - 约定补充：新探针 `mcode-round11-stream.cjs`（丢弃式配置，不调用模型，把回合直接放进 store）。**一个 verdict 如果只是把探针自己塞进去的数据读回来，就永远不会失败**——这次把 `reasoningKept` / `cipherKept` 两条从 verdict 里拿掉、只留在 `state` 里，"回传"改由 smoke 验。另外"完成的回合会把前面的行折叠到回合头后面"，所以验"没画出来"必须把 `[data-turn-head][aria-expanded]` 全部点开再看一次，否则折叠视图本身就让检查恒过。
  - 未做：LAN 模型端到端实测（`192.168.10.212:8888` 本轮不可达，连接超时）。

用户决定不做（不要再主动提）：

| 项目 | 原因 |
| --- | --- |
| 帮助与反馈 | MiMo 提交到小米服务器，MCode 没有这类服务 |
| 回复下方赞 / 踩 | MiMo 把反馈发到自己的服务，MCode 没有接收方 |
| 精选插件目录 | MiMo 的一键安装目录；MCode 的插件是用户自己配的 MCP 服务器和技能 |
| 创建插件 | MiMo 的「创建插件 / 更多创建」 |
| 设置页：钩子、自定义插件（CLI）、连接（SSH） | 清单之外的新功能，用户选择改为打磨现有功能 |

## 与 MiMo 故意不同的地方（用户定的，不要改回去）

- 第二十二轮 L1 新增（照 MiMo 实测，不是疏漏）：
  - **图片预览、视频预览、服务商选择下拉的阴影保留字面值 `0 12px 40px #00000024`，深色下不翻转。** MiMo 这三处挂的是 Tailwind 的 `shadow-pop` 工具类，工具类把浅色值烤进 `--tw-shadow`，不读 token；只有写了 CSS 规则的地方（`.np-card`、`.settings-full`）才用 `var(--shadow-pop)` 并随主题翻转。
  - **@ 菜单与斜杠菜单不用浮层壳。** MiMo 给它们的是自己的 `.menu` 类：12 圆角、整像素 `--color-line`、`--color-bg` 底、`--shadow-menu`；`.menu-glass` 写在前面被盖掉，只剩背后那层模糊（不透明底下看不见）。其余所有弹出层才是 16 圆角 + 半像素 input-border + 玻璃 + `--shadow-composer`。
  - **设置页的行分隔保持 `--border-weak`**，不进半像素统一：MiMo 那一条是 1px `--color-set-line` 的伪元素，左右各缩 16。

- 第二十一轮 F1 新增（MiMo 自己那一处 CSS 是坏的，MCode 保留能用的行为）：
  - `--overlay-hover` 深色用 `#ffffff14`。MiMo 的 `.bp-tab-x:hover{background:#00000014}` 没有深色覆盖，深色下那层黑几乎看不见。
  - **SelectMenu 的高亮行保持 side-hover，不采用品牌橙。** MiMo 裸 shadcn 的 `SelectItem` 是 `focus:bg-accent focus:text-accent-foreground`，而 `--color-accent` 是 `#ff6a2b`、前景是白字；但 MiMo 自己的设置页把它覆盖成了 `rounded-[8px] focus:bg-side-hover focus:text-txt`（`SettingsOverlay-*.js`，内容壳是 `Z0`+`menu-glass`+`p-[5px]`）。MCode 的 SelectMenu 复刻的正是设置页那一个，所以橙色高亮不进来。
  - MiMo `[data-theme=dark]` 里 `--color-set-line` 仍是 `#f1f1f1c7`（深色下画浅色边）；MCode 不复制这条。
  - shadcn `ghost` 变体的 hover 是 `bg-accent`（同样是橙）；MCode 的 ghost 不用它。
  - MiMo 几乎不画焦点环，MCode 保留自己给键盘用户加的 `:focus-visible` 环（可达性），只把颜色从蓝色换成 MiMo 的 `--color-ring`（浅色 `#151c13`、深色 `#fff`）。
  - 共用 `.btn` / `.field` 高度保持 28px：MiMo 自己的按钮尺寸是 26 / 30 / 36，但它的设置页用 `--settings-control-height: 28px` 压到 28，对话框里的控件行没有第四种尺寸。

- 第十七轮新增：项目**内**的绝对路径打开时文件树停在项目根（项目外则与 MiMo 一样跳到文件所在文件夹，用户 2026-09-21）；审阅页只列项目子树，MiMo 列整个仓库再错解路径——MCode 这边是对的。

- 第十六轮新增：内联交互组件的来源大小上限 512KB（MiMo 渲染层无上限）；内联组件由主进程在独立来源上提供并下发策略头（MiMo 直接内嵌，因其渲染层没有 CSP）；`metadata.filediff.patch` 存未裁剪补丁（撤销需要）；快捷键表里「切换编排模式」改为「切换目标模式」（该模式已删）。
- 第十六轮撤销：`write` 单独成桶、webfetch 默认询问这两条**不再是故意不同**，已按用户决定放松到 MiMo。

- **`create_session` 的工作目录要审批（第十五轮 R15-T2）**：MiMo 对此零检查（渲染端直接 `POST /session?directory=`，连目录存在都不验）；MCode 在项目（或其仓库根）外时走既有「项目外」审批，否则模型可零弹窗读遍家目录。

- 侧栏顶部一排按钮（切换侧栏、返回、前进）靠左（MiMo 从 x=65 开始）；收起时切换侧栏与新建任务也靠左（x=18）；macOS 仍留出红绿灯位置。
- ~~侧栏内容（字标以下）整体下移 4px~~；~~搜索与铃铛在顶部一排靠左~~——两条均于 2026-09-22 由用户决定撤销（第二十轮 R20-V5）：搜索与铃铛移到字标行右端（照 26.920，距侧栏右缘 16），字标行照 26.920 的 `--sidebar-brand-top` 从 52px 开始（预览卡片内 43）；侧栏底部改为一行 MiMo 形状的账户行（28px 头像、「本机」、菜单只有「设置」），「深色」主题切换行删除（主题仍在 设置 > 外观）。
- 首页保留 MCode 自己的静态字标，不做 MiMo 的可换图标按钮（做过后撤销，`18d888b` → `6c32812`）；点击字标会跳动一下（`ea62985`）。
- 「帮助与反馈」暂不做。
- 服务商预设连接后自动拉 `/models` 发现模型（MiMo 的预设是「填 Key + 手填模型名」的单模型表单）；「已添加」按服务商列行并保留刷新与地址编辑（第九轮 P9-6，2026-09-17 用户决定保留）。
- 自定义表单保留「接口协议」（OpenAI / Anthropic）选项（MiMo 新建自定义只能是 OpenAI 兼容，P9-7）。
- 步骤内容脱敏直播和重载都做（MiMo 只在重载后做，第十轮 K10-5）；阿拉伯语的步骤箭头镜像与方向隔离是 MCode 自有（MiMo 没有 RTL）。
- 保留 ChatGPT Pro/Plus 订阅登录（MiMo 桌面只有小米账号登录，P9-11）；入口在连接弹窗（模型菜单 / 命令面板打开的那个），设置页快速添加里没有。
- chat-completions 请求无条件发 `stream_options: {include_usage: true}`（第十一轮 S11-17）。MiMo 只在配置里给了 `includeUsage` 时才发，而它的通用 OpenAI 兼容服务商没有设——也就是说 **MiMo 在自建模型上根本拿不到用量**。MCode 一直发，用量卡对自建模型才有数；代价是个别严格校验未知字段的服务端可能 400。日后真有服务商报错，再做成自定义服务商表单上的开关，不要直接删掉。
- 第十一轮（2026-09-18，用户定）输入框这几项 MCode 比 MiMo 好，保留：
  - C11-9 输入框内的撤销 / 重做：两边的程序化改写都毁原生 undo 栈，MCode 选择保留现状并在后续有机会时做得更好（用户明确要留）。
  - C11-7 Backspace 整块删提及的「已知名字」名单跨重启保留（MiMo 的名单只在内存里，重启后就删不动了）。
  - C11-8 切会话时重置历史游标（MiMo 不重置，会把上一个会话的草稿带进下一个）。
  - C11-20 代码围栏按 `/\r?\n/` 切行、语言表自有（MiMo 按 `\n` 切，Windows 复制来的 CRLF 代码识别不出来）。
  - C11-4 Escape / Ctrl+C 在侧边聊天也能停自己那一路（MiMo 只在主对话的停靠栏生效）。
  - C11-12 手动高度在停靠栏与侧边聊天之间双向同步（MiMo 只有 dock→侧边单向，却共用同一个 localStorage 键）。
  - C11-19 粘贴图片落盘保留扩展名白名单（MiMo 把未知 mime 一律写成 `.png`，产出名不副实的文件）；25MB 上限已去掉。
  - C11-21 超大粘贴只弹一条提示（MiMo 弹两条重复的）。
  - C11-46 斜杠高亮的命令名接受 `[^\s/]+`（MiMo 只接受 `[A-Za-z0-9_-]+`）：MCode 的 MCP 提示命令名是 `服务:提示`，收严会让这类命令不再高亮；高亮本来就要求命令在缓存列表里，不会误标。
  - C11-48 只有技能芯片、没有文字时照常发出（MiMo 拒发并提示「请输入内容」）。
  - C11-50 运行中发送走完整路径（命令模板、技能芯片、批注都带上；MiMo 只插「文本 + 附件」）。
- 第十九轮（2026-09-21/22，我定并已告知用户，用户可要求改回）：
  - PDF 文内链接（目录等）点击后跳到目标位置；MiMo 26.920 的捕获阶段点击处理把它们一起拦掉，点了没反应。
  - 乐谱与内联音频旁的「（AI生成）」按界面语言翻译（`markdown.aiGenerated`）；MiMo 在所有语言下写死中文。与查看器底部 AI 提示一致。
  - 发送停靠的地板放在问题所在那一轮、并按列底而不是 scrollHeight 算空间（C 路）：MiMo 的算法在上一轮失去页脚时问题会漂移、对话短于视口时问题被放低。

## 第十九轮 · B：右侧面板与侧栏细节（2026-09-21）

清单 scratchpad `r19-laneB.json`，十项全部照 MiMo 26.920 改完；smoke `smoke-round19-panel.ts`（旧代码下各项均失败），探针 scratchpad `r19b/probe.cjs`（一次性配置，截图 `r19b/probe-*.png`）。
- RP-1 批注发光：输入框发送与运行中追加（steer）也登记文档监视（照 MiMo 的 VD/KD/HD，只算有批注文字、且是 PDF/Office 文件），同一次运行同一文件合并为一个监视并保留首个 prompt；已在发光的查看器合并新 id（26.920 的 noteBatch）；运行结束的监视标记 ended，之后的发送另起一个
- RP-2 子智能体详情头：「执行记录」后加模型胶囊（显示名，title 为完整 id；120 上限省略，1px 6px，圆角 999，文字色 6%，行高 1.35），模型取子对话自己的 `model`
- RP-3 侧栏收起时右侧面板不再扣 62 的导轨：1000 宽窗口最大 520（探针实测 innerWidth 1001 → 521）
- RP-4 同一对话/首页下目录变了，文件标签回到「打开文件」（清 viewFile / fileRoot / name，`rightPanel.reroot()`）
- RP-5 文件页图片点开预览带缩略图 rect，从原位放大；RP-6 文件树收起改 v-show，展开后滚动位置保留
- RP-7 启动卡描述照 MiMo 原文（14 种 MiMo 有的语言逐字，ar/bs/th/uk 自写同风格短句）
- RP-8 标签中键在松开时关闭（auxclick），按下后拖离不关
- R19-SH2 对话卡片在「更新于」/定时任务行之后、互聊行之前加「运行中的子智能体：…」（与胶囊同一数据，无名的略去，按 MiMo 用「、」连接；`subagentDetail.runningList` ×18）
- R19-SH3（用户 2026-09-21 决定）删行菜单「导出为对话文件」及整条对话文件链：`session.exportFile` / `session.importFile`、`src/shared/convo-file.ts`、`mcode:open-text` 与 `openText`、8 条文案 ×18；第七轮 S4、第八轮 X17 的对应检查一并删除。保留 MiMo 的 Markdown「导出对话记录」和其他导入器用的 store 选项。上文 S4 所述「命令面板导入对话文件」已不存在
## 第十九轮 · C：对话跟随、发送停靠与消息入场（2026-09-22）

清单 scratchpad `r19-laneC.json`，五项照 MiMo 26.920 的 ThreadView / scrollStick / HarnessRow 改完；规则在 `lib/scroll-follow.ts`（纯函数），smoke `smoke-round19-c.ts` 67 条（旧代码下 35 条接线检查全部失败，其余是新库自身的单元检查），探针 scratchpad `r19c/probe.cjs`（一次性配置 + 进程内 127.0.0.1 慢速 SSE 模型，截图 `r19c/v7-*.png`）。
- **CV-1 发送停靠**：输入框（主对话、非运行中、非 subtask）发送前 `requestPark`，被拒则 `clearPark`，3 秒过期。新问题出现时量它：目标 = min(ch/6, max(12, 2ch/3 − 行高))，所缺空间补成**该轮的** min-height 地板（另一轮接上时交给列，在原处结束），钉到底后停止跟随，列从 translateY(空间) 0.2s 滑入（减少动态效果时不滑）。地板在切对话、宽度变化时清掉；读者上滚或离底 >64、回合结束时，只在拿掉不挪视图时释放。停靠中新的权限/提问卡不拉走视图。**与 MiMo 的两处有意偏差**：MiMo 把地板放在整条 thread、按 scrollHeight 算——上一轮失去「最后一轮」页脚（实测 −14px）会让问题漂移，对话短于视口时 scrollHeight 即视口高会把问题放低（实测 267 对目标 137）；MCode 放在该轮上、按列底算。实测（40 轮含 content-visibility 占位）：问题落在 135.1px（目标 136.8，ceil 所致），回复流 2.5s 内 scrollTop 不动、scrollHeight 长 2048px，跳底按钮出现；一轮对话同为 135.1。
- **CV-2 跟随规则**：上滚 >8px（单步或累计）即停止跟随，哪怕离底很近；只在距底 ≤ ceil(1+1/max(.25,dpr))px 且是读者向下滚到的才恢复（浏览器因内容缩短把 scrollTop 拉回、无变化的重复 scroll 事件、只等于内容增长的位移都不算）；64px 只管跳底按钮；跟随时 overflow-anchor:none，否则 auto。跳底按钮改为不占流高（margin-top −34px）——原先它出现/消失会改 scrollHeight，离底 5px 的读者会被按钮消失拉到底并重新跟随（实测复现后修掉）。旧 `turn-end` 的 `STICK/stickState` 已删。
- **CV-3 暂停与重钉**：所有钉底走 `pin()`，拖选/选区在对话内（600ms 宽限后）、视频播放/暂停 600ms 内、编辑框打开及关闭后 300ms、150ms 内向上滚轮时不钉；窗口 focus / visibilitychange 回来且在跟随时重钉；新的待决权限或提问、运行中追加消息强制跟随并钉底。实测：拖选时 scrollTop 固定、松开后恢复；选区留在对话里保持暂停，清掉后恢复；上滚 400 后追加消息回到底部并跟随。
- **CV-4** 本次打开后新增的问题行 `msg-in`：淡入并上移 8px，0.2s cubic-bezier(.2,.7,.2,1)；切换/一次载入的不动画。停靠测量扣除动画的位移。
- **CV-5** 定时任务消息两行截断，溢出（scrollHeight−clientHeight>1）时显示 13px 次要色「显示更多」+13px 下箭头（上距 6、间距 4），点开不再收起；`stream.automationShowMore` ×18（ar/bs/th/uk 自写）。实测 40px → 80px。
- 注意：探针窗口不可见时（锁屏，`win.isVisible()` 为 false）不跑渲染帧，content-visibility 的轮次从未绘制过、没有记住的尺寸，测到的停靠位置不可信；只采信窗口可见的那几轮。

## 第十九轮 A 路：设置与外壳（2026-09-21）

对照 26.920 的 14 条（`r19-laneA.json`），smoke `smoke-round19-a.ts`（旧代码下各节全部失败），一次性配置真窗口探针看过截图。
- **F1**（用户定）：删首启「从其他 AI 应用导入」——MiMo 算出了钩子和懒加载弹窗却丢掉返回值，从不显示；连同 `ImportDialog.vue`、`server/import.ts`、`import.scan/run`、`importOnboarded` 及迁移、会话 `imported` 标记、18 表 `import.*` 一起删。常规页本来就没有导入入口，MiMo 也没有。
- **F6**（用户定）：新建项目弹窗删「默认新建项目位置」行（L8 把 `showLocation` 误读成存放位置），`project.createBlank` 不再收 `location`，空白项目一律放到常规里的默认位置。
- **F3/SH1**：原生选择框占用时主进程回 `{busy:true}`（`@shared/native-pick`），`save-png` 也纳入一次一个；窗口所有调用走 `lib/native-pick.ts`，弹 MiMo 原句 warning（`toast.pickerBusy`）。错误页没有吐司，写在它自己的提示行。
- **F2** 删自定义模型先确认（删除自定义模型），确认即从已存配置删（新请求 `provider.removeCustomModel`，最后一个保留）；**F7** 删供应商用「及其全部模型」文案；**F8** 模型页 提供商→供应商、探测只显示「{n} 个模型」、组合框「选择或添加 model-id」；**F9** 供应商 ID 照 MiMo：只禁 `/` 与（不分大小写的）重复，前后端共用 `@shared/provider-id`。
- **F4** 成功类吐司改 success，项目已存在/重名改 danger，批量恢复一律计数；**F10** 常规搜索词加 硬件加速/GPU/图形，高亮按整行文字；**F11** MCP 页配置文件行加 复制路径/打开；**F12** 检查更新的常驻吐司不可关，结果在同一 id 上替换；**F13** 配置页路径显示 `~`；**SH4** 重启更新抛错只显示原因句，原始错误进控制台。
- **未改（与 `reference-strings.json` 冲突，报告）**：`provider.custom.field.providerID.label` 仍为「提供商 ID」（MiMo「供应商 ID」），`provider.custom.error.providerID.exists` 仍为「该提供商 ID 已存在」（MiMo「该 ID 已被占用」）。
- 探针里 复制路径 在无焦点窗口被剪贴板拒绝（显示「无法复制路径」），属探针环境；success 级别用「已添加项目」验证。

## 第十八轮：对照 MiMo 26.920（2026-09-21）

**对照基准从 26.914 改为 26.920**（用户 2026-09-21 决定让 MiMo 自动更新；更新已由用户退出 MiMo 时自动完成）。26.920 的 out/ 已只读解到 scratchpad `r18-mimo920/out/`；26.914 的旧副本（`sf-main.mjs`、`r12-node.mjs`、`r12c-mimo/`、`r16-prompts/`）保留作对比，但 26.914 的 CSS、图片、`index.html` 没有存。从待装安装包取程序包的办法：NSIS 外壳里偏移 198712 处是一段原样 7z 流，电子打包缓存里的 `7za.exe` 能解。

**截图实测（第一次运行 MiMo）**：先按记忆里的保险用一次性配置启动 MiMo，结果停在小米账号登录页（不登录什么都看不到），且任务把用户随后打开的**用户自己的 MiMo 误判为自己的实例强制结束了**——教训记在记忆 `mimo-running-lessons`（只结束当场记下的进程号；MiMo 还会读写 `~/.local/share/mimocode` 等 XDG 目录、启动时重写开始菜单快捷方式）。之后改为用户授权下用 computer use 操作**用户已登录的 MiMo**，在临时项目 `C:\Users\Wyatt\XiaomiMiMoProjects\mimo-diff-demo` 里做了两次小改动，用 DPI 感知的原生截屏取色（`r18-mimo-*.png`）。**遗留在用户 MiMo 里**：该项目与一条对话「修改 src/greet.js 的问候语与变量名」，删除属永久删除、须用户自己做。实测结论见 `round18-visual-measured.md`：MiMo **没有**「已查看」勾选框；差异配色是 diff2html 的，且**成对改动与纯删除/纯新增颜色不同**（浅色 #fdf2d0/#ddeedd 对 #fee8e9/#ddffdd，深色 #3d321a/#1e3a23 对 #2f1e1d/#1b2c1e，词 #ffb6ba/#97f295、#883e2d/#246330）。

**用户决定（2026-09-21）**：拒绝后回合继续（撤销第五轮「两种拒绝都停」）；托盘删掉配置切换（撤销那条故意不同）；交付文件照 26.920 写入 AI 标识；定时任务工具不再给模型；模型层语言跟 26.920 的新分法。用户还要求「抄 MiMo 的代码和文字」——答复为不能（受版权保护的内容不能原样搬），数值、规格、行为、短标签照搬，代码与成段文字自己写，用户回复 OK。

**D 差异视图（R18-D）**：删「已查看」勾选框及 18 表文案（`114a8c6`）；行号栏改为 diff2html 的单格 7.5em、面板窄时两个行号自然上下叠（`1a6627d`）；成对/纯改动分色 + 词色 + hunk 行 + 文件头按实测，深色与 MiMo 逐项相差不超过 1（半透明叠 #181818 的取整），未新增 CSS 变量名（`bd6cc6a`）；审阅页「Files changed (N)」标题（18 表）、黄色方块状态图标、蓝色路径（目录部分淡化）、标签按状态上色（`5a0ead6`、`45f6fe9`）；步骤里的差异文件头显示正斜杠绝对路径，审阅页与权限卡保持相对路径（`1e0ba6c`）；多文件改动卡图标（`d567769`）。回复操作栏本来就有悬停显示的时间

**U 外壳与小界面（R18-U）**：侧栏完全收起（宽 0），悬停切换按钮 150ms 浮出整栏预览（8,8，宽 256，圆角 16）、离开 200ms 收回，按钮在 x=75（26.920 Windows 实测值）（`ac4668a`）；托盘只剩打开/退出（`ea2afac`）；删首页建议卡（`d7e4d04`）、出错卡的重试（`9abe7b4`）、底部菜单的退出应用（`e1aaa06`）；问题停靠栏可最小化、上限 50vh（`b2289f5`）；侧栏行「N 个子智能体」胶囊（`1132f63`、`61e9a16`）；更新失败 9 种原因（`src/shared/update-reason.ts`，`a724b53`）；发送中/压缩中（`7d54a32`）；自定义模型按供应商分组（`15a0d68`）；webfetch 改「读取网页」（`ffbc8c8`）；五个查看器底部「内容由 AI 生成，请注意核实」（`right/ViewerAiNote.vue`，`c14fcd0`）；乐谱与内联音频旁 MiMo 的「（AI生成）」小字已补（R18-U14，`smoke-round18-aigc-marks`）：乐谱视图在谱面上方一行（上 6、左右 12，12px，`--text-base`，代码视图不显示），语音气泡下方与气泡同宽一行（文件名占余宽截断，其后 10px / 行高 1.2、暗色 #777、不可选中；加载失败卡无此字），文件页的 .abc 与交付的音频同一组件故一并带上，文件页直接打开的音频不带（同 MiMo）；MiMo 此串写死中文，MCode 按 18 种语言翻译（`markdown.aiGenerated`）

**M 模型与设置（R18-M）**：模型页照 26.920 重做（新文件 `ModelsPage.vue`）——**实际是顶部横向页签（刷新/添加/每个供应商一个）+ 下方表单**，不是分析报告说的左右分栏；自定义供应商测试连接（Key 不回传窗口）、克隆、每模型一卡（上下文/输出上限、四种输入）；`CustomModelDialog` 与配置文件卡删除；快速添加仍是 7 家（26.920 把另外五个过滤掉了）（`684a5dc`）；自定义供应商新增 `/responses` 协议，适配器选择合并为 `adapterFor(kind)`（`0bfac95`）；开机自启（仅 Windows/macOS，默认关，Windows 带 `--openAsHidden`，开发版只写文件不碰系统）（`758f446`）；实验室页常显，只放「跨对话协作」一个开关（默认开，关掉则下一轮起模型拿不到 6 个互聊工具）——另两个开关 26.920 默认关且 MCode 没有背后的功能，不做（`62a4d13`）；技能兼容路径默认读 `~/.agents/skills` 与项目 `.agents/skills`，`.claude/.codex/.opencode` 各一开关默认关（`22b2d0e`）

**E 引擎与提示（R18-E）**：拒绝（含「拒绝并说明」与循环检测问题）变成交给模型的错误，只有「停止」结束回合，问题卡/计划卡保持打开，子智能体绕开，目标模式走到判定（`9b59c68`、`7bb3867`）；`cron`/`automation_update` 只在 `MCODE_E2E=1` 时提供，提示词新增「Scheduled tasks」一节说暂不可用；已存的任务照常运行、界面无创建入口（`273bde5`、`344799b`）；提示词按 26.920 新结构重排、计划模式不再附中文段、环境检测守卫删除、首条说明 2699→1202 字、目标守卫改英文（`4cfb4ce`、`f2c6fe6`）；自动工作树提示删除（`c7584a7`）；删 `frontend-design`、`design-blueprint`，新写 `less-ai-tone`、`powershell-reference`（用途与触发照 26.920，文字自写）（`d7a7b4e`、`c8f1f7a`）；toolcheck 禁止描述里用大写称呼其他工具（`58322ac`）

**A AI 标识（R18-A）**：`present_files` 交付的本地文件写入 AI 标识（`src/server/tool/aigc-label.ts`，`5287377`）。可见标识是我们自己的样式：docx 右对齐灰色段落、pptx 末页右下文本框、xlsx 的 A1 追加（数字/公式不动只写元数据）、pdf 末页右下、html 角落不拦点击的徽标、wav 末尾自合成提示音（1.2kHz、80ms 单位、按国标的「AI」摩尔斯节奏）。隐藏元数据按 GB 45438-2025 七字段，生产者填「MCode」（MiMo 填小米企业编码，我们没有）。内存生成→重解析（有 python-docx/pptx/openpyxl 时也用它们打开）→临时副本→读回→改名替换，任一步失败保留原件；二次交付不再改动；撤销恢复未标注版本。未做：同回合内被再次编辑的已交付文件自动重标（再交付一次即可）

**X（自查发现）**：定时任务时钟跳变守卫的基准只在第一次检查时才取，启动后第一次检查前时钟就跳（开机即睡眠）会漏判、把错过的全部触发；第十七轮那条检查单独跑 4/4 失败、全量里被前面的检查拖慢才侥幸通过。改为开始检查时就取基准（`99cfd57`）。合并 U 路时 preload 冲突「两边都保留」复活了已删的托盘配置切换通道，被第十二轮的 wiringcheck 规则抓到，已删（`a80d318`）

## 第十七轮：查看器、语音与媒体、工作流（2026-09-21）

三份只读对照后分三路修，合并后 13 项检查 + build 通过，smoke **5540 全过**。新增 `scripts/smoke-round17-{viewers,media,workflow}.ts`。

**又一条假差距（第五次）**：**MiMo 那整套定时任务管理界面是 E2E 专用**——页面、侧栏入口、快捷键、右面板标签、「立即运行」、运行历史动作与全部 194 条 `pages.automations.*` 文案都挂在 `window.mimo?.e2e`（preload 由 `MIMO_E2E === "1"` 置位）后面，发行版一律不可达。**MCode 没有这个页面是对齐，不是差距。** 已发行的只有调度器、队列、`automation_update` 与系统通知，以及侧栏行提示里的任务块（本轮 W26 补上）。同类结论另见记忆 [[mimo-ships-code-it-never-runs]]。

**文档与查看器（R17-V）**
- V1 文件页原来用「全关」的 `renderMarkdown()`：链接不是链接、图片不画、围栏零着色、无复制按钮、无图表/乐谱/公式。抽出 `parts/MarkdownBody.vue`（渲染块、着色、媒体挂载、表格按钮、路径菜单、样式表），回复与文件页共用；实测面板与回复逐块几何一致（`136a51b`）
- V2 查找条输入框在 640/380/300 三种面板宽度下实测 148.6/17.3/0.9px，现固定 150px，与 MiMo 同（`db545a7`）
- V3 文件树过滤原是子串匹配 + 攒够 50 即停，路径式查询搜不到；改用已有的 `rankFileHit` 对整条相对路径打分排序（`00d3259`）
- V4 超过 25MB 的 PDF 打不开：改为把地址交给本地预览服务（本就支持范围请求），不再 base64 走 IPC；27MB 实测两页正常、零控制台消息。版本存储仍按上限读字节，所以过大的文档没有撤销（`050a20e`）
- V5 盘符根目录的文件打不开（`fileRoot` 成了 `C:`）；另把「项目内的绝对路径保持项目根」写进 `office-open.ts` 并注明日期（`53f10ae`）
- V6 步骤行的路径按 MiMo 的四种写法解析（`6e51a23`）；V7 表格滚动不再被拽回（`d7919bc`）；V8 空 `<w:t/>` 不再吞标签、批注 id 转义（`c42750d`）；V9 Office 标签里的 PDF 标 `data-selectable="content"`，Ctrl+A 不再全选整窗（`3eb2d62`）；V10 PDF 批注引文折空白并补省略号（`19074c8`）；V11 重载取消上一次的滚动恢复（`f9f1406`）
- **V13（不在清单里、自查发现）**：abcjs 的 `responsive:"resize"` 会给 SVG 绝对定位并期待独占容器，而消毒后只剩五线谱——乐谱因此画在最近定位祖先上，在回复里藏在消息列表后面、在文件页里正好压住文档首个标题。已放回文档流（`45ed8c7`）
- ~~PDF 完整批注层~~ **已做（`aa3d041`）**：MiMo 26.920 用 react-pdf `<Page>` 默认值——pdf.js `AnnotationLayer` 开、`renderForms` 关（表单画在画布上）、外链在捕获阶段按 http/https/mailto/tel 交给 `openExternalUrl`；**它的捕获处理器连 `#` 内链一起吞掉，所以 MiMo 的文内跳转是死的**，MCode 这里让内链滚到目标页与点（与 MiMo 的差异，用户可决定是否回退）。MCode 现每页建 `lib.AnnotationLayer`（`dontFlip` 视口、`lib/pdf-links.ts` 的精简 `IPDFLinkService`），便签带 pdf.js 自带图标（构建复制到 `pdfjs/images/`，MiMo 的 `imageResourcesPath` 为空所以它的图标是裂图）与弹窗，高亮弹窗、附件、链接齐全；样式用 pdfjs-dist 5.4.296 自己的批注层规则（MiMo 带的是 react-pdf 旧版 CSS，类名 `popupWrapper` 已对不上 5.4 的 DOM）。实测 100%/130% 两档各批注框与 PDF 矩形×缩放误差 ≤0.09px，内链点击后目标点距视图顶 0.14/0.02px，外链只经 IPC 到 shell（桩），选字、V10 批注、重载滚动恢复照常。未做的原清单另一项：结构化回退（没有 Office 文本抽取就无内容可画，会多出四条 18 语言的死文案）

**语音与媒体（R17-M）**
- M1 「智能编辑」静默失败：它那次改写请求也发给了转写模型。**用户决定**：改写用当前对话模型（首页退回默认对话模型），语音模型设置只管转写，18 张表的说明同步改写；改写没成会明说（`editFailed: noModel|refused|unreadable`），不再静默退化成听写。顺带修掉写死的 `speech.webm` 分段名（`aa9cb04`）
- M2 等待确认无声且逻辑相反：MCode 照抄了 MiMo 的「播完自家提示音后把系统通知标静音」，却没有那第二种声音，于是开着提示音反而全程无声。新增 `confirmChime()`（按 MiMo 的音高与时值测量后用自己的合成器写：E5 起、+0.16s 接 A5、1.1s/1.4s、0.85:1，测量值写在代码里），有待确认项即播、不受「超过 1 分钟」限制；只有真播了才把系统通知标静音（`172237a`）
- M3/M4/M5 录音胶囊九种状态（6 键 ×18 表）、开麦前 `voice.precheck`（2 秒探测，模型不可用则根本不开麦克风，失败提示每次录音只说一次）、分段改为自适应语噪底 + 0.875 迟滞（快速输入 0.8s / 智能编辑 1.2s）、单段 60 秒上限、`getUserMedia` 要单声道 + 回声消除 + 降噪（`e918b0e`）。**未做**：MiMo 录音前留 0.6 秒预卷，需要编码前的环形缓冲，`MediaRecorder` 给不了，不伪造
- M6 `speak` 不再断言「用户已要求播报」，`present_files` 点名 ```` ```sci-widget ```` 围栏（`d904361`）；M8 停止、离开对话、关掉开关都会掐断正在念的句子（`066f322`）；M7 图片全屏预览支持框选批注，坐标经平移/缩放/旋转反算（实测 1160×870 上落点精确到 0.25/0.20/0.50/0.50）（`6158c88`、`03e386b`）；M9 导航条音阶与音量对齐 MiMo（`57e96ba`）
- 核实：**MiMo 的内嵌视频播放器是死代码**（组件、倍速、收起、CSP 放行俱全，但点击分发无条件开浏览器标签、live 的 setter 无人调用）——第五轮删掉内嵌播放是对的，别再翻案；缺的三条 `mediaCard.*` 文案只是死代码的文字

**工作流（R17-W，30 项）**
- W1 `notebook_edit` 不在两个 `EDITING` 集合里：笔记本改动既不画改动卡也永远无法撤销（`346269b`）
- W12 **子代理进度控制**（用户决定照 MiMo 做）：带任务号的子代理不交出进度文档就不许结束，最多重入三次，写进 `memory/guard.ts` 早已记录的那个目录（`f697eb7`，新文件 `src/server/session/task-progress.ts`）。措辞英文——MiMo 自己这块与旁边的 `taskGateReminder` 都是英文
- W9 切到别的工作树里的分支时把该工作树加入项目列表（`3b68612`）；W10 工作树提示补上 MiMo 给模型的三条指示（`e816d42`）；W11 工作树命中跨重启保留（`835f5cf`）
- 定时任务：W17 恢复暂停不再立刻补跑已过期的那次（`bc5522b`）；W18 时钟跳变（睡眠/夏令时/改时区）后重排而不是把错过的全部一次性触发（`6d678df`）；W19 排队中的运行在交付那一刻复核（暂停或删除后不再触发）（`ce346fa`）；W20 会话忙时跳过而非挂起，`queued` 阶段随之删除（`3d56db5`）；W21 运行通知不与完成提示音重复出声（`1669952`）；W22 起不来的新任务不留空对话（`b6e93df`）；W23 运行记录保留来源与所问（`9a2e947`）；W25 队列租约对齐 MiMo 的 30 秒（`de2db55`）；W26 侧栏行提示写明所属定时任务（`7488819`）
- W2 审阅页切文件时不再画上一个文件的差异（`0232ea5`）；W3/W4/W5/W8 提交卡写明分支、分支菜单建完分支后保持打开（实测确认）、空分支列表会说明、检出失败输出 git 的全部说明
- W13 子代理转录放进 MiMo 的盒式面板（`8a59554`）；W14 平铺的 `background: true` 调用改为真正派生而不是阻塞（`a8c3fcf`）；W15 排队中的子代理状态报 `pending`（`99362e6`）；W16 send 接受 MiMo 的两个额外字段（`a7117d5`）
- **W30（自查发现）**：每轮首次请求前的工作树读回两处读取都无防护，转录正被写入时会让整个回合在发出第一条请求前就结束（曾在一次计划检查里命中）。已加防护（`a0c45c5`）
- **settle 的悬案**：停止父回合**不**连带停后台子代理——MiMo 的 `SessionRunState.cancel` 同样只取消 `(sessionID,"main")`，阻塞式 `run` 只是因为工具自己的调用随回合取消而停；MCode 行为一致且第五轮早有检查覆盖
- 证伪后删掉的：`duplicate-run` 防护环建好后证明不可达（运行 id 是 `<任务>-<到点时刻>`，唯一重复路径已被 W19 的重叠守卫拦下），留着就是死代码

## 第十六轮：编码能力照 MiMo 重做（2026-09-20/21）

用户要求：编码能力不再跟 OpenCode，改为和 MiMo 1:1——对话方式、代码处理方式、编码时看到的界面。三份只读对照后分五路修，合并后 13 项检查 + build 通过，smoke **5246 全过**（两遍）。新增 `scripts/smoke-round16-{goal,prompts,tools,diff,widget,b}.ts`。

**对照得出的三条底层事实（下一轮不必重查）**
- **MiMo 的引擎本身就是 OpenCode 的分支**：`r12-node.mjs` 里 183 处 `opencode`、服务标签 `@opencode/…`、`MIMOCODE_SERVER_USERNAME:"opencode"`。所以「不跟 OpenCode 跟 MiMo」在代码处理层不是换实现，而是换配置——MCode 每一处跟的**已经是 MiMo 那一列**（蛇形参数、`actor`/`task` 分工、bash 六参数、编辑默认精确匹配而非 OpenCode 的无条件模糊）。
- **MiMo 的提示词是 asar 里的普通文件**（`electron/prompts/*.txt|md`），已只读提取到 scratchpad `r16-prompts/`。
- **四个看似最大的差距全是假的**：26 个格式化器、38 个语言服务器 + 诊断回流、bash 输出清洗流水线、同目录并发检测——代码都在 MiMo 包里，但它桌面端生成的引擎配置不写 `formatter`/`lsp`、清洗挂在未设的实验旗帜上、并发检测只有桌面从不调用的实验路由。**MCode 一个都没做，结果与 MiMo 桌面一致。**

**用户 2026-09-20/21 的决定**：①「完全中文化」只指给模型看的那一层，界面保持 18 语言、回复语言仍跟随界面；② 完全照 MiMo 并舍弃多余的；③ 做目标模式、删编排模式；④ 删三个环境信息块；⑤ 差异做词级高亮与文件头，标签走我们自己的 18 语言表；⑥ 两处比 MiMo 严的审批放松到 MiMo；⑦ 中英分层照 MiMo 的分法（基础提示英文、护栏中文、工具说明英文）。

**A 目标模式（R16-A）**
- 加号菜单里 MiMo 放「追求目标」的那一格改为目标模式开关＋目标栏；回合将结束时把整段记录交给裁判判定（**同一个对话模型**、温度 0、无工具、结构化 JSON），未达成则注入系统提醒重入循环，上限 **12**（`r12-node.mjs:369047` 核对）。裁判失败放行停止；Stop 连裁判一起中断、目标保留；子智能体不判定；目标存在会话上，重启仍在。计划模式同时开时 MiMo 只是不注入那一句护栏、裁判照跑，照搬（`b4cb55c`、`478bc56`、`6bcce78`、`4765eb7`）
- **删掉 MCode 自有的编排（compose/staged）模式**：代码、18 张表的文案、检查一并清除（`123c8ae`）
- 唯一偏离 MiMo 快捷键表的地方：MiMo 那一格是「切换编排模式」，模式删除后改为「切换目标模式」（同样未绑定按键）

**B 模型层（R16-B）**
- 按 MiMo 的实际分层逐段核对后改：`claude.txt`/`desktop-base.md` 英文 → CORE/DESKTOP 保持英文；`plan-addendum`/`guard-plan`/`guard-envcheck`/MCP 配置段中文 → 对应段落改写为中文（我们自己的措辞）。汉字占比与 MiMo 逐文件对齐（MiMo 0.25%/67%/67%/29%，MCode 1.7%/70%/71%/31%）（`4c30ba0`、`5f4f972`）
- **三个环境块删除**（`## Environment` / `## Repository` / `## Building and testing`）连同喂它们的 git/shell 调用与 `PromptModel`；提示词不再随模型变化，前缀缓存键去掉 model/shell。原来把这归功于 MiMo 的注释已更正（`f1fd288`）
- 环路检测补到 MiMo 的四类 + 跨步重复文本 + **把重复片段从请求里裁掉**（`src/server/session/loop-health.ts`，阈值读自引擎并在声明处写明）（`afa9b6b`）
- 便宜五项：SVG 设计令牌、Windows 工具链护栏、标题提示词、PPT 配图分支；多技能编排提醒**第十轮早已有**（审计写错）（`383aaaa`）
- `prompt-check` 改为断言语言分层本身，`tool-check` 新增「工具描述必须是英文」（与 MiMo 一致）（`4985ab7`）
- 内联组件那段提示按分法改回英文行文、保留中文触发词（`1d74656`）
- 审计对 `TryBestMonitor` 的判断有误：它挂在 `MIMOCODE_ENABLE_TRY_BEST_HANDOFF` 后而桌面端不设该变量；仍按简报实现并接到已有的询问上

**C 工具与审批（R16-C）**
- 交互式命令拒绝语改中文并新增 `session.notice` 事件（只带 key，窗口用 18 语言说），每会话一次（`340217d`）；bash 说明随 shell 变化，PowerShell 5.1 明说无 `&&` 并给 `cmd1; if ($?) { cmd2 }`（`023a703`）
- `trimDiff` 去公共缩进（`9af1b5a`）；edit/write 结果带加减行数（`e8544ab`）。**内部差异**：`metadata.filediff.patch` 存未裁剪补丁（MiMo 存裁剪过的），因为撤销要 `git apply --reverse`
- 新增只读的 `list_external_sessions` / `read_external_session`，参数/上限/拒绝照 MiMo；说明保持英文（MiMo 这两个本身英文）（`6640a0d`）
- **`write` 桶并入 `edit`、webfetch 默认 `allow`**，带迁移 `write-into-edit-r16`（旧配置取更严者落到 `edit`，用户设过的 `deny` 不动）（`1e1ac36`）
- 清掉不存在的 `patch` / `apply_patch` 分支（`a9420a3`）。顺带发现未修：`notebook_edit` 不在 `EDITING` 里，笔记本改动进不了撤销

**D 差异界面（R16-D）**
- 词级高亮：照 diff2html 的 `diffStyle:"word"` 重写分词与记号比对（未抄代码），用 MiMo 包里那份当基准跑 4000 组随机对比 **0 处不一致**；配对沿用 `splitRows`，单栏与左右对照点亮同样的词；1200 行上限与折叠不变。**一处刻意保护**：记号比对走满 1000 次编辑仍不收敛就整行画平（MiMo 会一路算完，压缩文件上会卡数秒）（`409fbf3`）
- 文件头：状态图标 + 状态标签 + 「已查看」勾选 + 重命名 `{old → new}`；标签走 18 语言表。**`+N -M` 从文件头移走**（MiMo 只在文件列表里显示）。「已查看」只记在这一次绘制上，不折叠、不存储、重绘即清——MiMo 未加载 diff2html-ui，行为如此（`10d7695`）
- 文件列表只在整页差异标签绘制（`9bb0d6c`）；右面板启动卡补说明行（`395cd1b`）；`exec_command` 按 bash 说话、命令读 `input.cmd`（`6c2ee80`）
- 两处从代码定不了、保持现状：深色差异配色与每文件边框；以及 MiMo 那个「已查看」勾选框是否可见（diff2html 自带样式把它设为 `display:none`，只有 diff2html-ui 才显出来）——要真截一次 MiMo 才能定

**E 内联交互组件（R16-E）**
- 复刻 `sci-widget`：围栏 + 自包含 HTML，沙箱 `allow-scripts`，流式时一行占位，**没有任何按钮、渲染层没有尺寸上限、没有错误处理**（MiMo 的减法照做）（`d121f84`、`c1c8849`）
- **一处必须不同**：MiMo 渲染层无 CSP，MCode 有。实测在我们的策略下 `srcdoc` 框被整个拒绝、脚本永不执行，因此文档改由主进程在**不可猜测的 `<token>.localhost:<port>` 独立来源**上提供，策略作为真正的响应头下发，窗口自身 CSP 未动。实测：本地存储、父窗口、`parent.mcode`、顶层跳转、fetch/XHR/远程图片全部被拒
- MCode 比 MiMo 多一个来源大小上限 `WIDGET_SOURCE_LIMIT` 512KB（超过则保持代码块），记为故意不同
- 探针发现并修掉一个缺陷：按视口布局的组件会与外框互相撑大、无限震荡（一轮两帧、上千次），现在锁定后只有窗口缩放才重算

## 第十六轮的真实模型端到端（2026-09-21）

用户局域网的 `qwen38-nvfp4`（vLLM，256K）跑六个场景，请求体与回复流经本机回环代理全量落盘（证据在 scratchpad `r16e-*`）。**通过**：先读后改、词级差异与文件头、撤销与重做双向且逐字节核对；PowerShell 下全程无 `&&`；计划模式的中文守则、只读不写、方案文件、切到构建；目标模式的判定请求形态（无工具、温度 0、JUDGE_SYSTEM）与目标条；内联组件渲染；交互式命令的中文拒绝 + 每会话一次通知；实际发出的系统提示 36,176 字符、只有 13 个汉字（英文里引的中文触发词）、三个环境块确已消失、29 个工具含两个新的跨会话只读工具。**真实模型两次都一轮达标**，所以「不达标→再来一轮→撞 12 次上限」这条臂只有 stub 探针验过。

**发现并已修的三个缺陷**
- **E2-1 被输出上限截断的回复**：续写原本另起一条 assistant 消息，于是未闭合的 ```` ```sci-widget ```` 围栏被当代码块、后面那个落单围栏又把讲解吞成第二个代码块（真实模型上复现：16K 推理耗尽 → 5,423 字截断 → 2,048 字续写）。改为**续写接在同一条回复的同一个 text part 上**：渲染、复制、搜索、导出一次全修。连带处理重试（回到本次尝试已有的片段而非清空）、用量（输出累加、输入只取最新一次，否则上下文环会算成两倍）、`LENGTH_NOTE` 每条消息只带一次。MiMo 自己是合成一条 user 提醒再开一步，转录同样是断开的，无可照搬（`b6a206f`）
- **E2-2 `Today:` 用 UTC**：东八区每天 00:00–08:00 报成前一天（证据 `r16e-1-user1.txt`）。改用 `localDay()`，与用量页同一套日历（`fef1a37`）
- **E2-3 中文环境守则把 Windows 一律当 PowerShell**：从 Git Bash 启动时，同一请求里工具说明说 bash、守则说写 PowerShell。守则改为接收本轮 shell 名、只在 powershell/pwsh 下保留 PowerShell 专属两条（`ff9070a`）

**未修、记在案**：真实模型会在中文回合中间整段改用英文（`## Reply language` 压不住，属模型不守指令）；`notebook_edit` 的改动仍进不了撤销。

## 第十五轮：二次全面复核与修复（2026-09-20）

六个只读复核代理（主进程、后端核心、工具/MCP/定时、界面状态层、对话界面、设置与弹窗）各自写报告，再由七路 worktree 修复。合并后 13 项检查 + build 通过，smoke **4891 全过**；新增 `scripts/smoke-round15-{{server,tools,main,state,ui-chat,ui-settings,font-scale}}.ts`（另有两个在 Electron 里跑的辅助文件）。每路都做了「把修复还原，检查必须失败」。

**后端核心（R15-S）**
- S1 重做必定失败：`runner.ts` 两处 `moveSnapshot` 只搬 `files`，丢了 `directory` / `messages`，正文搬进 per-project store 后就再也读不回来，条目还卡在 redo 栈。smoke 原来的 Undo 段用的是旧的内联形态所以看不见，已改成今天的 blob 形态（`e54bf19`）
- S2 收尾照片失败（目录被删/改名、git 超时、磁盘满）后 Recording 永远留在 `live`：之后该会话每回合都被记成不可撤销、理由是假的「另一个对话改了 X」，store 永不回收。清理移进 `finally`，开头照片的镜像洞也补上（`6a89a77`、`cc59258`）
- S3 中文搜不到（第十一轮改索引搜索引入）：`unicode61` 不切分连续汉字。改为另存一列 `search_body`（相邻 CJK 之间插空格）供 FTS 索引，查询同样切分后按短语匹配，浮层最后一个词当前缀；只有被切过的正文才存第二份——纯英文档案索引 +0%、全中文 +67%。`SCHEMA_VERSION` 2，旧索引启动自动重建。4000 条 parts 下英文 0.13→0.12ms，`配置` 0→1000 条命中。（`94b723c`、`a858ca1`）。**[已完成] 英文词中子串**（`figur` → `configuration`）：MiMo 26.920 浮层不走索引，对已载入对话逐条消息先找原样子串（1000 分 + 靠前加分 + 词边界加分）、找不到再按字符顺序散配，最多 50 条、同分按更新时间；其引擎 `history` 工具用 `unicode61 remove_diacritics 1`（只认整词）。于是模型的 `history` 工具不动；浮层的候选改由新表 `history_part_trigram`（FTS5 trigram、contentless + contentless_delete，只收浮层会读的 text / tool 行、每行前 20000 字 = MiMo 每条消息读取上限）给出：查询按空白与 `"` `\` 切块，≥3 字的块全部须在同一条消息里（INTERSECT），更短的块交给前端打分；全是 1–2 字的查询则并用旧的词索引（全量历史，词首 / 中文任意长度）与最新 3000 行 `instr` 扫描。候选取命中对话里最新的 50 个（排除归档 / 侧聊 / 子智能体）。`SCHEMA_VERSION` 3，旧索引启动自动重建。合成 4020 条 parts（4.07MB 文本）：索引 8.83→19.23MB（trigram 10.1MB）、首次建索引 1.7→2.9s；候选查询 `configuration` 1.23→0.77ms、`figur` 0→50 个对话 0.39ms、`the` 1.34→0.38ms、`配置` 0.19→8.5ms、`co` 6.2→13ms（多了扫描）；`history` 工具不变（0.47–0.55ms）。仍不同：散配（如 `cfg` → `config`）只在候选对话内生效，候选本身不按散配找
- S4 删会话后残留的 `ArtifactStore.dirty` / `repeatsAllowed` / `worktreeHits`（`24d270c`）；S5 用量「脏」标记确认自愈，改为用检查钉住（`ff33463`）

**工具 / MCP / 定时（R15-T）**
- T1 Windows 上经 `cmd.exe` 起的 MCP 服务器只杀了外壳：`taskkill /T /F` 抽成 `src/server/kill-tree.ts` 共用，探测的子进程登记进 `probing` 并在 `close()` 回收（`fdc4c30`）
- T2 `create_session` 可把任意绝对目录当项目根、零审批读遍家目录。**MiMo 完全不检查**（渲染端直接 `POST /session?directory=`，连目录存在都不验），本项故意不照抄：项目（或其仓库根）内照旧放行，项目外走既有「项目外」审批（`e7a08dc`，见「与 MiMo 故意不同的地方」）
- T3 cron 项目锁拿不到就永不重试（`??` 缓存了 `owned:false`）；除重试外加锁心跳：持有者每 30 秒盖时间戳，超 5 分钟未盖的锁即使 pid 还在也可接管——这才堵上「硬杀后 pid 被复用」（`61d0f64`）
- T4 `cron` 工具能写别的项目的 `.mcode/scheduled_tasks.json`：拒绝目录不在本次调用项目内的 `session_id`（`b693b10`）；T5 启动失败的命令永远留在 `live`（只有 `error`+`close`，没有 `exit`）（`1577ff6`）

**主进程（R15-M）**
- M1 面板页面自关（OAuth 回调页那类）后 `view.webContents` 变 `undefined`：面板所有操作抛错、`closePanel` 中断循环使其余页永不关闭、主进程多次未捕获异常。新增 `contentsOf(tab)` 与 `destroyed` 监听 → `dropTab()`（`8da2335`）
- M2 界面重新加载后面板网页仍压在界面上且无处可关：`wireWindow` 在 `did-navigate` 上 `closePanel`（用 `did-navigate` 而非 `did-start-navigation`，`index.ts:862` 拦下的导航不会误伤）（`e52c050`）
- M3 同一次重载永久泄漏 office 目录监听（`49ccef1`）；M4 每开一次面板多挂一个窗口 `closed` 监听，第 9 次告警，用 `WeakSet` 守门（`45ccb43`）；M5 托盘配置切换给刚建的窗口发消息必丢，改为等 `did-finish-load`（`829e827`）

**界面状态层（R15-R）**
- R1 `session.history` 的旧应答落到新会话：撤销状态张冠李戴、右侧面板被假变化触发重读。应答后核对 `currentID`（`5e72dd5`）
- R2 提示上限 3 会把常驻提示（断线横幅、登录过期、配置/凭据损坏）挤掉且再不回来：驱逐时先挤有时钟的，总量上限仍是 MiMo 的 3（`21e830a`）
- R3 对话框退场副本没有 `inert`，关后 200ms 内 Tab 掉进副本再落到 `<body>`；顺带修好这 200ms 内的拖放判定（`64a7869`）
- R4 查找条跨会话不刷新（旧命中数、高亮挂在已脱离文档的 Range）（`67eddf7`）；R5 着色缓存命中不刷新 LRU（`2e56165`）；R6 `forgetSession` 漏清按会话 id 的集合（`cda1414`）

**对话界面（R15-U1）**
- U1-1 盘符根目录的 .xlsx/.pptx/.html 打不开（`slice(0, cut)` 少了分隔符，第二轮修 PDF/Docx 时漏了三个）：五个视图统一 `splitFilePath`。复核推测的「会读到 cwd 同名文件」不成立——`office-guard` 的绝对路径校验先拒（`afeefb6`）
- U1-2 文件页查找条恒宽 324px 盖住文件树、面板拖窄时伸出面板；改为跟随面板宽度并给按钮加宽度下限（只加 `max-width` 会让按钮溢出窗口）（`e2c1344`）
- U1-3 「历史」按钮关不掉自己的弹层（捕获阶段先关、随后的 click 又开）（`3842f4d`）；U1-4 会话导航条为 synthetic 消息画死刻度、悬停显示写给模型的内部消息（`87129a6`）；U1-6 docx 修订卡无锚点时叠成一摞（`bff33dc`）；U1-7 子智能体行焦点环被分组 `overflow:hidden` 裁掉（`50db010`）；U1-8 首页字标弹跳无视 app 自己的「减少动态效果」（`95324da`）；U1-9 `.skill-item{30px}` 被后置 `.item{28px}` 压平（`1ae049d`）；U1-10 审查页乱序返回时旧读覆盖新读（`2a78b05`）
- 保留不改：代码字号放大后行号列重叠——MiMo 的 `.rv-ln{34px}` / `.ft-ln{44px}` 数值相同、放大同样会叠，属忠实复刻

**设置与弹窗（R15-U2）**
- U21 窄窗（窗口下限 720）下模型页与 MCP 页行重叠、按钮被卡片裁掉。真正成因不是 `.pname` 缺 `min-width:0`（它不是 flex item，加了是空操作），而是 `.ptext`/`.line-text` 的 `flex:1` 基准为 0 + 行不换行 + `.card{overflow:hidden}`。改为行可换行、控件组换行后仍靠右、文字列 `min-width: min(180px,100%)`（`e401c22`）
- U22 `.config-path` 的 11.5px 被后置 `.line-sub{12px}` 压平 → `.line-sub.config-path`；`.card.wt-empty` 的 18px 侧距 → 17（`3d5c072`）

**界面字号（R15-U3）**
- 外观页字号可调到 24，但 168 处声明跨 42 文件只缩 `font-size` 不缩 `line-height`（常配死 `height` + `overflow:hidden`）：导航标签溢出 241px 列被页面盖住、`.ctl-btn` 文字竖向裁掉、行互相压字、侧栏与首页字形底部被切。
- MiMo 的做法（`out/renderer/assets/index-Dz6PjQMq.css`）：`--ui-font-scale` 只出现在 16 个 `--text-N` token 和 7 个 `.type-*` 类的 **line-height** 上。照此把每条缩放字号的规则的 `line-height`（及包住该文字的 `height`）同比缩放；用 `height: calc(...)` 而非 `min-height`（后者会改变属性、破坏基类与修饰类的覆盖关系）。设置导航列另加行最小高度、`overflow-wrap: anywhere`、`.nav{overflow-x: clip}`（用 `clip` 不用 `hidden`，否则另一轴变 `auto` 会吃掉 10px 滚动条宽）。两处图片占位与九处滚动区 `max-height` 豁免（`ba1f77e`、`4c3eca0`、`214d37d`）
- 实测：德语字号 24 下裁切 225 → 0、行溢出 21 → 0、标签压页 22 → 0；默认字号中文逐元素几何 0 处变化。唯一有意变化：德语默认字号下「已归档对话」导航行 36px → 40px（它的标签本来就要两行、原先画在行外）
- **发现但未修（已另记）**：设置导航列在默认字号下就超出自身盒子（1400×900 中文 `scrollHeight 745` vs `clientHeight 659`），最后一组与「应用更新」被画在列外并被对话框裁掉。修它要让该列滚动，会占 10px 滚动条宽并移动默认字号下的每一行，与本路「默认像素不变」的前提冲突；MiMo 用的是内层 `.sn-scroll`。**已修（第十八轮后，`753c0a7`）**：标题与搜索框放进不滚动的 `.nav-top`，分组与各行放进 `.nav-scroll`（照 MiMo：起始侧内缩不变、末行下 12、结尾侧无内边距、9px 细滚动条 `u-scrollbar-thin`）；选中行在打开、换页、搜索时滚进视野并留 8（MiMo 同规则，新 `lib/scroll-reveal.ts`）。实测中文默认：列内 `scrollHeight 814 → 659`，列表 558 高可滚到 725，「应用更新」滚到底后完整可见可点；各行位置与高度 0 变化，宽 218.4 → 220.9（去掉的结尾内边距）；德语 24 同样可滚到底、无裁切。smoke `smoke-round18-settings-nav.ts` 15 项，旧代码下 11 项失败。

## 第十四轮：网络与代理、本地化、打包与更新（2026-09-20）

三份只读审计：`scratchpad/round14-network.md`、`round14-locale.md`、`round14-packaging.md`。网络只有一处与 MiMo 不同（视频卡片）；模型、`/models`、MCP、网页工具两边都不走任何代理、都没有代理设置页，证书、超时、离线启动一致。用户决定：名称排序、表格图表坐标数字继续跟随界面语言（记为故意不同）；超出 MiMo 的不做（Electron fuses 加固、全局环境变量代理）。两路 worktree，合并后 13 项检查 + build 通过，smoke **4700 全过**；新增 `scripts/smoke-round14-packaging.ts`（含 Electron 下跑的 `smoke-round14-net-electron.ts`，需要 PATH 上有 openssl）/ `smoke-round14-locale.ts`。

**网络与打包（P14-*）**
- P14-1 视频卡片标题/封面与封面代理走 Chromium 网络（跟随系统代理 / PAC），新文件 `src/main/chromium-fetch.ts` 封装 `net.request`：手动重定向返回 3xx 与 `location`、不带也不存 Cookie、referer 保留；`net.fetch` 的 `redirect: "manual"` 实测会报 "Redirect was cancelled" 所以没用；b23.tv 短链逐跳跟随（`c1f3753`）
- P14-2 系统关机/注销引起的退出（`noteOsQuit()`，含恢复放弃时）关掉 `autoInstallOnAppQuit`，下载好的更新等下次正常退出再装（`85b9548`）
- P14-3 `scripts/runtimes.mjs` 删掉 Python 包里名为 `tests`/`test` 的文件夹（从不删顶层包、从不删包自己导入的），保留 `numpy.testing`、`pandas._testing`；省 19.9 MB；运行时布局版本 3→4，下次打包重建（`01593f6`）
- P14-4 先跑 electron-updater 自己的 `isUpdateSupported`（`minimumSystemVersion`），再跑 MCode 的规则（`8cc53a0`）
- P14-5 下载完成后把安装包经临时文件改名覆盖到更新缓存的 `installer.exe`，下次可差分下载（`5b9f473`）
- P14-6 macOS 不加载自动更新，「检查更新」说未配置更新源；去掉 mac `zip` 目标（`1b60eeb`）
- P14-7 `electron-builder.yml` 从 `node_modules` 排除 `*.map`、`*.ts/.mts/.cts`、非许可证 `*.md`，干跑确认只少 1393 个文件（6.9 MB）（`73a3eec`）
- P14-8 `allowScripts` 改为 `electron@41.7.2`（`40afdf5`）
- 未端到端验证：P14-2/4/5 没有真的打包安装（打包会升版本号）

**本地化（L14-*）**
- L14-1 未手选语言时界面语言与回复语言同源：main 的 `app.getLocale()` 传给后端并回答窗口；`--lang=fr-FR` 实测界面法语、回复要求法语（`c14eeff`）
- L14-2 `<html lang>` 跟随界面语言，`index.html` 初值 `zh-CN`（`b279ba7`）
- L14-3 `src/shared/locale.ts` 一份语言映射给窗口与后端共用：zh-HK/zh-MO/zh-Hant→zh-TW，no/nb/nn→nb（`1e7a592`）
- L14-4 快捷键页「全部重置」不再受 320px 限制、可折行、有悬停提示（`0fe9173`）
- L14-5 「N 分钟/小时/天前」改为按复数类别分键，`tn()` 移入 `i18n.ts`、删 `plural.ts`；阿拉伯语有单/双/复数（`067255f`）
- L14-6 从右到左时侧栏前进/后退箭头镜像，对话脊柱与预览卡用逻辑方向（`eaf3b7c`）
- L14-7 用量页日期本地化（列宽 44→64px），token 数与输入框共用 `compactTokens`；该函数照 MiMo 在所有语言都用小数点「39.2K」（L 路曾改成跟随语言的小数点，合并后改回，`bbd4218`）（`d019d86`）
- L14-8 一个日期格式器 `dateIn` / `calendarDate`，产物、侧栏、回复脚注、信息卡、版本历史、用量页都用它，泰语全应用佛历（`8a726fa`）
- 没改：Word 批注时间照 MiMo 用 ISO 公历；PPTX 里的 echarts 切换语言后要重载才变（MiMo 同）

**打包与安装实测（2026-09-20，本轮之后做的）**
- **P14-9 打包后打不开（本轮最重要的发现）**：0.2.8 装好后主进程一直卡住、窗口始终不出现。原因是 `turndown`（第十轮加的）在 devDependencies，vite 把它打进主进程，但它对 `@mixmark-io/domino` 是运行时 `require`，而 electron-builder 只拷 `dependencies` 及其依赖，所以安装包里没有这个模块。开发和探针都从仓库的 `node_modules` 解析得到，所以一直没暴露。修法：把 `@mixmark-io/domino` 写进 `dependencies`（`0ce7d95`），并加检查「out/main 里引用的每个外部模块都必须在 `dependencies` 闭包里」（`smoke-round14-packaging.ts` P14-9）。**教训：只有真正安装的包才能发现这类问题，打包后至少装一次再发。**
- 0.2.9（`e3997bd`）已装到 `D:\Apps\MCode`（注册表里记着该目录，原地升级），窗口正常、日志正常、真实配置目录 `%APPDATA%\mcode` 不变。
- **自动更新端到端实测通过**：本机 `127.0.0.1:8765` 起一个 generic 更新源（`latest.yml` 写成 0.2.10，文件仍是 0.2.9 安装包），用 `MCODE_UPDATE_URL` 启动安装版（不动用户设置）。结果：启动 5 秒后检查 → 差分下载（读两个 blockmap，实际下载 0 KB，基准是缓存里的 `installer.exe`）→ 校验通过 → 正常退出时静默安装 → 装完版本正确。装完不会自动重开（electron-updater 的退出时安装不带重启），MiMo 同。测试下载已清掉，`installer.exe`（差分基准）保留。
- 未实测：P14-2（关机时不装更新）只有 smoke 覆盖，没有真的关机验证。
- **注意 MCode 还没有更新服务器**：`electron-builder.yml` 的 `publish.url` 是故意不可解析的 `updates.invalid`，更新源要在设置里填或用 `MCODE_UPDATE_URL`，否则装了新版也不会自动更新。

## 第十三轮：键盘与焦点、多实例、大数据量（2026-09-20）

三份只读审计：`scratchpad/round13-keyboard.md`（17 条）、`round13-instances.md`（7 条）、`round13-scale.md`（6 条 + 小项）。用户决定：开发版用独立数据目录（记为故意不同）；其余照 MiMo；超出 MiMo 的两条（键盘打开的菜单关闭后焦点归还、看过的子代理对话记录释放）不做。四路 worktree，合并后 13 项检查 + build 通过，smoke **4632 全过**（连跑两次）；新增 `scripts/smoke-round13-keyboard.ts` / `-instances.ts` / `-scale.ts` / `-artifacts.ts`。

**键盘与焦点（K13-*）**
- K13-7 共享 Escape 帮助函数 `lib/escape-layer.ts`：一次 Escape 只关最上一层并标记已处理；PDF/Office 批注不再被上层的 Escape 清掉；InfoPanel 的 `escapeBlocked` 名单删除（`6c5fc0d`）
- K13-1 模型页断开/删除确认框上 Escape 只关确认框；设置改为按下时检查页面上是否还有别的层（`f3914cc`）
- K13-2 分支选择器搜索框里 Escape 能关（`93b61da`）；K13-4 搜索浮层焦点在结果行时 Escape 能关（`d3a5fce`）；K13-11 项目选择器子菜单 Escape 只关子菜单（`45871ed`）；K13-15 导入对话框 Escape 关闭（`da708df`）
- K13-3 「+」菜单键盘操作：打开聚焦首行，上下/Home/End，Enter/Space，右键头进技能，Escape 逐层（`c01dd63`）
- K13-5 有浮层/弹窗/预览盖住时，置顶、重命名、归档、侧聊等对话快捷键不生效（`5c92f90`）
- K13-6 Ctrl+N 先关菜单、搜索、命令面板、预览、设置（环境有未保存修改先问），需要回答的对话框打开时不生效（`586bca7`）
- K13-8 图片/视频/表格预览焦点限制在内、关闭归还，视频预览打开即取焦点（`bb0bfd7`）
- K13-9 `lib/keys.ts` `composing()`：8 个输入框输入法选字时的 Enter 不再触发；smoke 扫描所有带 Enter 的输入框（`3b07275`）
- K13-10 输入框菜单与首页选择器焦点离开即关，菜单行不再是 Tab 停靠点（`f883a67`）
- K13-12 设置下拉框 Space 打开、1 秒内首字母跳转（`lib/type-ahead.ts`）（`0ab91d4`）
- K13-14 点击对话空白处聚焦输入框（`264907f`）
- K13-17（合并后发现）新建任务从未把焦点放进首页输入框：首页有自己的 Composer（HomeHero），`focusComposer` 却只聚焦对话页那个；现在首页时聚焦 HomeHero 的，侧栏「新建任务」也聚焦（`311994a`，探针实测）

**多实例与窗口（I13-*）**
- I13-1 未打包运行默认数据目录 `<默认名>-dev`（Windows `%APPDATA%\MCode-dev`），显式指定仍优先；单实例锁仍只在打包版（`6a3e255`）
- I13-6 单实例锁在设好数据目录后立刻取，抢不到 `process.exit(0)`（`8eeec96`）
- I13-2 退出过程中再次启动：退出完成后 `app.relaunch` 一次（带链接参数），托盘/activate 退出期间无反应（`71156fc`、`9e27f7d`）
- I13-5 再次启动总是先激活窗口；页面加载或替换中收到的链接存着，就绪后经 `mcode:take-link` 取走（`recovery.ts` `readyWindow()`）（`b727844`）
- I13-4 启动时保存的位置整体放回屏幕（`work-area.ts` `startBounds` + `clampToWorkAreas`）（`8067aff`）
- I13-3 Windows `query-session-end` 直接 `app.quit()` 走完整清理，`session-end` 同步写窗口位置；N11-1 的错误注释已改。代价：别的程序取消关机时 MCode 已退出（`1bcdc22`）
- I13-7 Linux 最大化照 MiMo 铺满工作区并记为最大化（只有单元级 smoke）（`1a5358b`）

**大数据量（S13-*）**
- S13-1 `server/diff.ts` 自写 Myers O(ND)：去掉共同开头，超过 2000 行改动或 4000 万步退成整块替换；4 万行改一行 36.6 s/6.2 GB → 约 25 ms，7 万行约 39 ms（`68b4527`）
- S13-2 用量页读 `storage/usage-daily.json`（`session/usage-days.ts`，按会话→日→模型汇总，版本 1，损坏挪开重建）；1990 会话首建 5 s 一次，之后 7–250 ms，旧全量扫描 24 s（`54abc74`）
- S13-3 产物列表只重读变化的对话，每页 50 条带游标与分类计数，超过 8 个变化转后台构建；产物页与搜索浮层滚到底加载更多；列表 1000 会话/3000 文件 290–390 ms → 4–5 ms；分类规则移到 `shared/artifact-category.ts`；不再返回已不存在的文件（`2040a3f`、`10f1909`）
- S13-4 对话列表缓存就地更新（排序 `updated` 倒序、同时间按 id），冷读 32 并发；2000 会话删 100 个 100.7 s → 1.26 s（`9d04b93`、`e3a3b33`）
- S13-5 搜索启动检查跳过记录与消息目录都早于上次索引的对话（16 并发），索引追赶期间仍从索引回答并直接读最新 20 个未索引对话；启动后首批查询 3.6–4.6 s → 10–324 ms。已知缺口：外部原地改写的消息文件启动时察觉不到（`9238e7c`、`b84017c`、`51ef923`）
- S13-7 文件面板先 stat，超过 25 MB 只读开头 2 MB，超 2 GB 的媒体显示「过大」，文本仍显示截断的开头（`65f53e0`）

## 第十二轮：数据生命周期、失败提示、主进程契约（2026-09-20）

三份只读审计：`scratchpad/round12-lifecycle.md`（22 条）、`round12-failure-ux.md`（17 条）、`round12-ipc.md`（13 条）。用户决定：凭证照 MiMo 用系统安全存储加密；卸载的技能照 MiMo 7 天清理；可选改进「MiMo 有的都做」（只做了定时任务运行记录的原因码，降级提示、无模型指路、磁盘满文案 MiMo 没有，不做）。四路 worktree 分头做，合并后 13 项检查 + build 通过，smoke **4457 全过**；新增检查文件 `scripts/smoke-round12-credentials.ts` / `smoke-round12-lifecycle.ts` / `smoke-round12-c.ts` / `smoke-round12-ipc.ts`。窗口提示用一次性配置实测过（产物库重建、对话读不出、定时任务文件损坏、凭证读不出四条中文提示都出现）。

**凭证与设置（L12-1…6）**
- L12-1 `storage/models.json` 损坏：挪成 `.corrupt-<iso>`，模型列表从空开始，启动不再失败（`6bbe519`）
- L12-2 `credentials.json` 读不出：挪到 `credentials.json.corrupt-<iso>`，挪不动就拒绝保存 Key（`error.credentialsInvalid`）；`config.get` 带 `credentialsUnreadable`，窗口提示；模型工具不能读 `credentials.json.*`（`8ad995b`，文件处理在 `src/server/credential-file.ts`）
- L12-3 **凭证加密**：Key 与 OAuth 令牌逐条用 Electron `safeStorage` 加密（base64）。main 注入加密器（`src/main/safe-storage.ts`），纯 node 跑时没有加密器、保持明文。一次性迁移 `credentials-sealed-r12`：写加密版→读回比对→再替换明文，失败保留明文下次重试。旧明文照读。别的用户/机器加密的文件、或无安全存储时读到加密文件，按读不出处理（走 L12-2）。系统无安全存储且确有保存内容时明文保存并提示 `error.credentialsPlaintext`（`750cc1c`）。已知取舍：Linux 密钥环暂未解锁时加密文件会被挪开，需要手动改回名字
- L12-4 所有启动 `migrate*` 遇到更新版本写的 config 直接返回（`3e4c5e0`）
- L12-5 设置校验只改内存副本，不认识的取值原样留在文件里，直到用户改该项（`517e84f`；`smoke-round9-settings.ts` 相应改了一条）
- L12-6 `Storage.drain()` / `Config.drain()`，`close()` 末尾依次 `permissions.flush()`、config、storage，仍在 5 秒上限内（`b2c6d40`）

**其余存储（L12-7…17）**
- L12-7 `artifacts.db` 真损坏时连同 -wal/-shm/-journal 挪开重建，`reconcile()` 补回，窗口提示 `error.artifactsRecreated`；损坏判断与挪开抽到 `sql-worker.ts` 与 search.db 共用（`dc017de`）
- L12-8 `.mcode/scheduled_tasks.json` 读不出挪开，挪不动拒绝写；解析不了的 cron 串写回时保留、不触发（`25ebb66`）
- L12-9 `imported.json` 损坏不再导致重复导入：用 `SessionInfo.imported` 去重，新增 `mtime`（`a70577f`）
- L12-10 `mcp-auth.json` 解析失败挪开；读不了时 `mutate()` 拒绝（`error.mcpAuthUnreadable`）（`c266065`）
- L12-11 读不出的 `info.json`：原地保留、记日志一次，checkpoint 清理与 artifacts reconcile 当作仍在用，窗口提示 `error.sessionsUnreadable`（`e6bf337`）
- L12-12 `skill-trash` 启动时删掉超过 7 天的（按名字开头的时间戳）（`c75b76c`）
- L12-13 撤销仓库启动约 1 分钟后、之后每小时 `git repack -a -d --keep-unreachable -q`，从不 prune，持有该仓库的 git 锁（`abb278e`）
- L12-14 `automations.json` 损坏启动时窗口提示 `error.automationsInvalid`（`a1f1f81`）
- L12-15 search.db schema 不匹配直接删掉重建；启动时清理超过 30 天的 `*.corrupt-*`，每份文档留最新一份（`f2b25a5`）
- L12-16 记忆 project-id 原子写（临时文件 + 硬链接），无效旧文件先另存（`b1c1142`）
- L12-17 定时任务运行记录带 MiMo 的 `errorCode`（`target-missing` / `project-unavailable` / `target-busy` / `schedule-changed` / `app_interrupted` / `empty-prompt` / `model-unavailable`），只改数据（`b95b894`）
- 窗口提示走新请求 `storage.problems`（`src/server/store-notices.ts`），每次启动每个 code 只说一次。注意提示最多同时显示 3 条（`lib/toast.ts` `LIMIT`），四个文件同时损坏时最早那条会被挤掉

**失败提示与空状态（C12-1…10）**
- C12-1 重试倒计时 18 种语言不再显示花括号；i18ncheck 拒绝任何 `{{`（`bb69baa`）
- C12-2 断线时只让已发出的请求失败，未发出的等重连（最多 30 秒），不会先报失败再发出；错误说本地服务（`error.backendLost`）（`8944bd3`）
- C12-3 启动后断线保留对话界面，只升级重连提示（`error.connectionStillDown`）；顺带修了离线计时每次重连都被重置、从未到点的旧 bug；`boot.unreachable` 删除（`7b0e3f1`、`c21462b`）
- C12-4 发送/子任务失败改成「请求失败」提示并保留草稿，`app.error` 只给启动失败；失败回合横幅读 `turnError`（`b0cc90a`）
- C12-5 消息搜索失败显示错误行加重试（`searchOverlay.messageError`）（`403bc8b`）
- C12-6 插件页列表失败显示失败行加重试（`plugins.listUnavailable`），刷新失败说「刷新失败：…」且不清空技能（`b429fce`、`ed7ad6d`）
- C12-7 表格视图离开时没写进去的编辑提示 `office.saveFailed`（`5ec2e0d`）
- C12-8 侧边对话历史加载失败：加载中→`subagentDetail.error`→每 2 秒重试；删了 `loadSubagent`（`5c92051`）
- C12-9 三句英文改成表内文案：限速重试行 `error.rateLimited`、不能继续用 `composer.reviewRestricted`、PDF 读失败 `rp.files.errCannotRead`（`17a0afe`）
- C12-10 读出来但没有可显示内容的对话显示「这个对话还没有消息」（`stream.emptyConvo`，MCode 自己的措辞）；全新空会话仍是欢迎页（`428059a`）

**主进程契约（D12-1…7）**
- D12-1 删掉没人调用的 `browserClose` 与 `mcode:browser-close`；wiringcheck 新规则：preload 暴露的每个方法都必须在渲染端有调用（`75bd186`）
- D12-2 `mcode:menu-labels` 只收纯对象里的字符串（`9d64d40`）
- D12-3 `clipboard-write` / `browser-bounds` / `titlebar-mode`（及 `browser-open` 的框）形状不对就忽略，`src/main/ipc-input.ts`（`1525bc3`）
- D12-4 `edit` / `view` / `window` / `browser-act` 不认识的动作什么也不做（`4c17a48`）
- D12-5 Office 通道检查抛错时回答自己的拒绝形状（`guarded()`）（`68397b4`）
- D12-6 `pick-directory` 标题只收文本、开关只认 `=== true`（`d47a3d9`）
- D12-7 `src/main/atomic-write.ts` `writeAtomicSync`：`boot-prefs.json` / `display-server.json` / `window.json` 走临时文件+fsync+改名（`c1ce049`）。收尾已做：`updates/update-transaction.json` 经 `fileTransactionStore` 走 `writeAtomicSync`（`399382f`）；`composer-input.ts` 也走 `writeAtomicSync`（`5d0db97`），只有关页那次 flush 做 fsync，打字时 300 ms 一次的保存不做（本机 NVMe 16 MB：无 fsync 约 8 ms，有 fsync 约 12 ms）；启动时 `sweepWriterTemps` 清三个目录里本写入者格式、进程已不在（或超过一小时）的 `*.<pid>.<n>.tmp`，含 composer-input 旧的 `.<pid>.tmp`（`bdcc62b`）。检查在 `scripts/smoke-atomic-leftovers.ts`。MiMo 26.920：更新记录走临时文件+改名、无 fsync；composer-input 直接覆盖写；不清残留临时文件

## 第十一轮：并发与长期运行（2026-09-18）

只读审计在 `scratchpad/round11-concurrency.md`（N11-1…N11-41，高 7）。**全部完成并验证，已合并入 `v2.0`（合并提交 `19c3a7e`）。**十一条 N11 提交加 N11-12，合并后 typecheck / build 通过，smoke **4168 全过**（新增第十一轮检查文件 `scripts/smoke-round11.ts`）。

**N11-12：SQLite 进 worker 线程（本轮最后一项）**
- 新文件 `src/server/sql-worker.ts`：`WORKER_SOURCE` / `SqlDatabase` / `SqlError`，每个库一个 worker 线程；MiMo 的四条 pragma（`busy_timeout = 5000` / `journal_mode = WAL` / `synchronous = NORMAL` / `temp_store = MEMORY`）、`SQL_REQUEST_TIMEOUT_MS = 15_000`、事务与回滚都在工作线程里跑。
- 转换：`history/database.ts`、`history/index.ts`、`history/service.ts`、`artifact/store.ts`、`memory/index.ts`、`search.ts`、`tool/history.ts`、`index.ts`、`handlers.ts`、`session/context.ts`（数据库调用全部变异步，调用点全部 await）。
- 收尾竞态：`HistoryIndex` 新增 `starting`，`start()` 拆成 `start()` / `begin()`，`close()` 依次等 `starting`、`flushed`、`writing`——否则后台 VACUUM / reconcile 还在飞时关库会抛未处理异常。
- smoke 新增 9 条：pragma 集合、超时、两个库都从 worker 打开、事务护住语句、pragma 到达文件、写入报 changes、事务整体落地与回滚、**一条慢语句不占调用线程**（四百万次递归查询跑在 worker 上时 1ms 定时器跳 480 次；同一查询放主线程实测只跳 0 次）。改坏 pragma 后对应检查确实报失败。

**其余 N11 提交**：退出、运行队列与通知说法（`b104b09`）；阴影仓库的锁、超时与半删除的存储（`957039c`）；界面搜索走索引、列表只读一次（`e6bc517`）；消息改逐 part 递给正在绘制它的窗口（`48421eb`）；git 写操作轮流、恢复不打扰快照（`62633a3`）；等待服务商时对用户开放、限流最多 30 分钟带倒计时（`decd517`）；子智能体闸门、更省的流式保存、删除对话后的残留（`bd0efdc`）；抽屉与面板终端各自拥有 pty（`28c1f67`）；MCP 在多个会话下（`d1fc2b2`）；小尾巴（`6fe3dc5`）；以及 N11-12（`c206feb`）。

## 第十一轮：输入框全链路（2026-09-18）

只读审计在 `scratchpad/round11-composer.md`（C11-1…C11-52，分卷稿 `r11-part-A.md`…`r11-part-D.md`）。除上面「故意不同」里列的十一项外全部按 MiMo 做了；当时没做的两项（C11-15、C11-13）已于 2026-09-18 补齐（见本节末尾）。

**附件怎么到模型那里（C11-30/31/32/33/24，用户定「完全照 MiMo」）**
- `lib/attach.ts`：只要文件在磁盘上就一律 `{path: 绝对路径, byPath: true}`；8 MiB 以内的图片 / 视频另外读一份 base64**只给缩略图**。以前「够小能画缩略图」被当成「不用留路径」，加号菜单选的、拖进来的图片会丢路径、整份 base64 进消息、还写进草稿文件（正好抵消 L6）。
- 只有图片进消息。文本、Office、二进制（音频 / 视频 / 压缩包 / `.svg`）全部只给绝对路径，走 `session/context.ts` 的三段 `[Attachments]` 块（文本一段 / Office 一段带每种格式的库名 / 二进制一段），每段都以同一句「按给定绝对路径操作，不要搜索、不要 glob、不要列目录」收尾。
- 文本附件不再内联、不再伪装成「read 已替你调过」（一个 300 KB 的日志以前只到模型手里 50 KB）；PDF / 音频 / 视频的字节不再送出。
- 工具结果里的附件规则不变：`read` 当时拿到的字节仍原样随结果走。`attachmentParts(…, source)` 区分两者，`session/attachments.ts` 的 loader 对用户附件只读图片。
- 四类扩展名表搬到 `src/shared/attachment-kind.ts`（渲染层和服务端共用）。文本表从 45 个扩展名扩到约 130（`.rst .cjs .gradle .tf` 之类），空文本文件也算提及。

**@ 提及恢复后端搜索（C11-38/39/40/41/42，用户定回滚 L7）**
- 第五轮的 L7 基于「MiMo 是本地过滤」的误判；26.912 和 26.914 都是主进程 `searchFiles`。现在查询非空就发 `file.search`（150ms 去抖、只认最后一次答复、50 条）。
- `handlers.ts` 新增 `rankFileHit()`：不含 `/` 时只看文件名（全等 1000 / 前缀 900 / 包含 800，再减 `min(路径长,200)×0.02`）；含 `/` 时基准 500、按段在目录链上依次匹配，末段落在文件名上 +200/+150/+100，中间段 +40/+30/+20，任一段不匹配即淘汰；同分按路径升序。
- 忽略名单改用 MiMo 那 22 项（`TREE_IGNORED`），隐藏文件可搜到；结果里没有目录。
- 补 `composer.at.searchFailed`、`composer.at.truncated` 两键 × 18 张表；删掉 MiMo 从不渲染的 `composer.at.enterFolder` 和用它的按钮（`›` 改回不可点的字形，整行点击进入）；「引用」胶囊只在 hover 有底色；文件名不收缩、目录收缩；`referenceFolder` 写 `@rel ` 不再多一个 `/`。

**按键、菜单、草稿（C11-1/2/3/5/6/10/11/13/14）**
- 「发送消息」快捷键现在真的生效：绑定能解析成 Enter 系组合就精确匹配并关掉 Ctrl+Enter 换行，否则维持默认。输入框自己处理过的键一律 `stopPropagation()`（以前 Ctrl+Enter 绑成发送会先插换行再把它发出去）。
- shell 模式的 Escape 进了 `onKeydown`、排在输入法守卫之后（中文组字时关候选窗不再退出 shell 模式）。
- 菜单开着时 Enter 不看修饰键，Ctrl+Enter 选行而不是插换行。
- 程序化改写（调历史、整块删提及、Ctrl+Enter 换行、语音填充、选技能）会关掉两个菜单，等同 MiMo 的 `wn()`。
- 加 ResizeObserver：宽度变了 60ms 后重测高度，手动高度同时重新 clamp；宽度 ≤28px 时跳过测量。
- `focus()` 先 `focus({preventScroll:true})` 再把光标放到末尾；切会话恢复草稿时把光标真的写进 DOM；语音填充前先把焦点从麦克风按钮拿回输入框。

**粘贴与拖放（C11-16/17/18/19/22/25/26/27/28/29/34）**
- 超大粘贴写盘失败时把原文插回输入框（替换选区），不再因为超过 50MB 就把内容丢掉。
- 粘贴和拖放都读 `text/uri-list`，解析出的路径先经新 IPC `mcode:describe-files` 过滤存在性，再走同一套「提及 / 附件」拆分；拖放不再从 `text/plain` 里抠 `file:`。
- 新 IPC `mcode:clipboard-has-image`（只回布尔）作为剪贴板图片判定的第一档；粘贴图片落盘去掉 25MB 上限。
- 拖入纯文本交还给浏览器（能拖字进框、能在框内挪选区）；窗口提示层与输入框光环共用 `acceptsDrop()`；拖到输入框上时只亮光环；提示层不再盖住右侧信息面板那一列；`.box.dropping` 补边框色并保住原阴影；系统吞掉拖动时下一次按下就清理（窗口和输入框两处）。
- `attach.tooLarge` 的数字改成从常量渲染（`{size}`，18 张表），以前写死 8 MB 而实际是 50 MB。

**斜杠、发送、芯片（C11-43/44/45/47/49）**
- 技能芯片显示技能的本地化名（`localizations` 随命令下发，`commandTitle()`）。
- 会话自带的 `/compact` 胜过同名项目命令；首页隐藏名为 `compact` 的项目命令。
- 选技能不再多吞一个空格；来源标签回到三种，删 `composer.slashBuiltinSkill`。
- 只有附件没有文字时正文写成一句本地化的「（见附件）」（新键 `composer.seeAttachments` × 18 张表；MiMo 是硬编码中文，MCode 按 18 张表翻）。

**附件胶囊与语音（C11-35/36/51/52/37）**
- 胶囊换成文件树那套带色文件页图标（`--ft-*` 从 RpFiles 的 scoped 块搬到 `base.css`，两处共用）；删除标记改成 `✕` 字符 13px；`filetype.ts` 的文字徽标只剩命令面板在用。
- 语音去掉 60 秒上限，改成边说边分段：1.2s 静音切一段，每段单独转写、按顺序落到当时的输入框状态（`lib/voice.ts` 的 `onSegment`）。
- 录音改成全应用一份 + `voiceOwner`：三个输入框同时挂载，以前各自 `new VoiceRecorder()` 能开出两路 `getUserMedia`；现在换一个框按麦克风会先停掉上一个。
- MiMo 的 `visionAutoSwitch` 是死文案（19 张表里有、全包无调用），不照抄；改为模型读不了图片时在界面上直说（新键 `attach.noImageInput` × 18 张表）。

**C11-15 / C11-13（2026-09-18 补齐，用户「全干」）**
- **C11-15 已接上**：协议 `SessionInfo.reviewRestricted?: boolean`（缺省即未限制，旧记录照旧）；请求 `session.reviewRestricted {sessionID, restricted}`，应答 `{ session: SessionInfo }`；`SessionStore.setReviewRestricted()` 不动 `updated`（照 `setAccess`，选状态不算活动），解除时删掉字段而不写 `false`；`handlers.ts` 的 `session.prompt` 在调 `runner.prompt` 之前先查，限制住就报「this conversation can't be continued」；Composer 的 `restrictedHere` 接管占位符（排在 compaction 之后、模式行之前，照 MiMo 的顺序）与 `:disabled`（textarea 和发送钮），`submit()` 里再一道退路。文案 `composer.reviewRestricted` × 18 张表：简体/繁体/英/日/韩/俄/德/法/西/葡/丹/挚麦/波/土/阿/阿拉伯用 MiMo 原文（`reviewRestricted:"…"`，逐条从 MiMo composer 分包取出），bs / th / uk 自译。**MCode 没有审核后端，所以新增一个可触发入口**（用户选的完整机制 + 可触发）：会话菜单里的 `row.reviewRestricted`（列表行与头部菜单都有，`menu.restrictConversation` / `menu.allowContinue` × 18），再报请求开关。新 smoke 检查 8 条（初始未限制、标记落盘与读回、不算活动、解除删字段、旧会话不限制、请求与应答在线、服务端拒绝）；改坏 `setReviewRestricted` 或拆掉报拒都会报失败。
- **C11-13 已补齐**：`Composer` 的 `onMounted` 在 `text.value` 非空时`void nextTick(focus)`——MiMo 恢复草稿后真的把键盘拿过去，光标置尾；MCode 的三个输入框不同时在屏（首页与会话、侧边与浮动各自随视图挂载），空草稿不抢键盘。新 smoke 检查 3 条（有草稿就聚焦、空草稿不聚焦、聚焦把光标置尾）；删掉那一行会报失败。
注："没做的两项"从此清空，下方那段「C11-13 的 `focus()` 那一半没有探针」仍然成立（DOM 焦点在探针窗口里测不到），所以新增的检查放在 smoke 里而不是探针里。

探针 `scratchpad/mcode-round11-composer.cjs`（12 段，截图 4 张）。每段都在故意改坏的构建上跑过一次并给出不同读数（`mcode-round11-composer.broken*.json`）。**C11-13 的 `focus()` 那一半没有探针**：探针窗口即使被 OS 激活，`document.activeElement` 也落不到 textarea 上，任何读数都只是 DOM 原来的位置——宁可不写，也不留一条不会失败的检查。

## 本会话完成的轮次（新到旧）

| 提交 | 内容 |
| --- | --- |
| `0c493b2` | 设置「环境」页按 MiMo 重做：项目列表（添加 / 移除 / 配置显示名）+ 所有项目的工作树（分支、项目标签、数量、刷新）；随后修了工作树名称被路径挤掉的问题 |
| `ea62985` | 首页字标点击跳动 |
| `6c32812` | 撤销首页可换图标按钮 |
| `ec4134c` | 会话导航条（每轮一个刻度、悬停预览、点击跳转）+ 导航条音效开关 |
| `00f31f3` | 产物页：打开预览 / 下载（定位文件）/ 进入对话，预览弹窗 |
| `cd73a7a` | 插件页：刷新列表、状态 + 类型筛选，已安装里列出技能 |
| `fb06971` | 侧栏底部菜单：设置、退出应用 |
| `43696f3` / `0984a62` | 侧栏内容下移 4px；顶部按钮靠左 |
| `30c3a0e` | 长任务完成提示音（超过 1 分钟、五种音效）+ 默认新建项目位置 |

更早的提交见 `git log`。

## 本轮：环境页与工作树

- `src/renderer/src/components/SettingsDialog.vue`：`environment` 一节。
  - 项目 = 会话所归的项目（排除已归档、无项目任务、已关闭的项目），和侧栏同一套规则。**第十轮（G10-8）起**：会话有「移动至项目」标签就按标签；否则会话目录本身是已列出的项目就归它；否则照 MiMo 归到该目录所属的主仓库（`git.repoRoots`，`rev-parse --git-common-dir` 的上一级），所以链接工作树、仓库子目录里的对话都在主仓库项目下；目录已不存在的会话不归任何项目（进「最近」），目录已不存在的项目不在列表里显示（配置里仍保留）。
  - 「添加项目」：选目录；若曾关闭就重新打开；没有会话就在那里新建一个（MCode 的项目靠会话存在）。
  - 「移除项目」：确认后加入 `closedProjects`，会话保留。
  - 「+」配置：返回按钮、本地环境卡片、名称输入框，保存到 `projectNames`（和侧栏重命名是同一个字段）。
  - 工作树：对每个项目调 `workspace.list`，去掉主工作树、按路径去重；每行名称、分支标签、「项目：名称」标签（名称绘制时实时查，改名立刻生效）、路径；有数量行、刷新按钮和提示、空状态、加载中。
- 删掉了不再使用的文案键：`set.project`、`set.noProject`、`set.mainTree`、`set.noWorktrees`。

## 怎么跑、怎么验

```bash
npm run dev          # 开发版（先结束残留的 node_modules/electron/dist/electron.exe）
npm run typecheck
npm run build
npm run smoke        # 当前 6143 条（2026-09-22）
npm run i18ncheck    # 18 种语言表键一致
npm run themecheck   # 重新生成 tokens.css 并逐字节比对；也拦物理方向的 CSS
npm run wiringcheck  # 配置字段要在设置之外被读到、事件要有监听
```

其余检查：mcpcheck、mdcheck、sessioncheck、snapshotcheck、sandboxcheck、toolcheck、promptcheck、shellcheck、providercheck。

界面改动都用「探针」验证：一个独立的 `.cjs`，用 `node_modules/electron/dist/electron.exe` 加载 `out/main/index.js`，在临时 userData 里只复制 `config.json`、`session/`、`models.json`，不复制任何凭据。探针脚本放在会话的 scratchpad 里，**不在仓库中**；需要时照着下面的套路重写。

每条新检查都要证明「能失败」：故意改坏代码 → 探针报失败 → 恢复并重新构建。

## 约定与坑

- 回复用中文；代码、标识符、注释用英文。
- 不能新增 CSS token 名（themecheck 会重新生成 tokens.css）；CSS 用逻辑属性（`padding-inline-start` 而不是 `padding-left`）。
- 字号一律写成 `calc(Npx * var(--ui-font-scale, 1))`，代码字号用 `--code-font-scale`。
- 新增文案要进全部 18 张语言表（zhCN zhTW en ar bs da de es fr ja ko nb pl ptBR ru th tr uk）；用脚本按锚点插入，保留 CRLF。
- 读 MiMo：只读方式解 `C:/Users/Wyatt/AppData/Local/Programs/Xiaomi MiMo/resources/app.asar`（用仓库里的 `@electron/asar`，内部路径要用反斜杠拼接）。只看行为和尺寸，**不复制** MiMo 的代码、文案、图标、插画和品牌。
- 安全：不读、不打印凭据值；不替用户登录；不在用户的 MiMo 里发消息、改设置、按麦克风或铃铛；未经同意不关用户的应用。
- 探针：
  - 不要 `moveTop()` 窗口；用 `setBackgroundThrottling(false)`。**截图前要 `win.show()`**：只 `showInactive()` 时 `capturePage` 可能拿到旧画面（2026-09-21 一张「AI 生成」截图停在首页，数据却是对话里的）。
  - 读数前先记 `win.isVisible()` 和 `document.visibilityState`：窗口被外部最小化或隐藏时 rAF 不跑，停靠、跟随这类依赖帧的测量全部作废（第十九轮 C 路有几轮因此偏到 268–314）。不是 MCode 自己最小化的（已用 `BrowserWindow.prototype.minimize` 钩子排除），多半是用户同时在用电脑。
  - 合成的 `mouseDown`/`mouseMove` 拖拽在探针里选不中文字（`getSelection()` 为空），要测选区就用 `Range` 直接放选区。
  - 有活动终端时不要直接退出探针（会弹 conpty 断言对话框）。
  - 打开外部程序、剪贴板、选目录的 IPC（`mcode:open-file`、`mcode:reveal-file`、`mcode:clipboard-write`、`mcode:pick-directory`、`mcode:quit`）先 `removeHandler` 再换成记录器。
  - 背景窗口里 `animation.finished` 可能一直不结束——产品代码里等动画都要配一个超时。
  - 打开弹窗后第一次 `capturePage` 可能是旧画面，等约 2 秒并 `invalidate()` 再截。
  - ContextMenu 当前选中项是 `.item.ticked`；侧栏底部「设置」行现在先打开菜单，再点菜单里的「设置」。
- 开发版重启：先停旧的 `npm run dev` 任务，再结束残留 electron 进程，否则两个开发实例抢同一份配置（会报缓存无法创建）。第十三轮起未打包运行默认用独立数据目录 `%APPDATA%\MCode-dev`（I13-1），不再和安装版共用 `%APPDATA%\MCode`；探针用 `app.setPath("userData")` 或 `--user-data-dir` 仍然优先。
- 已知不稳定检查：第五轮计划模式一节（`smoke-round5.ts`「plan mode writes one file…」）偶发 6 条一起失败，2026-09-20 四次全量里出现一次；疑似后台请求（标题生成）插进来，使 `e.bodies.at(-1)` 不是本轮请求。重跑即过，未修。第十四轮 P 路还见过一次第七轮「provider receives the long bash description」两条失败（那次请求里没有工具列表），重跑即过，疑同类。
- 版本号只在打包时递增，不要手改。WSL 永久不在范围内。
- 本机 TCP 动态端口从 **1024** 起（`netsh int ipv4 show dynamicport tcp`），向系统要端口 0 可能拿到浏览器 / fetch 拒绝的端口（5060、6000、6666 等）。应用里后端 socket 走 `server/free-port.ts` 的 `windowSafePort`，预览服务在 `bind()` 里换掉这类端口，列表在 `shared/blocked-ports.ts`；检查脚本的服务器由 `scripts/safe-listen.ts` 挪开（`smoke.ts`、`session-check.ts` 第一个 import，`smoke-blocked-ports.ts` 验证）。新写的检查脚本入口也要先 import 它。
- 合并多路时：各路都删同一批代码（如导入弹窗、对话文件），冲突两侧都要丢掉，不能 keep-both；合并后还要 grep 检查脚本里对已删符号的引用（第十九轮 E1/E11、`openText` 就是这样漏的）。
- 用 Python 改仓库文件一律 `open(..., newline="")` 读写，否则 Windows 下会把 LF 写成 CRLF。
- 对用户仓库跑 git 一律用 `server/git-process.ts` 的 `runGit`（固定环境、路径不加引号、超时、隐藏窗口）；解析路径用 `-z` 输出和 `parsePorcelain`。只有影子快照仓库（`session/snapshot.ts`）自己起进程。smoke-round10-git 会扫描 `src/server`、`src/main` 里没带 `windowsHide` 的 git 进程。

## 待办：用户截图逐项对照（2026-09-13，优先于下方审计清单）

用户并排截了 MiMo 和 MCode 的同一界面，要求逐个对照、1:1 复刻。每项动手前先读 MiMo 包核实细节；账号相关（头像 Biscuit、个人资料、计费）不在范围内。

- [x] A1 斜杠菜单（已完成；**第十轮更正**：MiMo 引擎自带的 /init /review /dream /distill /rebuild 也会列出，见第十轮记忆一路；原记录：只列项目命令 / MCP / 技能，`/name` 胶囊 + 说明 + 右侧来源标签；对话中首行是 `/compact`，选中直接压缩；浮层在输入框上方 8px 内缩、6px 间距、12px 圆角；应用命令不再出现在斜杠菜单里，Composer 和 HomeHero 的 `commands` 属性已删除，命令面板保留。注意 `prompt.*` 键是参考实现的译文，i18ncheck 会拦改值，MCode 自己的标签用 `composer.slash*` 键。探针 `mcode-slash-menu.cjs`）原始差异：MiMo 在输入框**上方**独立浮层，标题「命令」，每行 `/name` 胶囊 + 灰色说明 + 右侧「命令 / 技能」标签，内容是项目命令和技能；MCode 在输入框卡片内，列的是应用命令（新建会话、切换模型…），快捷键被截成「Ct…」
- [x] A2 权限菜单（已完成：芯片和菜单行都是 手 / 笔 / 带警示的盾 图标；行 = 图标 + 名称 + 右侧对勾（只在选中行显示），32px 行高、210 宽、12px 圆角；说明文字移到行右侧的换行提示（`v-tip` 新增 `wrap`，base.css `.app-tip.wrap`）；菜单行叫「完全访问权限」（新键 `composer.access.fullItem`），芯片仍是橙色「完全访问」；首页永远在芯片下方展开，对话里向下展开、离窗口底部不足 60px 时翻到上方，同 MiMo 的 avoidCollisions 只给 dock 变体。探针 `mcode-access-menu.cjs`，12 项）原始差异：MiMo 三项带图标（手 / 笔 / 警示）、对勾在右、无说明、在按钮**下方**展开；选中完全访问时胶囊是橙色「完全访问」；MCode 有说明文字、对勾在左、向上展开
- [x] A3 首页项目选择（已完成：新组件 `ProjectPicker.vue` 替换 SelectMenu。输入框放进一个 20px 圆角的深色托盘，下面 40px 条里是项目芯片（有项目时带文件夹图标，没有时显示「进入项目工作」）。菜单固定在芯片下方、不翻转，宽 260–440。依次是：搜索框（打开即聚焦）、最近 3 个项目（「显示更多」展开，超过 3 行滚动并在底部渐隐）、同名项目标出能区分它们的最短父目录、选中项右侧对勾、分隔线、「添加新项目 ›」右侧子菜单（创建空白项目 / 使用现有文件夹）、「× 不使用项目」（弹提示「已不使用项目」）。创建空白项目是新功能：用 RenameDialog 输入名称，服务端新请求 `project.createBlank` 在默认项目位置下建空文件夹，重名时加 (2)，Windows 不接受的字符会被清理；冒烟测试新增 3 项，共 337。未做：MiMo 弹窗里可以改位置，MCode 仍在设置里改默认项目位置；git 分支芯片也还没做。探针 `mcode-home-picker.cjs`，12 项）原始差异：MiMo「进入项目工作」挂在输入框下方的附着条里，菜单有「搜索项目」框、文件夹图标、分隔线、「+ 添加新项目 ›」子菜单、「× 不使用项目」；MCode 是文件夹 + 项目名的普通下拉
- [x] A4 模型菜单（已完成：菜单在芯片下方、与芯片右对齐，对话里离底部不足 60px 时翻到上方（与权限菜单共用 `menuUp`）；去掉搜索框。行依次是：Smart（带说明）、分隔线、第一个已连接提供商的模型（`ModelMenuRow.vue`：20px 厂商标记 + 名称 + 右侧对勾；有推理强度的带 › 并在旁边打开「默认 / 各级别」子菜单，选中即同时设置模型和强度）、「更多模型 ›」（其余提供商按厂商分组，子菜单在旁边，固定定位，空间不够时翻到另一侧，见 `lib/submenu.ts`）、分隔线、「配置自定义模型」（打开设置的模型页，`open-settings` 带 `"models"`）。当前强度显示在模型芯片名称后，单独的强度芯片已删除；首页和侧边聊天不提供强度子菜单。已删除 `ManageModelsDialog.vue` 和只被它与旧菜单使用的 `ModelTooltip.vue`，`manage-models` 事件链也一并删除。未做：MiMo 的价格倍率（0.4x / 1.0x）是它自家模型的计价，MCode 没有对应数据，不编造。探针 `mcode-model-menu.cjs`，12 项）原始差异：MiMo 在按钮下方展开、每行有模型图标、Smart 带说明、模型带倍率（0.4x / 1.0x）、对勾在右、底部「配置自定义模型」（打开设置的模型页）；MCode 向上展开、有搜索框和厂商分组、对勾在左、「管理模型」打开单独弹窗
- [x] A5 （已完成：导航按 MiMo 分成 个人（常规 / 使用情况 / 外观 / 配置 / 模型 / 提供商 / 服务器 / 个性化 / 键盘快捷键）、编码（环境）、已归档（已归档对话）、关于（应用更新）四组；「提供商」「服务器」是 MCode 自有页，放在「模型」后面。「外观」从常规页拆成独立页（主题、配色、应用图标、指针、动效、字号字体、差异标记、托盘、平滑、换行）。每页标题与导航名一致，搜索会连同分组标题一起收窄。新键 `set.nav.*`、`set.group.*`；`set.general` / `set.archive` / `set.groupDesktop` / `set.groupServer` 是参考镜像键，值不改保留；删除了不再使用的 MCode 自有键 `set.groupProject` / `set.keyboard` / `set.usage` / `set.files` / `set.updates`。个人资料、使用情况和计费里的计费部分按用户决定不做。探针 `mcode-settings-nav.cjs`，5 项）原始：设置导航：MiMo 分组 个人（常规、个人资料、使用情况和计费、外观、配置、模型、个性化、键盘快捷键）/ 编码（环境）/ 已归档（已归档对话）/ 关于（应用更新）；MCode 是 桌面 / 项目 / 服务器 / 关于，名称和顺序都不同（MCode 自有的服务器、提供商、用量、文件要决定放哪）
- [x] A6 （已完成：模型页按 MiMo 排成 标题 + 说明 → 快速添加（每个未连接厂商一个 34px 胶囊，最后是「自定义」，点开连接对话框 / 自定义表单）→ 已添加（已连接和自定义提供商，保留刷新 / 断开 / 移除和端点编辑，每个已连接提供商下面直接列出它的模型开关）→ Smart → 配置文件（本地配置文件 config.json 的路径，打开 / 在文件夹中显示）。原「提供商」页并入模型页，导航和 `Section` 类型里的 providers 已删除；A5 里「个人」组因此不再有「提供商」。模型页搜索框、`available` computed、`.search-in` / `.pmark` 样式、`set.providersNote` / `model.manageSub` 键已删除（英文表里 `set.providersNote` 是两行写法，脚本按行删时会漏，已手动删）。从模型菜单「配置自定义模型」进来时路径会自动加载。未做：MiMo 的「编辑 / 复制」是针对它自己的自定义模型文件，MCode 的提供商没有对应的复制语义。探针 `mcode-settings-models.cjs`，9 项）原始：设置「模型」页：MiMo 有「快速添加」厂商按钮、「已添加」卡片、「配置文件」路径卡片
- [x] A7 （已完成：新组件 `SearchOverlay.vue`，侧栏放大镜和 Ctrl+K 打开（MiMo 快捷键表里 mod+k 就是「搜索」）。模糊背景浮层，560 宽、14px 圆角的卡片在 13vh 处；搜索栏占位「搜索对话、项目、产物」。空输入列出「近期对话」（最多 50 条，置顶的在前，右侧是项目名）；有输入时按「对话 / 项目 / 产物」分组，最佳匹配的组在前，命中文字用暖色标出；对话还会匹配消息内容，标题下显示命中那一行。消息搜索是服务端新请求 `search.messages`（`src/server/search.ts`：只读提问和回答正文，不读推理和工具输出，每个对话一条，排除归档和侧边聊天），冒烟新增 5 项，共 342。上下键 + 回车打开，Esc 关闭；选项目回到首页并选中该项目，选产物打开它所在的对话。新键 `searchOverlay.*`（`search.placeholder` 等是参考镜像键不能改）。原来 Ctrl+K 打开的命令面板「all」模式现在没有入口了，文件 / 会话 / 项目 / 消息几个模式仍在用，下一轮评估是否删除「all」和命令行。探针 `mcode-search.cjs`，7 项；注意后台窗口里入场动画会停在第一帧，尺寸要用 offsetWidth 量）原始：顶部放大镜：MiMo 是「搜索对话、项目、产物」浮层，空输入时列「近期对话」（标题 + 右侧项目名）；MCode 打开的是「搜索文件、命令和会话」命令面板
- [x] A8 右上角（已完成：MiMo 顶栏右侧只有一个全局按钮「切换侧边面板」（Ctrl+Alt+B），首页和对话里都在，固定在 Windows 窗口按钮左侧 9px（`env(titlebar-area-*)`；探针窗口里没有这个区域，所以探针量到的是离窗口边 9px），面板打开时按钮显示按下态。面板里什么都没开时显示新组件 `RightLauncher.vue`：380 宽，五张卡片 审查 / 文件 Ctrl+P / 侧边聊天 / 浏览器 Ctrl+T / 终端；当前界面用不了的卡片变灰（首页只有浏览器可用）。审查卡打开审查面板，文件卡打开审查面板并切到「所有文件」（FilePanel 暴露 `showTab`），侧边聊天 / 浏览器 / 终端分别打开 MCode 现有的侧边聊天列、浏览器列、底部终端。审查面板或启动器开着时再按按钮或 Ctrl+Alt+B 就全部收起。原 Ctrl+Alt+B 只切审查面板、首页无效，已改。SessionHeader 右侧多留 38px 给按钮。探针 `mcode-side-panel.cjs`，9 项。与 MiMo 的结构差异：MiMo 的侧边聊天 / 浏览器 / 终端是右侧面板里的标签页，MCode 仍是各自的列和底部抽屉，没有面板标签条和「+」菜单；首页没有加底部面板按钮（MiMo 的底部面板按钮在对话标题栏里，MCode 已有）。此前完成的部分：侧栏顶部的浏览器按钮已删除，同 MiMo；浏览器仍可用 Ctrl+T / Ctrl+Shift+B 打开，Sidebar 的 `browser` / `browserAllowed` 属性和 `toggle-browser` 事件一并删除，探针 `mcode-sidebar-top.cjs`。未做：右侧面板空白时的启动器卡片、首页右上角的底部面板 / 右侧面板按钮）原始差异：MiMo 首页也有「底部面板」「右侧面板」两个按钮；右侧面板空白时是启动器（审查、文件 Ctrl+P、侧边聊天、浏览器 Ctrl+T、终端）；MiMo 侧栏顶部**没有**浏览器按钮，MCode 多一个
- [x] A9 浏览器面板（已完成：真实窗口截图确认原因——浏览器面板在最右时，它顶栏右端的「+」和面板关闭「×」挤在 Windows 自带的最小化 / 最大化 / 关闭按钮旁边甚至下面，看起来像第二套窗口按钮；A8 加的切换侧边面板按钮也会压住它们。修法：浏览器面板、侧边聊天、审查面板都加 `edge` 属性，贴着窗口右边时头部右侧留出标题栏按钮宽度 + 46px（App 按「谁在最右」传值：审查面板总在最右，浏览器在启动器 / 审查面板没开时，侧边聊天在浏览器也没开时）；同时照 MiMo 删掉浏览器面板自己的关闭「×」（MiMo 面板没有，关最后一个标签页或 Ctrl+Shift+B 关闭）。探针 `mcode-edge-headers.cjs`，另用 computer-use 在真实开发窗口截图核对。侧边聊天头部的关闭「×」暂时保留）原始：MCode 截图里面板内出现第二套窗口控制按钮（最小化 / 最大化 / 关闭），疑似 bug
- [x] A10 侧栏收起（已完成：收起后不再整列消失，而是 MiMo 的 62px 图标栏：只剩 新建任务 / 插件 / 产物中心 三个图标和底部的主题 / 设置图标，悬停时提示显示在图标右侧；「切换边栏 / 后退 / 前进 / 搜索」一排浮在图标栏右侧 3px（left 65、top 13），对话标题栏左侧留出 132px 不被压住；点这排里的切换按钮或 Ctrl+B 展开。Ctrl+B 以前只在打开对话时有效（命令带 `enabled: hasSession`），首页按了没反应，已去掉；`side.toggle` 中文改为 MiMo 的「切换边栏」。顺带修了提示指令 `tip.ts` 的通用缺陷：挂载时闭包住了旧绑定值，挂载后才出现的提示文字（如收起后的图标名）永远不显示，现在悬停时读元素上最新的值。探针 `mcode-rail.cjs`，6 项；另用 computer-use 在真实开发窗口核对图标栏和提示）原始：MiMo 收成图标栏（新建任务 / 插件 / 产物中心，底部头像），按钮提示「切换边栏 Ctrl+B」
- [x] A11 底部终端（已核对：真实窗口截图里是「终端 ×」标签、「+」、右侧收起 ×，与 MiMo 一致；逐项对 MiMo 测量值——标签 70×28、圆角 7、左右内边距 11、12px、选中有细描边且关闭号常显，收起按钮 26×26 圆角 7——都相符，唯一不符的「+」按钮圆角 4px 改为 MiMo 的 7px。探针 `mcode-terminal-bar.cjs`，4 项）原始：MiMo 标签「终端 ×」、「+」、右侧关闭按钮
- [x] A12 输入框（已完成：核实 MiMo——输入栏没有常驻的智能体选择器，只有模式不是构建时才出现带图标的模式胶囊（悬停提示「已开启…，点击关闭」，点击回到构建）；上下文圆环只在会话已有用量时出现。MCode：删掉「Build ⌄」选择器和已无用的 `showAgentPicker` 设置（协议、服务端默认值、设置页开关、`set.agentPicker*` 文案）；加号菜单在「分阶段」上方加「计划模式」开关；开启计划模式或分阶段时栏里显示「计划」/「分阶段」胶囊，点击关闭；空对话（还没有用量）不显示圆环。Ctrl+. 循环切换智能体保留。MiMo 的「编排模式」对应 MCode 已有的「分阶段」。真实开发窗口截图核对首页输入栏。探针 `mcode-modes.cjs`，6 项）原始：MiMo 首页输入框没有智能体（Build）选择，也没有上下文圆环（需核实对话中是否出现）
- [x] A13 项目行（已完成：真实窗口确认两处差异并修正——展开的项目改画打开的文件夹（收起时仍是合上的）；项目行尾的「…」菜单和「+」新建任务原本透明但仍占宽度，「StoneAge-Ser…」不悬停也被截断，现在和会话行一样放进 `row-actions` 悬停叠加层，平时名字占满整行，悬停时按钮盖在行尾。叠加层原来是 `background: inherit`，继承的是半透明悬停色，长名字会从按钮底下透出来（真实窗口和探针截图都看到「+」压在文字上），现改为「悬停色叠在侧栏底色上」的不透明底，打开中的行用选中色。探针 `mcode-project-row.cjs`）原始：MiMo 展开时是打开的文件夹图标；MCode 项目名被行尾按钮挤窄（会话行已改为悬停叠加，项目行还没改）

## 待办：清单之外的只读审计结果（2026-09-13）

三个只读代理对照 MiMo 安装包和 MCode 源码找出的候选差距，已排除已完成项和用户不做的项。**动手前每条都要再核实一次**（MiMo 组件里真的调用了、MCode 真的没有）。对话视图的 MiMo 组件在懒加载块 `ThreadView-*.js`、`HarnessRow-*.js`、`MarkdownImpl-*.js` 里。

设置页：
- [已完成] 已归档对话批量管理（批量管理 / 全选 / 已选 N 项 / 恢复 N 项 / 删除 N 项，单条删除也用确认弹窗）——探针 `mcode-archived-batch.cjs` 9 项通过；注意临时配置里会话可能不够，探针会先在副本里新建再归档
- [已完成] MCP 服务器：添加 / 编辑 / 移除表单（大）；每行「工具」列表（中）；手动配置区的配置文件路径和示例（小）——设置新增「集成 › MCP 服务器」页（MiMo `Oa` / `Ra` 的顺序和尺寸）：每行名称下是「本地 · stdio / 远程 · http」+ 状态胶囊（6px 圆点、11px、圆角，已连接绿 / 连接失败红 / 待授权黄 / 连接中与已禁用灰），行尾开关 +「工具 / 编辑 / 移除」；「工具」在行下展开面板（获取中… / 共 N 个工具 + 等宽工具名和两行省略的说明 / 该服务器未提供任何工具 / 获取失败 + 重试）；「添加 MCP 服务器」行 → 表单页「连接至自定义 MCP」（名称、stdio / Streamable HTTP 胶囊切换、命令、参数列表、环境变量 KEY / value（密码框，可显示 / 隐藏）、HTTP 的地址和请求头 + 说明；名称为空、stdio 无命令、HTTP 无地址或地址不合法时「保存」不可点）；「编辑」回填并锁定名称；「移除」不确认，直接提示「已移除 MCP 服务器：名称」；下方「手动配置」+ 配置文件 config.json 路径（单行省略）+ 示例（MCode 自己的 `mcpServers` 格式）。实现：页面直接用 `patchConfig` 改 `mcpServers`（后端本来就在配置变化时重连），命令存成数组：表单里命令行按空格 / 双引号拆开，参数逐条追加；编辑时首个元素回填命令、其余回填参数。后端只新增 `mcp.tools` 请求（已连接时列出工具，否则返回状态名或错误）。旧的 `McpDialog.vue` 删除，命令「MCP」、Ctrl+;、插件页「管理」都改为打开设置的 MCP 页。与 MiMo 的差别：「授权」按钮后来已补上（见下方「MCP 授权」一条）；手动改配置文件：2026-09-14 起照 MiMo 不用重开——`Config.watch()` 监听 storage 目录，config.json 内容和内存里不同就重新加载并发 `config.updated`（MCP 随之重连，界面刷新；解析失败的文件先不理），文案改为 MiMo 的「保存后在下一个对话生效」（18 张表）；探针 mcode-config-watch.cjs 验证文案、手写加入的服务器出现并连接、手写删除后消失。新键 `set.nav.mcp` / `set.group.integrations` / `set.mcp.*` / `set.mcpForm.*` 共 52 个（18 张表）。探针 `mcode-mcp-page.cjs` 9 项（`fake-mcp.cjs` 是 scratchpad 里的 stdio 假服务器，列出两个工具；远程项指向本机关闭的端口；表单保存的远程项地址是 example.invalid），换回旧代码时 9 项全失败；截图 `mcp-list.png` / `mcp-form.png` 看过
- [已完成] MCP「从其他工具导入」（中）——核实 MiMo 主进程 `mimo:mcpImportScan` / `mcpImportApply` 和设置 `Oa` 的导入视图（只读理解行为，代码自己写）：按 Claude Code（`~/.claude.json` 顶层 `mcpServers`）、Kiro（`~/.kiro/settings/mcp.json`）、Codex（`~/.codex/config.toml` 的 `[mcp_servers.名称]` 表）顺序扫描，同名只取第一次出现的；有 url 的算远程（只收 http/https），否则有 command 的算本地（command + args、env / headers），`disabled` 转成关闭；已在本机配置里的同名项标「已存在」且不可勾选。视图：标题「导入 MCP 服务器」+ 说明，按来源分组（小节标题 + 卡片），每行名称 + 「本地 · stdio / 远程 · http · 命令或地址」+ 开关（新项默认全开），底部「返回」+「导入所选（N）/ 导入中…」，一个都没有时显示「未发现可导入的 MCP 配置」卡片；导入后提示「已导入 N 个 MCP 服务器」回到列表。MCode：新文件 `src/server/mcp-import.ts`（自己写的 JSON / 最小 TOML 解析，支持行内 `env = {…}` 和 `[mcp_servers.x.env]` 子表），请求 `mcp.importScan`（**只把名称、类型、摘要发给页面，环境变量和请求头的值不出后端**）和 `mcp.importApply`（后端重新扫描一次，只写入仍在磁盘上且未存在的勾选项，不信任页面传来的内容）。`MCODE_IMPORT_HOME` 环境变量可以替换主目录（探针用）。新键 `set.mcp.import*` 14 个（18 张表）。与 MiMo 的差别：没有底部那段 MiMo 自己技能目录的说明；导入后立即连接（MiMo 说「下个新对话生效」）。探针 `mcode-mcp-import.cjs` 8 项（假主目录里放三份假配置，命令都不存在、密钥都是假值，并检查页面文字里没有密钥），换回旧代码时 8 项全失败
- [已完成] MCP「授权」（OAuth，MCode 后端没有，大）——**2026-09-14 用户要求改为 MiMo 的做法，已按 MiMo 引擎（安装包 `out/main/node.mjs`，内含 MCP SDK 1.27.1 的 `auth()` 和它自己的 McpOAuthProvider / 回调服务 / McpAuth 存储）重写 `src/server/mcp-oauth.ts`，不引入 SDK 依赖**：回调固定 `http://127.0.0.1:19876/mcp/oauth/callback`（可在服务器配置 `oauth.redirectUri` 改，端口已被占用时不另起）、5 分钟超时、state 为 32 字节十六进制并在回调时核对；配置新增 `oauth?: { clientId, clientSecret, scope, redirectUri } | false`（false 关闭授权，401 直接算连接失败，不显示「授权」）；发现顺序照 SDK：401 的 WWW-Authenticate（resource_metadata、scope）→ 路径感知的受保护资源元数据 → 根路径 → 授权服务器元数据（OAuth / OpenID，带路径时三种地址）→ 资源地址必须和服务器同源同前缀 → 未配置 clientId 时动态注册（client_name MCode，有 secret 用 client_secret_post）→ 有 refresh_token 先续期 → 否则 PKCE S256 授权；换令牌时按服务器支持的方式选 basic / post / none；invalid_client 清空重来、invalid_grant 清令牌重来。存储改为 MiMo 的结构 `storage/mcp-auth.json`（按名称：tokens{accessToken, refreshToken, expiresAt 秒, scope}、clientInfo、codeVerifier、oauthState、serverUrl，文件权限 0600，写入串行）。连接行为照 SDK 传输层：带存储的 Bearer 和 mcp-session-id，配置里的请求头覆盖同名；401 时调用 auth()（有 refresh 就续期后重试，否则记下授权地址、状态「待授权」），已经授权过仍 401 就报错；注册不被支持时状态为连接失败并提示需在配置里填 clientId。`McpServers.authenticate` 照 MiMo 的 startAuth / authenticate / finishAuth。探针 mcode-mcp-oauth.cjs 改为 8 项全过（新增 oauth:false 失败无按钮、授权地址 redirect 等于配置、state 十六进制、存储结构、令牌被吊销后用 refresh 续期），换回上一版实现时 oauth:false、授权地址、存储结构 3 项失败。第一版记录如下：照 MiMo：启用中且状态「待授权」的远程服务器行，在「工具」前多一个「授权」按钮；按下提示「授权中…」、按钮变「授权中…」并禁用，完成后提示「授权成功」并重连（失败提示「授权失败：原因」）。后端新文件 `src/server/mcp-oauth.ts`（不引入 SDK，按 MCP 授权规范自己写）：先 POST 一次读 401 的 `WWW-Authenticate` 里的 `resource_metadata`，取受保护资源元数据 → 授权服务器元数据（没有元数据时退回 /authorize /token /register），以公共客户端做动态注册，PKCE S256 + state，在 127.0.0.1 随机端口开一次性回调 `/callback`，用系统浏览器打开授权页（服务端用 start/open/xdg-open，不经 Electron），拿 code 换令牌（带 resource）。令牌只存在本机 `storage/mcp-auth.json`（按服务器名，记录 url、clientId、tokenEndpoint、resource、access、refresh、expires），不发给窗口；服务器地址变了就不再使用旧令牌。`Connection.post` 在配置里没写 Authorization 头时自动带 Bearer，到期前 60 秒先用 refresh_token 续期，遇到 401 且有 refresh 时续期后重试一次。`McpServers.authenticate` + 请求 `mcp.authenticate`（请求会一直等到浏览器流程结束，前端 client 没有请求超时）。测试接口：环境变量 `MCODE_OAUTH_OPEN_FILE` 让授权地址写进文件而不是打开浏览器。新键 `set.mcp.authorize` / `authorizing` / `authorized` / `authorizeFailed`（18 张表）。探针 `mcode-mcp-oauth.cjs` 在进程内起一个假的 MCP + OAuth 服务器（无令牌 401、元数据、注册、立即同意的授权页、校验 PKCE 的令牌端点、30 秒短令牌 + refresh），7 项全过：待授权行与授权按钮（无鉴权的服务器没有按钮）、按下后的进度提示、授权地址参数（client_id、S256、state、resource、回环地址、注册名 MCode 且 auth none）、PKCE 校验与回调 200、已连接且工具列出 echo、令牌落盘（只读键名）、短令牌用 refresh 续期后仍连接；HEAD 上 7 项全败。**以下是核实时的现状记录（已被上面几条取代，留作背景）**：MCode 设置里没有 MCP 页；唯一的管理界面是 `McpDialog`（命令「MCP」或 Ctrl+;，只能列出和开关），插件页隐藏后它的「管理」入口也跟着没了；配置存在 config.json 的 `mcpServers`（`McpServerConfig`：type local/remote、command 数组、environment、url、headers、enabled）。MiMo 设置 `Oa` 的顺序：服务器行（状态胶囊、工具面板：加载中 / N 个工具列表 / 无工具 / 失败 + 重试、移除）→「添加服务器」行 →「从其他工具导入」行（扫描中…）→ 小节「手动配置」+ 说明「也可直接编辑配置文件（或让 AI 帮你改），保存后在下一个对话生效。」→ 卡片「配置文件」行（`sr-path` 单行省略，未解析时「解析中…」）→「配置示例（…配置文件顶层 mcp 段）：」→ `pre.mcp-example`（代码底色、1px 边框、圆角 9、12.5px 等宽、内边距 12 / 14、行距 1.5、横向滚动）。建议做法：在设置里新增 MCP 页，把这几块一起做，示例用 MCode 自己的 `mcpServers` 格式
- [已完成] 常规：默认打开方式下拉（只列本机应用，中）；外观独立成页（中）——外观：核实时发现 MCode 设置里「外观」早已是独立一页（导航「外观」、`section === 'appearance'`）。默认打开方式：核实 MiMo 设置常规页 `Ca`：第一行「默认打开目标」，说明「默认用哪个程序打开文件夹/位置(仅列出本机已安装的应用)」，下拉只列本机装了的应用，选中即成为聊天头「打开位置」的默认程序，不会立刻打开。MCode 原来「打开位置」菜单在 Windows 上把 VS Code / Cursor / Zed / PowerShell / Sublime Text 全列出来（不管装没装），设置里没有这一行。现在：新文件 `src/main/installed-apps.ts`（Windows / Linux 用 `where.exe` / `which` 在 PATH 上找得到才算装了——MCode 本来就是按名字启动，找不到的也打不开；macOS 看 `/Applications` 或 `~/Applications` 里有没有对应 .app），IPC `mcode:installed-apps`（主进程每次运行只查一次）；`lib/open-with.ts` 只列已安装的（主进程还没回答或查不了时照旧全列），新增 `choose` / `options` 供设置页用；设置常规页第一行「默认打开目标」下拉（文件资源管理器 + 已安装应用），选中只记住不打开，和标题栏共用同一个记住的选择。新键 `set.openTarget` / `set.openTargetSub`（18 张表）。探针 `mcode-open-target.cjs` 3 项（包装 `ipcMain.handle`：已安装只回 VS Code 和 PowerShell，打开文件只记录），换回旧代码时 3 项全失败。本机实测 `code`、`powershell` 能找到，`cursor`、`zed` 找不到
- [已完成] 常规：语音「发送」开关只在控制模式出现、开启前确认（小）——核实 MiMo 设置 `Ca`：「语音控制发送」行只在语音模式为「智能编辑」（control）时出现，说明随开关变（关：说「发送」不会有实际效果；开：已开启，有误判风险）；打开时先弹确认框（标题「开启语音控制发送」、两段警告：误判会把消息发给 Agent 执行、建议在安全环境或容器内使用并避免高权限；按钮「取消」/「我已了解风险，开启」），关掉不问。MCode 的「整理」模式对应 MiMo 的智能编辑、「快速」对应快速输入：设置行改为只在「整理」模式显示，打开走 `ConfirmDialog`（正文加 `white-space: pre-line` 以显示分段），Composer 只在「整理」模式下响应说出的「发送」。改了 `set.voiceSendSub` 的值，新键 `set.voiceSendSubOn` / `set.voiceSendConfirmTitle` / `set.voiceSendConfirmBody` / `set.voiceSendConfirmOk`（18 张表；MiMo 的「完全访问」MCode 没有同名权限，改写为「例如不经询问就执行」的高权限）。探针 `mcode-voice-send.cjs` 6 项（不按麦克风，不调用模型），换回旧代码时 6 项全失败。没做：MiMo 确认框的红色警告图标和红底按钮，MCode 沿用自己的确认框样式
- [已完成] 配置：AGENTS.md 行的状态标签和 打开 / 停用 / 启用 / 删除（中）——核实 MiMo 设置 `Ka` 和主进程 `agentsPath / agentsOpen / agentsSetEnabled / agentsDelete`：「配置」页只有一张卡片两行——「配置文件」（路径单行，无按钮）和「AGENTS.md / 全局指令文件」；全局 AGENTS.md 放在全局配置旁边，每个对话都会读入；状态标签（已加载：绿色胶囊；已关闭 / 未配置：灰色）；按钮：未关闭时「打开」（没有文件就先写一个起始文件再打开）、已加载时「关闭」（改名为 `AGENTS.md.disabled`）、已关闭时「启用」（改回）、非未配置时「删除」（先确认「删除 AGENTS.md？」，开着的和关掉的都删）。MCode 原来没有全局指令文件，「配置」页是 config.json / models.json / 项目 AGENTS.md / CLAUDE.md / rules.md 的列表 + 打开 / 在文件夹中显示。现在：新文件 `src/server/global-agents.ts`（路径 `<storage>/AGENTS.md`，状态 / 创建 / 开关 / 删除），请求 `agents.state / agents.ensure / agents.setEnabled / agents.delete`；提示词新增「## Global instructions」段（在个人自定义指令之后、项目指令之前，项目指令优先），runner 和「查看系统提示词」都传入这个文件；「配置」页按 MiMo 改成两行，打开走主进程 `mcode:open-file`。起始文件内容是 MCode 自己写的英文说明。旧的文件列表删掉（`set.filesSub` / `set.fileMissing` 一并删除；config.json 路径仍在模型页和 MCP 页显示）。新键 `set.config.file` / `set.agents.*` 13 个（18 张表）。探针 `mcode-agents-page.cjs` 7 项（包装 `ipcMain.handle` 让打开只记录不真的打开），换回旧代码时 7 项全失败；smoke 新增 8 条（状态、创建、进入提示词且在项目指令之前、关闭改名并离开提示词、启用恢复、删除）——其中「在项目指令之前」原来会在没有该段时误判通过（indexOf 为 -1），已改为先要求该段存在；`mcode-mcp-page` 重跑通过
- [已完成] 模型：自定义模型的编辑和复制（中）——核实 MiMo 模型页 `qa`：「已添加」的每个自定义模型行有「编辑 / 复制 / 删除」；编辑读取该模型配置后打开同一个添加表单（读不到时提示「读取该模型配置失败」），复制用同样的配置另存一份，名称加「副本」，成功提示「已创建副本」、失败「复制失败」。MCode 的自定义模型挂在自定义提供方下面，原来这一行只有「移除」。现在：自定义提供方行是「编辑 / 复制 / 移除」；「编辑」在这一行下方展开 `CustomProviderForm` 的编辑模式（id 锁定、字段回填、按钮变「保存」；**密钥不发给页面**，密钥框留空表示保持原样，placeholder「已保存，留空表示不变」，如果密钥来自 `{env:变量}` 就回填变量名）；「复制」在后端完成（新 id 取 `<id>-copy`、被占用就 `-copy-2`…，名称是页面给的「{name} 副本」，存储的密钥在后端复制过去）。后端新请求 `provider.updateCustom`（留空保留原来的密钥或变量、输入新密钥替换、`{env:}` 改成变量）和 `provider.copyCustom`；store 新增 `updateCustomProvider` / `copyCustomProvider`。新键 `set.models.edit / editFailed / copy / copied / copyFailed / copyName`、`provider.custom.field.apiKey.keep`（18 张表）。探针 `mcode-custom-edit.cjs` 4 项（临时配置里放一个地址不可达的自定义提供方，密钥来自只在探针进程里设置的环境变量，不涉及真实密钥、不联网），换回旧代码时 4 项全失败；smoke 新增 5 条（编辑保留 id 并写入、留空保留变量、输入密钥替换变量、复制带字段和密钥、第二次复制取下一个 id）
- [已完成] 模型：底部配置文件路径行（小）——核实时发现早已存在：模型页底部「配置文件 / 本地配置文件」行显示 config.json 路径。与 MiMo `qa` 的差别：MiMo 这一行没有按钮、路径单行省略；MCode 多了「打开 / 在文件夹中显示」两个按钮、路径可换行，暂保留
- [已完成] 快捷键：按键录制搜索（中）；两列表头、命令描述、录制确认、删除默认绑定（中）——核实 MiMo 设置 `rr` / `ar`：标题下是一条圆角 12 的搜索栏（文字搜索「搜索快捷键」，右侧 28px 键盘按钮切换到「按下搜索快捷键」模式，按下的组合键显示在栏里并按它精确过滤，有内容时出现「清除」×），下面一张表（表头「命令 / 按键绑定」，命令列 42%，行内边距 14 / 20，悬停变色），没有分组标题；每行：已绑定显示 kbd（13px、描边、代码底色），未绑定「未指定」，悬停出现铅笔「修改快捷键」→ 录制：蓝色 2px 脉动框「按下快捷键…」，按下后显示组合键和「确认」（蓝）/「取消」，和别的命令冲突时框变红、下方「已被「X」占用，请换一个」且不给确认，点行外取消；行尾 28px：改过的显示「重置 X」（↺），没改过但有默认绑定的显示「删除快捷键」（垃圾桶，保存为空）；无结果「无匹配快捷键」；底部右侧「全部重置为默认值」，提示「已全部重置为默认值」。MiMo 的「命令描述」第二行只在命令有描述时出现，MCode 的命令没有描述字段，所以没有第二行。MCode 原来按分组分成多张卡、点快捷键直接录下（冲突弹提示）、只能「重置」、「全部恢复默认」在顶部。现在按 MiMo 重做：`shortcutRows` 一张表（仍按分组顺序再按名称排，只是不显示分组标题）；录制状态 `recording` / `recordChord` / `recordConflict`；`deleteBinding` 保存空字符串；App.vue 的 `retiredChords` 把「保存为空」也当作内置组合键被让出（不再响应），命令面板的快捷键提示也按「空 = 未绑定」显示。新键 `set.keys.*` 16 个；删除不再使用的 `set.shortcutsSub / set.resetKeys / key.searchEmpty / set.pressKeys / set.reset / key.conflict / key.conflictBody`（`key.search`、`key.unassigned` 是参考镜像键，保留）。探针 `mcode-keys-page.cjs` 7 项（文字搜索、按键搜索、录制确认保存、冲突不给确认、删除默认并重置、全部重置），换回旧代码时 7 项全失败；`mcode-open-target` / `mcode-agents-page` 重跑通过
- [已完成] 应用更新：行内「重启更新」（小到中）——核实 MiMo 设置 `Nr`：页标题下直接是一张卡片，没有说明行；「当前版本」行说明是「品牌名 版本号」，按钮平时「检查更新」、检查时「检查中…」并禁用，下载好后变成实心按钮「重启更新」，说明下多一行安装提示；第二行「开源引擎 / 前往 GitHub」是 MiMo 自己的仓库链接，**不做**。MCode 原来是说明行 + 版本卡片（右侧 v 版本号）+ 另一张卡片里的更新源和「检查更新 / 立即检查」两行，关掉「有可用更新」弹窗会连下载一起丢掉。现在：一张卡片，「当前版本」行（`MCode 版本号`，按钮如 MiMo 三态）+「更新源」行（MCode 没有更新服务，必须保留）；App 新增 `updateChecking`（检查中不再重复发起）和 `updatePrompt`（弹窗关掉只收起弹窗，下载保留，设置页可随时「重启更新」），通过 `update-checking` / `update-ready` 属性和 `install-update` 事件传给设置页。安装提示如实写成「关闭并运行新版本的安装程序」（MCode 的安装是打开安装包后退出，不会自动重开）。新键 `set.checking` / `set.restartUpdate` / `set.updateInstallHint`，删 `set.checkNow` / `set.updatesSub` / `set.versionSub`（18 张表）。探针 `mcode-update-row.cjs` 5 项：在导入 out/main 之前包装 `ipcMain.handle`，检查返回新版本（延迟 1.5 秒）、下载直接返回、安装只计数，不联网不安装；换回旧代码时 5 项全失败
- [已完成] 个性化：自定义指令的「了解更多」展开说明（小）——核实 MiMo 设置 `Pa`（`SettingsOverlay-*.js`）：页标题下是小节标题「自定义指令」（14px 中等），说明一行末尾是行内链接「了解更多」（强调色、`aria-expanded`），展开后是 1px 边框、圆角 10、13px 弱色、行距 1.6 的三行说明（注入方式与生效时机 / 只存本机、清空保存即停用 / 适合写什么）；输入框直接在页面上（不在卡片里），最小高 200、14px、圆角 10、内边距 12 / 14，占位「添加自定义指令…」；「保存」只有去掉首尾空白后内容变了才可点，保存的是去空白后的文字并提示「已保存自定义指令」；没有「尚未保存」。MCode 原来是卡片里一行 132px 输入框 + 「尚未保存」。文案照 MiMo 各语言表，品牌换成 MCode，并保留 MCode 原有的「项目 AGENTS.md 优先」说明（放进第一行说明）。改了 `set.personalSub` / `set.instructionsSub` / `set.instructionsPlaceholder` 的值，新键 `set.learnMore` / `set.ciHelp1..3` / `set.instructionsSaved`，删 `set.unsaved`（18 张表，ar / bs / th / uk 自译）。探针 `mcode-personal-help.cjs` 6 项（临时配置把 instructions 清空），换回旧代码时 6 项全失败。注意：旧探针 `mcode-pages.cjs` 找的 `textarea.instructions` 已不存在

侧栏 / 首页 / 标题栏：
- [已完成] 会话行和项目行的实时状态（运行转圈、未读点、待确认胶囊；项目折叠时汇总）（中）——Sidebar `statusOf` / `projectStatus`：每行只显示最急的一个标记（待确认 > 运行中 > 未读 / 失败），当前打开的会话不显示待确认，悬停时让位给操作按钮；项目折叠时汇总，展开时不显示。探针 `mcode-row-status.cjs` 直接在页面 store 里设置 running / unseen / pendingPermissions。注意：装着当前会话的项目总是展开的。会话行的置顶和菜单按钮改为包在 `.row-actions` 里、绝对定位叠在行尾，只在悬停时出现（和 MiMo 一样），标题和状态标记占满整行；当前行和已置顶行不再常显这两个按钮。项目行上的 git 分支名（MiMo `pi-branch`）**2026-09-18 核实已完成**：`projectLabels` 按 MiMo（`index-Dh5uSQVU.js` 的 `pi-branch`，10px 弱色、在行尾、悬停时让位给操作）——同名项目先用父目录区分，仍分不开才在名字旁显示分支（`row-branch` / `data-project-branch`），普通项目不显。
- [已完成] 普通视图里独立的「已置顶」分区（先 5 条，展开更多）（中）——见下方「侧栏置顶分区」一条
- [已完成] 项目和会话拖动排序（中）；从系统拖文件夹进项目区添加（小到中）——照 MiMo 的 Iz / o4 / proj-section：侧栏项目行和项目内任务行可拖（多选模式不可），被拖的行 opacity .5，悬停目标行上方画 2px 圆头线（inset 6px），放下即插到目标之前；任务只能在同一项目内移动。顺序存进配置新字段 `projectOrder: string[]` 和 `taskOrder: Record<目录, id[]>`，套用方式同 MiMo 的 rN：列表里有的项按保存的顺序占住它们原来的位置，没保存的（新项目、新任务）留在按最近排序的位置。从系统拖文件夹到「项目」区（项目标题、项目行、任务行、翻页行都算）时，按首尾行量出范围画 2px 虚线圈；放下后 preload 新增 `pathForFile`（webUtils.getPathForFile）和 `directoriesOf`（主进程 `mcode:directories-of` 只返回存在的文件夹，path.resolve 统一分隔符），也读 text/uri-list；每个文件夹：从已关闭项目里恢复、没有会话就建一个，最后打开最后一个；一个文件夹都没有时提示「只能拖入文件夹作为项目」（side.dropNotDir，18 种语言）。探针 mcode-side-drag.cjs 7 项全过（最近顺序、拖动样式、项目放下保存、任务放下保存、跨项目拒绝、文件夹虚线圈并加入、文件拒绝），HEAD 上 7 项全败。注意：App 的 window dragover 会对所有拖动 preventDefault，所以探针不能用 dispatchEvent 的返回值判断是否接受。
- [已完成] 首页项目选择器：搜索、路径提示、显示更多、「新建空白项目 / 使用现有文件夹」（中）——核对后 ProjectPicker.vue 的结构（搜索框、最近 3 行 + 展开、132px 滚动带渐隐、同名项目显示区分父目录、添加新项目子菜单、不使用项目）已和 MiMo 的 jRe 一致；差的是文案：中文改成 MiMo 的「无匹配的项目 / 展开显示 / 新建空白项目 / 创建项目 / 已设为不使用项目」（繁体同步）。探针 mcode-home-picker.cjs 覆盖。
- [已完成] 首页分支选择器、新建分支、切换确认（大，后端要加分支函数）——照 MiMo 的 IRe / MRe / Ar：首页项目芯片旁的分支芯片（仓库且在分支上才显示；新仓库无提交、分离 HEAD、非仓库都不显示），菜单 240–320 宽：搜索「搜索分支…」、本地分支列表（当前分支打勾，210px 滚动）、「无本地分支 / 无匹配的分支」、分隔线、「创建并检出新分支…」点开变成输入框（「新分支名，回车创建」，Enter 创建，Esc 收起）。后端 src/server/git.ts 新增 `branchState`（rev-parse + for-each-ref）、`branchNameProblem`（MiMo 的分支名规则）、`checkout(dir, branch, {force, create})`：切到另一工作树已检出的分支时返回该工作树（首页改指向它并提示）；工作区有改动（status --porcelain 非空）时返回 dirty，前端弹「切换到分支「x」？」确认框（说明文字、取消 / 仍然切换），仍然切换用 `checkout --merge` 带着改动切过去，有冲突标记时提示冲突；未跟踪文件会被覆盖 / 本地改动冲突各有提示；创建时已存在或名字非法各有提示。请求 `git.branches` / `git.checkout`，类型 BranchState / CheckoutResult。文案 home.branch* 19 个键（18 种语言）。探针 mcode-branch-picker.cjs（在草稿区真建 git 仓库、两个分支和一个工作树）8 项全过：芯片显示分支、菜单列表与搜索、干净切换、有改动时确认并可取消、仍然切换保留改动、创建时拒绝非法 / 已存在并成功创建、工作树分支切到工作树、非仓库无芯片；HEAD 上 7 项失败。
- [已完成] 新建空白项目（命名并显示存放位置）（中）——新组件 NewProjectDialog.vue 取代 HomeHero 里借用的 RenameDialog，照 MiMo 的 cm(showLocation)：430 宽、16 圆角，44px 图标格，「新建空白项目」19px 600，「项目名称」输入框（默认「未命名项目」全选），「源文件夹」大按钮（26/16 内边距，没选时提示「添加 MCode 可读取和编辑的文件夹」，选了显示路径），取消 / 创建项目（名称为空时禁用）。没选源文件夹：照旧 project.createBlank 在默认项目位置下建空文件夹；选了源文件夹：名称没改过就用文件夹名，创建时直接用该文件夹，名称和文件夹名不同就写入 projectNames，已关闭的恢复。新增 home.blankSubtitle / blankNameLabel / blankSource / blankSourceHint（18 种语言）。探针 mcode-home-picker.cjs 7 项全过（菜单行数、同名提示、无匹配与子菜单、对话框样式、空白创建落盘、源文件夹命名并选中、不使用项目提示），HEAD 上 6 项失败（同名提示原本就有）。探针注意：Composer 里有个隐藏的 input.picker，选择器要用 `.scope div.picker`；对话框有缩放入场，量尺寸用 offsetWidth。
- [已完成] 项目列表分页、每个项目下显示更多（原来悄悄截断到 8 条）（小）——核实 MiMo 侧栏：每个项目先列 5 条，多出来时下方有「展开显示」（12px 弱色，左边和任务名对齐），点了列出全部，折叠或展开项目后回到 5 条；项目列表先 5 个，「显示更多」到 10 个，之后每次 +10，按钮变「显示更多（剩余 N）」，翻过第一页后右侧出现「收起」回到 5 个；选择模式显示全部并把页数重置。两行都用 MiMo 的 22px 行高（高 32）。文案按 MiMo 各语言表。Sidebar `tasksOf` / `allTasks` / `shownProjects` / `moreProjects`。探针 `mcode-proj-pages.cjs` 8 项（12 个临时项目，其中一个 7 条任务），改成 8 条 / 每次 +20 时 5 项失败。置顶项目的单独分区见下方「侧栏置顶分区」一条
- [已完成] 会话行悬停信息卡、标题栏置顶图钉（小）——见下方「会话悬停信息卡」一条
- [已完成] 搜索结果里加产物分组（中）——2026-09-14 核实时发现早已做完（提交 `98b2151`「MiMo's search over conversations, projects and artifacts」）：`SearchOverlay.vue` 按对话 / 项目 / 产物分组，最佳匹配的分组在前，匹配处高亮；产物来自 `artifact.list`。与 MiMo 的差别：MiMo 的产物是向服务端异步搜索，有「正在搜索产物… / 产物搜索暂不可用 / 重试」三种状态；MCode 的产物列表在本地，打开时一次读入，没有这些状态。`mcode-search.cjs` 重跑 7 项通过（该探针不覆盖产物分组）
- [已完成] 双击侧栏标题改名、长标题悬停滚动（小）——核实 MiMo 侧栏会话行：标题放不下（算上行尾按钮盖住的 55px）时，平时末尾 24px 渐隐（不用省略号），悬停或聚焦该行时停 0.35s 后匀速向左滚到末尾（每秒 36px，时长限制在 0.9–8s），离开复位；减少动画时不滚；双击标题 = 行菜单的「重命名」。新组件 `RowTitle.vue`（用 Web Animations，按 `data-motion` 和系统偏好判断减少动画，RTL 反向），Sidebar 两处会话行都换成它，选择模式下不算按钮遮挡、不响应双击；App `renameFromSide` 走和行菜单同一条路（打开会话后开始编辑标题栏）。探针 `mcode-row-title.cjs` 7 项，遮挡改 0、停顿改 0 时 2 项失败。注意：MiMo 的重命名是弹窗，MCode 沿用自己标题栏里的原地编辑
- [已完成] 会话行 / 项目行悬停按钮的渐隐遮罩、尺寸和顺序（小）——核实 MiMo `.ci-actions` / `.pi-actions`：按钮区绝对定位贴住行尾（right 0），按钮 24×24、间隔 1px、圆角 6，淡入 0.1s；按钮下方的 `:before` 遮罩向前多伸 32px，两层渐变（透明 → 行底色，叠在透明 → 侧栏底色上），所以长标题是渐隐进按钮下面，不再是一块不透明底；当前行用选中色。会话行顺序是「…」在前、置顶图钉在后（原来反了）。待确认胶囊不跟转圈 / 未读点一起隐藏：会话行悬停时左移 54px 给按钮让位；项目行悬停时右侧留出 52px，并去掉遮罩。Sidebar `.row-actions` / `::before`（RTL 渐变反向，按钮 `position: relative` 盖在遮罩上）。探针 `mcode-row-scrim.cjs` 11 项（真实指针移动悬停，窗口在后台时会丢事件，所以重发直到 `:hover` 成立，并关掉过渡读终值），遮罩改 24px、胶囊改 40px、留白改 40px、按钮顺序换回时 4 项失败。注意：MCode 行的左右内边距和高度仍是自己的（14px / 38），MiMo 是 9px / 34，没有动
- [已完成] 会话标题栏右侧按钮、前进 / 后退禁用态（小）——用户给了两张标题栏截图对照（上 MCode、下 MiMo，侧栏都是展开的，左边一排是侧栏顶部按钮，靠左是故意的）。核实 MiMo `fOe` 聊天头 / `cje` 顶栏：右侧按钮都是 24×24、圆角 7、标题栏图标色；信息卡开关是「列表」图标 15px，只在有消息的会话里出现（`Ed` / `YS`），按下时用选中底色；底部面板开关图标 14px，按下不高亮；最右的侧边面板开关 24px、距标题栏按钮区 9px、顶 13px，聊天头右内边距 = 让最后一个按钮离它 4px（原来 MCode 按钮 26/30px、间距 19px，信息卡是分栏图标）。后退 / 前进在没有历史可去时禁用、透明度 0.35（原来一直可点、不变暗），App 把 `canGoBack` / `canGoForward` 传给侧栏两排按钮。探针 `mcode-titlebar.cjs` 8 项（在页面 store 里塞一条假消息模拟「有内容」，不调用模型），右内边距改回 58、开关改 30px、去掉信息卡条件、禁用透明度改 1 时 4 项失败。「打开位置」MiMo 在没有工作目录、远程会话或右侧面板显示 office / 浏览器 / html 标签时隐藏；MCode 会话总有目录，暂按有目录就显示
- [已完成] 侧栏项目行 / 会话行改成 MiMo 的紧凑行（小）——核实 MiMo `.sidebar-compact-row`（圆角 6、上下 6px、行高 22 → 高 34）：项目行 `proj-item` 左 0 右 9，文件夹图标在 46px 宽的格子里居中，名字从 46 开始；项目下的会话 `conv-item project-child` 左 46 右 9；最近 / 优先视图里的会话左右 9；当前会话标题 medium。原来 MCode 这些行沿用上面导航项的 38 高、左右 14、圆角 8（导航项 `sidenav-item` 本来就是 38 / 8，不动）。上下 6px 放在行里的按钮上，所以点行的上下边缘仍能打开。优先视图里带项目名的两行行：MiMo 第二行 11px、沿用 22px 行高，所以高 56（原来 11.5px / 15 行高、最小 44）。最近列表的行加了 `recent` 类区分。探针 `mcode-compact-rows.cjs` 7 项（最近列表在这个临时项目里是空的，所以用优先视图里的 `recent` 行量 9px），行高 / 图标格 / 最近左边距 / 标题字重改回时 6 项失败；`mcode-row-scrim` / `mcode-row-title` / `mcode-proj-pages` / `mcode-titlebar` 重跑仍全部通过。注意：标题在子组件 `RowTitle` 里，父组件的 scoped 样式要用 `:deep(.title-txt)` 才生效
- [已完成] Windows 最小化 / 最大化 / 关闭按钮和标题栏图标没对齐（小）——用户截图指出：MCode 的三个系统按钮比标题、图标高一截。核实 MiMo 主进程 `out/main/index.mjs`：`titleBarOverlay` 高 50（`25*2`）、底色透明、图标色深色 `#ececec` / 浅色 `#2b2b2b`，所以按钮中线在 25，正好和聊天头（46 高、上 4）、侧栏顶部按钮、侧边面板开关的中线一致。MCode 原来是 40（中线 20，高 5px）、纯白 / 纯黑。改 `src/main/titlebar.ts` 的 `TITLEBAR_HEIGHT` 和 `symbolColor`（缩放时仍按缩放放大）。探针 `mcode-caption-band.cjs` 4 项：探针窗口读不到 `env(titlebar-area-*)`，所以在导入 out/main 之前拦截 `BrowserWindow.prototype.setTitleBarOverlay` 记录参数，再和页面里标题、「…」、底部面板按钮、侧边面板开关、侧栏顶部按钮的中线（都是 25）比较；改回 40 / white 时 4 项全失败（中线 20）。注意：MiMo 主进程文件用 `@electron/asar` 的 extractFile 读不出来（全部 not found），要直接解析 asar 头部 JSON 按 offset 读
- [已完成] 用户决定：删除命令面板「全部」模式、隐藏插件入口、产物中心不显示已不存在的文件（小）——(1) 命令面板只剩按类型打开的选择器（文件 / 会话 / 项目 / 提问），`PaletteMode` 去掉 `"all"`、`commands` 属性和「命令」分组；原来打开它的菜单项「命令面板 Ctrl+K」（窗口内菜单 AppMenu、原生菜单 menu.ts、preload 频道、App `menuCommands.palette`）一并删除，键 `menu.palette` / `search.placeholder` / `search.commands` 从 18 张表删除。(2) 侧栏「插件」行、Ctrl+Shift+P、快捷键页里的「插件」命令删除；**PluginsView 页面代码保留**（用户说的是隐藏，将来要恢复只需加回入口）。(3) 核实 MiMo 产物中心：没有「文件已不在」状态，只有打开 / 定位失败时的提示；MCode 改为直接不列出已不存在的文件（网格和列表都一样），删掉划线样式、`art.missing` / `art.revealMissing` 键。探针 `mcode-hide-three.cjs` 5 项（产物索引在页面里伪造 2 个存在 + 1 个不存在的文件；菜单从主进程 `Menu.getApplicationMenu()` 读），换回 HEAD 旧代码时 5 项全失败
- [已修复] BUG：右上角「切换底部面板」「切换侧边面板」两个按钮点不了（用户 2026-09-14 截图报告，悬停有提示但点击无效）——和之前左侧折叠栏按钮同一个原因：这两个按钮 `position: fixed` 写在 App 模板最前面，首页顶部的 `.drag` 条（HomeHero）和对话标题栏 `.head`（SessionHeader）在文档里更靠后，Electron 按文档顺序算拖动区域，后面的 drag 盖过前面的 no-drag，Windows 把点击当成拖窗口吞掉。修法同 `.rail-no-drag`：App 模板最后加 `.toggles-no-drag`（不接收指针事件、no-drag，距系统按钮区 9px 起宽 52px，盖住两个按钮），引导页以外都显示。探针 `mcode-toggles-region.cjs` 在按钮中心按文档顺序找最后一个覆盖该点的 drag / no-drag 元素：新代码三处（首页两个、对话页侧边面板开关）都是 no-drag；HEAD 上三处全失败（首页被 `div.drag` 盖住、对话页被 `div.head` 盖住）。另在开发版窗口里真实点击确认：底部面板打开终端、侧边面板打开启动器，再点都能收起。以后新增固定在标题栏的按钮，都要确认有这样的补丁
- [已完成] 用户截图对照（MiMo / MCode 首页开终端、开侧边面板）后「直接复刻 MiMo」——三处：
  - 终端（BUG + 外观）：MCode 终端提示符后出现 `[?1;2c`。原因是控制台主机在 shell 启动时询问设备属性，xterm 的回答经窗口来回送到时它已不再等待，于是当成键盘输入交给 PowerShell；重新接回已在运行的终端时回放缓冲也会再触发一次。TerminalPane：回放解析期间不发任何回答；打开 / 接回后 3 秒内丢弃设备属性回答（`ESC[?…c`），之后照常应答。外观照 MiMo 的 `vendor/pty-term.js`：字号 12、xterm 默认行高、默认块状光标闪烁、失焦不画光标（`cursorInactiveStyle: "none"`，删掉原来聚焦 / 失焦切换闪烁的代码和 `smoothScrollDuration`）；终端内边距 6/8/12。TerminalDrawer 照 MiMo `.bp-*`：默认高 240、顶线 1px、标签 12px 常规文字色、选中标签 1px 边线、关闭「×」13px 常显、新建是纯文字「+」14px（原生 title）、收起按钮 26px 内 18px X。回滚量（scrollback 10000）没照 MiMo 的默认 1000，看不见的差别，保留
  - 「切换底部面板」按钮：MiMo 放在主栏标题行末端，不是固定在窗口右上角。首页按钮移进 `<main>`（`.home-bottom`，在首页拖动条之后，所以不可拖动生效）：旁边没面板时在侧边面板开关左边 4px，有面板（启动器 / 审查 / 浏览器 / 侧边聊天）时离主栏右端 12px；对话标题栏同理，新属性 `panelBeside` 让右内边距变 12px。右侧 `.toggles-no-drag` 补丁缩到只盖侧边面板开关（24px）
  - 侧边面板顶栏（RightLauncher）：照 MiMo `rp-head`，左边 26px「+」（提示「新建工具」）弹出工具菜单（图标、名称、Ctrl+P / Ctrl+T），右边 24px「展开面板 / 恢复面板宽度」，结束于开关左边 4px；展开时主栏宽度折到 0、面板占满并在左侧圆角加阴影，启动器关闭时自动还原。卡片照 `launch-card`：行高 22（卡片 50 高、间距 10）、快捷键框 1px 边线 5px 圆角 padding 1/5；图标描边 1.33，审查 / 文件改成「文档 / 文件夹 + 放大镜」（自绘）。首页选了项目时启动器里的终端可用。新键 `launch.newTool/expand/restoreWidth`（18 张表，14 种取自 MiMo 自带翻译）。注意：MiMo 的展开对整个右侧面板（含审查、浏览器等标签）都有效，MCode 这些面板还是各自独立的列，目前只有启动器有展开按钮
  - 探针 `mcode-terminal-look.cjs` 5 项（打开 240 高、单元格高约 14.3 即 12px 字、内边距、标签栏标记、没打字时 shell 只收到焦点事件）HEAD 上 5 项全失败；`mcode-side-panel-head.cjs` 9 项，HEAD 上 7 项失败（「首页按钮在开关左 4px」「还原到 380」本就成立）；`mcode-toggles-region.cjs` 改用新选择器后仍 3 项全过
- [已完成] 用户要求「审查、浏览器面板也要能展开，照 MiMo 统一」——新组件 `PanelExpand.vue`（24px、标题栏图标色、12px 图标、「展开面板 / 恢复面板宽度」），启动器、审查（FilePanel）、浏览器（BrowserPanel）、侧边聊天（SideChat）共用。只画在位于侧边面板开关下方的最右一列上：App `edgePanel`（审查 > 启动器 > 浏览器 > 侧边聊天，与原来各自的 `edge` 判断一致），`panelBeside` 也改由它得出。审查 / 浏览器 / 侧边聊天的按钮绝对定位在面板内（顶 13、离系统按钮区 37，与开关平齐、相隔 4px），各自顶栏靠边时右内边距从 46 改 65 让位。展开：`.body.panel-full` 主栏宽 0，最右那列加 `.side-full`（`!important` 盖过浏览器的行内宽度和审查列的宽度，左侧圆角 16/20 加阴影），调宽把手隐藏；从展开的启动器里选工具后保持展开（MiMo 跨标签页保持），侧边没有面板时自动还原。注意：`watch(edgePanel)` 必须放在 `browserOpen` / `sideChat` 声明之后——watch 会立刻求值，放前面会在初始化时报 `Cannot access 'browserOpen' before initialization` 让界面崩溃（探针抓到的）。探针 `mcode-panel-expand.cjs` 5 项（启动器、从启动器选浏览器后保持展开、浏览器、审查、侧边聊天：各自唯一一个按钮、位置、展开后主栏 0 / 面板 1245 / 无把手、还原回原宽 420 / 805 / 380），HEAD 上 5 项全失败；`mcode-side-panel-head.cjs` 9 项、`mcode-toggles-region.cjs` 3 项重跑全过。（这一条的「各自独立的列」已被下一条的统一右侧面板取代）
- [已完成] 用户要求右侧照 MiMo 统一成「一个面板 + 标签页」（2026-09-14 决定，接受失去多列并排）。先由两个只读调研整理出 MiMo 规格（scratchpad `mimo-right-panel-spec.md`）和 MCode 现有入口清单，再重写：
  - 数据层 `stores/right-panel.ts`：标签属于当前对话，切换对话时收起再放回（含选中和开关状态）；首页开的标签在进入对话时释放；审查 / 终端 / 浏览器 / 侧边聊天每次新开一个（同类第二个起显示「终端 2」），文件只保留一个；关闭时选右边邻居、没有再选左边，关掉最后一个面板收起；展开只在打开时有效，收起时一并取消；差异标签按来源更新，正在显示时再点就收起面板；宽度存 localStorage `mcode.rw`（默认 380，最小 300，最大留主栏 480）。
  - 外壳 `RightPanel.vue`：顶栏标签条（160 宽胶囊，放不下改 120 并可横向滚动，中键关闭，右键「关闭 / 关闭其他标签页 / 关闭右侧标签页」），紧跟标签的「+」菜单（审查 Ctrl+Shift+G、终端、浏览器 Ctrl+T、文件 Ctrl+P、侧边聊天 Ctrl+Alt+S），展开按钮，左边 7px 拖宽；没有标签时显示启动器（卡片 46 高、间距 10）；所有标签页保持挂载，侧边聊天只挂当前那个；关闭敲过命令的终端先确认（「关闭终端？/关闭多个终端？」）。
  - 标签页 `components/right/`：`RpReview`（未暂存 N + 刷新、M/A/D 文件列表、差异，空状态「未打开项目 / 不是 git 仓库 / 读取失败 / 工作区干净」），`RpDiff`（新旧行号 + 符号列，增删行底色加 3px 色条），`RpFiles`（顶栏：文件树开关、路径、编辑 / 保存 / 取消、用默认程序打开 html、在文件管理器中显示、刷新；文件树可搜索可拖宽，存 `mcode.ftw`；查看器：代码带行号、Markdown 渲染、图片点开预览、音频、二进制提示、Ctrl+F 查找；右键打开 / 显示 / 复制路径 / 复制相对路径），`RpChat`（空状态「与主对话并行的独立侧边对话」+ 输入框，每个标签一个侧边会话，store 新增 `showSide`），`RpBrowser`（状态点、后退、前进、网址、刷新、在浏览器中打开、截图到剪贴板、更多菜单：强制刷新 / 缩放 − % + 复位 / 清除 Cookie / 清除缓存；空白页列出本地服务；加载失败显示「无法访问此网站」+ 分类说明 + 重试；每个标签一个主进程页面，不在显示时隐藏），`RpTerminal`（终端 + 工作目录不一致提示）。
  - 主进程 / 后端：`browser.ts` 每次打开新增一个页面，状态带缩放和加载失败，新增截图、清除 Cookie / 缓存；后端新增 `file.write`（只写已存在的文件）。
  - App 接入：标题栏开关、Ctrl+Alt+B、Ctrl+Shift+G、Ctrl+P（改为文件标签，原来的文件选择器不再占这个键）、Ctrl+T、Ctrl+Shift+B（有浏览器标签时切换）、Ctrl+Alt+S、Ctrl+L / Ctrl+R / Ctrl+Shift+R 作用于当前浏览器标签；「修改了 N 个文件」小胶囊改为差异标签；「已编辑 N 个文件」卡片的「审阅」聚焦已有审查标签或新开；输入框「+」里的终端改为开终端标签（首页仍是底部终端）；打开产物中心 / 插件页时收起面板；删除对话时释放它的终端和页面。
  - 删除：`FilePanel`、`BrowserPanel`、`SideChat`、`RightLauncher`、`ContextView`、`ReviewPatch`、`lib/session-tabs.ts`，审查备注状态，上下文用量拆分估算，「显示文件树」设置和 `showFileTree` / `browserWidth` 配置，原生菜单和应用内菜单的「切换文件树」，以及这些组件留下的 94 个文案键（18 张表共 1692 行）；新增 `rp.*` 文案 81 个（14 种取自 MiMo 自带翻译）。检查脚本同步：wiring-check 扫描 `components/right/`、去掉审查补丁和上下文标签的检查，prompt-check 换成右侧面板数据层的 17 项测试，theme-check 去掉 FilePanel 例外。
  - 验证：探针 `mcode-right-panel.cjs` 12 项（启动器、「+」菜单、标签编号与宽度、审查列出改动和差异、文件、侧边聊天、浏览器、终端、右键菜单、展开、关闭规则、按对话保存标签）全过，HEAD 上 12 项全失败；`mcode-terminal-look.cjs` 5 项、`mcode-toggles-region.cjs` 3 项重跑全过；冒烟 369 项全过。注意：`prompt-check` 里另有 3 项（输入框强度菜单、从对话记录撤回到输入框）在这次改动之前就已失败，检查的代码早已改掉，不是这次引入的。
  - 仍和 MiMo 不同 / 未做：展开后面板底部的悬浮聊天已在下一条补上；代码高亮、文件「添加批注」、浏览器的「标注」和「设备工具栏」都已在后面补上；浏览器仍只允许 http / https，不能打开本地文件路径（安全限制保留）
- [已完成] 展开面板时的悬浮聊天（照 MiMo `FloatingChat`）：新组件 `components/right/FloatingChat.vue`，在右侧面板里一直挂着（里面有固定的 `#float-dock`），只在对话中且面板展开时显示。底部悬浮层左右 20、下 14，最宽 720；有回复或正在生成时，默认是小胶囊「查看输出」（生成中为「正在生成…」加转圈），点开是卡片（圆角 16、阴影），头部「最新回复 / 正在生成…」加折叠按钮，内容最高 38vh、自动贴底，用对话记录同一套文本 / 思考 / 工具组件画最近一轮回复；卡片下面是输入框。App 在展开时把同一个输入框 Teleport 到 `#float-dock`（草稿和附件跟着走），并关掉拖动调高（Composer 新属性 `resizable`，同时忽略记住的手动高度）；悬浮层高度写成面板上的 `--fc-h`，文件查看器展开时底部留出 `--fc-h + 8`。新文案 `rp.floatingChat.*` 4 个（14 种取自 MiMo 自带翻译）。探针 `mcode-floating-chat.cjs` 7 项全过（平时不显示、展开后输入框移入且草稿保留、无拖动把手、胶囊文字与 `--fc-h`、卡片内容与尺寸、折叠、生成中、还原后输入框回到对话），HEAD 上 5 项失败（「平时不显示」「还原后回到对话」本就成立）；统一面板和终端探针重跑全过，冒烟 369 项全过
- [已完成] 代码语法高亮（照 MiMo 的 shiki 用法，用户同意安装 shiki 4.4.3）：新 `lib/highlight.ts`，`shiki/core` + JavaScript 正则引擎（不用 wasm），GitHub 浅色 / 深色双主题，语言只载 MiMo 那 19 种（ts、tsx、js、jsx、json、python、bash、html、css、go、rust、java、sql、yaml、c、cpp、diff、markdown、vue）和它的别名（node / mjs / cjs → js、sh / shell / zsh / console → bash、yml → yaml、md → markdown、htm / xml → html、patch → diff、c++ / objc / cuda → cpp 等），首次用到才加载（各语言单独分包），结果按「语言 + 代码」缓存 400 条，超过 20 万字不着色。接入三处：回复代码块（TextPart 渲染后停顿 120ms 着色，流式输出时已着色的块从缓存立即恢复）、提问里的代码块（MessageStream `v-highlight`）、文件标签查看器（按扩展名逐行着色，行号保留；打开查找时退回纯文本以便标记匹配）。不在列表里的语言保持原样。base.css：深色主题（显式或跟随系统）时 token 取 `--shiki-dark`，浅色用 shiki 自带颜色；代码块底色仍用 MCode 自己的。探针 `mcode-highlight.cjs` 4 项（回复 ts 块、未知语言保持纯文本、提问里的 python、文件标签的 .ts；深色下 token 计算色等于 `--shiki-dark`）全过，HEAD 上 3 项失败（未知语言那项本就成立）；冒烟 369 项全过
- [已完成] 浏览器标签的「标注」和「设备工具栏」（照 MiMo `RpBrowser`，MiMo 自己也还是占位）：地址栏截图按钮之后加「标注」按钮（高 34、1px 边线、圆角 8、12px 字、间距 6、左右 10，里面是 11px 等宽的 `Ctrl+.` 键帽：1px 线、圆角 5、行高 18；打开时强调色字和边线，`aria-pressed`；提示「标注(Ctrl+.)」；窄栏时隐藏）。打开后页面框内显示 2px 强调色虚线框（向内 2px、6% 强调色底、圆角 10、不挡鼠标），顶部居中提示「标注功能即将上线 · 按 Ctrl+. 退出」（12px 强调色字、底色、1px 强调色边、圆角 8、上边距 10、内边距 4/10、阴影）。与 MiMo 的差别：MCode 的网页是主进程画在界面之上的原生视图，DOM 盖不住它，所以标注时网页四边各缩 2px、顶部下移 46px，把虚线框和提示露出来（MiMo 是 webview，覆盖层直接盖在网页上）。Ctrl+.：有浏览器标签在显示时切换标注，否则照旧向后切换智能体（和 Ctrl+L / Ctrl+R 同样的分流）；焦点在网页里时按键到不了界面，这点和 Ctrl+L 一样。更多菜单第二项「显示设备工具栏」（无页面时禁用），点了关菜单并提示「设备工具栏开发中」。新文案 `rp.browser.annotate` / `annotateLabel` / `annotateHint` / `dotMenu.deviceToolbar` / `toast.deviceToolbarWip`（18 张表，14 种取自 MiMo 自带翻译，ar / bs / th / uk 自译）。探针 `mcode-browser-annotate.cjs` 6 项（探针自己在 127.0.0.1 起一个本地网页；按钮尺寸与位置、覆盖层与提示、原生页面 y+46 / x+2 / 宽 −4、Ctrl+. 关闭并恢复原位、设备工具栏提示）全过，HEAD 上 6 项全失败。注意：1.75 倍缩放下 2px 虚线框读出来是 1.714px，只判定 dashed
- [已完成] 注释 / 批注（照 MiMo 的 annotations：`s8` / `vLe` 数据、`k8e` 选区钩子、`$3` 注释框、`Gz` 标签、`HN` 随消息发送）：
  - 数据：`shared/protocol.ts` 新增 `Annotation {id, kind: answer|code|file, path?, name?, quote?, occ?, occTotal?, text}`，`UserMessage.annotations`、`session.prompt.annotations`；`shared/annotations.ts`（上限 20、`collapse`、给模型看的 `<annotations>` 块，措辞是 MCode 自己写的，没抄 MiMo 的提示词）。后端 runner 把注释存进用户消息（插话也一样），Anthropic / OpenAI / ChatGPT 三个适配器和压缩摘要都用 `withAnnotations(text, annotations)`；对话气泡只显示打的字。
  - 渲染进程：`stores/annotations.ts` 按对话保存待发送的注释（首页用 `home`），添加时提示「已添加评论到对话」，满 20 条提示「注释已达上限（20 条），请先发送或清空」。`lib/annotate.ts`：可注释区域用 `data-annotate="answer"`（TextPart）/ `data-annotate="code"` + `data-annotate-path`（文件标签的代码），侧边聊天整体 `data-annotate-off`；空白折叠后的文字与原文节点映射，用来算「第几处 / 共几处」和双击时重新定位。
  - `AnnotationComposer.vue`（App 里挂一个）：松开鼠标或 Shift / 方向键选择后 300ms，在选区末端上方出注释框（宽 296、内边距 5/6/5/10、1px 线、圆角 10，不盖住输入框，放不下改到下方）；文本框 12px/18 行高最高 132，占位「修改或提问，留空则仅引用」；有字时出 28px 强调色发送箭头；右侧 28px 描边按钮「添加到对话」（提示带「输入文字 → 注释；留空 → 仅引用此处」）只加入不发送；Enter = 加入并立刻发送（App 调 Composer 新暴露的 `submit`），Esc 关闭；新选区不抢焦点，编辑和文件批注自动聚焦；文本框聚焦时用 CSS Highlight 点亮原文（浅 #b3d7ff / 深 #33518a）；双击已注释的原文重新打开并带出原注释；按下别处 180ms 淡出；切换对话、打开弹窗时关闭。
  - `AnnotationChips.vue`：输入框顶部一行（与文件卡片对齐 12/16），有注释文字的合成一个「N 条注释」标签（方框加号图标 + ✕ 清空），只引用的逐条显示前 3 条（14px 强调色编号 + 「选中『…』」/「整个文件」，最宽 96 省略），其余「+N 条引用」；悬停 200ms 出列表（320 宽、最高 300）：编号、来源（助手回复 / 文件代码 / 文件名）、「范围：…」、注释（点击原地修改，Enter 保存、Esc 取消）、✕ 删除。标签胶囊 24 高、13px、绿色文字，照 MiMo `.cchip`。发出去的用户消息下面显示只读的同一组标签。
  - 文件标签：文件右键菜单「打开」之后加「添加批注」，在指针处打开注释框，生成整文件注释（范围「整个文件」）。Composer 发送时取走当前对话的注释一起发（只有注释没有文字也能发），发送 / 新建对话失败时放回。
  - 新文案 `annotations.*` 16 个、`composer.annotationAdded` / `annotationLimit`、`rp.files.annotate`（18 张表，14 种取自 MiMo 自带翻译：composer / store / rightpanel 各语言分包；ar / bs / th / uk 自译；「选中『…』」「整个文件」MiMo 是写死的中文，MCode 做成了各语言文案）。冒烟 +2（给模型的注释块格式、无注释不加内容），共 371。
  - 验证：探针 `mcode-annotations.cjs` 7 项（选区出框且位置 / 尺寸 / 占位 / 按钮对、暂存注释出标签和提示、空注释成引用标签、悬停列表内容、双击重开带原注释、文件「添加批注」+ Enter 发送三条（`app.send` 换成记录器，不调模型）、历史消息只读标签）全过，HEAD 上 7 项全失败；`mcode-right-panel` 12 项、`mcode-highlight` 4 项、`mcode-floating-chat` 7 项重跑全过。
  - 与 MiMo 的差别 / 没做：MiMo 注释还能来自表格单元格、PDF、网页模块、图片圈选（MCode 没有这些查看器，见后面的调研条目）；跳回原处、侧边聊天注释、重发带注释、原文角标已在下一条补上。注意：探针窗口不在前台时 rAF 和 CSS 过渡都不走，注释框进场改成「量完尺寸再加 shown」，探针读终值前要关过渡
- [已完成] 注释的后续差别（用户：「把没做的差别也补上」）：
  - 点标签跳回原文（MiMo `Uz` / `C1`）：输入框标签和悬停列表里点编号 / 范围，在所属对话里找到那段原文（侧边聊天的标签只在侧边聊天里找，代码只在该文件打开时找，从最新的块往前），滚到滚动区中间并以 `rgba(50,149,251,.6)` 闪亮 1.2 秒；已发送消息下的整文件标签点了在文件标签里打开该文件（输入框里的整文件标签点了不动，同 MiMo）。`lib/annotate.ts` 新增 `jumpToAnnotation`、导出 `scrollerOf`。
  - 侧边聊天单独注释（MiMo `J3` 按所在输入框分组）：`RpChat` 根元素带 `data-annotate-scope = sideID`（还没会话时 `side`），里面选中文字的注释进侧边聊天输入框；Composer 的注释分组改成 `sessionID ?? (side ? "side" : "home")`；注释框的 Enter 改为发出 `annotationSend(scope)`，由对应分组的 Composer 自己提交（App 不再转发）。去掉了原来的 `data-annotate-off`。
  - 重试、原地编辑重发都把原消息的 `annotations` 一起发出。
  - 原文角标（MiMo `APe`）：新组件 `AnnotationMarkers.vue`（App 里挂一个），所有待发送的回复 / 代码注释在原文上淡蓝点亮（`rgba(50,149,251,.2)`），首行上方 3px 放 19px 编号小圆标（强调色底、11px 白字、阴影、淡入；上方放不下时放到行首左侧），限制在对话区顶部以下、输入框以上；页面变化（观察 `#app`）、滚动、缩放时重算，用 16ms 定时器而不是 rAF（被遮挡的窗口不跑 rAF）；有弹窗时不显示；发送后消失。MiMo 的 `.annot-fx` 水波纹只用在它的 PDF / Office 查看器里，对话里没有。
  - 验证：`mcode-annotations.cjs` 扩到 11 项（新增角标数字 / 点亮数 / 位置 / 高度且发送后清空、点标签闪亮后消失、编辑重发带两条注释、侧边聊天注释只进侧边分组），全过；上一个提交上新增的 4 项失败、原来 7 项照常通过（探针先改成找不到注释框时不抛错，否则整段结果丢失）
- [调研] MiMo 其他会产生注释的查看器（后台只读调研，完整规格在 scratchpad `mimo-viewers-spec.md`）：PDF（react-pdf + pdfjs-dist 5.4.296，文件标签内联）、Office 标签（xlsx 用 Univer 0.25.1 + exceljs，docx 用 docx-preview，pptx 用 @aiden0z/pptx-renderer + echarts，旧格式靠自带 LibreOffice 转换）、HTML 预览标签（主进程本地预览服务 + 注入脚本点选 / 框选模块）、视频暂停后框选。图片圈选的代码在但这一版进不去。用户 2026-09-15 只选了 PDF；Word / PPT、Excel、网页模块 + 视频没做（Excel 如果做，用户倾向只读表格）。
- [已完成] 文件标签里的 PDF 查看与注释（照 MiMo `PdfView`，用户同意安装 pdfjs-dist 5.4.296，与 MiMo 同版本）：
  - 后端：`file.read` 新增 `kind: "pdf"`（按扩展名，第十七轮 R17-V4 起 PDF 不再走 base64、没有上限，改由本地预览服务按范围流式提供；图片 / 音频 / 视频与 Office 字节通道仍是 `MEDIA_LIMIT` 25,000,000）。构建：`electron.vite.config.ts` 新增 `pdfjsAssets` 插件，开发时从包里提供 `/pdfjs/{cmaps,standard_fonts,wasm,iccs}`，构建时复制到 `out/renderer/pdfjs/`；pdf.js 本体和 worker 按需加载（不进主包）。
  - `components/right/PdfView.vue`：页面是白纸（阴影 `0 1px 4px rgba(0,0,0,.15)`，间距 12，四周 16，侧栏底色），页宽 =（视图宽 − 32）× 缩放（0.5–3，步长 0.1），只画当前视图上下各一屏内的页（更远的释放）；canvas 按设备像素比绘制 + pdf.js 文字层（可选中复制）+ 链接层（只放行 http / https / mailto / tel，用系统浏览器打开）；右下角悬浮胶囊（右 14 下 12，圆角 999，内边距 4/10，12px，1px 线，阴影）：缩小、百分比（最窄 38）、放大、适应宽度、分隔线、「当前页 / 总页数」（当前页 = 底边越过视图三分之一处的第一页）；缩放保持阅读位置。
  - 注释：在某一页文字里选中后在指针处出注释框（复用 `AnnotationComposer`）；「添加到对话」加入主输入框（kind `pdf`，页码、选中文字最多 400 字、该页内第几处 / 共几处、PDF 坐标左下原点的矩形）；Enter / 箭头立刻发送「【PDF 第N页】+ 文字」并只带这一条注释（对话生成中提示「该对话正在生成中，请稍后再试」，首页没有对话时改为加入输入框），发送后该处在回复结束前有脉动框。等待中的 PDF 注释在页面上画 2px 强调色框 + 8% 底 + 15px 编号（框左上 −7，页内留 6）；点输入框里的标签：滚到该页并闪亮 1.2 秒（底 22%、编号放大 1.25 加光环）；点已发送消息下的标签：打开该文件、滚到该页、在文字层里重新找到那段（最多重试 3 秒）画琥珀色框。标签范围「第 N 页·选中『…』」，来源显示文件名；给模型的注释块加上 PDF 页码和位置。
  - 新文案 `rp.pdf.zoomIn / zoomOut / fitWidth / loading / failed`、`annotations.busy`（14 种取自 MiMo `office.*`，ar / bs / th / uk 自译）、`annotations.rangePdf` / `annotations.pdfPrefix`（MiMo 写死中文，18 种自译）。冒烟 +1（PDF 注释块），共 372。
  - 验证：探针 `mcode-pdf.cjs`（探针自己手写一个两页 PDF，含 Helvetica 文字和一个网页链接；`app.send` / `revert` 换成记录器）7 项全过：打开成两页 + canvas + 文字层 + 胶囊 + 链接、放大到 110% 页宽 ×1.1 与适应宽度、选中出框并暂存为 pdf 注释且框和编号盖在那个词上、列表文字与点击闪亮、第 2 页 Enter 直接发送带前缀和一条注释、历史标签重新定位、控制台没有 pdf.js 字体 / cmap / worker 警告；HEAD 上没有查看器，全部失败。`mcode-annotations.cjs` 11 项重跑全过。
  - 与 MiMo 的差别（已在下一条改为一致）：注释框、水波纹、全文扫描定位。
- [已完成] PDF 与注释细节改为和 MiMo 一致（用户：「和 MiMo 仍不一样的地方，都改为一样，包括界面」；逐行读了 MiMo `PdfView` 与它引用的 index 函数）：
  - 文档内联注释框 `CellAffordance.vue`（MiMo 的 cell affordance）：固定 z 4000、tip 阴影、无进场动画；右边缘在指针处、上方 8（放不下到下方），限制在查看器内 4px；占位 `annotations.cellPlaceholder`、发送按钮 `annotations.send`（原生 title）、「添加到对话」title 两行；按下查看器外关闭、滚轮关闭、每次松开清空文字。
  - 发送 = MiMo `f_e`：生成中拒绝并提示；首页无对话时新建；发出**空文字**的用户消息只带这一条注释（不再加「【PDF 第N页】」前缀，前缀只作为版本记录的提示词保存）；记下 office watch，查看器进入水波纹阶段（点燃 550ms → 运行中 → 结束 850ms → 淡出 500ms），发送的那段在页面上保留无编号框直到 Esc 或该文件有新注释进入输入框（新 `stores/annotation-batch.ts`）。
  - 水波纹 `AnnotationFx.vue` + `lib/annotation-fx.ts`：三层水波、环上旋转亮弧、结束扫光 / 爆光 / 闪光，参数照 MiMo（自己写的 CSS）。
  - 页面标记改为按 DOM Range 的每行矩形（不再按 PDF 坐标画一个大框），编号在第一行左上 −7、限制在查看器内 6px，颜色用 MiMo 的 #3295fb；只标本查看器创建的注释，重绘后从页码 + 文字 + 第几处重新定位（600ms 重试）；点输入框标签：平滑滚到页顶 −4 并闪亮 1.2 秒。
  - 定位（已发送消息的标签）：没有页码时逐页扫描文字；滚到页顶 −4 并在 3 秒内随页面高度变化保持对齐（滚轮 / 按下 / 按键打断）；按文字层 span 拼接（空白折叠，先精确后忽略大小写）找第几处；琥珀色框相对查看器、圆角 2、随滚动更新，下次松开清除。
  - 其他：页宽 = round((宽 − 32) × 缩放)、页高先用第一页比例再逐页修正（默认 1.414）；缩放不再保持比例位置（同 MiMo）；工具栏间距 6、按钮用原生 title 无悬停底色；加载 / 失败层盖满；文件在磁盘上变化时重新读取并恢复滚动位置（新 IPC `mcode:watch-file` / `unwatch-file` / `file-changed`）；链接改为真实 `a[href]` 捕获点击。
  - 对话注释也照 MiMo 调整：文字比较改为去掉所有空白并跳过不可选中的元素（`lm`/`dz`）；第几处按选区框最近的那处算；引用最多 280 字；注释框放在选区第一行上方、右对齐第一行（`nC`/`fz`，边距 8）、z 120、tip / menu 阴影、.18s 缓动、按钮原生 title；标签、角标、注释框颜色用 #3295fb。
  - 验证：`mcode-pdf.cjs` 按新结构更新后 7 项全过，`mcode-annotations.cjs` 11 项全过。
- [已完成] Office 标签页外壳 + Word 查看器（照 MiMo `RpOffice` 的 `Vc` / `yc`，规格在 scratchpad `spec-office-docx.md`；安装 docx-preview 0.3.7、jszip 3.10.1、@fontsource/carlito、@fontsource/caladea）：
  - 主进程 `src/main/office.ts`：`mcode:read-file-bytes`（限根目录内、扩展名白名单、25MB、按大小 + 修改时间返回「未变化」）、`mcode:file-size`、`mcode:watch-file`（改为 MiMo 做法：监听所在目录、按文件名过滤、400ms 去抖、比较大小和修改时间）、版本库（`<userData>/office-versions/<sha1>/manifest.json + .bin`，最多 50 个、相同内容跳过、撤销 / 重做只移动游标、回溯写回文件，失败原因 unsupported / noversion / nobin / writefail）、`mcode:office-convert-legacy`（doc / xls / ppt 用系统里的 LibreOffice `--headless --convert-to`，60 秒超时、按路径 + 修改时间 + 大小缓存；MiMo 自带和下载的 LibreOffice 运行时无法照搬，没装时提示「旧格式转换失败」并退回文件标签）、`mcode:reveal-path`。
  - 渲染进程：`stores/office-versions.ts`（版本状态 + 回溯后的 reloadTick）、`lib/ai-touch.ts`（判断磁盘变化是否来自 AI：刚完成的 edit / write / patch、项目目录内正在跑或刚结束的对话；app store 在 message.updated / session.idle / session.error 时记录）、`lib/office-open.ts`（MiMo `DS`：xlsx / docx / pptx / pdf 进 Office 标签，旧格式先转换，其他进文件标签）、右侧面板新标签类型 `office`（按文件路径复用，记录来源对话）。
  - `OfficeTab.vue`：头部类型图标（颜色照 MiMo）、文件名 600、「  · Word · 大小」、撤销 / 重做（不可用时 0.4）/ 历史版本 / PPT 演示 / 打开文件夹（`.fc-btn` 5×8、圆角 8）；`VersionHistory.vue`（320 宽、最新在前、来源图标与颜色、相对时间、「当前」标记、「回溯」= 回到该改动之前、截断时悬停出全文、Esc / 点外部关闭）；`OfficeFallback.vue`（结构化预览退路：提示条 + 空消息）。PDF 也改为在 Office 标签里打开（同一个 `PdfView`，按路径读取、磁盘变化记版本、回溯后重载、发送用来源对话）。
  - `DocxView.vue`：docx-preview 渲染（修订开、有 CSS Highlight 时渲染批注），无尺寸的页面补 A4 与 72pt / 90pt 边距；`lib/docx-fidelity.ts` 照 MiMo 修正 Symbol / Wingdings / Webdings 字符、Calibri→Carlito / Cambria→Caladea 与各平台中日韩字体链、主题东亚字体、无单位行高按字体「normal」行高缩放；缩放 = min(1, 宽 /(页宽 + 60)) × 0.5–3；右下角工具栏；`lib/docx-parse.ts` 解析修订（ins / del 顺序对应 DOM `data-rev-idx`）和批注（按范围文字 / 引用 / 段落序号挂到段落）；视图 ≥700 宽时右侧 260 宽修订栏（粘性头「修订 N 条」、删除 / 批注卡片按段落位置排布不重叠、紫色竖条 + 虚线折线连到段落、点击展开），窄时右上角「修订 N 条」胶囊；插入处悬停显示作者 / 时间 / 插入。
  - Word 注释：选中文字在选区上方出文档注释框（`CellAffordance` 新增按选区定位与聚焦事件，聚焦时用 `docx-editing` 高亮保留选区）；拖出查看器外松开也能打开；锚点 = 全文去空白后第几处 / 页码 / 页内像素矩形；发送 = 空文字消息只带这条注释（提示词「【Word 文档】…」），回复结束后若文件被改，记为 AI 版本并附段落差异摘要（「a→b;新增:c 等 N 处」）；暂存进输入框；标记层抽成 `AnnotationMarkLayer.vue`；重载后按段落映射（公共前后缀）+ 段内第几处重新定位；磁盘变化时 AI 正在跑则延后重载；Esc 清除已发送批次。
  - 附件卡片：输入框里和已发送消息里的文件卡片可点击（MiMo `DS`），文档进 Office 标签；标签点击（`C1`）：已发送消息里的文档注释打开 Office 标签（PDF 还会定位），其余发出定位脉冲由对应查看器滚动闪亮（`annotationFlash` / `pdfLocate` 取代原 `pdfJump`）。
  - 新文案 `office.*` 42 个（14 种取自 MiMo `office.*` 对象；MiMo 各语言包缺的 11 个照 MiMo 回退英文；ar / bs / th / uk 自译）。
  - 验证：新探针 `mcode-office.cjs` 8 项全过（探针用 jszip 现做一个带批注、删除、插入的 docx；从已发送消息的文件卡片打开、头部、页面与修订标记、「修订 2 条」胶囊与修订栏卡片、插入悬停、选中暂存为 docx 注释且框在文字上、磁盘改写后重载 + 撤销可用 + 历史行「手动修改（外部程序）」+ 回溯恢复原文、缩放 110%、控制台无错误）；`mcode-pdf` 7 项、`mcode-annotations` 11 项重跑全过。
  - 与 MiMo 的差别 / 没做：（「变更通知」那条已过期——`stores/office-versions.ts:35,42` → `lib/file-notices.ts` → `shared/annotations.ts` 已实现）；MiMo 由产物索引驱动的自动打开交付物、产物卡片没有（MCode 没有这套产物服务）；旧格式转换依赖用户自己装的 LibreOffice。
- [已完成] PPT 查看器 + 全屏演示（用户 2026-09-15「和 MiMo 仍不一样的地方，都改为一样，包括界面」；照 MiMo `RpOffice` 的 `Bi` / `Ei`，规格在 scratchpad `spec-pptx-xlsx.md` §A；@aiden0z/pptx-renderer 1.2.3、echarts 6.1.0）：
  - `PptxView.vue`：渲染器列表模式（`fitMode: contain`、滚动容器即宿主、`teardownAdaptiveResize` 后自己 180ms 去抖调 `handleContainerResize`），幻灯片占满面板宽、间隔 20，无工具栏无缩放；加载 / 失败层；重载时隐藏宿主并恢复滚动位置（60 帧、用户滚动超过 8px 放弃）；链接只放行 http / mailto / tel。
  - `lib/pptx-parse.ts`（照 MiMo `di` / `Js` / `ri` / `wi` / `Si` / `$i`，自己写的实现）：每页 `p:sldId`、铺满整页且带 `srcRect` 的图片裁切（含版式 / 母版）、左对齐段落、形状 id / 名称 / 文字、图表缓存数据 → echarts 配置（柱 / 条 / 折线 / 面积 / 饼 / 环 / 散点 / 气泡，雷达保留渲染器自己的）；首次打开入场时间表（每项 150ms、单页最多 12 步、页间 400ms、总长压到 18 秒）；演示用的 `p:transition` 与 `p:timing` 入场效果。
  - `lib/pptx-dom.ts`：模块命中（从最外层非整页盒子往指针方向收，面积 ≥0.5% 且有 2 个以上可见子块才继续；有文字时取文字外框外扩 12 / 8）、框选文字（相交的顶层块用「 ⏎ 」连接）、区域按幻灯片比例存取、裁切与对齐修正、图表重画（按顺序对应渲染器的图表盒子，不够时 200 / 600 / 1400ms 重试，重画后隐藏旁边的图例和标题）。
  - 交互照 MiMo：悬停模块描边（2px #3295fb、.08 底、圆角 3）；点击模块打开注释框并自动聚焦（`CellAffordance` 新增 `autofocus`）；在空白处拖动 ≥6px 画框（十字光标），小于 6px 清除本文件批次；选中文字画每行浅蓝框、不抢焦点；滚轮关闭；尺寸变化时按比例重新投影。
  - 注释：新类型 `pptx`（`slide` / `slideId` / `shapeId` / `shapeName` / `region` / `boxed`，协议与 `annotationsBlock` 同步，模型读到「slide N (slide id X), shape "名称"」或「框选区域大致从 (x%, y%) 到 (x2%, y2%)」）；发送提示词「【PPT 第n页】…」，回复结束后记 AI 版本「【第n页·框选范围 / 选中模块】…」；标签范围新键 `annotations.rangeSlide` / `rangeSlideRegion` / `rangeSlideImage`（中文照 MiMo「第 n 页·选中『…』/ 框选区域 / 图片」，其他语言自译）；标记按区域比例画，重载后吸附到区域中心下的模块；点标签平滑滚到区域并闪亮；AI 运行时的水波纹同 Word。
  - 刚由 AI 新建的文件（`ai-touch` 记录 write 工具的 `created`，`takeCreated` 只取一次）首次打开时逐页淡入、每块上浮进场，滚轮 / 按下 / 按键立即结束；减少动画（`data-motion`）时不播。
  - `PptxPresent.vue`：头部「全屏演示」从当前页开始；黑底全屏、A / B 两层切换并播放该页切换效果（淡入 / 推进 / 擦除 / 分割 / 覆盖 / 无），之后播放入场动画（淡入 / 飞入 / 擦除 / 缩放 / 分割）；点击、→、空格、PageDown 下一页（入场未播完先播完），←、PageUp 上一页，Home / End，Esc、右上角按钮或退出全屏结束；按钮和「n / N」3 秒不动鼠标淡出。新文案 `office.pptxPresentExit` / `loadingConvert` / `previewFailed`（14 种取自 MiMo，zhTW / de / ja 缺的照 MiMo 回退英文，ar / bs / th / uk 自译）。
  - 依赖整理：渲染进程才用的包（pptx-renderer、echarts、exceljs、jszip、docx-preview、pdfjs-dist、shiki、@fontsource、@univerjs）移到 devDependencies，打包不再带进 node_modules。
  - 验证：新探针 `mcode-pptx.cjs` 8 项全过（jszip 现做两页 pptx，第二页柱状图 + 淡入切换；从已发送消息的文件卡片打开、两页渲染且图表重画、悬停描边、点击模块自动聚焦并暂存为带形状名和区域的注释且编号框在模块上、空白拖框暂存后标签「第 1 页·框选区域」、演示 1 / 2 → 2 / 2 → Esc 关闭、磁盘改写后重载且撤销可用标记仍在、控制台无错误），HEAD 上 7 项功能检查全败；`mcode-office` / `mcode-pdf` 重跑；smoke 373 项（新增幻灯片注释块一项）。
  - 探针注意：`executeJavaScript` 里调 `requestFullscreen` 不算用户手势会被拒并打印错误（真实点击没问题），探针里过滤；指针移动后画的高亮要等 Vue 下一拍才出现。
- [已完成] Excel 查看器（照 MiMo `RpOffice` 的 `Ds`，规格 scratchpad `spec-pptx-xlsx.md` §B；Univer 0.25.1 + exceljs 4.4.0；按用户「都改为一样」做成 MiMo 的可编辑表格，不再是只读）：
  - `lib/univer-create.ts`：Univer 固定中文、浅色，只留底部工作表标签（无顶栏 / 工具栏 / 公式栏 / 右键菜单），`INotificationService` 换成空实现，Univer 自己不弹提示。
  - `lib/xlsx-convert.ts`（后台代理按 MiMo `xlsxToUniver` 重写）：exceljs 浏览器版读取，失败时用 jszip 去掉绘图 / 批注 / 表格部件后重试；最多 20000 行 × 200 列（超出提示「表格较大，仅预览部分行列」）；单元格值 / 公式缓存值 / 超链接 / 字体 / 填充 / 对齐 / 13 种边框 / 数字格式 / 列宽行高 / 合并 / 冻结 / 表格样式 / 主题色；颜色刻度与图标集交给 Univer 条件格式，数据条、渐变填充、图片、图表数据交给叠加层。与 MiMo 的差别（修 MiMo 的问题）：合并区域的被覆盖格不重复左上值、主题色的颜色刻度按 tint 解析、共享公式按本格翻译、富文本超链接不再显示 [object Object]。
  - `lib/xlsx-chart.ts`（后台代理按 MiMo 的 SVG 图表重写）：柱 / 条 / 折线 / 面积 / 饼 / 环 / 散点（气泡）/ 雷达 / 组合与次坐标轴、堆积、平滑、样式号取主题色、「12%」→0.12；用 createElementNS + textContent 生成（MiMo 拼 innerHTML）。
  - `lib/xlsx-overlays.ts`：各层贴在最大的 canvas 上、裁掉冻结窗格和表头，跟随滚动 / 命令 / 数值变化 / 尺寸变化重排；渐变填充与数据条（z 1）、图片与图表框（z 10，白底 1px #d9d9d9 圆角 2，选中时 8 个手柄的外框）；其他工作表的项隐藏。Univer 坑：表格没排版前 `getScrollState` 会抛错、`getCellRect` 会先打印「FRange.getCell can only be called in current worksheet」再抛错，所以所有取格子位置的调用都先看 `FWorksheet.getSkeleton()`。
  - `lib/xlsx-writeback.ts`（后台代理按 MiMo `rs`/`es`/`ns`/`ts` 重写，56 项节点测试）：只用 jszip 改 XML（行 / 格按序插入、保留 `s`、字符串写 inlineStr、布尔 `t="b"`、原有 `<f>` 保留并更新缓存值），不动共享字符串和 calcChain；新增 / 删除（仅本次新增的）/ 重命名（仅本次新增的）工作表；原有工作表改名被拦下并提示「原有工作表暂不支持重命名」；版本备注「A1:前→后;… 等 N 处」。修了 MiMo 用字符串替换写入时 `$&` 会被当成替换模式的问题。
  - `XlsxView.vue`：单元格编辑 800ms 后写回（公式格不写），右下角「保存中… / 已保存 / 保存失败」，记为「手动」版本；点单格出「修改或提问」胶囊（点击后注释框自动聚焦），框选范围或点图表直接出注释框；发送 = 空文字消息带注释（提示词「【表格 A1】…」/「【图表「标题」】…」），暂存进输入框；单元格编号标记 1px 边框 .10 底（`AnnotationMarkLayer` 新增 `cells`），AI 运行时水波纹；超链接格点击跟随（网址外部打开、`#'表'!A1` 切到该表）；重载时恢复工作表和滚动位置；磁盘变化 / 回复结束 / 回溯时重载。新 IPC `mcode:write-file-bytes`。
  - 注释：新类型 `xlsx`（`sheet` / `sheetId` / `a1`，引用为单元格值预览「前 40 个非空值 | 分隔(共 N 个单元格,已截断)」）和 `chart`（`chartTitle` / `chartKind` / `dataRef`）；模型读到 `sheet "S"!A1` + `Current cell values: …` 或 `chart "T" (kind; 数据引用)`；标签「Data!B2:C3·『…』」「Data·图表『标题』」（新键 `annotations.rangeCell` / `rangeChart` / `untitledChart`）。新文案 `office.cellEdit` / `saveSaving` / `saved` / `saveFailed` / `tooLarge` / `renameSheetUnsupported` / `versionNoteAddSheet` / `RemoveSheet` / `RenameSheet`（14 种取自 MiMo，ar / bs / th / uk 自译）。
  - 验证：新探针 `mcode-xlsx.cjs` 7 项全过（exceljs 现做带公式、超链接、图片的表；打开与头部、图片叠加宽 60、点 B2 胶囊→注释框聚焦→暂存为 `Data!B2` 值 10 且有标记、拖选 B2:C3 直接出框且标签正确、在表格里输入 42 回车后「已保存」且 exceljs 读回 B3=42 公式 D2 仍在、撤销可用、外部改写后重载、控制台无错误），HEAD 上 6 项功能检查全败。
- [已完成] 网页预览标签（照 MiMo `RpHtml`，规格 scratchpad `spec-html-video.md` §A）：
  - 主进程 `src/main/preview-server.ts`：整个应用一个只监听 127.0.0.1 的服务，按文件夹发令牌（MCode 用 24 位随机十六进制，MiMo 是 d1、d2 可被猜到），越界 403，全部 `no-store`；带 `?__mcodeedit=<nonce>` 请求 .html 时在 `</body>` 前注入 MCode 自己写的编辑脚本（悬停虚线描边、点击选模块、拖动 >4px 画框、选中后 postMessage `select`，编辑态下页面链接和按钮不响应）。IPC `mcode:office-serve`；窗口 CSP 加 `frame-src http://127.0.0.1:*`（顺带 `media-src data: blob:` 给视频预览）。
  - 右侧面板新标签类型 `html`（`openHtml` 按路径复用、记来源对话，`toggleHtmlEdit`），标签图标自画地球；`lib/office-open.ts` 把 .html / .htm 送到这里（输入框和已发送消息的文件卡片都走它）。
  - `HtmlTab.vue`：头部地球 #4f46e5、名称 600、编辑开关（笔形图标，开启时 #3295fb 底白字、提示「编辑网页 / 退出编辑」）、撤销 / 重做 / 历史版本 / 在浏览器打开 / 打开文件夹；编辑态提示条「编辑态：点选模块，或拖拽框选区域，添加批注」；iframe 白底无边框；页面发来 `select` 时在选中处打开对话注释框（`AnnotationRequest` 新增 `sendNow` 与 `onClose`：发送 = 立即发一条空文字消息带这条注释，留空也发；关闭时通知页面清除选中），`clear` 时收起；AI 写入本页（`ai-touch` 新增 `aiWrite`）时记 AI 版本并重载，写入同目录其他文件时只重载；不监听磁盘（同 MiMo）。
  - 注释：新类型 `html`（`selector` / `tag` / 模块文字前 200 字）；模型读到「the module matching CSS selector `#hero` <h1>, containing "…"」，有网页注释时块尾加一句处理原则（MCode 自己的措辞）；标签「模块 『…』/ 模块 <tag>」（新键 `annotations.rangeModule` / `rangeModuleTag`）。新文案 `html.noPage` / `edit` / `exitEdit` / `editHint` / `openBrowser` / `annotateFull`（14 种取自 MiMo，ar / bs / th / uk 自译）。
  - 验证：新探针 `mcode-html.cjs` 7 项全过（从已发送消息的 .html 卡片打开、地址是 127.0.0.1 + 24 位令牌、样式表加载且注入了编辑脚本、编辑态提示条与页面点击被拦、点标题暂存为 `#hero` `h1` 注释、拖框后回车立即发出空文字消息带注释、退出编辑提示条消失、控制台无错误；通过 Electron 的 `framesInSubtree` 在页面框架里派发鼠标事件），HEAD 上 6 项功能检查全败。smoke 374 项（新增表格 / 图表 / 网页注释块一项）；`mcode-pptx` / `mcode-office` / `mcode-pdf` / `mcode-annotations` 重跑全过。
  - 没做：MiMo 由产物服务驱动的「网页卡片」和自动打开（MCode 没有产物服务，同之前的决定）。
- [已完成] 视频预览框选（照 MiMo `L8e`，规格 scratchpad `spec-html-video.md` §C）：
  - `lib/image-preview.ts` 改成 MiMo 的单一预览槽：打开视频会关掉图片，反之亦然；新组件 `VideoPreview.vue` 挂在 App 里 ImagePreview 旁边，计入 `modalOpen`。
  - 入口：输入框附件区和已发送消息里的视频附件（`lib/attach.ts` 新增 `videoUrl`），显示为静音缩略画面，悬停「点击预览」。
  - 界面：黑色 .5 遮罩 + .72 内容层、.2 秒淡入缩放；视频最高 78vh、圆角 8，打开时暂停；下方浅色控制条（播放 / 暂停 30px、`当前 / 总长` 等宽数字、进度滑块强调色 #ff6a2b）；提示「播放中 · 点击画面暂停 /已暂停 · 在画面上拖拽框选当前帧来批注」。
  - 交互：播放中按下画面只暂停；暂停时拖动画框（宽高都小于 5px 忽略），框按视频实际内容区（去掉黑边）换算成比例并记下当前时间，在框旁打开对话注释框（`AnnotationRequest` 新增 `above`：层级 320 盖在预览上；`emptyEnterStashes`：空注释回车只加入不发送）；加入后框在画面上带编号，只在播放位置离该时刻 0.4 秒内显示；Esc 先清掉未完成的框，再关预览；点黑色背景关闭（拖完后的那次点击不算）。App 在视频预览打开时不禁用注释框（`disabled = modalOpen && !videoPreview`）。
  - 注释：新类型 `video`（`region` / `timeSec`；附件视频没有本地路径时写明「An attached video … whose local path is unknown」，不像 MiMo 那样误称附了截图）；标签「圈选区域@0:07」（新键 `annotations.rangeVideo`）；文案 `videoPreview.title` / `play` / `pause` / `progress` / `hintPlaying` / `hintPaused`（14 种取自 MiMo `components` 分包，ar / bs / th / uk 自译）。
  - 验证：新探针 `mcode-video.cjs` 7 项全过（页面里用 MediaRecorder 从 canvas 录一段 webm 作为已发送附件；打开后暂停、提示与时长、拖框出框且注释框层级 320、暂存为带比例区域和时刻的 video 注释且画面编号 1 个、没有发送、第二个框空注释回车只加入、播放提示与按下暂停、Esc 关闭、控制台无错误），HEAD 上 6 项功能检查全败；`mcode-annotations` / `mcode-html` / `mcode-xlsx` 重跑全过。
  - 探针坑：合成的 PointerEvent 的 pointerId 不是活动指针，`setPointerCapture` 会抛 DOMException，在 Vue 事件里未捕获就会进 MCode 的致命错误页——组件里已加 try/catch。
  - MiMo 图片预览里的圈选批改在它那一版本身就进不去（规格 §B），不做。
- [已完成] 二次复核（用户 2026-09-15「二次复核代码，检查BUG」）：四个只读代理分别审 PPT、Excel、网页 / 视频、Office / Word / PDF，共报 50 条，逐条核实后修复（三个修复代理按文件分工 + 我修 PPT），全部探针重跑通过。要点：
  - PPT：并发重载时旧加载的 destroy 清空新幻灯片（每次加载渲染进自己的容器、成功后才用掉保存的滚动位置）；调整大小时渲染器整组重画导致跳页（记住当前页与页内比例并滚回，演示中不重画）；过期加载覆盖修正数据；点模块后旧文字选区残留；隐藏 / 未挂载时渲染跳过图片裁切（量不到尺寸时重试，演示下一页先占位再渲染）；入场动画被打断清掉标记；演示中 Esc 清掉已发批次；恶意图表点数撑爆内存（上限 10 万）。
  - Excel：加粗等只改样式的操作把单元格值写成空（没有 `v` 字段就跳过）；保存期间的新编辑被清；重载 / 回溯后旧保存覆盖新文件（按加载保存字节、写前检查）；图表工作表导致序号错位（只数 worksheet）；数值仅差浮点噪声时刻度循环卡死（整数计数、上限 50）；关闭 / 换文件时未保存编辑丢失（磁盘未变才补写，失败重试 3 次）；`x:` 命名空间前缀、`r` 不在首位的单元格、控制字符、公式重算标记 `fullCalcOnLoad`（仅已有 calcPr 时）、冻结窗格恢复滚动偏移、换文件恢复到旧文件视图、大范围数据条、跨表版本备注合并。
  - 网页 / 视频：预览页可导航主窗口并拿到 `window.mcode`（iframe 沙箱 + 主窗口 `will-navigate` / `will-frame-navigate` 只允许应用自己的页面）；所有预览文件夹同源、可读 `.ssh` 等隐藏文件（改为每个令牌一个 `*.localhost` 源、校验 Host、点开头的路径一律 404、同端口同时监听 `::1`）；页面可伪造「选中」反复弹框抢键入（只收来自该 iframe 的消息，且只在鼠标位于 iframe 上方时接受——代理先做的「焦点检查」被页面自己 `window.focus()` 绕过，探针抓到后改成父窗口里 iframe 元素的 mouseenter / mouseleave，页面伪造不了）；AI 一次写多个文件时漏重载（批量发布、规范化 `.` / `..`）；视频框选后第一次点背景关不掉；版本初始化并发；盘符根目录网页 403；畸形请求挂住连接；视频上的注释框被隐藏的输入框顶上去。
  - Office / Word / PDF：发送 Word 注释途中滚动 / 重载导致致命错误页；版本库并发写丢版本、残留 `.bin`（按文件串行 + 独立临时文件，25 路并发验证）；PDF 从不保存原始版本；无查看器时工作灯监视不清除（会话空闲 5 秒后清理，布防时跳过已结束的会话）；盘符根目录文档打不开；Word 运行结束的「选中文本;改动摘要」备注被吞；PDF 重载重置缩放却恢复旧滚动；文件监听竞态 / 路径写法不一致 / 窗口销毁不释放；LibreOffice 失败结果被缓存、超时不杀进程树；旧格式文件重复开标签；Word 过期加载抢滚动恢复；适配缩放因滚动条闪烁；批注全局高亮泄漏；表格写入改为原子替换且只允许 `.xlsx` / `.xlsm`。
  - 没修（有意保留）：运行中的同项目对话会把用户手改记为 AI 版本——这是 MiMo 的做法。
  - 验证：typecheck / i18ncheck / wiringcheck / themecheck / mdcheck、smoke 374 项；探针 `mcode-pptx` 8、`mcode-office` 8、`mcode-pdf` 7（发送桩改为像真实发送一样把会话标为运行中）、`mcode-annotations` 11、`mcode-xlsx` 7、`mcode-html` 10（新增拦截主窗口跳转、真实鼠标进出信号、鼠标不在页面上时忽略「选中」）、`mcode-video` 8 全过；代理的脚本测试：写回 101 项、图表刻度 52 项、office.ts 35 项、预览服务探针全过。
  - 探针坑：后台显示（未激活）的窗口里，`sendInputEvent` 的鼠标事件进不了跨站点 iframe 的进程，但父窗口能收到 iframe 元素本身的进出事件；Node 解析不了 `*.localhost`。
- [已完成] 回复里的视频链接卡片（用户 2026-09-15「把回复里的视频链接卡片也做了」；照 MiMo `MarkdownImpl` 的 `a` / `img` 渲染）：
  - `lib/markdown.ts`：新选项 `videoCards`；链接地址是 http / https / data / blob / file 且扩展名为 mp4 / m4v / webm / mov / ogv（MiMo 的判定），或图片语法 `![]()` 的地址是视频时，渲染成卡片按钮（10px 上下外边距、圆角 10、1px 边框、#f0f0f2 底（深色 #2e2e2e）、9×12 内边距、13px、16px 橙色播放三角 + 截断的链接文字，空文字用「视频」，悬停提示「点击预览批注」）；其他链接照旧是「文字 + 灰色网址」，不可点。地址和文字在转义之后才进属性，mdcheck 16 个恶意输入仍全过。
  - `TextPart.vue`：点卡片时 http / https / data / blob 直接进视频预览；file: 地址（Windows 盘符转成反斜杠路径）或图片语法里的本地路径（相对路径按当前会话目录）交给本地预览服务，拿到 127.0.0.1 地址再预览，注释带真实文件路径；文件不存在时提示「文件不存在」。
  - `src/main/preview-server.ts`：允许 mp4 / m4v / webm / mov / ogv；网页以外的文件改为流式输出并支持 Range（206 / 416、HEAD），视频能拖动进度。窗口 CSP `media-src` 加 `http: https:`（只在点开预览后才会加载）。
  - 新文案 `markdown.previewAnnotateTip` / `markdown.videoFallbackLabel`（14 种取自 MiMo `thread` 分包，ar / bs / th / uk 自译）。
  - 注：复核后本地预览地址改为每个文件夹一个源 `http://<令牌>.localhost:<端口>/`（见下一条），探针的 Range 请求改为直连 127.0.0.1 并带 Host 头（Node 解析不了 `*.localhost`，Chromium 可以）。
  - 验证：`mcode-video.cjs` 新增第 8 项 `replyCard`（回复里 file: 链接和图片语法各出一张卡片、标签「演示片段 / 视频」、提示文案、普通链接仍是文字、点卡片后 src 是 127.0.0.1 + 24 位令牌且视频可读、Range 请求返回 206 且正好 100 字节、框选暂存的 video 注释带文件路径）。
- [已完成] 顶栏图标重画（小）——用户反馈顶栏图标不如 MiMo 好看、工整。实测 MiMo 顶栏图标规格（只读取尺寸和描边，不复制路径）：24 网格、2 单位圆头描边、显示 14px（线宽约 1.17px，字形约 10–11px）；铃铛 16px / 1.75 描边；信息卡列表 15px。MCode 原来是 17px、20 网格、1 单位方头描边（线宽约 0.85px、字形偏大）。重画侧栏顶部一排（切换侧栏 / 后退 / 前进 / 搜索 / 铃铛）、折叠后的同一排、聊天头「…」/ 列表 / 底部面板、侧边面板开关，全部自己画在 24 网格上。颜色按 MiMo 顶栏图标色：深色主题用最强文字色，浅色主题用它的 60%（用 `data-theme` / `prefers-color-scheme` 选择器，没有新 token）。探针 `mcode-topbar-icons.cjs` 5 项（尺寸 / 网格 / 线宽 / 圆头 / 在 24px 按钮里居中 / 深色颜色），换回旧代码时 4 项失败（居中本来就是对的）；`mcode-titlebar.cjs` 的颜色期望随之改为最强文字色。首页右上角的底部面板按钮见下一条
- [已完成] 首页也能打开底部终端，首页右上角加底部面板按钮（小，用户同意）——MiMo 首页右上角有「底部面板 / 侧边面板」两个按钮。MCode 原来的底部终端只属于会话：`terminalUp` 排除首页，后端 `shell.open` 必须带 sessionID，所以首页的「终端」入口实际打不开。现在：协议 `shell.open` / `shell.list` 在没有 sessionID 时可以传绝对路径 `directory`，后端 `shellGroup` 以 `home:<目录>` 分组（Shells 里的 sessionID 本来就只是分组键），相对路径拒绝；HomeHero 把当前选中的项目目录 `emit('directory')` 给 App（「无项目」时为空）；TerminalDrawer / TerminalPane 改成用 `sessionID` / `directory` 属性，不再读 `app.currentID`（否则首页会开到上一个会话的目录）；App 在首页切换时按 `home:<目录>` 重新挂载抽屉；首页按钮 24px、在侧边面板开关左侧 4px、按下不高亮，无项目时禁用（0.35）。探针 `mcode-home-terminal.cjs` 5 项（真的在临时目录起一个本地 shell，随应用退出），换回旧代码时 4 项失败（相对路径被拒绝那项旧代码本来也拒绝）；`mcode-titlebar` / `mcode-topbar-icons` 重跑通过
- [已完成] 会话悬停信息卡、标题栏置顶图钉、提示框样式（小）——核实 MiMo `fOe` 聊天头与 `Cz` / `q7e`：会话标题（向下）和侧栏会话标题（向右）悬停时出信息卡：标题（medium）+ 11px 弱色的「项目 名称」、目录、「更新于 MM月DD日 HH:MM」（中文补零，其他语言用 Intl 短月日 + 时分），卡片圆角 20、0.5px 边框、内边距 10 / 14、12px；普通提示 MiMo 是圆角 8、1px 边框、内边距 5 / 8、12px，出现延迟 200ms、连续悬停 300ms（原来 MCode 4px 圆角、无边框、11px、500 / 400ms）。标题栏：置顶的会话在标题前显示 14×26 弱色图钉（悬停「已置顶」）；标题去掉内边距和悬停底色，高 26、最宽 320；原地改名输入框按 MiMo 为 1px 细边框、圆角 7、左右 8；「…」按 MiMo 为 26px、弱色、14px 图标；左侧三者间距 8。实现：`lib/tip.ts` 新增 `card` 模式（标题 + 若干行，空行跳过），`lib/convo-card.ts` 生成卡片内容，新键 `convoTip.project` / `convoTip.updatedAt` / `header.pinnedTip`（18 张表，MiMo 有的语言照它的译法，ar / bs / th / uk 自译）。探针 `mcode-convo-card.cjs` 8 项（真实指针悬停；1.75 倍缩放下 1px 边框读出来是 0.571px，所以和同页的 1px 参照元素比），换回旧代码时 7 项失败；`mcode-topbar-icons` 的「…」期望改为 14px，和 `mcode-titlebar` / `mcode-row-title` / `mcode-hide-three` 一起重跑通过。注意：MiMo 渲染进程的各语言分包也用 `@electron/asar` 读不出来，同样要解析 asar 头部
- [已完成] 拖放提示层（小）——核实 MiMo `nH` 拖拽钩子和 `.chat-drop-overlay`：把文件或链接（`Files` / `text/uri-list`，纯文字不算）拖进窗口时，主栏盖一层强调色 8% 的底、2px 强调色 55% 虚线框，中间卡片「松开以添加文件」（圆角 12、内边距 10 / 18、14px 中等字重、强调色字）；输入框拖拽高亮是 2px 强调色 35% 的光环。MCode 原来整窗都能接收拖放，但只有输入框自己亮一圈（1px + 底色），没有提示层。现在 App.vue 在 window 上跟踪 dragover / dragleave（relatedTarget 为空才算离开窗口）/ drop / dragend，有弹窗或遮罩（`.scrim` / `.overlay`）时不显示，提示层画在 `.main` 里、不挡鼠标，放下仍由输入框处理；输入框光环改成 MiMo 的。新键 `composer.dropOverlay`（18 张表，MiMo 有的语言照它，ar / bs / th / uk 自译）。探针 `mcode-drop-overlay.cjs` 8 项（页面里用带真实 File 的 DataTransfer 派发拖拽事件，不打开任何选择器；关掉过渡读终值），换回旧代码时 4 项失败（平时不显示、纯文字不显示、离开清除、遮罩下不显示这 4 项旧代码因为根本没有提示层也成立）；`mcode-home-terminal` / `mcode-convo-card` / `mcode-hide-three` 重跑通过。与 MiMo 的差别：MiMo 只有主栏接收拖放，MCode 仍是整个窗口都能放下
- [已完成] 提问里的代码块（小）——核实 MiMo `HarnessRow` 的 `ya` / `Ua` / `en`：提问按 ``` 围栏切成文字段和代码段（开头行 `^(`{3,})([\w#+.-]*)\s*$`，结束行反引号不少于开头；没有结束行就整段当文字；文字段去掉首尾空行、空段丢弃）；文字段各自按 14 行 / 1200 字折叠；代码段用和回复相同的代码块（语言名 + 复制），超过 14 行截到 264px、底部 56px 渐隐到代码底色，下方 12px 弱色按钮「展开全部 N 行」/「收起代码」。MCode 新增 `lib/question-parts.ts`；MessageStream 对带代码块的提问逐段渲染（气泡 `white-space: normal`，只有文字段保留空白，避免块之间出现空行），代码段用 `renderMarkdown` + `codeActions` 包在 `.text` 里复用回复的代码块样式，复制按钮照 TextPart 处理；「展开全部 N 行」沿用 `stream.expandAsked`，新键 `stream.collapseCode`（18 张表，MiMo 有的语言照它，ar / bs / th / uk 自译）。探针 `mcode-question-code.cjs` 8 项（在页面 store 里放 4 条假提问，剪贴板换成记录器），换回旧代码时 6 项失败（没闭合的围栏当文字、无代码长提问照旧折叠这两项旧代码本来就对）；`mcode-asked-fold` / `mcode-convo-card` 重跑通过。注意：含反斜杠的修补脚本要用 Write 工具写成文件再运行，别走 heredoc
- [已完成] 大段粘贴转附件（小）——核实 MiMo 输入框 `In` 粘贴处理和主进程 `savePastedText`：粘贴纯文字达到 256×1024 个字符（`UIe`）时不插入输入框，存成临时文件 `mimo-paste-<时间>-<随机>.txt` 作为附件随消息发送，并弹提示「粘贴内容较大，已转为文件附件随消息发送」；保存失败才照常插入。MCode 在渲染进程直接生成 `text/plain` 附件 `mcode-paste-<时间>-<随机>.txt`（仍受 8MB 附件上限，超出时提示文件过大），弹同样的提示；剪贴板里是文件时照旧按文件附件处理，门槛以下照常粘贴。新键 `composer.pasteAttached`（18 张表，MiMo 有的语言照它，ar / bs / th / uk 自译）。探针 `mcode-paste-attach.cjs` 4 项（在输入框上派发带 DataTransfer 的合成粘贴事件，不碰真实剪贴板），换回旧代码时「达到门槛转附件」失败，其余 3 项旧代码本来就对；附件内容在生产构建里读不到组件状态，只记录不判定；`mcode-drop-overlay` 重跑通过。**没做**：MiMo 对较小的、看起来像代码的粘贴会按它自己的语言识别规则自动包成 ``` 代码块，这套识别规则是它的代码，未照搬
- [已完成] 输入框拖拽调高（小）——核实 MiMo 输入框 `hH`：顶边一条把手（绝对定位 top -5、左右各 12、高 10、上下箭头光标，悬停时中间出现 36×3 小横条，提示「拖拽调整输入框高度，双击恢复自动」）；按住移动超过 6px 才算拖动，高度 = 起始高度 + 向上拖的距离，限制在 44 到 min(480, 窗口高度一半)；松手记进 localStorage（首页 `composer.manualHeight.home`，会话和侧边聊天共用 `composer.manualHeight.dock` 并用事件同步）；只按下不动不改变；双击恢复自动。没设高度时随内容撑高、上限 200，内容达到 3000 字或 30 行时固定 200；设了高度后输入框上限 min(480px, 50vh)、下限 44 并可滚动。MCode 原来只有随内容撑高（JS 限 260、CSS 限 180），没有把手。Composer 照此实现（`fresh` 用 home 键，其余用 dock 键），setPointerCapture 失败时忽略；新键 `composer.resizeHandle`（18 张表，MiMo 有的语言照它，ar / bs / th / uk 自译）。探针 `mcode-resize-composer.cjs` 8 项（在把手上派发 PointerEvent；位置相对输入框边框内侧量、允许 1px 取整误差），换回旧代码时 8 项全失败（旧代码没有把手）；`mcode-paste-attach` / `mcode-drop-overlay` 重跑通过
- [已完成] 侧栏「置顶」分区（中）——核实 MiMo `dI` / `oN` / `WS` / `JS` / `kP`：侧栏自上而下是「置顶」「项目」「最近」。置顶分区（可折叠，折叠状态记住）先列置顶会话（按置顶先后，新置顶追加在后），再列置顶项目（`pinToFront`，最新置顶的在前）；合计先显示 5 条，其余在「展开更多」后（先会话后项目），当前打开的会话在被收起的部分里时自动展开。置顶会话不再出现在项目下的任务列表和「最近」里，置顶项目不再出现在「项目」列表里（也不计入项目分页）。置顶会话行开头是 46px 的会话图标格、标题从 46 开始；项目行上不再画图钉。置顶 / 取消置顶会话提示「已置顶」「已取消置顶」，置顶 / 取消置顶项目提示「已置顶项目」「已取消置顶」。MCode 实现：Sidebar 顶部改为一个有序的 `columnBlocks` 列表（置顶标题、置顶会话、项目块、展开更多、项目标题、普通项目、分页）一次渲染，项目块模板共用；`projects` 每项多一个去掉置顶会话的 `children`；App 项目菜单的置顶改成放到最前并提示；store `togglePinned` 加提示。新键 `side.expandPinned` / `side.projectPinnedToast` / `side.projectUnpinnedToast` / `side.pinnedToast` / `side.unpinnedToast`（18 张表，MiMo 有的语言照它，ar / bs / th / uk 自译），分区标题沿用 `side.priorityPinned`。探针 `mcode-pinned-section.cjs` 8 项（三个临时项目，会话从 store 置顶，项目走真实右键菜单置顶），换回旧代码时 8 项全失败；`mcode-compact-rows` / `mcode-row-scrim` / `mcode-row-title` / `mcode-proj-pages` / `mcode-convo-card` / `mcode-hide-three` 重跑通过。注意：探针用 executeJavaScript 返回 store 里的响应式数组会报 could not be cloned，要先展开成普通数组
- [已完成] 回复里表格的预览和复制（小）——核实 MiMo `MarkdownImpl` 的 `Tn` / `An` / `Mn` / `Sn` 和 `.md-table-*` 样式：表格左右各外伸 24px、在自己的滚动条里横向滚动；右上方一条 56×26 的按钮区（在表格上方 6px、距末端 24px），平时隐藏，悬停或聚焦表格时出现，两个 26px 图标按钮「预览表格」「复制表格」（图标 12px、描边 1.7）。复制用 ClipboardItem 同时写纯文本（Markdown 管道表格）和 HTML（去掉 class 的表格），不支持时退回只写文本，成功后按钮变对勾 2 秒，失败提示「复制表格失败」。预览是全屏半透明遮罩里最宽 1120px 的对话框，标题栏 46px（「表格预览」+ 关闭按钮），Esc、关闭按钮、点遮罩都能关。MCode 原来的表格没有任何按钮。实现：`renderMarkdown` 新增 `tableActions` 选项生成容器和按钮，`TextPart.vue` 处理复制和预览（预览用 Teleport 挂到 body），样式照 MiMo。新键 `table.actions` / `table.preview` / `table.previewTitle` / `table.previewClose` / `table.copy` / `table.copyFailed`（18 张表，MiMo 有的语言照它，ar / bs / th / uk 自译）。探针 `mcode-table-actions.cjs` 7 项（页面 store 里放一条带表格的回复，剪贴板换成记录器），换回旧代码时 7 项全失败；`mcode-question-code` 重跑通过

对话视图 / 输入框：
- [已完成] 代码块复制按钮（小）——`renderMarkdown(text, { codeActions })` 只在回复正文（TextPart）里给代码块加标题栏：小写语言名 + 复制按钮，复制后 2 秒显示「已复制」，失败弹「复制失败」；导航条卡片、上下文页等其他调用方输出不变。探针 `mcode-code-copy.cjs` 在页面里替换 `navigator.clipboard.writeText`，不碰真实剪贴板
- [已完成] 失败 / 停止 / 空回复的轮次带「重试」和耗时（中）——MessageStream：失败卡片（原因最多约 6 行 + 重试胶囊）、「已停止（耗时 X）」「（无内容返回）」下方的重试按钮；重试 = `app.revert(会话, 提问)` 后 `app.send(原文, 原附件)`，生成中或找不到提问时提示无法重试。探针 `mcode-retry.cjs` 在页面 store 里注入轮次、把 revert/send 换成记录器，不调用模型；假回复要从真实回复克隆（页脚会读 model 字段）
- [已完成] 每轮末尾「已编辑 N 个文件」卡片：增删统计、撤销、审阅（大）——新组件 EditedFilesCard.vue，照 MiMo HarnessRow 的 file-card：回合结束后（正在运行的最后一轮不画）在回合内容之后、footer 之前；10 圆角 1px 边，头部 66px（40px 图标格：多文件 / 新建 / 已编辑三种图标），标题单文件「已编辑 文件名」（点文件名用系统打开，title 为路径）、多文件「已编辑 N 个文件」，下方等宽 +a -d；右侧「撤销 ↶」（无边框）和「审阅」（有边框），高 26；多文件时下面列文件行（36px，悬停底色，tip 为路径，各自 +/-），默认 3 行，「再显示 N 个文件 / 收起」。撤销先出确认卡（暖色底边，「确定撤销 N 个文件的改动？只撤销本回合的编辑（保留之前几轮的改动），本回合新增的文件将被删除，不可恢复。」确定撤销 / 取消），确定后调用新请求 `session.revertTurn {sessionID, messageIDs}`：服务端 src/server/session/turn-revert.ts 按回合内 edit/write/patch 的 diff 逆向应用（src/shared/unified-diff.ts 按 hunk 行数解析、多文件拆分，hunk 找不到原位就就近查找，找不到则该文件不动算失败），本回合新建的文件删除，项目外路径跳过；有文件变动时给回合最后一条 assistant 消息写 `reverted: true`，卡片变成「已撤销 N 个文件的改动」且重开仍保留；toast 按结果显示 已撤销 / 部分失败 / 项目外取消 等。不依赖 git（MiMo 需要 git，MCode 的逆向 diff 不需要）。审阅通过 lib/review-request.ts 让 App 打开右侧审阅。侧边对话不显示操作按钮。LiveEditPill 改用同一个 lib/edited-files.ts 统计。文案 stream.editedCard 等 16 个键（18 种语言）。smoke +8（diff 拆分、逆向、位移后仍能找到、找不到拒绝、「-- 」行不误判为文件头、回合撤销恢复/删除/跳过项目外），共 369。探针 mcode-edited-card.cjs 8 项全过（真实写入存储的两轮消息，磁盘文件确实恢复），HEAD 上 8 项全败。
- [已完成] 输入框旁「N 个文件已更改 +a −d」胶囊（中）——新组件 LiveEditPill.vue，照 MiMo 的 CRe / .live-edit-pill：从当前对话 assistant 消息里 edit / write / patch 工具部件（非 error、带 metadata.diff）统计不同文件数（patch 用 metadata.files；项目外的路径 ../ 或不在项目目录下的绝对路径不计），+/− 只数 hunk 内的行（新文件头 `--- `+`+++ ` 结束上一个 hunk，patch 的第二个文件头不算删除）。胶囊 32 高、12 圆角、1px 边、13px 中字重，统计为等宽 12px 600（绿 +、红 −），挂在输入框顶边上方 8px、与输入框同列居中（App.vue 里零高度的 .live-edit-anchor，补回 composer 顶部 4px 内边距，信息卡打开时同样让出 262px）。点击打开 / 收起右侧审阅（aria-expanded 跟随），权限卡片出现时不画，空对话不画；有胶囊时「回到底部」按钮抬到 48px。文案 composer.filesChanged（18 种语言）。探针 mcode-live-edit-pill.cjs 5 项全过，HEAD 上 4 项正向检查全败。
- [已完成] 原地编辑最后一条提问（中）——核实 MiMo `HarnessRow` 的 `Ga` / `Ka`：只有最后一条提问有「编辑」（悬停操作里），双击该气泡也会进入编辑并全选；编辑时这一行占满整列、左对齐，气泡变成同色圆角 16 的框，里面是随内容长高的输入框（14px / 行高 20，占位「编辑消息…」），下方靠右「取消」（描边）/「发送」（实心，内容为空或对话进行中时禁用），对话进行中时左侧显示「对话进行中，无法编辑重发」；Enter 发送、Shift+Enter 换行、Esc 取消；发送 = 回滚到这条提问之前再发送新内容。MCode 原来每条提问都有「编辑」，点了是回滚并把原文放回底部输入框。现在按 MiMo：只有最后一条提问有编辑按钮、双击气泡全选编辑，原地编辑框和按钮如上，发送时 `app.revert` 后 `app.send` 新内容，进行中时提示并不发送；成为非最后一条时自动退出编辑。MessageStream 的旧 `revert()` 和 `useRestoreDraft` 引用删除（RevertDock 仍在用 `restoreDraft`）。新键 `stream.editPlaceholder / editSend / editBusy`（18 张表）。探针 `mcode-edit-asked.cjs` 7 项（store 里放两轮问答，`revert` / `send` 换成记录器，不调用模型），换回旧代码时 7 项全失败；`mcode-asked-fold` / `mcode-question-code` / `mcode-retry` / `mcode-steer` 重跑通过
- [已完成] 长提问折叠「展开全部 N 行」（小）——核实 MiMo `HarnessRow`：超过 14 行或 1200 字（不计末尾换行）就折叠，折叠时高 264px、底部 56px 渐隐到气泡底色，下方 12px 弱色文字按钮「展开全部 N 行」/「收起」，双击按钮不冒泡。MessageStream `foldable` / `askedLines` / `openAsked`；气泡保留空白，所以正文和按钮必须写在同一行（探针检查气泡里只有 SPAN 和 BUTTON 两个节点）。探针 `mcode-asked-fold.cjs` 6 项，阈值改 30 行时 4 项失败。提问里的 ``` 代码块见下方「提问里的代码块」一条
- [已完成] 权限卡片：拒绝并说明、查看改动 / 完整命令开关、队列 1/N、方向键（中）——PermissionDialog.vue 按 MiMo 的卡片重写：一个 20px 圆角的 dock（最高 72vh，内部滚动）；头部「请求{动词}」（bash 执行命令 / 删除类执行删除命令 / edit 修改文件 / write 写入文件 / outside 访问工作目录外的文件 / webfetch 访问网络 / 其余执行操作，其余种类把标题作为小标签），bash 的 description 作为灰色小标签，末尾「1/N」（N>1 才显示，title 共 N 个待确认请求…）；命令框 `$ 命令`，多行或首行超 120 字只显示首行，右侧 22px 按钮切换 查看完整命令 / 收起命令；有 diff 时「▸ 查看改动 / ▾ 收起改动」折叠；按钮 拒绝 / 拒绝并说明（灰字）/ 总是允许 / 本次允许（实心，data-cnav-primary），中文文案改为 MiMo 的「本次允许 / 总是允许」；拒绝并说明展开输入框（占位 说明拒绝原因(反馈给模型)）+ 提交，Enter 提交。键盘照 MiMo：请求到达时 dock 取焦（输入框里已有文字则不抢），方向键在按钮间循环，Enter 在已接管的 dock 上点本次允许，焦点借自空输入框时第一个其它按键把焦点还回去；Escape 不再拒绝（2026-09-14 用户要求照 MiMo 去掉，PermissionDialog 的 `covered` 属性一并删除；探针 mcode-config-watch.cjs 验证按 Esc 不应答、卡片仍在）。后端：`permission.respond` 可带 `reason`，拒绝理由写进 PermissionDenied 交给模型；bash 命令属于 LOST_WORK（删除 / reset）时请求带 `forced: true`，每次都问、不给总是允许、之前的总是允许也不覆盖它。store 的 pendingPermissions 改为每个会话一个队列（原来只存最后一个，前一个会永远挂起），新增 `permissionQueue`；打开会话不再清掉它的待确认请求。smoke +5（理由传给模型、普通命令非 forced、删除无视总是允许、批准后执行、总是允许不被记住），共 361。探针 mcode-perm-card.cjs 8 项全过，HEAD 上 8 项全败。
- [已完成] 轮次进行中末尾的「工作中」动画条（小）——核实 MiMo `HarnessRow` 的 `t1` 和 `.thread-work-indicator` / `.work-loading--cascade` 样式：轮次运行期间（等用户输入时除外）在这一轮末尾、已到达内容的下方一直显示：40×14 的框、最强文字色 58% 透明度，里面 34×7 的一排四个图形，按 1.8s 循环依次上浮变亮（错开 1/10 循环），`role=status`，读屏文字「正在组织下一句回复」。MCode 原来只在第一段内容出现前显示「思考中」闪烁文字，内容一到就消失。现在 MessageStream 改为这个指示器（四个图形是 MCode 自己画的圆点，不用 MiMo 的图形），有待确认的权限请求时隐藏，压缩对话时照旧显示。`stream.thinking` 换成 `stream.workLoading`（18 张表）。探针 `mcode-work-indicator.cjs` 6 项（在页面 store 里标记运行中、放入回复和权限请求，不调用模型），换回旧代码时 4 项失败（空闲不显示、停止后消失这两项旧代码本来就对）
- [已完成] 生成中插话显示为当前轮次里的气泡并标「已插话」（中）——核实 MiMo `HarnessRow` 的 `user-steer` 步骤：轮次运行中发出的消息不另起一轮，而是作为这一轮里的一个步骤，出现在它到达时的位置，靠右、最宽 78%、和提问同样的气泡（圆角 16、内边距 9 / 13、14px 中等），附件在气泡上方；模型还没接收到时气泡下方显示 12px 弱色「已插话 · 会尽快处理」，之后提示消失、气泡留在原位。MCode 后端本来就支持往运行中的轮次追加消息（runner `join`），但界面把它当成新的一轮（新提问气泡 + 后面的回复），看起来像另起了一轮。现在：后端 `join` 保存消息时标记 `steered: true`（协议 `UserMessage.steered`）；MessageStream 分组时带这个标记的用户消息放进当前轮次的 `steers`（记下它之前有几个 part），`shown()` 按位置插入 `steer` 行；「已插话」提示在它之后还没有新的助手消息、且会话在运行时显示。**注意**：一开始用「前一条助手消息没有 finish 就算插话」来猜，结果把「应用中途关闭的轮次之后的下一个新提问」也吞进去了（`mcode-asked-fold` / `mcode-question-code` / `mcode-retry` 三个旧探针都因此失败），所以改成后端明确标记；没有标记的旧记录照旧各自成轮。新键 `stream.steerWaiting`（18 张表）。探针 `mcode-steer.cjs` 7 项（store 里放消息、标记运行中，不调用模型），换回旧代码时 5 项失败（普通两轮、未标记的中断轮次这两项旧代码本来就对）；smoke 新增一条后端检查（在 runner 的 steering 表里放一个进行中的轮次，再 prompt，确认保存的消息带 `steered`）；上面三个旧探针和 `mcode-work-indicator` 重跑全部通过
- [已完成] 已发送图片点击预览（缩放、旋转、复制、下载）（中）——核实 MiMo `HarnessRow` 的 `Va`（发送的图片 64×64、圆角 12、提示「点击预览」）和 index 里的图片预览（`openImagePreview` + 预览组件）：72% 黑色遮罩；图片按窗口减去四周 40px 适配后以 80% 显示；右上角（Windows 在右）40px 圆形关闭按钮，悬停提示「关闭预览 Esc」；底部浮条（半透明黑、圆角 14、内边距 6）：缩小 / 百分比 / 放大 / 旋转 / 复位 | 下载，每个 40px 按钮悬停显示名称和快捷键；缩放范围 20%–800%（按钮与 +/- 键 ×1.2 / ×0.83，Ctrl+滚轮 ×1.12 / ×0.89），滚轮上下平移，拖动平移（限制在溢出窗口的范围内），R 旋转 90°，0 复位，D 下载（带图片名的链接），← / → 在同一条消息的图片之间切换，Esc 或点遮罩关闭（点图片不关）。「复制图片」和「在访达中显示」MiMo 只在图片有本地路径时出现，发送的图片是 data URL 没有路径，所以 1:1 也不显示。MiMo 的「圈选批改」模式不在这一项里，没做。MCode 原来发送的图片 58×46、不能点。新增 `lib/image-preview.ts`（全窗口唯一的预览状态）和 `components/ImagePreview.vue`（挂在 App，图标自己画）；MessageStream 的提问和插话里的图片改为 64×64 圆角 12 的按钮；预览打开时计入 App 的 `modalOpen`，快捷键在捕获阶段拦下。新键 `imagePreview.*` 8 个、`stream.previewTip`（18 张表）。探针 `mcode-image-preview.cjs` 7 项（页面里用 canvas 生成两张小图放进提问；下载前把链接的 click 换成记录器，不真的保存），换回旧代码时 7 项全失败；`mcode-edit-asked` / `mcode-steer` 重跑通过。**注意**：淡入原来用 requestAnimationFrame，被遮挡的窗口不跑帧会导致永远不显示，已改成 16ms 定时器；探针里后台窗口的 CSS 过渡会停住，读终值前要关掉过渡
- [已完成] Markdown 表格的预览和复制按钮（小到中）——见上方「回复里表格的预览和复制」一条
- [已完成] 输入框：拖拽调高、大段粘贴转附件、拖放提示卡片（各小）——见上方三条

## 下一步建议

**2026-09-22：第十九轮做完，已知差异清零，0.3.8 已装、`v2.0` 已推到 GitHub。** 可选的下一步：

1. [已完成] 开拉取请求 #4 并合并进 `main`、发布预发布版 `v0.3.8`。之后的工作仍在 `v2.0` 上做，攒够再开新的拉取请求。
2. 用真实模型（局域网 `qwen38-nvfp4`，见记忆 `reference-lan-test-model`，只用一次性配置）实际走几轮对话，重点看第十九轮 C 路的发送停靠与跟随、拖选暂停，以及批注发光。
3. MiMo 若再更新：先对比新旧 bundle 的版本差异（第十八轮做法），再决定是否重跑逐页对照（第十九轮做法：四块只读审计 + 每条独立复核）。
4. 偶发的 smoke 不稳定项仍在（第五轮计划模式、第七轮 bash 描述，见「约定与坑」），重跑即过，未修。

以下是更早的建议，留作记录：

**第十五轮（二次全面复核）34 条缺陷已全部修掉并合并入 `v2.0`**，smoke 4891。下一步：

0. **第十六轮已完成**（编码能力照 MiMo 重做，见上一节）。剩下的尾巴：MiMo 的「已查看」勾选框是否可见、深色差异配色与每文件边框，这三条要真截一次 MiMo 才能定；`notebook_edit` 的改动进不了撤销（`EDITING` 里没有它）。设置导航列溢出已修（`753c0a7`，见第十五轮 R15-U3 一节）。
1. 用真实模型实际使用已装好的版本，按看到的问题逐条修。
2. [已完成] 设置导航列在默认字号下超出自身盒子——照 MiMo 的 `.sn-scroll` 让列表在列内滚动（`753c0a7`），各行位置与高度不变、宽 +2.5px。
3. 其他小尾巴（可选）：`update-transaction.json` 与 `composer-input.ts` 走 `writeAtomicSync`；清理崩溃留下的 `*.tmp`；[已完成] 英文词中子串搜索（`figur` → `configuration`，trigram 索引，见 R15-S3）；偶发失败的两处 smoke 检查（见「约定与坑」）；[已完成]「bad port」偶发失败（本机端口范围，见「约定与坑」）。
4. 新页面（钩子、CLI 插件、SSH 连接）用户已决定不做。
5. [已完成] **T3 切回长对话**（第七轮遗留）：照 MiMo 26.920 的 `#thread>.row` 规则，对话里每一轮 `content-visibility: auto; contain-intrinsic-size: auto 240px`，最后一轮始终完整绘制；在对话里按下拖选或选区还在对话里时（`.stream.selecting`）所有轮都绘制并保留 containment，拖选越过窗口边缘时滚的是真实高度、切换时不挪动；另把 `dateIn` 的 `Intl.DateTimeFormat` 按语言与参数缓存（每个时间戳新建一个占 23ms）、导航条 `markActive` 由每轮一次 querySelector 改为一次扫描（22ms）；因轮次有了 containment，改过的「已编辑文件」卡片右键菜单挪到 body（fixed 定位否则以轮次为包含块）。**实测**（真实窗口、临时 profile，160 轮 / 480 条消息，含代码块、表格、工具步骤；探针 `scratchpad/perf/perf-switch.cjs`，从 `open()` 到流绘制且连续 30 帧不变）：切回长对话中位 438ms → 124–188ms（单帧最长 406 → 96–154ms，其中布局 300ms → 12ms），首次打开 1073 → 573–664ms，小对话 38 → 16–24ms。所见不变：底部与中段截图只有亚像素差异（滚动位置小数部分不同）；搜索结果跳转居中偏差 0 并闪烁；选区跨 40 轮复制出的字数与改前相同（34 898）；查找按 TreeWalker 走文本节点，字数与命中数与改前相同；编辑最后一问可打开、聚焦、Esc 关闭。注意：对话元素的 `innerText` 不再包含屏幕外轮次（仓库里没有代码在对话上用 `innerText`，新代码也别用，改用 `textContent` 或 TreeWalker）。smoke `smoke-perf-thread.ts` 9 条，改前代码上 7 条失败。
6. [已完成] **入口 chunk**（第七轮遗留，当时 5.60MB，本轮开始前已涨到 5 902 781 字节，MiMo 26.920 为 2 271 966）：用 rollup 的逐模块 renderedLength 拆出大头——`lib/i18n.ts` 2.2MB（18 张语言表）、katex 600KB、设置对话框 185KB、jszip 与 Office / PDF 查看器约 300KB、图片与视频预览、产物页、插件页、连接与导入对话框。做法：① 语言表照 MiMo 分语言按需加载：源文件仍是一个 `i18n.ts`（各检查照旧读取与导入），构建时由 `electron.vite.config.ts` 的 `languageChunks` 把 zh-CN（默认）与 en（回退）以外的 16 张表各拆成一个 chunk、填进 `LOADERS`，找不到预期结构就让构建失败；`App.vue` 切语言前先 `loadLanguage`，表到手才切（不会半中半外，后发先至以最后一次为准）；窗口把上次的语言记在 localStorage，启动时与系统语言一起预取（不阻塞挂载）。② KaTeX 首次画公式时 `import()`，并在空闲时预取；未到时公式显示源码一瞬，`mathReady` 变真后重画；`smoke.ts` 与 `markdown-check.ts` 开头 `await loadMath()`。③ 设置、产物页、插件页、图片 / 视频预览、连接 / 导入对话框、Office / HTML / 浏览器标签、文件标签里的 PDF 改为 `defineAsyncComponent`。**结果**：入口 5 902 781 → 2 136 100 字节（-64%，已低于 MiMo），入口 CSS 639KB → 451KB；主进程依赖不变，新 chunk 都在 `out/renderer/assets`（`files` 已含 `out/renderer/**`）。**实测**（临时 profile 冷启动各 7 次取中位，从导入 `out/main` 起算；本机噪声约 ±30ms）：首个窗口创建 344 → 328–341ms（主进程，不受影响）、窗口显示 650 → 565–595、DOMContentLoaded 613 → 538–556、首次内容绘制 689 → 642–662、Vue 挂载完成 670 → 620–639；法语配置首次启动时文字在设置到达后约 20ms 换成法语（改前与设置同时），之后的启动因预取在设置到达时即是法语（0ms）。真实窗口里公式（行内与块级）、图片预览、Ctrl+, 打开设置、切换到日语 / 阿拉伯语（含 RTL）再切回英语均正常。smoke `smoke-perf-entry.ts` 14 条（入口预算 2 400 000 字节、各懒加载边界在源码与构建产物里都存在、16 个语言 chunk、法语专有字符串不在入口），改前代码上 12 条失败。未做安装包实测（打包会递增版本号）。
