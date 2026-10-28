# MCode 项目长期笔记

## 环境坑（本机）

- **判 fs API 误用前先看 import**：`await fs.stat(x)` 在 `node:fs/promises` 下合法，只有回调版才炸。
- **shell 带 `ELECTRON_RUN_AS_NODE=1`**：electron 退化成 Node，依赖真 Electron 的检查假红，跑前 `unset`。PowerShell 有 HTTP_PROXY 大小写重复键 → PS 5.1 `Start-Process` 抛字典冲突；启 GUI 用 bash 后台 `env -u`。
- **锁屏期间 GPU 起不来**：Electron 41.10.7 连崩 `GPU process isn't usable`，等解锁；仍崩加 `--no-sandbox --in-process-gpu --use-angle=swiftshader`。OpenCode CLI 必须经 ConPTY。
- 受限沙箱拒绝编译器/Electron/git 子进程属环境问题，不算产品回归。

## 设备与驱动

- **目标平板**：USB `0A06049009983540`（M367FC，2272×3408，density 400）。**别往非目标设备装**（`192.168.10.173/174/155`）。
- **`build.py` 会装到无线端点**：多设备在线时它挑 `192.168.10.173`。**必须 `--no-install` 后自己 `adb -s 0A06049009983540 install -r android/app/build/outputs/apk/debug/app-debug.apk`**。
- **`build.py` 说 “built in 1.4s” = 缓存未重建**，改动没进去；先查 python `s.replace` 是否静默失败。
- **adb**：`C:/Users/Wyatt/.workbuddy/binaries/android-sdk/platform-tools/adb.exe`（不在 PATH）。
- **截图**：`screencap -p /sdcard/s.png` + `pull`，bash 下必须 `MSYS_NO_PATHCONV=1`。`exec-out screencap` 易拿黑帧。
- **保活**（缺一不可）：`screen_off_timeout=2147483647`、**`screen_brightness_mode 0`**（自动亮度压 0 会「Awake 但截图全黑」）、`screen_brightness 200`、`svc power stayon true`、`locksettings set-disabled true`。**不充电时 adb 唤不亮**。
- **有 PIN 锁**：`isKeyguardShowing=true` 时 adb 解不开；`mCurrentFocus=com.android.systemui` = 锁屏挡着不是崩溃。**别用 `KEYCODE_POWER` 唤醒**（一按设备从 adb 消失）。
- **脚本**：`pad.py` `ui.py` `nav.py` `shot.py` `build.py` `drive.py` `see.py` `measure_all.py` `side2.py`。
- **点击坐标**：一律用 `uiautomator dump` 的 bounds；边缘点击会变系统返回手势（汉堡 x=60px）。
- **Claude 参考件**：`com.anthropic.claude/.mainactivity.MainActivity`。
- **「空白/没渲染」先查进程**：`pidof com.mcode.remote` 为空 = App 没跑；`logcat -b crash -d | grep FATAL`。
- **「点了没反应」先分清「事件没到」和「到了被覆盖」**：真因常是 `if (widthSize < Expanded) return` 让宽屏被双栏盖住。先打日志再猜坐标。
- **`.workbuddy/PORT-STATUS.md` 是进度唯一索引**（参考值 vs 实现值），每轮更新。

## Compose / Kotlin 硬知识

- **`Box` 是层叠不是堆叠**：同级第二个 child 要用 `Column`。
- **`fillMaxSize().wrapContentHeight()` 在固定高 Box 里测得零高度** → 不画。用 `.fillMaxWidth().height(x.dp).wrapContentHeight(CenterVertically)`。
- **`weight(1f)` 三坑**：①再叠 `fillMaxWidth` 让宽度分配失效（27.1% 渲染成 17.6%）；②子节点只给 `fillMaxWidth()` 时内部 weight 分不到空间，要 `fillMaxHeight()`；③`SpaceBetween` 把图标推到标题上，用 `Spacer(weight(1f))` 推右。
- **`padding` 会压缩子元素、会叠加**：移位置一律 `offset`。**`height` 必须在 `padding` 之前**。**`heightIn(min=x)` 压不住行高**：子内容更高时行会长到内容高，必须同时给 `max`。
- **Row 高度取两 child 的较大者**：想让固定高的那个（如缩略图井）决定卡片高，另一个 child 必须 `heightIn(max=井高)` 钉住。
- **`LazyColumn.spacedBy` 也算进行距**：flat 列表用 `spacedBy(0)` + `contentPadding(top=...)`。
- **无 surface 的 `clickable` Box 把 ripple 画成整块灰矩形**：用 `clickable(remember { MutableInteractionSource() }, indication = null)`，`Popup` 里同理。
- **别用 `as` 修类型推断**：`if/else` 推成 `Any` 首帧抛 ClassCastException → 启动即崩，用 `when`。
- **`Icons.Outlined.Info`/`History` 不存在**；`Schedule` 可用；`MiIcon` 手绘是通用替代。`Dp*Float` 合法、`Float*Dp` 不合法。`DrawScope` 转角度用 `withTransform({ rotate(a) })`。`TextLayoutResult` 没有 `density`，传 `LocalDensity.current.density`。
- **`Path` 坐标必须成对写**：`cubicTo(size.width*0.0f, 0.0f, ...)` 混用会让 y 全成 0，整条路径塌成横线。用局部 `cx`/`cy`。
- **新增颜色 CompositionLocal 必须在主题里 provide**：只写默认值 → 深色下侧栏全白板。
- **`clampToLayout` 必须挡在 `getBoundingBox` 前**：终点排他，传 `0 until length` → `offset out of bounds` → 在 `drawBehind` 里抛 → **整个应用崩溃**。
- **`waitForUpOrCancellation` 返回 null 有歧义**，用 `awaitLongPressOrCancellation`。
- **`onGloballyPositioned` 不因选区变化触发**：Popup 锚点写进 state，用 `LaunchedEffect` 按选区 key 算。
- **`Popup` 不与内容联动**：锚在写入时的 root 坐标，移动内容必须清选区。
- **中文分词用 ICU**：`BreakIterator.getWordInstance(SIMPLIFIED_CHINESE)`，先 following 再 preceding。
- **画的和能抓的必须同源**：手柄用同一个 `handleCentres(...)` 供绘制与命中测试。
- **`ModalBottomSheet` 要传 `dragHandle = { }`**，否则自带把手与自绘的叠成两条。

## 选区模块

- **真实值**（400dpi）：色块 `#DEBFAF` 直角 27.6dp 高；手柄直径 25.2dp 贴外侧、顶边嵌入 1.6dp；菜单 `#ECDFE6` 胶囊 112×48 圆角 24、13sp。**`#ECDFE6` 是胶囊色不是选区色。**
- **两个历史 bug**：切片拿到「块在全文偏移」而非「块内偏移」→ 段落全选不中；`Int.MAX_VALUE` 与基数相加回绕 → 复制范围起点大于终点。
- **表格分隔符不属于任何单元格**：格间 1 空格、行间 1 换行，折进长度会整体右移一位。
- **找手柄不能用色值掩码**（`#AE6B4E` 也用于字符串/数字），用连通域 + ≥30×30px 过滤。
- **「拖动没反应」先确认起点**：抓起点手柄往右拖会让选区变窄。**回复消息菜单入口是底部「⋯」不是长按。**

## 网关与协议

- **改网关 src 必须重建 bundle 并重启**：`npx esbuild scripts/remote-server.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --outfile=out/remote-server.mjs --packages=external --loader:.html=text`。
- **凭据只走 `provider.auth`**；写 `customProviders[].apiKey` 无效。`SessionInfo.access` 缺失时按 `defaultAccess` 从 `config.permissions` 推导，别默认 full。
- **卡片数据在 `metadata` 顶层**（工具 part = `{type,id,callID,name,status,input,time,output,title,metadata}`），编辑卡片 diff 是 `metadata.diff`，`state.output` 只有一句话。
- **`metadata.diff` 是唯一真实 patch 来源**：188 次工具调用 40 处有它，**没有一处** `output` 含 patch。行内 diff 几乎永不触发，看 diff 走「审阅」→ 底部 sheet。`.workbuddy/find-patch.mjs` 可复核。
- **怀疑「没渲染」先证明「数据到了吗」**：`.workbuddy/probe-get.mjs <sid>`、`.workbuddy/scan-all-meta.mjs`。
- **不要给 `session.create` 传 title**；**必须带 `directory`**（否则侧栏过滤看不见），并**立即插入侧栏**。
- **`cockpit-html.ts` 由 `cockpit.html` 生成**，生成器 `.workbuddy/gen-cockpit.py`，改 HTML 后必须重跑。

## 工作流

- 一切从最新 `main` 拉分支（`fix/...`/`feat/...`），PR 合回 `main`；`v2.0` 已退役（2026-10-17）。
- `HANDOFF.md` 每轮更新，也走 PR。
- 十二项专项检查（i18n/theme/wiring/md/prompt/tool/session/snapshot/mcp/provider/shell + sandbox）**不在** `npm run smoke` 里。新工具必须进全部 18 张语言表。
- 版本号只在 `npm run package` 时递增；0.7.5 起无 Windows 安装包，本机装 0.7.4.0。
- **commit message 写文件再 `git commit -F`**：`-m` 里反引号会被当命令替换，`</>` 会被当重定向。
- **Python `s.replace()` 找不到目标不报错**：静默不改。用 Edit 精确匹配或 `assert old in s`。

## 整屏对齐方法论

**看清再判断**
- **先证明截图来源，再采信任何数值**。**蓝色弧计数判据两头都会错**：`R1` 是 184 却是我方、`REF-codeblock` 是 0 却是 Claude、`CX2`–`CX6` 与 `CL-ART*` 全是我方。**唯一可靠判据：读左栏顶部文字**（Claude 写「Claude / 项目 / Code / Artifacts」；我方写「设备 / 添加设备」+ 底部「新建会话」胶囊）。同场景下两边右栏像素完全一致 = 量的是自己。
- **缩略图会骗人，已错 7 次**：三对勾/三竖轴读成返回箭头、截断箭尖当 bug、透明描边当白填充、粗体标题当按钮、调色盘读成梅花。**形状/存在性/颜色必须放大到原生 3408×2272 或采样像素。**
- **先确认 x/y 落在哪个盒子**（同类错 4 次）。
- **量顶栏前排除系统层**（状态栏/通知卡/应用顶栏）；**顶栏一律裁图人眼确认**。
- **对照前确认两边状态相同且都有内容**：状态差异不是样式差异。
- **动手前先扫全部截图**，别断定「没有参考件」就自己造布局。
- **读符号用「竖带」**：连续 N 行各裁最左 30dp 竖拼。
- **把墨迹打成 ascii 点阵**是抄手绘图标最快的办法（徽标调色盘就这样抄的）。

**改之前**
- **代码注释常比代码准**：注释写「glyph starts at 30.0」代码写 `padding(start=10.dp)`。**注释带具体数字就核对代码。**
- **改共享 token 前先 grep 谁在用**。
- **改 UI 尺寸前先确认「谁在撑满」**：往上找最近的 `fillMaxWidth`。
- **改不动就换机制**：空态三次改 size modifier 结果相同 → 约束来自上游，写显式 `padding(top=327.8.dp)` 一次就对。
- **子页面在 App 顶部必须有宽度守卫**：`if (leftMode == X && widthSize == WindowSizeClass.Compact)`。
- **同一 UI 可能有两份渲染代码**（代码块内联 + 全屏 Dialog）：改字号前先确认哪一份在当前路径。

**测与验**
- **并排对照图是唯一可信验证**：纯数值漏掉 4 处肉眼差异。`.workbuddy/side2.py`，**每轮至少一次**。
- **别只报百分比**（用户明确反感）：只说哪几项对齐、哪几项没有、缺什么。
- **校准套路**：测量 → 算差值 → 直接加减（10→30 实测 36.4，过 6.4，改 23.6 一次到位）。**一次改到位**，别反复微调。
- **换算比例前先确认基准测量有效**（半绘制态会骗人）。
- **标题宽度不能跨文字比较**：中文墨迹 vs 拉丁墨迹不可比，要用双方都有的拉丁字形。
- **别用放大图判断字号**：以墨迹像素为准。
- **定位「子元素不渲染」：给容器涂红**；**验证分支是否执行用文字标记**，不要用背景色。
- **数行必须一次扫全页**。**行间距 ≠ 行高**。
- **测试期望值一律先跑再写**（手算错过四次）。
- **「tool 紧跟 text」≠「tool 前面没有 text」**。
- **两张截图里没测到 ≠ 产品里没有**：Step 竖线曾据两张图判定「无」并删除，第三张里清晰可见。
- **分辨不出就说分辨不出**。
- **私有仓库的 404 不能当作 URL 错的证据**：`curl` 连仓库首页都 404（未登录看私有库一律 404）。要验 URL 形状，**拿公开仓库的真分支/假分支各测一次**（真 200、假 404）才能定性。
- **没有参考件时，可以请它生成**：行内代码 chip 找了几轮都拿不到（含反引号的会话都在 Claude Code 页看不到的目录里）。最后**在自己的会话里发一句「用行内代码写出 package.json / README.md / npm run build」**，回复本身就是参考件。这比继续翻旧截图快得多，且内容可控。

## 已确认的实测值

**逐项数值全在 `.workbuddy/PORT-STATUS.md`**（每页一张对照表：参考值 vs 实现值）。这里只留最容易弄错、或一句话就能省下一次测量的判据：

- **左栏比例 0.2641**（900/3408）。深色：页面 `#151515`、卡片 `#20201F`、边框 `#232323`、图标块 `#2A2A29`、文字 `#F9F9F7`、弱化 `#8A8A8A`、输入卡 `#202020`。切换 `cmd uimode night yes|no`。
- **正文列** x 408.8..1341.6（**左 48.8 / 右 21.6，不对称**），正文 **17.4sp / 30sp 行距**。
- **主页与 Code 是两页**：前者有搜索框/无设备块/平铺行，后者相反/圆角卡片。卡片三级底色只差 1 阶（边框 `#F8F8F6` / 页面 `#F9F9F7`），差 24 阶的 `#E1E1DF` 会像描边盒。
- **图标**：**声明尺寸 ≠ 墨迹尺寸**（24 网格只画 3/4：17dp → 12.0 墨迹）。筛选 = 三竖轴 + 三**空心圆**；列表 = 三**对勾** + 三横线；**都不是漏斗/圆点**。
- **diff 面板**：加减行代码**同色**、不染色，靠底色 + 行左缘 0.8dp 竖条区分；行号列 51.2 右对齐、加减行行号比上下文深；变更行另有 4.4×0.8 蓝条；**行距 19.6**。头部 ✕ 墨迹 12×12 @x32。
- **摘要 sheet**：三行行距 **45.2**（要在 `ToolRow` 自身 5dp 外补 `spacedBy(12.4)`）；竖线穿过图标中心、整组一条。
- **回复下方按钮**：白胶囊 32 高、**0.4dp 描边**（白底与页面只差 1 阶，没边就散成「几个词」）。
- **代码块**：标签行 `(240,239,236)` 比正文区 `(243,243,240)` **更深**；语言首字母大写；代码墨迹 13.6 / 行距 16.4；右上两图标间距 26.0。
- **artifacts 卡片**：**0.4dp 描边**、内边距 12.0、井 112.0×75.2 圆角 9.6；**卡高由井决定**（文字列须 `heightIn(max=75.2.dp)`）；徽标是**画家调色盘**（圆轮廓右下内凹缺口 + 四点），不是梅花。
- **行内代码 chip**：底 `(237,237,235)`、字 **(40,78,144) 蓝色等宽**、高 **17.6**、圆角 3.2、左右内边距 5.6/5.2。**桌面端那对灰字灰底是错的**。取高不能用 `getBoundingBox`（它是**行**盒，17.4 字号 30 行距→30），要按字号给固定高并以行盒中点居中。

**工具**：单测 **119 个**（SelectionSlice 56 / StepFold 13 / DiffNumber 11 / RunSummary 10 / DiffSlice 9 / MarkdownBlocks 9 / DiffFold 8 / StepFoldRealThread 3），`build.py` 连带跑；JVM 测里 `org.json` 是空壳，要加 `testImplementation("org.json:json:20240303")`；uiautomator 抓不到 Compose 的 `text` 但抓得到 `clickable` bounds（`nav.py dump` 返回缓存，用 `drive.py`）；`input text` 不可靠，造内容用 `.workbuddy/prompt.mjs`；同名会话是陷阱，按 `updated` 对 id；权限卡会挡工具（工具停在 `pending` 是在等批准）。

## 已知未解决

- **创建 PR 打不开就直接说清**：网关只有 `git.pullRequest`（查），但动作已接上——`pullRequestUrl(remote, branch)` 拼 forge 的 compare URL，remote 从 `.git/config`（`file.read` 可读）、branch 从 `git.status` 拿。GitHub `/compare/`、GitLab `/-/compare`；scp 形态 `git@host:o/r.git` 先转 https；分支里的 `/` 要转 `%2F`。
- **artifacts 井里是真实预览图**（参考件 2×2 页面截图拼贴），我们画类型图标。网关 `artifact.list` 只回 path/size/mtime、无缩略图接口，本机语料全文本 —— 不造假图。
- 设置页可进入，**无参考件、视觉未校准**；面板形态属用户主动搁置。