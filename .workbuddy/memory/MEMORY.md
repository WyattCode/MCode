# MCode 项目长期笔记

## 环境坑（本机，持久有效）

- **判断 fs API 误用前必看文件 import**：`await fs.stat(x)` 在 `import fs from "node:fs/promises"` 下完全合法（全库 70+ 处都是），只有 `node:fs` 回调版才会炸。2026-10-17 曾误报 office.ts statOf 有 bug（其实它一直正常），修了反而引入真 bug（promises 命名空间没有 .promises 属性），幸而 typecheck 前回滚。教训：先看 import 再定性，别拿 `require("fs")` 的实验结论套 ESM 源码。
- WorkBuddy 的 shell 带 `ELECTRON_RUN_AS_NODE=1`：electron.exe 会退化成纯 Node（`--version` 打出内嵌 Node 版本而非 Electron 版本），依赖真 Electron 的检查（如 toolcheck 的 nested PowerShell）会假红。跑检查前先 `unset ELECTRON_RUN_AS_NODE`。**PowerShell 工具同样带着**，Start-Process 启动 GUI 应用前要 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`；另外它还带 HTTP_PROXY/http_proxy 大小写重复键，会让 PS 5.1 的 Start-Process 抛字典冲突异常——用 bash 后台 `env -u` 启动更稳。
- **锁屏期间 GPU 子进程起不来**：工作站锁屏（LogonUI 在跑）时，Electron 41.10.7 的 GPU 进程 0xC0000005 连崩 6 次 → `GPU process isn't usable. Goodbye.` FATAL，任何 flag 组合（--disable-gpu/--in-process-gpu/--no-sandbox）都救不回整个应用，渲染进程也会连崩 0x80000003。GUI 层测试必须等解锁。第九轮记录过锁屏的显示怪病（getAllDisplays 空、按 100% 渲染）。**解锁后 WorkBuddy 上下文里 GPU 进程仍可能崩**（与执行链有关）：MCode 的 bench/smoke 要加 `--no-sandbox --in-process-gpu --use-angle=swiftshader`（渲染进程零崩溃验证过）；OpenCode CLI 管道下挂起，必须经 ConPTY 终端。
- 本机 TCP 动态端口从 1024 起；受限沙箱可能拒绝编译器/Electron/git 子进程，环境拒绝不算产品回归。

## MCode Remote（安卓平板端，`android/`）

- **驱动脚本在 `.workbuddy/`**：`pad.py`（adb 自动重连）、`ui.py`（按 uiautomator bounds 点击）、`shot.py`（只截图，不重启 Activity）、`build.py`（gradle + 安装）、`see.py`（会自动 `am start`，中途截图别用）。
- **点击坐标铁律**：一律用 `uiautomator dump` 的 bounds（真机 3408×2272）；按 1080 宽截图换算必点空。同名节点按 y 取最大。
- **改网关 src 必须重建 bundle 并重启**：`npx esbuild scripts/remote-server.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --outfile=out/remote-server.mjs --packages=external --loader:.html=text`。
- **凭据只走 `provider.auth`**：写 `config.json` 的 `customProviders[].apiKey` 无效（这点早期踩过）。
- `SessionInfo.access` 可选，缺失时按 `src/shared/access.ts` 的 `defaultAccess` 从 `config.permissions` 推导，别默认 full。
- **卡片数据在 `metadata`，而且要看顶层**：工具 part 的形状是 `{type,id,callID,name,status,input,time,output,title,metadata}` —— `metadata` 在**顶层**，不在 `state` 里（live 与回放都可能不同，两处都问）。编辑卡片的 diff 是 `metadata.diff`（不是 `state.output`，那个只有一句话回复）。2026-10-21 曾在 `state.output` 里找一个不存在的补丁，排查了很久。
- **怀疑「没渲染」先证明「数据到了吗」**：写个遍历全部 session 的统计脚本（`.workbuddy/scan-all-meta.mjs` 是范例），比在渲染代码里猜快十倍。实测过一次就有结论：1306 次调用 / 244 次带 diff / 0 次在 output。
- **`rowsOf`→`stepsOf` 会折叠，任何「只在某个 when 分支里渲染」的东西都可能永不显示**：相邻调用折成 `ToolRun`，再折进上方的 `Step`，裸的 `is Item.Tool ->` 分支几乎到不了。编辑卡片和交付卡片都栽在这上面（后者是靠 `onOpenDelivered != null` 把关）。
- **Compose 的 `Box` 是层叠不是堆叠**：在一行里追加第二个 child（比如卡片），必须用 `Column`，否则卡片会盖住段落。这个错误肉眼看起来像「文字被裁了」。
- **`Icons.Outlined.Info` 不存在**；`MiIcon` 手绘路径是通用替代。`Dp*Float` 合法、`Float*Dp` 不合法。
- **参考截图必须能和自己的截图分开**：2026-10-22 连续好几轮把 MCode 自己的截图当成 Claude 的来量，配色/几何全错（选了粉色圆角，实际参考是桃色直角）。凡是量参考，截图名一律 `ref-*`，自己的用 `mine-*`，量之前先确认前台包名（`dumpsys window | grep mCurrentFocus`）——**跑 adb 前一定先确认前台不是别人的会议/通话**。
- **Claude 安卓端选区的真实值**（`ref-claude-sel.png`，400dpi）：色块 #DEBFAF 直角 27.6dp 高、左右各留 0.8dp；手柄直径 25.2dp 的圆贴在色块左右外侧、顶边嵌入 1.6dp；菜单 #ECDFE6 胶囊 112×48dp 圆角 24，文字「复制 / 全选」13sp。**#ECDFE6 是胶囊色，不是选区色。**
- **中文分词用 ICU**：`TextLayoutResult.getWordBoundary` 无词典，中文整段一个词。用 `android.icu.text.BreakIterator.getWordInstance(Locale.SIMPLIFIED_CHINESE)`——locale 必须显式给，且要「先 following 再 preceding」（两者都会移动游标）。
- **`onGloballyPositioned` 不因选区变化而触发**：选中文字不动布局，所以不能在里面写 Popup 锚点。要写进 state，再用 `LaunchedEffect` 按选区 key 算；滚动场景再加一个坐标变化 tick。
- **`waitForUpOrCancellation` 返回 null 有歧义**（抬起 / 被父组件抢走都算），拿它当「还在按」会导致每次滑动都选词。用 `awaitLongPressOrCancellation`。
- **选区算术有单测，别绕过**：`android/app/src/test/java/com/mcode/remote/SelectionSliceTest.kt`
  （25 例）锁住 `sliceOfSelection`、`copyRange`、`tableCellStarts`。改选区偏移必跑
  `gradle app:testDebugUnitTest`（`.workbuddy/build.py` 已内置）。
  两个历史 bug：切片拿到的是「块在全文的偏移」而非「块内偏移」→ 段落全选不中；
  `Int.MAX_VALUE`（到块尾标记）与基数用 `Int` 相加会回绕 → 复制范围起点大于终点。
  **验证测试有效性的方法**：故意改回 `Int` 加法，应看到
  `anOpenEndReachesTheEndRatherThanWrapping` 精确失败。
- **测试期望值不要手算**：`"a b\ncc dd"` 的行首偏移手算成 5，实际是 4
  （`\n` 在索引 3）。一律先构造真实 flat 字符串，再用
  `flat.substring(start, start+len) == 期望单元格文本` 反断。
- **表格分隔符不属于任何单元格**：`(head+rows).joinToString("\n"){ it.joinToString(" ") }`
  里，格间是 1 空格、行间是 1 换行。折进单元格长度会让后面整体右移一位。
- **别往非目标设备装东西**：网络上的 `192.168.10.174`（25079RPDCC）不是 MCode 的目标机，
  用户 2026-10-23 明确选择「不装」。只有平板 `192.168.10.173` 才装。
- **`TextLayoutResult` 没有 `density` 属性**：需要 dp→px 时显式传
  `LocalDensity.current.density` 进来，别写成 `laid.density`。
- **画的和能抓的必须同源**：手柄用 `handleCentres(...)` 同时供绘制与命中测试；
  两处各算一遍必然漂移。
- **`git commit -m` 里的反引号会被 bash 当命令替换执行**（内容静默丢失）。
  提交信息先写进 `.workbuddy/commitmsg.txt`，再 `git commit -F`。
- **平板首选 USB 直连**：序号 `0A06049009983540`（M367FC，2272×3408，density 400），
  `adb -s 0A06049009983540`。USB 下端口不变，比无线稳得多。
  只有走无线时才需要注意下面这条。
- **平板的 adb 端点不稳定，且 `KEYCODE_POWER` 会踢掉无线调试**：
  端点随开关无线调试/重启/息屏变化，旧端口报 `10061 目标计算机积极拒绝`
  —— 看起来像设备离线，其实 ping 得通。**别再用 `input keyevent KEYCODE_POWER` 唤醒**
  （2026-10-23 实测：按一下就整台设备从 adb 消失，端口全扫不到，必须人工解锁）。
  用 `.workbuddy/find-pad.py` 做 mDNS + 端口发现（只探测，不碰设备）。
- **`hitsHandle(pressX, pressY, centreX, centreY, radius)` 是纯函数**，6 个测试锁住
  「视觉半径 12.6dp ≠ 触控半径 18dp」和「圆形而非方形命中区」。改手柄交互必跑。
- **`clampToLayout(range, length)` 必须挡在 `getBoundingBox` 前面**：
  区间终点是排他的，「到最后一个字符」= `length`，而 `getBoundingBox` 只收 `[0, length)`。
  2026-10-23 全选直接把 `0 until length` 传进去 → `offset(103) is out of bounds`
  → 在 `drawBehind` 里抛出 → **整个应用崩溃**。
- **`Popup` 里的 `clickable` 默认 ripple 会渲染成灰矩形**（窗口没有 surface 给它着色）。
  用 `indication = null`。
- **`Popup` 不与内容联动**：它锚在写入时的 root 坐标上。抽屉/换会话导致内容位移时，
  气泡会变成浮在别处的僵尸。凡是会移动内容的操作都要清选区。
- **小截图会骗人**：1080 宽的缩略图上多次误判「没有色块」「气泡跑位」，
  放大到原生 3408 宽后完全正常。**先放大再下结论。**
- **找手柄不能用色值掩码**：代码高亮主题里 `#AE6B4E` 同时也用于字符串/数字，
  按颜色扫会把 `"zh_CN"`、`1000` 当成手柄。用 **连通域 + 尺寸过滤**（≥30×30px），
  工具在 `.workbuddy/handles.py`。实测圆盘 61~62px = 24.4~24.8dp。
- **「拖动没反应」先确认起点**：抓起点手柄往右拖会让选区**变窄**（activeOffset 逼近
  anchorOffset），看起来像失效。2026-10-23 连续三次把 70px 的坐标偏差当成功能 bug。
- **回复的消息菜单入口是底部的「⋯」图标，不是长按**（`MainActivity` 7632 行附近）。
  长按现在直接进选区，这是更快的路径，不冲突。
- **`.workbuddy/selmeas.py`** 按选区自身像素测 wash / handles / pill 的 bbox；
  **`.workbuddy/handles.py`** 连通域找圆盘。量选区一律用这两个，别手数。
- **证明测试有效，前提是真的破坏了东西**。2026-10-23 试过两种「故意改坏」：
  第一种其实是等价改写（`a+=len; if(..)a+=1` → `a+=len+(if(..)1 else 0)`），
  测试全绿是对的，不是测试失效。必须区分「测试没用」和「改动无害」。
- **不要给 `session.create` 传 title**：服务端 `src/server/session/title.ts` 的规则是
  「没有标题才自动命名」（首行 fallback → 后台模型命名）。传了标题就永远不生成。
  2026-10-23 之前手机端硬编码 `"来自手机"`，十几天所有会话同名，侧栏无法区分。已修。
- **新建会话必须带 `directory`**：不带则用服务端默认 `D://Apps//MCode`（安装目录），
  而侧栏按目录过滤 → 新建的会话在列表里看不到。默认取当前会话的 directory。
- **新建会话要立即插入侧栏**：`select()` 依赖 `session.get` 回来才 add，是异步的；
  用 `session.create` 的返回直接 `sessions.add(0, row)`。
- **`cockpit-html.ts` 由 `cockpit.html` 生成**，生成器是 `.workbuddy/gen-cockpit.py`
  （原文件头写着「re-run the generator」但生成器从未提交）。改 HTML 后必须重跑。

## 工作流

- **第五十四轮起（2026-10-17 用户定）`v2.0` 退役**：一切工作（含交接更新）都从最新 `main` 拉分支（`fix/...`、`feat/...`），PR 合回 `main`。本地 `v2.0` 已删，远端 `origin/v2.0` 留着不动（停在 0.7.4）。首个范例：`fix/i18n-handoff` → PR #28。
- 交接文档 `HANDOFF.md`：每完成一轮更新一次（当前状态 + 逐轮记录，新到旧）；更新也走 PR。
- 十二项专项检查（i18ncheck/themecheck/wiringcheck/mdcheck/promptcheck/toolcheck/sessioncheck/snapshotcheck/mcpcheck/providercheck/shellcheck + sandboxcheck 单独跑）**不包含**在 `npm run smoke` 里，提交前都要过。
- 新加工具必须进全部 18 张语言表（新工具惯例：zhCN/zhTW 中文、其余 16 张英文，锚点按注册表追加顺序；`lsp` 的漏就是 PR #28 修的）。
- 版本号只在 `npm run package` 打包时自动递增，不要手改。
- 注意：0.7.5 起的三版都没有 Windows 安装包，本机装的还是 0.7.4.0。
- **平板已设永不锁屏**（用户 2026-10-21 要求）：`locksettings set-disabled true` + `screen_off_timeout=2147483647` + `stay_on_while_plugged_in=7` + screensaver off。封装为 `python .workbuddy/pad.py awake`（恢复：`locksettings set-disabled false`）。唤醒用 `pad.py wake`（KEYCODE_POWER，KEYCODE_WAKEUP 常被忽略）。
- **网关启动**：沙箱里 run_in_background 启动可靠（别中断 turn）；分离进程（DETACHED_PROCESS）会被沙箱回收。防火墙已放行 node.exe 入站（规则名 MCodeGateway）——之前 app 连不上 156:7900 就是它拦的。完整命令：`node out/remote-server.mjs --host 0.0.0.0 --port 7900 --token mcode-fold-2026 --data-dir C:/Users/Wyatt/AppData/Roaming/mcode`。
- **1:1 视觉对齐**（`1ce169b2`+`d907566f`）：对照 src/renderer 的 CSS 逐数字抄。正文列 764+28、气泡 16/9,13/500/78%、工具行 14/22.4/5/23（两处渲染都要改！ToolRow 和 Item.ToolRun 的 runSummary）、会话行 34+6+2、抽屉行 38/8/14、输入卡 10 圆角/13sp/44 条。会话行三态：旋转环/蓝点/待确认胶囊（新增 unseen 状态）。

## 整屏对齐（2026-10-23 起，与选区模块分开记）

- **填充色相差 4 阶在缩略图上不可见**：侧栏卡片 `#F9F9F7` vs 页面 `#F7F7F5`，
  缩小后完全看不出。代码里曾有长注释论证「Claude 没有卡片」，就是这么错判的。
  **一切颜色差异必须在原生分辨率采样。**
- **`weight()` 与 `fillMaxWidth()` 互相打架**：Row 里给带 weight 的子项再加
  fillMaxWidth，宽度分配会失效（实测左栏 27.1% 渲染成 17.6%）。weight 子项不要 fillMaxWidth。
- **padding 值可能是在另一个窗宽下量的**：输入框 `start=116.4/end=106.8` 是双栏
  切窄「之后」又扣一次，导致右侧差 101.6dp。跨布局复用 padding 前先确认坐标系。
- 侧栏卡片实测（400dpi）：**332×68dp**，填充 `#F9F9F7`，边框 `#E1E1DF`，
  图标方块 36×36 `#F5F5F3` 圆角 10，距卡左 18dp，标题起点 77.6dp，时间在标题同行右侧。
- 输入框实测：右边距 **10.4dp**，左栏比例 **0.2641**（900/3408）。
- **别用放大图判断字号**：双倍 NEAREST 放大后会觉得「标题偏大」，
  实测两边墨迹都是 11.2dp。字号要以墨迹像素为准。
- **坐标必须连同所属面板一起记**：2026-10-23 三次同类错误——
  拿左栏内的 x（900px 内）当右栏证据，得出「Claude 聊天页没有标题」的错误结论。
  右栏标题实际在 x 2143..2225。**先确认 x 落在哪个面板，再下判断。**
- **代码注释里的「实测结论」可能来自旧截图**：顶栏图标数、有无卡片、有无标题
  都出现过注释与当前参考件不符。**注释只是线索，结论必须重新量。**
- **模式必须有出口**：搜索框从常驻改成模式后，必须补关闭方式，否则是死路。
- **marks canvas 缩放的是网格不是墨迹**：24 网格里半径 9.4 只画出 16.8dp 墨迹，
  要填满 18.4dp 的框得用 11.1。
- 整屏已对齐项：侧栏卡片(332×68)、图标块(36)、列表头(会话/全部)、
  左顶栏(Code+时钟)、右栏标题(Main+Remote control)、输入框(右边距10.4)、
  左栏比例(0.2641)、选区模块全部。
- **新增的颜色 CompositionLocal 必须在主题里 provide**：`LocalCard` 系列只写了默认值，
  深色下侧栏全是白板。加颜色时同时补 `if (dark) ... else ...`。
- **复用测量值前先确认目标盒子的原点**（今天第 4 次同类错误）：
  输入框 padding、空状态 top=393、右栏标题坐标、searchTop —— 全是「在 A 盒子量的，
  拿到 B 盒子用」。数字本身没错，坐标系错了。
- 深色主题实测值：页面 `#151515`、卡片 `#20201F`、边框 `#232323`、图标块 `#2A2A29`、
  文字 `#F9F9F7`、弱化 `#8A8A8A`（取自 `claude_clean.png`）。
- 空状态一律用 `weight(1f)` + `Arrangement.Center`，**不要用 padding-top 定位**。
- **Material 图标的声明尺寸 ≠ 墨迹尺寸**：24 网格里 Search 只画约 3/4，
  17dp 声明 → 12.0dp 墨迹。要 18.8dp 墨迹须声明 26.6dp。
  换算比例 ≈ 0.75，或直接用 MiIcon 手绘。
- **筛选图标是「三根竖轴 + 空心圆」不是漏斗**：参考件 x 820..859，左右圆点高、中间低。
  项目页和产物页原本都写成漏斗 `M4 5.6h16M7 12h10M10 18.4h4`。
- **各页面顶栏图标数量不同**：会话页 1(时钟)、项目页 2(放大镜+筛选)、产物页 1(筛选)。
- 项目/产物页标题 `offset` 应为 **+2.4**，不是 -5.2（实测偏左时被推得更左）。
- **`.workbuddy/nav.py`**：按 uiautomator bounds 精确点击（`dump` / `tap <text>` / `tapcd <desc>`）。
  手动猜坐标浪费大量时间：时钟在 800 点 700 无效、汉堡在 24 点 20 出界、
  边缘点击会变成系统返回手势直接退出应用。
  `screencap` 原生 3408×2272 与 `input tap` **同一坐标系**（不是 1080 缩放）。
- **声明尺寸 ≠ 墨迹尺寸**（今天第 4 次）：24 网格里路径占多少就画多少。
  托盘占 20/24 → 声明 40 只画 33.3；Search 占 3/4 → 17 只画 12.0。
  **所有图标都要实测换算，不能按声明值当绘制值。**
- 产物页搜索框：**328×56dp 胶囊**，距左 16dp，radius 28，占位 15sp。
- 空状态圆底**只有定时任务页有**（#F0EFEC 64dp + 20dp 时钟）；
  项目页托盘是裸图标 56×29.2dp。
# MCode 项目长期笔记

## 环境坑（本机，持久有效）

- **判断 fs API 误用前必看文件 import**：`await fs.stat(x)` 在 `import fs from "node:fs/promises"` 下完全合法（全库 70+ 处都是），只有 `node:fs` 回调版才会炸。2026-10-17 曾误报 office.ts statOf 有 bug（其实它一直正常），修了反而引入真 bug（promises 命名空间没有 .promises 属性），幸而 typecheck 前回滚。教训：先看 import 再定性，别拿 `require("fs")` 的实验结论套 ESM 源码。
- WorkBuddy 的 shell 带 `ELECTRON_RUN_AS_NODE=1`：electron.exe 会退化成纯 Node（`--version` 打出内嵌 Node 版本而非 Electron 版本），依赖真 Electron 的检查（如 toolcheck 的 nested PowerShell）会假红。跑检查前先 `unset ELECTRON_RUN_AS_NODE`。**PowerShell 工具同样带着**，Start-Process 启动 GUI 应用前要 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`；另外它还带 HTTP_PROXY/http_proxy 大小写重复键，会让 PS 5.1 的 Start-Process 抛字典冲突异常——用 bash 后台 `env -u` 启动更稳。
- **锁屏期间 GPU 子进程起不来**：工作站锁屏（LogonUI 在跑）时，Electron 41.10.7 的 GPU 进程 0xC0000005 连崩 6 次 → `GPU process isn't usable. Goodbye.` FATAL，任何 flag 组合（--disable-gpu/--in-process-gpu/--no-sandbox）都救不回整个应用，渲染进程也会连崩 0x80000003。GUI 层测试必须等解锁。第九轮记录过锁屏的显示怪病（getAllDisplays 空、按 100% 渲染）。**解锁后 WorkBuddy 上下文里 GPU 进程仍可能崩**（与执行链有关）：MCode 的 bench/smoke 要加 `--no-sandbox --in-process-gpu --use-angle=swiftshader`（渲染进程零崩溃验证过）；OpenCode CLI 管道下挂起，必须经 ConPTY 终端。
- 本机 TCP 动态端口从 1024 起；受限沙箱可能拒绝编译器/Electron/git 子进程，环境拒绝不算产品回归。

## MCode Remote（安卓平板端，`android/`）

- **驱动脚本在 `.workbuddy/`**：`pad.py`（adb 自动重连）、`ui.py`（按 uiautomator bounds 点击）、`shot.py`（只截图，不重启 Activity）、`build.py`（gradle + 安装）、`see.py`（会自动 `am start`，中途截图别用）。
- **点击坐标铁律**：一律用 `uiautomator dump` 的 bounds（真机 3408×2272）；按 1080 宽截图换算必点空。同名节点按 y 取最大。
- **改网关 src 必须重建 bundle 并重启**：`npx esbuild scripts/remote-server.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --outfile=out/remote-server.mjs --packages=external --loader:.html=text`。
- **凭据只走 `provider.auth`**：写 `config.json` 的 `customProviders[].apiKey` 无效（这点早期踩过）。
- `SessionInfo.access` 可选，缺失时按 `src/shared/access.ts` 的 `defaultAccess` 从 `config.permissions` 推导，别默认 full。
- **卡片数据在 `metadata`，而且要看顶层**：工具 part 的形状是 `{type,id,callID,name,status,input,time,output,title,metadata}` —— `metadata` 在**顶层**，不在 `state` 里（live 与回放都可能不同，两处都问）。编辑卡片的 diff 是 `metadata.diff`（不是 `state.output`，那个只有一句话回复）。2026-10-21 曾在 `state.output` 里找一个不存在的补丁，排查了很久。
- **怀疑「没渲染」先证明「数据到了吗」**：写个遍历全部 session 的统计脚本（`.workbuddy/scan-all-meta.mjs` 是范例），比在渲染代码里猜快十倍。实测过一次就有结论：1306 次调用 / 244 次带 diff / 0 次在 output。
- **`rowsOf`→`stepsOf` 会折叠，任何「只在某个 when 分支里渲染」的东西都可能永不显示**：相邻调用折成 `ToolRun`，再折进上方的 `Step`，裸的 `is Item.Tool ->` 分支几乎到不了。编辑卡片和交付卡片都栽在这上面（后者是靠 `onOpenDelivered != null` 把关）。
- **Compose 的 `Box` 是层叠不是堆叠**：在一行里追加第二个 child（比如卡片），必须用 `Column`，否则卡片会盖住段落。这个错误肉眼看起来像「文字被裁了」。
- **`Icons.Outlined.Info` 不存在**；`MiIcon` 手绘路径是通用替代。`Dp*Float` 合法、`Float*Dp` 不合法。
- **参考截图必须能和自己的截图分开**：2026-10-22 连续好几轮把 MCode 自己的截图当成 Claude 的来量，配色/几何全错（选了粉色圆角，实际参考是桃色直角）。凡是量参考，截图名一律 `ref-*`，自己的用 `mine-*`，量之前先确认前台包名（`dumpsys window | grep mCurrentFocus`）——**跑 adb 前一定先确认前台不是别人的会议/通话**。
- **Claude 安卓端选区的真实值**（`ref-claude-sel.png`，400dpi）：色块 #DEBFAF 直角 27.6dp 高、左右各留 0.8dp；手柄直径 25.2dp 的圆贴在色块左右外侧、顶边嵌入 1.6dp；菜单 #ECDFE6 胶囊 112×48dp 圆角 24，文字「复制 / 全选」13sp。**#ECDFE6 是胶囊色，不是选区色。**
- **中文分词用 ICU**：`TextLayoutResult.getWordBoundary` 无词典，中文整段一个词。用 `android.icu.text.BreakIterator.getWordInstance(Locale.SIMPLIFIED_CHINESE)`——locale 必须显式给，且要「先 following 再 preceding」（两者都会移动游标）。
- **`onGloballyPositioned` 不因选区变化而触发**：选中文字不动布局，所以不能在里面写 Popup 锚点。要写进 state，再用 `LaunchedEffect` 按选区 key 算；滚动场景再加一个坐标变化 tick。
- **`waitForUpOrCancellation` 返回 null 有歧义**（抬起 / 被父组件抢走都算），拿它当「还在按」会导致每次滑动都选词。用 `awaitLongPressOrCancellation`。
- **选区算术有单测，别绕过**：`android/app/src/test/java/com/mcode/remote/SelectionSliceTest.kt`
  （25 例）锁住 `sliceOfSelection`、`copyRange`、`tableCellStarts`。改选区偏移必跑
  `gradle app:testDebugUnitTest`（`.workbuddy/build.py` 已内置）。
  两个历史 bug：切片拿到的是「块在全文的偏移」而非「块内偏移」→ 段落全选不中；
  `Int.MAX_VALUE`（到块尾标记）与基数用 `Int` 相加会回绕 → 复制范围起点大于终点。
  **验证测试有效性的方法**：故意改回 `Int` 加法，应看到
  `anOpenEndReachesTheEndRatherThanWrapping` 精确失败。
- **测试期望值不要手算**：`"a b\ncc dd"` 的行首偏移手算成 5，实际是 4
  （`\n` 在索引 3）。一律先构造真实 flat 字符串，再用
  `flat.substring(start, start+len) == 期望单元格文本` 反断。
- **表格分隔符不属于任何单元格**：`(head+rows).joinToString("\n"){ it.joinToString(" ") }`
  里，格间是 1 空格、行间是 1 换行。折进单元格长度会让后面整体右移一位。
- **别往非目标设备装东西**：网络上的 `192.168.10.174`（25079RPDCC）不是 MCode 的目标机，
  用户 2026-10-23 明确选择「不装」。只有平板 `192.168.10.173` 才装。
- **`TextLayoutResult` 没有 `density` 属性**：需要 dp→px 时显式传
  `LocalDensity.current.density` 进来，别写成 `laid.density`。
- **画的和能抓的必须同源**：手柄用 `handleCentres(...)` 同时供绘制与命中测试；
  两处各算一遍必然漂移。
- **`git commit -m` 里的反引号会被 bash 当命令替换执行**（内容静默丢失）。
  提交信息先写进 `.workbuddy/commitmsg.txt`，再 `git commit -F`。
- **平板首选 USB 直连**：序号 `0A06049009983540`（M367FC，2272×3408，density 400），
  `adb -s 0A06049009983540`。USB 下端口不变，比无线稳得多。
  只有走无线时才需要注意下面这条。
- **平板的 adb 端点不稳定，且 `KEYCODE_POWER` 会踢掉无线调试**：
  端点随开关无线调试/重启/息屏变化，旧端口报 `10061 目标计算机积极拒绝`
  —— 看起来像设备离线，其实 ping 得通。**别再用 `input keyevent KEYCODE_POWER` 唤醒**
  （2026-10-23 实测：按一下就整台设备从 adb 消失，端口全扫不到，必须人工解锁）。
  用 `.workbuddy/find-pad.py` 做 mDNS + 端口发现（只探测，不碰设备）。
- **`hitsHandle(pressX, pressY, centreX, centreY, radius)` 是纯函数**，6 个测试锁住
  「视觉半径 12.6dp ≠ 触控半径 18dp」和「圆形而非方形命中区」。改手柄交互必跑。
- **`clampToLayout(range, length)` 必须挡在 `getBoundingBox` 前面**：
  区间终点是排他的，「到最后一个字符」= `length`，而 `getBoundingBox` 只收 `[0, length)`。
  2026-10-23 全选直接把 `0 until length` 传进去 → `offset(103) is out of bounds`
  → 在 `drawBehind` 里抛出 → **整个应用崩溃**。
- **`Popup` 里的 `clickable` 默认 ripple 会渲染成灰矩形**（窗口没有 surface 给它着色）。
  用 `indication = null`。
- **`Popup` 不与内容联动**：它锚在写入时的 root 坐标上。抽屉/换会话导致内容位移时，
  气泡会变成浮在别处的僵尸。凡是会移动内容的操作都要清选区。
- **小截图会骗人**：1080 宽的缩略图上多次误判「没有色块」「气泡跑位」，
  放大到原生 3408 宽后完全正常。**先放大再下结论。**
- **找手柄不能用色值掩码**：代码高亮主题里 `#AE6B4E` 同时也用于字符串/数字，
  按颜色扫会把 `"zh_CN"`、`1000` 当成手柄。用 **连通域 + 尺寸过滤**（≥30×30px），
  工具在 `.workbuddy/handles.py`。实测圆盘 61~62px = 24.4~24.8dp。
- **「拖动没反应」先确认起点**：抓起点手柄往右拖会让选区**变窄**（activeOffset 逼近
  anchorOffset），看起来像失效。2026-10-23 连续三次把 70px 的坐标偏差当成功能 bug。
- **回复的消息菜单入口是底部的「⋯」图标，不是长按**（`MainActivity` 7632 行附近）。
  长按现在直接进选区，这是更快的路径，不冲突。
- **`.workbuddy/selmeas.py`** 按选区自身像素测 wash / handles / pill 的 bbox；
  **`.workbuddy/handles.py`** 连通域找圆盘。量选区一律用这两个，别手数。
- **证明测试有效，前提是真的破坏了东西**。2026-10-23 试过两种「故意改坏」：
  第一种其实是等价改写（`a+=len; if(..)a+=1` → `a+=len+(if(..)1 else 0)`），
  测试全绿是对的，不是测试失效。必须区分「测试没用」和「改动无害」。
- **不要给 `session.create` 传 title**：服务端 `src/server/session/title.ts` 的规则是
  「没有标题才自动命名」（首行 fallback → 后台模型命名）。传了标题就永远不生成。
  2026-10-23 之前手机端硬编码 `"来自手机"`，十几天所有会话同名，侧栏无法区分。已修。
- **新建会话必须带 `directory`**：不带则用服务端默认 `D://Apps//MCode`（安装目录），
  而侧栏按目录过滤 → 新建的会话在列表里看不到。默认取当前会话的 directory。
- **新建会话要立即插入侧栏**：`select()` 依赖 `session.get` 回来才 add，是异步的；
  用 `session.create` 的返回直接 `sessions.add(0, row)`。
- **`cockpit-html.ts` 由 `cockpit.html` 生成**，生成器是 `.workbuddy/gen-cockpit.py`
  （原文件头写着「re-run the generator」但生成器从未提交）。改 HTML 后必须重跑。

## 工作流

- **第五十四轮起（2026-10-17 用户定）`v2.0` 退役**：一切工作（含交接更新）都从最新 `main` 拉分支（`fix/...`、`feat/...`），PR 合回 `main`。本地 `v2.0` 已删，远端 `origin/v2.0` 留着不动（停在 0.7.4）。首个范例：`fix/i18n-handoff` → PR #28。
- 交接文档 `HANDOFF.md`：每完成一轮更新一次（当前状态 + 逐轮记录，新到旧）；更新也走 PR。
- 十二项专项检查（i18ncheck/themecheck/wiringcheck/mdcheck/promptcheck/toolcheck/sessioncheck/snapshotcheck/mcpcheck/providercheck/shellcheck + sandboxcheck 单独跑）**不包含**在 `npm run smoke` 里，提交前都要过。
- 新加工具必须进全部 18 张语言表（新工具惯例：zhCN/zhTW 中文、其余 16 张英文，锚点按注册表追加顺序；`lsp` 的漏就是 PR #28 修的）。
- 版本号只在 `npm run package` 打包时自动递增，不要手改。
- 注意：0.7.5 起的三版都没有 Windows 安装包，本机装的还是 0.7.4.0。
- **平板已设永不锁屏**（用户 2026-10-21 要求）：`locksettings set-disabled true` + `screen_off_timeout=2147483647` + `stay_on_while_plugged_in=7` + screensaver off。封装为 `python .workbuddy/pad.py awake`（恢复：`locksettings set-disabled false`）。唤醒用 `pad.py wake`（KEYCODE_POWER，KEYCODE_WAKEUP 常被忽略）。
- **网关启动**：沙箱里 run_in_background 启动可靠（别中断 turn）；分离进程（DETACHED_PROCESS）会被沙箱回收。防火墙已放行 node.exe 入站（规则名 MCodeGateway）——之前 app 连不上 156:7900 就是它拦的。完整命令：`node out/remote-server.mjs --host 0.0.0.0 --port 7900 --token mcode-fold-2026 --data-dir C:/Users/Wyatt/AppData/Roaming/mcode`。
- **1:1 视觉对齐**（`1ce169b2`+`d907566f`）：对照 src/renderer 的 CSS 逐数字抄。正文列 764+28、气泡 16/9,13/500/78%、工具行 14/22.4/5/23（两处渲染都要改！ToolRow 和 Item.ToolRun 的 runSummary）、会话行 34+6+2、抽屉行 38/8/14、输入卡 10 圆角/13sp/44 条。会话行三态：旋转环/蓝点/待确认胶囊（新增 unseen 状态）。

## 整屏对齐（2026-10-23 起，与选区模块分开记）

- **填充色相差 4 阶在缩略图上不可见**：侧栏卡片 `#F9F9F7` vs 页面 `#F7F7F5`，
  缩小后完全看不出。代码里曾有长注释论证「Claude 没有卡片」，就是这么错判的。
  **一切颜色差异必须在原生分辨率采样。**
- **`weight()` 与 `fillMaxWidth()` 互相打架**：Row 里给带 weight 的子项再加
  fillMaxWidth，宽度分配会失效（实测左栏 27.1% 渲染成 17.6%）。weight 子项不要 fillMaxWidth。
- **padding 值可能是在另一个窗宽下量的**：输入框 `start=116.4/end=106.8` 是双栏
  切窄「之后」又扣一次，导致右侧差 101.6dp。跨布局复用 padding 前先确认坐标系。
- 侧栏卡片实测（400dpi）：**332×68dp**，填充 `#F9F9F7`，边框 `#E1E1DF`，
  图标方块 36×36 `#F5F5F3` 圆角 10，距卡左 18dp，标题起点 77.6dp，时间在标题同行右侧。
- 输入框实测：右边距 **10.4dp**，左栏比例 **0.2641**（900/3408）。
- **别用放大图判断字号**：双倍 NEAREST 放大后会觉得「标题偏大」，
  实测两边墨迹都是 11.2dp。字号要以墨迹像素为准。
- **坐标必须连同所属面板一起记**：2026-10-23 三次同类错误——
  拿左栏内的 x（900px 内）当右栏证据，得出「Claude 聊天页没有标题」的错误结论。
  右栏标题实际在 x 2143..2225。**先确认 x 落在哪个面板，再下判断。**
- **代码注释里的「实测结论」可能来自旧截图**：顶栏图标数、有无卡片、有无标题
  都出现过注释与当前参考件不符。**注释只是线索，结论必须重新量。**
- **模式必须有出口**：搜索框从常驻改成模式后，必须补关闭方式，否则是死路。
- **marks canvas 缩放的是网格不是墨迹**：24 网格里半径 9.4 只画出 16.8dp 墨迹，
  要填满 18.4dp 的框得用 11.1。
- 整屏已对齐项：侧栏卡片(332×68)、图标块(36)、列表头(会话/全部)、
  左顶栏(Code+时钟)、右栏标题(Main+Remote control)、输入框(右边距10.4)、
  左栏比例(0.2641)、选区模块全部。
- **新增的颜色 CompositionLocal 必须在主题里 provide**：`LocalCard` 系列只写了默认值，
  深色下侧栏全是白板。加颜色时同时补 `if (dark) ... else ...`。
- **复用测量值前先确认目标盒子的原点**（今天第 4 次同类错误）：
  输入框 padding、空状态 top=393、右栏标题坐标、searchTop —— 全是「在 A 盒子量的，
  拿到 B 盒子用」。数字本身没错，坐标系错了。
- 深色主题实测值：页面 `#151515`、卡片 `#20201F`、边框 `#232323`、图标块 `#2A2A29`、
  文字 `#F9F9F7`、弱化 `#8A8A8A`（取自 `claude_clean.png`）。
- 空状态一律用 `weight(1f)` + `Arrangement.Center`，**不要用 padding-top 定位**。
- **Material 图标的声明尺寸 ≠ 墨迹尺寸**：24 网格里 Search 只画约 3/4，
  17dp 声明 → 12.0dp 墨迹。要 18.8dp 墨迹须声明 26.6dp。
  换算比例 ≈ 0.75，或直接用 MiIcon 手绘。
- **筛选图标是「三根竖轴 + 空心圆」不是漏斗**：参考件 x 820..859，左右圆点高、中间低。
  项目页和产物页原本都写成漏斗 `M4 5.6h16M7 12h10M10 18.4h4`。
- **各页面顶栏图标数量不同**：会话页 1(时钟)、项目页 2(放大镜+筛选)、产物页 1(筛选)。
- 项目/产物页标题 `offset` 应为 **+2.4**，不是 -5.2（实测偏左时被推得更左）。
- **`.workbuddy/nav.py`**：按 uiautomator bounds 精确点击（`dump` / `tap <text>` / `tapcd <desc>`）。
  手动猜坐标浪费大量时间：时钟在 800 点 700 无效、汉堡在 24 点 20 出界、
  边缘点击会变成系统返回手势直接退出应用。
  `screencap` 原生 3408×2272 与 `input tap` **同一坐标系**（不是 1080 缩放）。
- **声明尺寸 ≠ 墨迹尺寸**（今天第 4 次）：24 网格里路径占多少就画多少。
  托盘占 20/24 → 声明 40 只画 33.3；Search 占 3/4 → 17 只画 12.0。
  **所有图标都要实测换算，不能按声明值当绘制值。**
- 产物页搜索框：**328×56dp 胶囊**，距左 16dp，radius 28，占位 15sp。
- 空状态圆底**只有定时任务页有**（#F0EFEC 64dp + 20dp 时钟）；
  项目页托盘是裸图标 56×29.2dp。
- **设置页进不去（2026-10-24 未解决）**：抽屉里点「设置」/齿轮/laptop 图标，
  抽屉关闭但页面不切换。代码路径、渲染分支、点击坐标都已排除。
  怀疑 Compose `ModalDrawer` 在 Expanded 屏上 hit-test 与绘制错位。
  **同一个抽屉里项目/Artifacts/定时任务也都点不动**，只能直接点左栏入口。
  下一步：用真手指确认，若是则宽屏下改用非 Drawer 布局。
- **「点了没反应」先分清「事件没到」和「到了被覆盖」**（2026-10-24 血泪）：
  设置页进不去，我连错三轮猜坐标，判断「ModalDrawer hit-test 坏了」——**全错**。
  真因是一行 `if (widthSize < Expanded) return`：宽屏下不 return，
  页面画完被后面的双栏布局**盖住**。
  用两行 logcat 就分开了：`onSettings fired` + `leftMode=Settings` 都正常，
  只有绘制顺序错。**先打日志，再猜坐标。**
- 设置页已可进入，左导航 12 项 + 右内容面板，可交互。**无参考件，视觉未校准。**
- **动手前先扫一遍全部截图**（2026-10-24 大教训）：我断定「没有抽屉/Code 页参考件」，
  于是自己造布局 + 写长注释论证。实际 `claude_code.png`（抽屉）和
  `A_claude.png`（Code 页）一直躺在 `.workbuddy/shots/`（748 张可用）。
  先用缩略图总览扫（`SHEET*.png` 范例），别靠推断。
- **参考件事实**：抽屉四项 = 项目/Code/Artifacts/定时任务，Code 配 `</>`；
  「最近使用」3 行 + 查看全部；抽屉会话行**无卡片**（`#F3F3F0` 通铺）。
  Code 页左栏 = 设备(+添加设备胶囊 117.6×31.6) + 会话 + 卡片(高82.4)。
  卡片第二行 `已连接 · Remote control` 绿 `#296118`。
- **`if (a || b)` 里 a 是「运行中」时要留意**：`s.running || s.directory.isNotBlank()`
  让旋转环分支永远不显示。**布尔或里，特殊态要单独优先判断。**
- **Compose**：`DrawScope` 里转角度用 `withTransform({ rotate(angle) }) { }`，
  直接 `rotate()` 不是可用扩展。
- **正文缩进是 40dp，不是 137.6**（2026-10-24）：`contentPadding` 曾按 Claude **chat 页**
  量（99.5dp），但双栏布局对应 **Code 页**。`A_claude.png` 实测正文和工具行
  **都从 40.0dp 起**、彼此对齐。**注释里写了「我读错了面板」却没改数值**——
  出现这种注释时必须连带改代码。
- 正文排版已验证正确：**17sp / 30sp 行高**（参考件墨迹 16.0dp、行距 29.5dp）。
- **目标平板连接状态**：USB 序号 `0A06049009983540`，无线 `.173`。
  2026-10-24 两者都断开，只剩 `.174`（1880×3008，未装 MCode，**不是目标机，不碰**）。
- **不充电时 adb 唤不亮屏幕**（2026-10-24 实测 5 种全败）：`screen_off_timeout` 最大值、
  `svc power stayon true`、`locksettings set-disabled`、每 20s 发 `KEYCODE_WAKEUP`、
  `am start` —— 命令都返回成功，屏幕依旧黑。
  **`stay_on_while_plugged_in` 是唯一可靠机制，但必须插电。**
  别写 adb 循环保活脚本，无效且费 token。正解：插电源 + `svc power stayon true`。
- **平板无线端口会漂移**（42407 -> 35909）。`adb connect` 被拒绝 != 设备离线，
  直接问用户当前端口最快，别硬猜。
- **并排对照图是唯一可信的验证**（2026-10-24 用户批评后确立）：纯数值测量漏掉了
  4 处肉眼可见的差异（卡片边框色、分隔点字符、运行环尺寸、卡片边距）。
  脚本 `.workbuddy/side2.py`：同尺度裁剪拼接两张图。**每轮至少做一次。**
- **千万别只报百分比**。用户明确反感。只说「哪几项对齐了、哪几项没有、缺什么」。
- **卡片边框 #F8F8F6 vs 页面 #F9F9F7 只差 1 阶**（几乎不可见）。
  之前用 #E1E1DF（差 24 阶），卡片像描边盒子。**一个颜色就能决定观感。**
  量颜色要量「卡片内部 / 边框 / 页面」三者。
- **左栏精确值**：卡片 x 12.0..347.6、新建会话右边距 16.4、设备 x0 28.8、
  顶栏→设备 41.6、设备→胶囊 36.8、胶囊→会话 44.0、胶囊 x0 30.0。
- **截图的可靠方式**：`screencap -p /sdcard/s.png` 再 `pull`，
  且 bash 下要 `MSYS_NO_PATHCONV=1`（否则 /sdcard 被转成 Windows 路径）。
  `exec-out screencap` 更易拿到黑帧。
- **共享设计令牌改了会误伤**（2026-10-24）：`LocalCardLine` 同时给会话卡和添加设备胶囊，
  但卡片边框 `(248,248,246)`（几乎不可见）、胶囊 `(225,225,223)`（看得见）。
  改卡片时把胶囊边框擦掉了。**改共享 token 前先 grep 谁在用。**
- **缩略图判断颜色第二次出错**：胶囊在缩略图里像白色填充，实际是 `(249,249,247)`
  = 页面色、**完全透明只有描边**。**配色一律采样，不看观感。**
- **添加设备胶囊精确值**：x 22.0 起、`+` 31.6..44.0、文字 57.2 起、
  文字 14sp、总宽 73.6、边框 1dp `#E1E1DF`、**无填充**。
  内容 inset 9、`+` 与文字间隙 13.2。
- **卡片图标没有方块底**（2026-10-24）：一直是 36dp 浅灰圆角方块 + 符号，
  参考件同位采样 `(249,249,247)` = 页面色，**根本没有底**。已删。
- **对照前先确认两边状态相同**：参考件那张卡是「运行中」（旋转弧），我一度想把
  静止态的 `</>` 改成弧。状态差异不是样式差异。
- **commit message 里写 `</>` 会被 bash 当重定向**，必须 Write 到文件后 `git commit -F`。
- **左栏已确认一致**：卡片高 81.6/83.2、标题墨迹 11.2/11.2、标题 x0 80.0/80.0、
  胶囊内部与图标位均为页面色。
- **量参考件顶栏前必须排除系统层**（2026-10-24 连错多次）：参考截图里有
  ①系统状态栏（y 0..~100）②系统通知卡（会压在应用顶部）③应用自己的顶栏。
  我多次把 ①② 当 ③ 量，得出互矛的数字。
  **顶栏一律裁图人眼确认**，别硬扫像素。
- **并排图里的「竖线」是拼接间隔，不是界面差异**（踩过一次）。
- **顶栏差异（已确认）**：Claude 右侧是 ↻+⋮ 两个；我的是 🖥+◉+⋮ 三个。
  **但这是产品决定**（Claude 把设置放左栏底部），改要连带想清楚入口放哪。
- **平板上有 Claude，自己截**（2026-10-25）：`com.anthropic.claude/.mainactivity.MainActivity`，
  `am start` 或 `monkey -p com.anthropic.claude` 都能起。**别再向用户要截图。**
  已存参考集：`CLAUDE-1.png` 最近记录 / `CLAUDE-CODE.png` Code / `CLAUDE-DRAWER.png` 抽屉 /
  `CL-PROJ|ART|SCHED.png`。
- **主页(最近记录) 和 Code 是两个页面**，别混：
  | | 最近记录 | Code |
  |---|---|---|
  | 顶字幕 | 最近记录 | Code |
  | 右图标 | 筛选+列表 | 时钟 |
  | 搜索框 | **有**（白色圆角 336×40） | **无** |
  | 设备块 | **无** | **有** |
  | 列表 | 平铺行 | 圆角卡片 328×75.2 |
- **实测值**：搜索框 336.0×40.0 x12.0 描边 `(206,206,206)` 填充纯白；
  「最近记录」标题居中(179.8/180.0)；Code 卡片 328.0×75.2 x16.0 描边 `(225,225,223)` 无填充；
  主页会话标题 x0 26.0、条目间距 24.0。
- **卡片描边是 `#E1E1DF` 不是 `#F8F8F6`**（2026-10-25 Code 页实测）。之前改错了。
- **注释与代码不符时，注释常常是对的**（2026-10-25 又撞一次）：抽屉行注释写
  「glyph starts at 30.0」、代码写 `padding(start = 10.dp)`；最近使用注释写
  「Six, not three」、代码写 `take(3)`。**看到注释带具体数字就核对代码。**
- **校准套路**：测量 → 算差值 → 直接加减，别猜。例：10→30 后实测 36.4（过 6.4），
  30−6.4=23.6 一次到位。
- **抽屉实测（400dpi）**：宽 400.0dp，遮罩 `(169,169,168)`；
  标题 54.4/x24.0；项目 115.2、Code 172.8、Artifacts 227.6、定时任务 283.6（间距 38.4~40.0）；
  最近使用 348.8/x24.8；**7 项**，首行 y390.0、图标 30.0..41.6、标题 61.2、间距 28~31；
  底部胶囊 y832.8 x16.0..343.6 高 44.0。
- **Code 页胶囊完全对齐**：左 16.0 右 130.8 宽 115.2；内部 15.6、图标 12.8、文字 14sp。
- **主页与 Code 已拆开**（2026-10-25）：`LeftMode.Recent`（默认）/ `LeftMode.Sessions`（Code），
  用 `isListPage` 共享 chrome。`SessionList(flat=)` 一组件两皮肤：
  flat=无卡片+时间在下+图标列 23.6；非 flat=卡片+时间在右+图标列 36。
- **抽屉「最近记录」用 `Icons.Outlined.Schedule`**（`Icons.Outlined.History` 不存在）。
- **主页实测**：顶栏 56.4；搜索框描边 108.8、12.0..347.6、336×40；首行标题 174.0/x26.0
  （图标 26.0..37.6，图标列 23.6）；时间 196.4/x48.8；行间距 24.0；行 padding 1.6；
  标题 18sp、时间 14sp。
- **注释比代码准，第三次**：`fontSize = 15.sp` 的注释写着 18sp。看到注释具体数字就核对。
- **新建会话按钮只属于 Code 页**（2026-10-25 我改坏过一次）：Claude 主页底部
  **完全是空的**，没有按钮。拆页时把条件从 Sessions 改成 isListPage，顺手带到主页，
  且被列表 weight 撑成 286.8×56.8（应 123.2×44.0）。已改回 Sessions-only。
- **按钮没有阴影**：边缘外 1dp 即页面色。缩略图看到的"阴影"是缩放柔化。
- **深色元素检测必须限尺寸**，否则会把粗体标题当成按钮（踩过两次）。
- **这台平板屏幕极易睡**，不插电时几十秒；无线端口会漂移（35909→43781）。
  一次验证常需唤醒 4 次。
- **平板保活（不充电）完整配方**，缺一不可：
  `screen_off_timeout=2147483647`、**`screen_brightness_mode 0`**（← 关键，
  自动亮度会把背光压到 0，造成「Awake 但截图全黑」）、`screen_brightness 200`、
  `svc power stayon true`、`locksettings set-disabled true`。
- **设备有 PIN 锁**：`locksettings set-disabled true` 不即时生效；
  `isKeyguardShowing=true` 时 adb 解不开，**必须人工输一次密码**。
- **`mCurrentFocus = com.android.systemui`** = 锁屏或通知面板挡着，不是崩溃。
  查 `dumpsys window|grep isKeyguardShowing`。
- **截图一律用 `.workbuddy/pad_awake.py <out.png>`**：自动找端口（会漂移）、
  唤醒、黑帧重试 6 次。别再手写 adb 截图。
- **抽屉只有 4 项**：项目 / Code / Artifacts / 定时任务。**没有「最近记录」**
  （那是默认页，靠返回键退回）。2026-10-25 我曾凭猜测加过，已移除。
- **别用 `as` 修 Compose 的类型推断**（2026-10-25 事故）：`if/else` 链推成 `Any` 时，
  `) as Alignment` 会在首帧抛 `ClassCastException` → **启动即崩**。
  改用 `when`（分支同类型）。`Alignment.Top` 与 `Alignment.TopStart` 是不同类。
- **怀疑「页面空白/没渲染」先查进程**：`adb shell pidof com.mcode.remote` 为空 = App 没跑。
  `adb logcat -b crash -d | grep FATAL` 能直接给出异常。
  **（我因没查进程，把 Claude 界面和桌面壁纸当自己 App 量了好几轮）**
- **主页实测**：顶栏 56.4、搜索框 119.2、标题 174.0（墨迹 12.8）、时间墨迹 13.6、
  **行距 60.0**。flat 行不能用卡片的 `.height(68.dp)`。
- **子页面 `onClose`/`onNew` 指向 `LeftMode.Recent`**（主页），只有抽屉 `onSessions` 是 Code。
- **`.workbuddy/measure_all.py` 一次打印全部参考图的行表**（最近记录/Code/抽屉/项目）。
  以后别逐个元素重算。
- **项目页空态间距**：图标 349.2..394.8 → 「暂无项目」420.4 → 说明 452.0，
  即 **25.6 / 16.4**（原为 14 / 8）。
- **截图必须验证内容再按文件名归档**：`CL-ART.png` 实际是 Code 页（点击没生效），
  害我拿 Code 的数据当 Artifacts。
- **最近记录行距 60.0**、标题 174.0（墨迹 12.8）、时间 196.4（墨迹 13.6）。
- **`height` 必须写在 `padding` 之前**（2026-10-25）：`.padding(v=5).height(60)` 总量是 70，
  不是 60。这是行距错了 12dp 的原因。
- **LazyColumn 的 `spacedBy` 也算进行距**：flat 列表必须 `spacedBy(0)`，
  另用 `contentPadding(top = 6.8)` 定位首行。
- **主页已逐行对齐**：首行 174.0、第二行 234.0、行距 60.0，与参考完全一致；
  图标 x26.0 / y174.0（参考 26.0..37.6）。
- **顶栏图标要放大原图**：筛选是「三竖轴+三个空心圆（左高/中低/右中）」不是漏斗；
  列表是「三对勾+三横线」不是圆点。**缩略图完全看不出**。
- **无 surface 的 `clickable` Box 会把 ripple 画成整块灰矩形**：
  汉堡按钮实测 (224,224,222)，参考是页面色。必须
  `clickable(interactionSource = remember { MutableInteractionSource() }, indication = null)`。
- **搜索框 ✕ 只在 Code 页**，主页常驻搜索框右侧是空的。
- **改 UI 尺寸前先确认「谁在撑满」**：往上找最近的 `fillMaxWidth`。输入框改错过一次——
  给 `Column` 加 padding 没用，真正的 fillMaxWidth 在 `Surface` 的 modifier 上。
- **顶栏两个图标要 5 倍放大才看得清**：
  筛选 = 三根全高竖轴 + 三个**空心圆**（左高/中低/右中），**轴在圆边断开**，色 `#383835`，
  墨迹 16.0×13.6；列表 = 三**对勾** + 三横线。**都不是漏斗/圆点。**
- **输入框 766.4 宽**（右栏 1003.2 内，左 130.4 / 右 106.8）。
- **adb 上常有三台设备**，务必先 `getprop ro.serialno` 确认
  `0A06049009983540` 才是目标平板；`5XOFPBYDVWWWGA49`（25079RPDCC）**别装**。
- **`.workbuddy/PORT-STATUS.md` 是当前进度的唯一索引**：各页「参考值 vs 实现值」，
  标注已验证/未验证/未对照。**每轮结束更新它。**
- **padding 会叠加**：给 Surface 加 130.4 内边距，实际落在 182.4（外层还有 52）。
  改完必须复测，不能只算一次。
- **星形图标要按墨迹换算**：描边星形止于半径、无笔画沿轴，39.5 的盒子只画 32.6 墨迹。
  按盒子比例算会一直偏小。
- **右栏空态**：图标墨迹 41.2×40.8（y373.2）、文案 y432.0 墨迹 23.2、间距 **18.0**、
  整块中心 **43.3%** 屏高（`padding(bottom=135.8)`）。
- **输入框 766.4 宽**，右栏内左 130.4 / 右 106.8；卡高 84.0、填充 `(254,254,254)`。
- **输入框已精确对齐（2026-10-25 上屏确认）**：x 490.4..1256.4、宽 766.0。
  内边距用 **78.4 / 78**（不是 130.4/106.8，因为外层已有 52）。
- **数行必须一次扫全页**：抽屉「最近使用」我先用截断在 y=1150px 的窗口数到 4 行，
  又凭印象补成「7 项、间距 28~31」——**实际是 6 项、间距 43.4**。
  分段数完不能相加，必须整页一次扫。
- **抽屉「最近使用」= 6 项**，y 390.0/432.4/476.0/519.6/564.4/606.8，查看全部 654.4。
- **抽屉左下角有紫色 W 头像**，尚未实现。
- **行间距 ≠ 行高**：抽屉实测间距 45.6、目标 43.4，把 43.6（均值）当行高改没用，
  反推得行高 **41.4** 才对。改行高要用「实测间距差」反推。
- **行图标语义**：`</>` = **当前打开的会话**，其余全部气泡。判断用 `s.id == current`，
  **不是** `directory.isNotBlank()`。
- **气泡是正圆 + 左下短尾**，不是圆角矩形。
- **项目行高亮 `(240,239,236)` 是「当前页」标记**，不在项目页就不该亮——不是 bug。
- **抽屉底部「设置」行是参考件没有的**，保留作唯一入口，属已知差异。
- **定位「子元素不渲染」最有效的手段：给容器涂红**。
  `Box(...background(Color(0xFFFF0000)))`。一次就能区分「盒子没尺寸」还是「子元素没画」。
  2026-10-25 靠这个发现项目页顶栏 Box 尺寸完全正确、只有汉堡画了出来。
- **子页面在 App 顶部必须有宽度守卫**：`if (leftMode == X)` 在 pad 上会画一份全屏副本
  （带自己的状态栏 Spacer，推下 32.8），宽屏分支再画一遍。
  统一写成 `if (leftMode == X && widthSize == WindowWidthSizeClass.Compact)`。
  「设置」和「项目」都栽在这上面。
- **`fillMaxSize().wrapContentHeight()` 在固定高 Box 里测得零高度**——标题整块不画。
  一律写成 `.fillMaxWidth().height(63.2.dp).wrapContentHeight(Alignment.CenterVertically)`。
  全库还有多处是这个写法，见到就改。
- **`Arrangement.SpaceBetween` 会把图标推到标题上**。头栏是 Box 层叠，标题居中，
  图标必须用 `Spacer(Modifier.weight(1f))` 推到右端。
- **深色主题已验证通过**：页面 `#151515`、输入卡 `#202020`，所有 CompositionLocal 都有深色分支。
  切换命令 `adb shell cmd uimode night yes|no`。
- **换算比例前先确认基准测量有效**：我曾用「39.5 只画 32.6 墨迹」算出 49.9，
  实测 49.9 画 52.0、反推 39.5 → 41.2 正好对。**32.6 是在半绘制状态下量的。**
- **空态星芒 39.5 是正确的**，`padding(bottom = 147.dp)`，图标落 y373.2 / 宽 41.6。
- **定时任务页空态偏上 200dp 未解决**（图标 243.2 vs 参考 449.6）。
  `fillMaxWidth`/`fillMaxSize` 都试过，**两次完全相同**；`embedded` 分支涂绿**零像素**。
  说明那个分支没走到，问题在 `when (leftMode)` 的外层容器。**别在这上面继续瞎猜。**
- **定时任务页缺底部「+ 新建任务」按钮**（Claude 在 y832.8，x220.8..343.6）。
- **验证「某个分支是否执行」要用文字/内容标记，不要用背景色**。
  背景会被同层后续绘制的内容盖掉；文字不会。2026-10-25 涂绿误判「分支没走到」，
  用品红 `Text("EMB")` 才发现分支一直在跑。
- **`weight(1f)` 的子节点不能再只给 `fillMaxWidth()`**：没有高度约束时 Column
  按子元素测量，内部的 `weight(1f)` 分不到空间（定时任务页空态因此偏上 200dp）。
  要写 `fillMaxHeight()`。
- **主页右上方多了一个返回箭头 + 汉堡打不开抽屉**：待查，可能是同一个 bug。
- **缩略图上的形状判断必须放大确认**：2026-10-26 把列表图标的「三个对勾」读成「返回箭头」，
  据此得出「主页多了个 bug」的错误结论。放大到原生分辨率后完全不存在。
- **改不动就换机制**：定时任务空态三次改 size modifier（fillMaxWidth/fillMaxHeight/fillMaxSize）
  结果完全相同 → 约束来自上游。**直接改成显式 `padding(top = 327.8.dp)` 一次就对。**
- **主页标题**：16.6sp（不是 18）、offset **-0.8**（不是 -5.2，注释方向反了）。
- **定时任务空态块**：图标盒子 31.9dp（20dp 只画 14.8 墨迹）、圆盘下间距 **0**、
  整块 `padding(top = 327.8.dp)`。落点 449.6 / 498.8 / 528.8（参考 449.6 / 497.2 / 526.4）。
- **adb 用 USB 直连**（`adb devices` 里无端口后缀的 `0A06049009983540`）。
  无线端口会反复掉线；**截图必须 `MSYS_NO_PATHCONV=1`**。
- **子页面右栏必须空白**：项目/定时任务/产物/插件 这四页，Claude 右栏是纯空白。
  已加守卫 `if (leftMode != Projects && != Scheduled && != Artifacts && != Plugins)`。
  之前右栏无条件画会话顶栏，导致子页面浮着一个返回箭头。
- **筛选图标的激活态是 `MaterialTheme.colorScheme.primary`（陶土色）**，未激活是
  `LocalText.current`。**这是设计，不是 bug。**
- **项目页空态图标是「三段递增」**：上线 41.2 / 下线 55.6 / 托盘 67.6×46.0（y 321.6/335.2/348.8）。
  路径 `M4.7 1.6h14.6M2.2 6.4h19.7M2.3 12h19.4l-3.5 10.4H5.8z`，盒 67.6dp。**未验证。**
- **`input text` 注入不进搜索框**，想测空态得另想办法。
- **标题宽度不能跨文字比较**：Claude「交换机固件」90.8 vs 我的「Greeting」80.8，
  我据此把 17sp 改成 19.1sp——**错了，两者文字不同**。可比的是**墨迹高度**
  （两行合计 31.2 vs 30.8，本来就一致）。**已改回 17sp。**
- **`padding` 会压缩子元素，`offset` 不会**：用 `padding(end=42.4)` 移 `⋯`，
  Canvas 从 12.4 宽被压成 3.6。移位置一律用 `offset`。
- **会话右栏顶栏 = 3 个元素**：`←` 400.8..414.8 / 标题居中 / `⋯` 1290.4..1308.0，**之后什么都没有**。
  我原有的笔记本图标（进设置）和 `⋮` 都删了。`⋮`→`⋯` 是横排三点，Canvas 手绘。
- **看右栏顶栏必须用「有消息的会话」**：Claude 抽屉点 Main。
  空态和单栏截图都给不了正确参照。
- **会话右栏纵向分布是对的**：顶栏 44.8..73.6 / 副标题 96..140.8 / 消息 161.6.. / 
  按钮 236.8 / **离线提示贴底 776..881.6** / 输入框 899.2。
  中间 251~775 是真空白，不是漏扫。
- **浅灰文字要放宽墨迹阈值**：免责声明这类用 `<170` 扫不到，要 `<215`。
  但扫不到时**先怀疑那里本来就没东西**，再怀疑阈值。
- **`.workbuddy/PORT-STATUS.md` 已是最终状态表**：各页实测值 + 未对照项。
- **主页右栏 = 会话页，八段全部与 Claude 吻合**：状态栏 11.2 / 顶栏 44.8 / 副标题 96 /
  消息 161.6 / 回复 204.8 / 按钮 236.8 / **提示区 776 贴底** / 输入框 899.2。
  中间 251~775 是空白——提示**不紧跟消息，而是贴底**。这个布局早就对了。
- **缩略图误判第 5 次**：看到「左栏右边露出 ◀」以为有 bug，
  实际是我裁图只到 404dp、把 400.8 起始的返回箭头切断了。
  **不看缩略图判断任何形状或存在性。**
- **对照前先确认参考件是「有内容」还是「空态」**：Artifacts 页我对着空态改了很久，
  有产物时结构完全不同（顶部只有标题+搜索框+卡片，中间无任何东西）。
  **Claude 抽屉里点进去、有数据的那一版才是真参照。**
- **Artifacts 页**：顶栏 57.2..72.0 / 搜索框 **104.8..160.4（h55.6）** / 卡片 **180.8..279.2**，
  全部 x 16.0..343.6。已删掉我多做的「产物中心」大标题、两行说明、筛选胶囊行、视图切换。
- **Artifacts 卡片形态待改**：参考是横向卡（缩略图 124.8 宽 + 紫色画笔徽标 + 三行文字：
  标题 / 🔒仅您可见 / 编辑于3天前），我做的是九宫格竖卡。
