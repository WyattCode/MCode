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
