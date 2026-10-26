# MCode 项目长期笔记

## 环境坑（本机，持久有效）

- **判断 fs API 误用前必看文件 import**：`await fs.stat(x)` 在 `import fs from "node:fs/promises"` 下合法（全库 70+ 处），只有 `node:fs` 回调版才炸。2026-10-17 误报 office.ts 有 bug，修了反而引入真 bug。先看 import 再定性。
- WorkBuddy 的 shell 带 `ELECTRON_RUN_AS_NODE=1`：electron.exe 退化成纯 Node，依赖真 Electron 的检查会假红。跑检查前 `unset`。PowerShell 工具也带，且带 HTTP_PROXY/http_proxy 大小写重复键 → PS 5.1 `Start-Process` 抛字典冲突；启动 GUI 用 bash 后台 `env -u` 更稳。
- **锁屏期间 GPU 子进程起不来**：Electron 41.10.7 的 GPU 进程连崩 → `GPU process isn't usable` FATAL，任何 flag 都救不回。GUI 测试必须等解锁。解锁后仍可能崩：bench/smoke 加 `--no-sandbox --in-process-gpu --use-angle=swiftshader`；OpenCode CLI 管道下挂起，必须经 ConPTY。
- 本机 TCP 动态端口从 1024 起；受限沙箱拒绝编译器/Electron/git 子进程属环境问题，不算产品回归。

## MCode Remote（安卓平板端，`android/`）

### 设备与驱动

- **目标平板**：USB 直连序号 `0A06049009983540`（M367FC，2272×3408，density 400）。USB 最稳；无线 `.173` 端口会漂移且反复掉线。
- **别往非目标设备装**：`192.168.10.174` / `5XOFPBYDVWWWGA49`（25079RPDCC）不是目标机，用户 2026-10-23 明确「不装」。装前 `getprop ro.serialno` 确认。
- **截图**：`screencap -p /sdcard/s.png` + `pull`，bash 下必须 `MSYS_NO_PATHCONV=1`（否则 `/sdcard` 被转成 Windows 路径）。`exec-out screencap` 易拿黑帧。封装用 `.workbuddy/pad_awake.py <out.png>`（自动找端口、唤醒、黑帧重试）。
- **平板保活完整配方**（缺一不可）：`screen_off_timeout=2147483647`、**`screen_brightness_mode 0`**（关键，自动亮度压到 0 会「Awake 但截图全黑」）、`screen_brightness 200`、`svc power stayon true`、`locksettings set-disabled true`。**不充电时 adb 唤不亮**（5 种方法全试过），必须插电。
- **设备有 PIN 锁**：`isKeyguardShowing=true` 时 adb 解不开，必须人工输密码。`mCurrentFocus = com.android.systemui` = 锁屏/通知面板挡着，不是崩溃。
- **别用 `input keyevent KEYCODE_POWER` 唤醒**：2026-10-23 实测按一下就整台设备从 adb 消失。
- **驱动脚本**：`pad.py`（重连/唤醒）、`ui.py`/`nav.py`（按 uiautomator bounds 点击，`tap <text>` / `tapcd <desc>`）、`shot.py`、`build.py`（gradle + 单测 + 安装）、`see.py`（会 `am start`，中途截图别用）、`measure_all.py`（一次打印全部参考图行表）。
- **点击坐标铁律**：一律用 `uiautomator dump` 的 bounds；按 1080 宽截图换算必点空，边缘点击会变系统返回手势。`screencap` 原生 3408×2272 与 `input tap` 同一坐标系。
- **Claude 参考件自己截**（2026-10-25）：`com.anthropic.claude/.mainactivity.MainActivity`，`am start` 或 `monkey` 都能起。别再向用户要。
- **怀疑「页面空白/没渲染」先查进程**：`adb shell pidof com.mcode.remote` 为空 = App 没跑；`adb logcat -b crash -d | grep FATAL`。曾因没查进程，把 Claude 界面和桌面壁纸当自己 App 量了好几轮。
- **「点了没反应」先分清「事件没到」和「到了被覆盖」**：设置页进不去，我连错三轮猜坐标、判断「ModalDrawer hit-test 坏了」——全错。真因是一行 `if (widthSize < Expanded) return` 让宽屏下页面被双栏布局盖住。两行 logcat 就分开了。**先打日志，再猜坐标。**
- **截图的可靠方式**：`screencap -p` 再 `pull`；`pad_awake.py` 已封装重试。
- **`.workbuddy/PORT-STATUS.md` 是进度的唯一索引**（参考值 vs 实现值，标注已验证/未验证/未对照），每轮结束更新。

### Compose / Kotlin 硬知识

- **`Box` 是层叠不是堆叠**：同一行追加第二个 child 必须用 `Column`，否则卡片盖住段落（肉眼像「文字被裁了」）。
- **`fillMaxSize().wrapContentHeight()` 在固定高 Box 里测得零高度** → 整块不画。写成 `.fillMaxWidth().height(63.2.dp).wrapContentHeight(Alignment.CenterVertically)`。
- **`weight(1f)` 与 `fillMaxWidth` 打架**：Row 里给带 weight 的子项再加 `fillMaxWidth`，宽度分配失效（左栏 27.1% 渲染成 17.6%）。weight 子项不要 fillMaxWidth。
- **`weight(1f)` 的子节点不能再只给 `fillMaxWidth()`**：无高度约束时 Column 按子元素测量，内部 `weight` 分不到空间。要 `fillMaxHeight()`。
- **`padding` 会压缩子元素，`offset` 不会**：用 `padding(end=42.4)` 移 `⋯`，Canvas 从 12.4 宽被压成 3.6。移位置一律用 `offset`。
- **`height` 必须写在 `padding` 之前**：`.padding(v=5).height(60)` 总量是 70。这是行距错 12dp 的原因。
- **`padding` 会叠加**：给 Surface 加 130.4 内边距，实际落 182.4（外层还有 52）。改完必须复测。
- **`LazyColumn` 的 `spacedBy` 也算进行距**：flat 列表必须 `spacedBy(0)`，另用 `contentPadding(top=...)` 定位首行。
- **`Arrangement.SpaceBetween` 会把图标推到标题上**：头栏是 Box 层叠、标题居中，图标用 `Spacer(Modifier.weight(1f))` 推右。
- **无 surface 的 `clickable` Box 把 ripple 画成整块灰矩形**（汉堡实测 224,224,222）：必须 `clickable(interactionSource = remember { MutableInteractionSource() }, indication = null)`。`Popup` 里同理。
- **别用 `as` 修 Compose 类型推断**：`if/else` 链推成 `Any` 时 `) as Alignment` 首帧抛 ClassCastException → 启动即崩。用 `when`。`Alignment.Top` 与 `TopStart` 是不同类。
- **`Icons.Outlined.Info` / `History` 不存在**；`Icons.Outlined.Schedule` 可用，`MiIcon` 手绘是通用替代。`Dp*Float` 合法、`Float*Dp` 不合法。`DrawScope` 里转角度用 `withTransform({ rotate(a) })`。
- **`TextLayoutResult` 没有 `density` 属性**：显式传 `LocalDensity.current.density`。
- **新增颜色 CompositionLocal 必须在主题里 provide**：`LocalCard` 系列只写默认值 → 深色下侧栏全是白板。加颜色同时补 `if (dark) ... else ...`。
- **`clampToLayout(range, length)` 必须挡在 `getBoundingBox` 前面**：区间终点排他，「到最后一个字符」= `length`，而 `getBoundingBox` 只收 `[0, length)`。2026-10-23 全选传 `0 until length` → `offset(103) out of bounds` → 在 `drawBehind` 里抛 → **整个应用崩溃**。
- **`waitForUpOrCancellation` 返回 null 有歧义**（抬起/被父组件抢走都算），用 `awaitLongPressOrCancellation`。
- **`onGloballyPositioned` 不因选区变化触发**（选中文字不动布局）：Popup 锚点要写进 state，再用 `LaunchedEffect` 按选区 key 算。
- **`Popup` 不与内容联动**：锚在写入时的 root 坐标上，抽屉/换会话会让气泡变僵尸。凡移动内容都要清选区。
- **中文分词用 ICU**：`TextLayoutResult.getWordBoundary` 无词典（中文整段一个词）。用 `android.icu.text.BreakIterator.getWordInstance(Locale.SIMPLIFIED_CHINESE)`，locale 必须显式给，且「先 following 再 preceding」。
- **画的和能抓的必须同源**：手柄用 `handleCentres(...)` 同时供绘制与命中测试，两处各算一遍必然漂移。

### 选区模块

- **真实值**（`ref-claude-sel.png`，400dpi）：色块 `#DEBFAF` 直角 27.6dp 高、左右各留 0.8dp；手柄直径 25.2dp 圆贴色块左右外侧、顶边嵌入 1.6dp；菜单 `#ECDFE6` 胶囊 112×48dp 圆角 24，文字「复制 / 全选」13sp。**`#ECDFE6` 是胶囊色，不是选区色。**
- **有单测**：`SelectionSliceTest.kt`（25 例）锁 `sliceOfSelection` / `copyRange` / `tableCellStarts`；`hitsHandle` 6 例锁「视觉半径 12.6 ≠ 触控半径 18」和圆形命中区。改选区偏移必跑 `gradle app:testDebugUnitTest`（`build.py` 已内置）。
- **两个历史 bug**：切片拿到「块在全文的偏移」而非「块内偏移」→ 段落全选不中；`Int.MAX_VALUE` 与基数用 `Int` 相加会回绕 → 复制范围起点大于终点。
- **表格分隔符不属于任何单元格**：`joinToString("\n"){ it.joinToString(" ") }` 里格间 1 空格、行间 1 换行，折进长度会让后面整体右移一位。
- **测试期望值不要手算**：`"a b\ncc dd"` 行首偏移手算成 5、实际 4（`\n` 在索引 3）。先构造真实 flat 串再用 `substring(start, start+len) == 期望` 反断。
- **证明测试有效，前提是真的破坏了东西**：2026-10-23 试的「故意改坏」其实是等价改写，测试全绿是对的。必须区分「测试没用」和「改动无害」。
- **找手柄不能用色值掩码**：代码高亮主题里 `#AE6B4E` 也用于字符串/数字。用连通域 + 尺寸过滤（≥30×30px），工具 `.workbuddy/handles.py`；量选区用 `.workbuddy/selmeas.py`。
- **「拖动没反应」先确认起点**：抓起点手柄往右拖会让选区变窄（activeOffset 逼近 anchorOffset）。
- **回复的消息菜单入口是底部「⋯」图标，不是长按**（长按现在直接进选区，更快的路径）。
- **中文分词/选区相关的单测失败**先看 `SelectionSliceTest`。

### 网关与协议

- **改网关 src 必须重建 bundle 并重启**：`npx esbuild scripts/remote-server.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --outfile=out/remote-server.mjs --packages=external --loader:.html=text`。
- **凭据只走 `provider.auth`**：写 `config.json` 的 `customProviders[].apiKey` 无效。
- `SessionInfo.access` 可选，缺失时按 `src/shared/access.ts` 的 `defaultAccess` 从 `config.permissions` 推导，别默认 full。
- **卡片数据在 `metadata` 顶层**：工具 part 是 `{type,id,callID,name,status,input,time,output,title,metadata}`，`metadata` 在**顶层**不在 `state` 里。编辑卡片的 diff 是 `metadata.diff`（`state.output` 只有一句话回复）。
- **怀疑「没渲染」先证明「数据到了吗」**：写遍历全部 session 的统计脚本（`.workbuddy/scan-all-meta.mjs` 范例）。实测 1306 次调用 / 244 次带 diff / 0 次在 output。
- **`rowsOf`→`stepsOf` 会折叠**：相邻调用折成 `ToolRun` 再折进上方 `Step`，裸的 `is Item.Tool ->` 分支几乎到不了。编辑卡片和交付卡片都栽过。
- **不要给 `session.create` 传 title**：服务端规则是「没有标题才自动命名」。2026-10-23 前手机端硬编码「来自手机」，十几天所有会话同名。已修。
- **新建会话必须带 `directory`**（不带用默认 `D://Apps//MCode`，侧栏按目录过滤 → 看不到），并**立即插入侧栏**（`select()` 依赖 `session.get` 回来才 add，是异步的）。
- **`cockpit-html.ts` 由 `cockpit.html` 生成**，生成器是 `.workbuddy/gen-cockpit.py`（原文件头写着「re-run the generator」但生成器从未提交）。改 HTML 后必须重跑。

## 工作流

- **第五十四轮起（2026-10-17 用户定）`v2.0` 退役**：一切工作从最新 `main` 拉分支（`fix/...`、`feat/...`），PR 合回 `main`。本地 `v2.0` 已删，远端 `origin/v2.0` 停在 0.7.4 不动。
- 交接文档 `HANDOFF.md` 每完成一轮更新（当前状态 + 逐轮记录，新到旧），更新也走 PR。
- 十二项专项检查（i18n/theme/wiring/md/prompt/tool/session/snapshot/mcp/provider/shell + sandbox 单独跑）**不在** `npm run smoke` 里，提交前都要过。
- 新加工具必须进全部 18 张语言表（zhCN/zhTW 中文、其余 16 张英文）。
- 版本号只在 `npm run package` 时自动递增。0.7.5 起三版都没有 Windows 安装包，本机装的还是 0.7.4.0。
- **网关启动**：沙箱里 run_in_background 可靠（别中断 turn）；分离进程会被回收。防火墙已放行 node.exe 入站（规则 `MCodeGateway`）。命令：`node out/remote-server.mjs --host 0.0.0.0 --port 7900 --token mcode-fold-2026 --data-dir C:/Users/Wyatt/AppData/Roaming/mcode`。
- **commit message 写文件再 `git commit -F`**：`git commit -m` 里的反引号会被 bash 当命令替换（内容静默丢失），`</>` 会被当重定向。
- **1:1 视觉对齐**（`1ce169b2`+`d907566f`）：正文列 764+28、气泡 16/9,13/500/78%、工具行 14/22.4/5/23（**两处渲染都要改**：`ToolRow` 和 `Item.ToolRun` 的 `runSummary`）、会话行 34+6+2、抽屉行 38/8/14、输入卡 10 圆角/13sp/44 条。会话行三态：旋转环/蓝点/待确认胶囊。

## 整屏对齐（2026-10-23 起）

### 方法论（这些是本项目最贵的教训）

- **缩略图会骗人，已错 6 次**（2026-10-22~26）：把列表图标的「三个对勾」和筛选的「三根竖轴」读成返回箭头（为此浪费 3 轮）；把裁图只到 404dp 截断的箭头左尖当成 bug；把胶囊的透明描边当成白色填充；把粗体标题当成按钮。**任何形状/存在性/颜色判断必须放大到原生 3408×2272 或采样像素，缩略图只能看宏观布局。**
- **先确认 x 落在哪个面板，再下判断**：拿左栏内的 x 当右栏证据，得出「Claude 聊天页没有标题」的错误结论（右栏标题实际在 x 2143..2225）。
- **量参考件顶栏前必须排除系统层**：①系统状态栏（y 0..~100）②系统通知卡（会压在应用顶部）③应用自己的顶栏。我多次把 ①② 当 ③。**顶栏一律裁图人眼确认，别硬扫像素。**
- **复用测量值前先确认目标盒子的原点**（同类错误 4 次）：输入框 padding、空状态 top、右栏标题坐标、searchTop —— 全是「在 A 盒子量的，拿到 B 盒子用」。数字本身没错，坐标系错了。
- **对照前先确认参考件是「有内容」还是「空态」**：Artifacts 页对着空态改了很久，有产物时结构完全不同。Claude 抽屉里点进去、有数据的那一版才是真参照。
- **对照前先确认两边状态相同**：参考件那张卡是「运行中」（旋转弧），我一度想把静止态 `</>` 改成弧。状态差异不是样式差异。
- **代码注释里的「实测结论」可能来自旧截图**，但**注释常比代码准**（第三次撞）：抽屉行注释写「glyph starts at 30.0」而代码写 `padding(start=10.dp)`；`fontSize=15.sp` 的注释写着 18sp。**看到注释带具体数字就核对代码，两者不符时重新量。**
- **注释里写了「我读错了面板」却没改数值** —— 出现这种注释时必须连带改代码。
- **别用放大图判断字号**：双倍 NEAREST 放大后会觉得标题偏大，实测两边墨迹都是 11.2dp。字号以墨迹像素为准。
- **并排对照图是唯一可信的验证**（2026-10-24 用户批评后确立）：纯数值测量漏掉 4 处肉眼可见差异（卡片边框色、分隔点字符、运行环尺寸、卡片边距）。脚本 `.workbuddy/side2.py`，**每轮至少一次**。
- **千万别只报百分比**：用户明确反感。只说「哪几项对齐了、哪几项没有、缺什么」。
- **动手前先扫一遍全部截图**：我断定「没有抽屉/Code 页参考件」并自己造布局，实际 `claude_code.png` 和 `A_claude.png` 一直躺在 `.workbuddy/shots/`（748 张）。先用缩略图总览扫（`SHEET*.png` 范例）。
- **截图必须验证内容再按文件名归档**：`CL-ART.png` 实际是 Code 页（点击没生效），害我拿 Code 数据当 Artifacts。
- **定位「子元素不渲染」最有效：给容器涂红**，一次区分「盒子没尺寸」还是「子元素没画」。
- **验证「某个分支是否执行」用文字/内容标记，不要用背景色**：背景会被同层后续绘制内容盖掉。2026-10-25 涂绿误判「分支没走到」，用品红 `Text("EMB")` 才发现分支一直在跑。
- **改不动就换机制**：定时任务空态三次改 size modifier（fillMaxWidth/fillMaxHeight/fillMaxSize）结果完全相同 → 约束来自上游，直接改成显式 `padding(top = 327.8.dp)` 一次就对。
- **子页面在 App 顶部必须有宽度守卫**：`if (leftMode == X)` 在 pad 上会画一份全屏副本，宽屏分支再画一遍。写成 `if (leftMode == X && widthSize == WindowWidthSizeClass.Compact)`。「设置」和「项目」都栽过。
- **数行必须一次扫全页**：抽屉「最近使用」先用截断在 y=1150px 的窗口数到 4 行、又凭印象补成「7 项」——实际 6 项、间距 43.4。分段数完不能相加。
- **行间距 ≠ 行高**：抽屉实测间距 45.6、目标 43.4，改 43.6（均值）没用，反推行高 41.4 才对。
- **改共享 token 前先 grep 谁在用**：`LocalCardLine` 同时给会话卡和添加设备胶囊，改卡片时把胶囊边框擦掉了。
- **改 UI 尺寸前先确认「谁在撑满」**：往上找最近的 `fillMaxWidth`。输入框改错过——给 `Column` 加 padding 没用，真正的 fillMaxWidth 在 `Surface` 上。
- **校准套路**：测量 → 算差值 → 直接加减。例：10→30 后实测 36.4（过 6.4），30−6.4=23.6 一次到位。
- **换算比例前先确认基准测量有效**：我曾用「39.5 只画 32.6 墨迹」算出 49.9，实测 49.9 画 52.0、反推 39.5→41.2 正好对。**32.6 是在半绘制状态下量的。**
- **标题宽度不能跨文字比较**：Claude「交换机固件」90.8 vs 我的「Greeting」80.8，据此把 17sp 改成 19.1sp——错了。可比的是墨迹高度（31.2 vs 30.8，本来就一致）。已改回 17sp。

### 已确认的实测值

- **左栏比例 0.2641**（900/3408）；深色：页面 `#151515`、卡片 `#20201F`、边框 `#232323`、图标块 `#2A2A29`、文字 `#F9F9F7`、弱化 `#8A8A8A`；输入卡 `#202020`。切换 `cmd uimode night yes|no`。
- **主页（最近记录）**：顶栏 56.4、搜索框描边 108.8（12.0..347.6，336×40，描边 `(206,206,206)` 纯白填充）、首行标题 174.0/x26.0（墨迹 12.8，图标 26.0..37.6）、时间 196.4/x48.8、**行距 60.0**、行 padding 1.6、标题 **16.6sp**、时间 14sp。标题 offset **-0.8**。
- **主页顶栏**：汉堡 15.6..31.6、标题 147.2..212.4（宽 65.2、中心 179.8）、筛选 278.8..295.6（激活态 `MaterialTheme.colorScheme.primary` 陶土色 `(193,128,100)`，未激活 `LocalText.current` —— **是设计不是 bug**）、列表 327.2..344.0。**没有第四个元素。**
- **Code 页**：卡片 328.0×75.2 x16.0、描边 `#E1E1DF`、高 81.6/83.2、标题 x0 80.0、第二行 `已连接 · Remote control` 绿 `#296118`；顶栏右图标是时钟；**有**设备块 + 添加设备胶囊（x22.0，`+` 31.6..44.0，文字 57.2 起 14sp，总宽 73.6，边框 1dp `#E1E1DF`，**无填充**）。新建会话胶囊左 16.0 右 130.8 宽 115.2、内部 15.6、图标 12.8。
- **主页 vs Code 是两个页面**：最近记录有搜索框/无设备块/平铺行；Code 无搜索框/有设备块/圆角卡片。
- **卡片边框 `#F8F8F6` vs 页面 `#F9F9F7` 只差 1 阶**（几乎不可见）；曾用 `#E1E1DF`（差 24 阶）像描边盒子。**一个颜色就决定观感**，要量「卡片内部/边框/页面」三者。卡片图标**没有方块底**。
- **抽屉**：宽 400.0dp、遮罩 `(169,169,168)`；标题 54.4/x24.0；四项 项目 115.2 / Code 172.8 / Artifacts 227.6 / 定时任务 283.6；最近使用 348.8/x24.8，**6 项** y 390.0/432.4/476.0/519.6/564.4/606.8、查看全部 654.4；底部胶囊 y832.8 x16.0..343.6 高 44.0。**没有「最近记录」**（默认页，靠返回键退回）。左下角有紫色 W 头像（未实现）、底部「设置」行参考件没有（保留作唯一入口，已知差异）。
- **行图标语义**：`</>` = 当前打开的会话（判断用 `s.id == current`，**不是** `directory.isNotBlank()`），其余全部气泡；气泡是正圆 + 左下短尾。项目行高亮 `(240,239,236)` 是「当前页」标记。
- **输入框**：x 490.4..1256.4 宽 **766.4**、卡高 84.0 填充 `(254,254,254)`；内边距 **78.4 / 78**（不是 130.4/106.8，外层已有 52）。✕ 只在 Code 页。
- **右栏空态**：图标墨迹 41.2×40.8（y373.2）、文案 y432.0、间距 18.0、整块中心 **43.3%** 屏高 → `padding(bottom = 147.dp)`，星芒 **39.5dp**。
- **会话页右栏顶栏 = 3 个元素**：`←` 400.8..414.8 / 标题居中 17sp / `⋯` 1290.4..1308.0（横排三点，Canvas 手绘），**之后什么都没有**。笔记本图标（进设置）和 `⋮` 都已删。
- **会话右栏纵向**：顶栏 44.8..73.6 / 副标题 96..140.8 / 消息 161.6 / 回复 204.8 / 按钮 236.8 / **离线提示贴底 776..881.6** / 输入框 899.2。中间 251~775 是真空白（提示**不紧跟消息，贴底**）。
- **子页面右栏必须空白**：项目/定时任务/产物/插件四页 Claude 右栏是纯空白。已加守卫 `if (leftMode != Projects && != Scheduled && != Artifacts && != Plugins)`，之前右栏无条件画会话顶栏导致子页面浮着返回箭头。
- **定时任务页**：空态图标墨迹 23.6（盒子 31.9）、圆盘下间距 **0**、整块 `padding(top = 327.8.dp)`，落点 449.6/498.8/528.8（参考 449.6/497.2/526.4）；底部「+ 新建任务」胶囊 x232.8..343.2 / y838.4..882.4（参考 220.8..343.6 / 832.8..876.4，**宽差 12.4 改 padding 两次无效，未解决**）。
- **项目页**：顶栏四元素（汉堡/项目/搜索/筛选）；空态图标是**三段递增**——上线 41.2 / 下线 55.6 / 托盘 67.6×46.0（y 321.6/335.2/348.8），路径 `M4.7 1.6h14.6M2.2 6.4h19.7M2.3 12h19.4l-3.5 10.4H5.8z`，盒 67.6dp（**未验证**）；空态间距 图标→「暂无项目」25.6 →说明 16.4；「+ 新建项目」胶囊 **95.2×43.2、右边距 44**。页是**左栏内容**（不是全屏，那张「全宽」是小屏无会话布局）。
- **Artifacts 页**：顶栏 57.2..72.0 / 搜索框 **104.8..160.4（h55.6）** / 卡片 **180.8..279.2**，全部 x 16.0..343.6。已删掉我多做的「产物中心」大标题、两行说明、筛选胶囊行、视图切换。搜索框 **328×56 胶囊**、radius 28、占位 15sp。
- **Artifacts 卡片（横向）已对齐**：卡 327.6×98.4 **无填充（就是页面色 249,249,247）+1dp 描边**；缩略图井 **112.0×74.8** 色 `(237,237,235)`，距卡 12；井左上角 x28.0/y192.8。文字三行 **197.6 / 221.6 / 252.0**（间距 24.0 然后 30.4，标题在井顶下 4.8），x 152.8。角落贴片 **23.6 见方**、`#DEDBFA` 底 `#5C50AC` 笔画，里面是**调色盘**（盘身+右下缺口+四点），贴井左缘、站井底边。
- **图标**：**声明尺寸 ≠ 墨迹尺寸**（24 网格里 Search 只画约 3/4，17dp 声明 → 12.0dp 墨迹，换算比例 ≈0.75；托盘占 20/24 → 40 只画 33.3）。筛选 = 三根全高竖轴 + 三个**空心圆**（左高/中低/右中）、轴在圆边断开；列表 = 三**对勾** + 三横线；**都不是漏斗/圆点**。各页顶栏图标数不同：会话页 1（时钟）、项目页 2（放大镜+筛选）、产物页 1（筛选）。空状态圆底只有定时任务页有（`#F0EFEC` 64dp + 时钟），项目页托盘是裸图标。
- **正文排版已正确**：**17sp / 30sp 行高**；正文缩进 **40dp**（不是 137.6——双栏对应 Code 页，`A_claude.png` 实测正文和工具行都从 40.0dp 起）。

### 已知未解决

- 定时任务底部胶囊宽 110.4 vs 122.8，来源未定位。
- Artifacts 横向卡片：已改出（每张高 112.8，参考 98.4，高出 14.4），内边距需从 8 改 6 微调。
- 富文本细节（行内代码底、项目符号缩进、代码块、工具/diff/交付卡片）未对照。
- 设置页可进入（左导航 12 项 + 右内容面板），**无参考件、视觉未校准**。
