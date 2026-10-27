# MCode 项目长期笔记

## 环境坑（本机，持久有效）

- **判断 fs API 误用前必看 import**：`await fs.stat(x)` 在 `node:fs/promises` 下合法（全库 70+ 处），只有 `node:fs` 回调版才炸。2026-10-17 误报 office.ts 有 bug，修了反而引入真 bug。
- **shell 带 `ELECTRON_RUN_AS_NODE=1`**：electron.exe 退化成纯 Node，依赖真 Electron 的检查会假红，跑前 `unset`。PowerShell 工具还带 HTTP_PROXY 大小写重复键 → PS 5.1 `Start-Process` 抛字典冲突；启 GUI 用 bash 后台 `env -u`。
- **锁屏期间 GPU 子进程起不来**：Electron 41.10.7 GPU 连崩 → `GPU process isn't usable` FATAL，任何 flag 都救不回。GUI 测试等解锁；解锁后仍崩则加 `--no-sandbox --in-process-gpu --use-angle=swiftshader`；OpenCode CLI 管道下挂起，必须经 ConPTY。
- 受限沙箱拒绝编译器/Electron/git 子进程属环境问题，不算产品回归。

## MCode Remote（安卓平板端，`android/`）

### 设备与驱动

- **目标平板**：USB 序号 `0A06049009983540`（M367FC，2272×3408，density 400）。USB 最稳；无线端口会漂移且反复掉线。
- **别往非目标设备装**：`192.168.10.174`/`5XOFPBYDVWWWGA49`（25079RPDCC）、`192.168.10.155`/`0186D460499C3540`（2608BPX34C）都不是目标机，用户 2026-10-23 明确「不装」。装前 `getprop ro.serialno` 确认。
- **截图**：`screencap -p /sdcard/s.png` + `pull`，bash 下必须 `MSYS_NO_PATHCONV=1`。`exec-out screencap` 易拿黑帧。封装 `.workbuddy/pad_awake.py`。
- **保活配方**（缺一不可）：`screen_off_timeout=2147483647`、**`screen_brightness_mode 0`**（自动亮度压到 0 会「Awake 但截图全黑」）、`screen_brightness 200`、`svc power stayon true`、`locksettings set-disabled true`。**不充电时 adb 唤不亮**。
- **有 PIN 锁**：`isKeyguardShowing=true` 时 adb 解不开，必须人工输密码。`mCurrentFocus=com.android.systemui` = 锁屏/通知面板挡着，不是崩溃。
- **别用 `input keyevent KEYCODE_POWER` 唤醒**：一按整台设备从 adb 消失。
- **脚本**：`pad.py`(重连/唤醒)、`ui.py`/`nav.py`(按 bounds 点击)、`shot.py`、`build.py`(gradle+单测+安装)、`drive.py`(刷新 dump+点击)、`see.py`、`measure_all.py`。
- **点击坐标铁律**：一律用 `uiautomator dump` 的 bounds；按 1080 宽缩略图换算必点空；边缘点击会变系统返回手势（汉堡用 x=60px，别用 110）。
- **Claude 参考件自己截**：`com.anthropic.claude/.mainactivity.MainActivity`。
- **「空白/没渲染」先查进程**：`pidof com.mcode.remote` 为空 = App 没跑；`logcat -b crash -d | grep FATAL`。曾把 Claude 界面和桌面壁纸当自己 App 量了几轮。
- **「点了没反应」先分清「事件没到」和「到了被覆盖」**：设置页进不去连错三轮猜坐标，真因是一行 `if (widthSize < Expanded) return` 让宽屏被双栏盖住。**先打日志再猜坐标。**
- **`.workbuddy/PORT-STATUS.md` 是进度唯一索引**（参考值 vs 实现值，标注已验证/未验证/未对照），每轮更新。

### Compose / Kotlin 硬知识

- **`Box` 是层叠不是堆叠**：同级追加第二个 child 必须用 `Column`，否则卡片盖住段落。
- **`fillMaxSize().wrapContentHeight()` 在固定高 Box 里测得零高度** → 整块不画。写 `.fillMaxWidth().height(63.2.dp).wrapContentHeight(CenterVertically)`。
- **`weight(1f)` 三坑**：①再叠 `fillMaxWidth` 会让宽度分配失效（左栏 27.1% 渲染成 17.6%）；②子节点只给 `fillMaxWidth()` 时无高度约束，内部 weight 分不到空间，要 `fillMaxHeight()`；③`Arrangement.SpaceBetween` 会把图标推到标题上，头栏 Box 层叠居中、图标用 `Spacer(weight(1f))` 推右。
- **`padding` 会压缩子元素、会叠加**：移位置一律用 `offset`（`padding(end=42.4)` 把 Canvas 从 12.4 压成 3.6）；给 Surface 加 130.4 实际落 182.4。
- **`height` 必须写在 `padding` 之前**：`.padding(v=5).height(60)` 总量 70。
- **`LazyColumn.spacedBy` 也算进行距**：flat 列表必须 `spacedBy(0)`，用 `contentPadding(top=...)` 定位首行。
- **无 surface 的 `clickable` Box 把 ripple 画成整块灰矩形**：必须 `clickable(remember { MutableInteractionSource() }, indication = null)`。`Popup` 里同理。
- **别用 `as` 修类型推断**：`if/else` 链推成 `Any` 时首帧抛 ClassCastException → 启动即崩，用 `when`。`Alignment.Top` 与 `TopStart` 不同类。
- **`Icons.Outlined.Info`/`History` 不存在**；`Schedule` 可用，`MiIcon` 手绘是通用替代。`Dp*Float` 合法、`Float*Dp` 不合法。`DrawScope` 转角度用 `withTransform({ rotate(a) })`。`TextLayoutResult` 没有 `density`，显式传 `LocalDensity.current.density`。
- **新增颜色 CompositionLocal 必须在主题里 provide**：只写默认值 → 深色下侧栏全白板，加 `if (dark) ... else ...`。
- **`clampToLayout(range, length)` 必须挡在 `getBoundingBox` 前**：终点排他，「到最后一个字符」= `length`，而 `getBoundingBox` 只收 `[0,length)`。传 `0 until length` → `offset out of bounds` → 在 `drawBehind` 里抛 → **整个应用崩溃**。
- **`waitForUpOrCancellation` 返回 null 有歧义**，用 `awaitLongPressOrCancellation`。
- **`onGloballyPositioned` 不因选区变化触发**：Popup 锚点写进 state，用 `LaunchedEffect` 按选区 key 算。
- **`Popup` 不与内容联动**：锚在写入时的 root 坐标，抽屉/换会话会变僵尸。移动内容必须清选区。
- **中文分词用 ICU**：`getWordBoundary` 无词典（整段一个词）。用 `android.icu.text.BreakIterator.getWordInstance(SIMPLIFIED_CHINESE)`，locale 显式给，「先 following 再 preceding」。
- **画的和能抓的必须同源**：手柄用同一个 `handleCentres(...)` 供绘制与命中测试。

### 选区模块

- **真实值**（`ref-claude-sel.png`，400dpi）：色块 `#DEBFAF` 直角 27.6dp 高、左右各 0.8dp；手柄直径 25.2dp 贴外侧、顶边嵌入 1.6dp；菜单 `#ECDFE6` 胶囊 112×48dp 圆角 24、13sp。**`#ECDFE6` 是胶囊色不是选区色。**
- **有单测**：`SelectionSliceTest`（25 例）锁 `sliceOfSelection`/`copyRange`/`tableCellStarts`；`hitsHandle` 6 例锁「视觉半径 12.6 ≠ 触控半径 18」。
- **两个历史 bug**：切片拿到「块在全文的偏移」而非「块内偏移」→ 段落全选不中；`Int.MAX_VALUE` 与基数用 `Int` 相加会回绕 → 复制范围起点大于终点。
- **表格分隔符不属于任何单元格**：`joinToString("\n"){ it.joinToString(" ") }` 格间 1 空格、行间 1 换行，折进长度会整体右移一位。
- **找手柄不能用色值掩码**（`#AE6B4E` 也用于字符串/数字），用连通域 + ≥30×30px 过滤（`.workbuddy/handles.py`）。量选区用 `selmeas.py`。
- **「拖动没反应」先确认起点**：抓起点手柄往右拖会让选区变窄。
- **回复的消息菜单入口是底部「⋯」，不是长按**（长按直接进选区）。

### 网关与协议

- **改网关 src 必须重建 bundle 并重启**：`npx esbuild scripts/remote-server.ts --bundle --platform=node --format=esm --target=node22 --alias:@shared=./src/shared --outfile=out/remote-server.mjs --packages=external --loader:.html=text`。
- **凭据只走 `provider.auth`**；写 `customProviders[].apiKey` 无效。
- `SessionInfo.access` 缺失时按 `src/shared/access.ts` 的 `defaultAccess` 从 `config.permissions` 推导，别默认 full。
- **卡片数据在 `metadata` 顶层**（工具 part = `{type,id,callID,name,status,input,time,output,title,metadata}`），编辑卡片的 diff 是 `metadata.diff`，`state.output` 只有一句话回复。
- **怀疑「没渲染」先证明「数据到了吗」**：写遍历全部 session 的统计脚本（`.workbuddy/scan-all-meta.mjs` 范例）。
- **不要给 `session.create` 传 title**（服务端规则「没有标题才自动命名」，之前硬编码「来自手机」导致十几天所有会话同名）；**必须带 `directory`**（否则侧栏按目录过滤看不见），并**立即插入侧栏**（`select()` 依赖异步 `session.get`）。
- **`cockpit-html.ts` 由 `cockpit.html` 生成**，生成器 `.workbuddy/gen-cockpit.py`，改 HTML 后必须重跑。

## 工作流

- **`v2.0` 已退役（2026-10-17 用户定）**：一切从最新 `main` 拉分支（`fix/...`/`feat/...`），PR 合回 `main`。
- `HANDOFF.md` 每轮更新（当前状态 + 逐轮记录，新到旧），也走 PR。
- 十二项专项检查（i18n/theme/wiring/md/prompt/tool/session/snapshot/mcp/provider/shell + sandbox 单跑）**不在** `npm run smoke` 里，提交前都要过。
- 新加工具必须进全部 18 张语言表（zhCN/zhTW 中文、其余 16 张英文）。
- 版本号只在 `npm run package` 时递增；0.7.5 起三版都无 Windows 安装包，本机装的是 0.7.4.0。
- **网关启动**：沙箱里 `run_in_background` 可靠（别中断 turn），分离进程会被回收。防火墙已放行 node.exe 入站（`MCodeGateway`）。
- **commit message 写文件再 `git commit -F`**：`-m` 里的反引号会被 bash 当命令替换（内容静默丢失），`</>` 会被当重定向。

## 整屏对齐

### 方法论（本项目最贵的教训）

**看清再判断**
- **缩略图会骗人，已错 6 次**：把「三个对勾」和「三根竖轴」读成返回箭头（浪费 3 轮）、把只到 404dp 截断的箭头左尖当 bug、把透明描边当白色填充、把粗体标题当按钮。**形状/存在性/颜色必须放大到原生 3408×2272 或采样像素。**
- **先确认 x/y 落在哪个盒子，再下判断**（同类错误 4 次）：拿左栏 x 当右栏证据得出「聊天页没标题」；输入框 padding、空态 top、右栏标题坐标全是「在 A 盒子量的拿到 B 盒子用」。
- **量顶栏前排除系统层**：①状态栏 ②通知卡 ③应用顶栏。多次把 ①② 当 ③。**顶栏一律裁图人眼确认。**
- **对照前确认两边状态相同且都「有内容」**：对着 Artifacts 空态改了很久；参考件是「运行中」旋转弧，我差点把静止态 `</>` 改成弧。状态差异不是样式差异。
- **动手前先扫一遍全部截图**：断定「没有参考件」并自己造布局，实际 `claude_code.png`/`A_claude.png` 一直躺在 `.workbuddy/shots/`。先看缩略图总览（`SHEET*.png`）。截图必须验证内容再按名归档（`CL-ART.png` 实际是 Code 页）。
- **读符号位置用「竖带」**：反复裁单行会认错 `•`/`○`；把连续 7 行各裁最左 30dp 竖拼，一次看清全部。

**改之前**
- **代码注释可能过时，但常比代码准**（撞过三次）：注释写「glyph starts at 30.0」代码写 `padding(start=10.dp)`；`fontSize=15.sp` 注释写着 18sp。**看到注释带具体数字就核对代码，不符则重新量。**
- **注释写了「我读错了面板」却没改数值** → 出现这种注释必须连带改代码。
- **改共享 token 前先 grep 谁在用**：`LocalCardLine` 同时给会话卡和添加设备胶囊，改卡片把胶囊边框擦掉了。
- **改 UI 尺寸前先确认「谁在撑满」**：往上找最近的 `fillMaxWidth`。给 `Column` 加 padding 没用，真正撑满的在 `Surface` 上。
- **改不动就换机制**：定时任务空态三次改 size modifier 结果完全相同 → 约束来自上游，直接写显式 `padding(top = 327.8.dp)` 一次就对。
- **子页面在 App 顶部必须有宽度守卫**：`if (leftMode == X && widthSize == WindowSizeClass.Compact)`，否则 pad 上画一份全屏副本再被双栏盖住。「设置」「项目」都栽过。

**测与验**
- **并排对照图是唯一可信的验证**（2026-10-24 用户批评后确立）：纯数值漏掉 4 处肉眼可见差异（卡片边框色、分隔点字符、运行环尺寸、卡片边距）。脚本 `.workbuddy/side2.py`，**每轮至少一次**。
- **千万别只报百分比**：用户明确反感。只说「哪几项对齐了、哪几项没有、缺什么」。
- **校准套路**：测量 → 算差值 → 直接加减。10→30 实测 36.4（过 6.4），30−6.4=23.6 一次到位。
- **换算比例前先确认基准测量有效**：曾用「39.5 只画 32.6 墨迹」算 49.9，实际那 32.6 是半绘制状态量的。
- **标题宽度不能跨文字比较**：Claude「交换机固件」90.8 vs 我的「Greeting」80.8 → 把 17sp 改 19.1sp 是错的；可比的是墨迹高度（31.2 vs 30.8 本来就一致），已改回 17sp。
- **别用放大图判断字号**：双倍 NEAREST 放大后觉得标题偏大，实测两边墨迹都是 11.2dp。字号以墨迹像素为准。
- **定位「子元素不渲染」最有效：给容器涂红**，一次区分「盒子没尺寸」还是「子元素没画」。
- **验证「分支是否执行」用文字标记，不要用背景色**：背景会被同层后续绘制盖掉，涂绿误判「分支没走到」，用品红 `Text("EMB")` 才发现一直在跑。
- **数行必须一次扫全页**：抽屉「最近使用」先数到 4 行又凭印象补成 7 项，实际 6 项、间距 43.4。分段数完不能相加。
- **行间距 ≠ 行高**：实测间距 45.6、目标 43.4，改 43.6（均值）没用，反推行高 41.4 才对。
- **测试期望值一律先跑再写**：手算错过三次（块数 7→8、折叠行数 3→2、`role[0]` 把 tool/text 都变成 t 得出 0 个 tool）。
- **「tool 紧跟 text」≠「tool 前面没有 text」**：曾据此断言「服务端顺序会变」并加反向折叠，实测零变化，已回退，注释改成实测结论。
- **证明测试有效，前提是真的破坏了东西**：2026-10-23 的「故意改坏」其实是等价改写，全绿是对的。区分「测试没用」和「改动无害」。
- **分辨不出就说分辨不出**：不要拿「看着像」去覆盖一个有实测依据的值。

### 已确认的实测值

- **左栏比例 0.2641**（900/3408）。深色：页面 `#151515`、卡片 `#20201F`、边框 `#232323`、图标块 `#2A2A29`、文字 `#F9F9F7`、弱化 `#8A8A8A`，输入卡 `#202020`。切换 `cmd uimode night yes|no`。
- **主页（最近记录）**：顶栏 56.4、搜索框描边 108.8（12.0..347.6，336×40，描边 `(206,206,206)`）、首行标题 174.0/x26.0（墨迹 12.8，图标 26.0..37.6）、时间 196.4/x48.8、**行距 60.0**、行 padding 1.6、标题 **16.6sp**、时间 14sp。标题 offset **-0.8**。
- **主页顶栏**：汉堡 15.6..31.6、标题 147.2..212.4（中心 179.8）、筛选 278.8..295.6（激活 `(193,128,100)` 陶土色，未激活 `LocalText.current` —— **是设计不是 bug**）、列表 327.2..344.0。**没有第四个元素。**
- **Code 页**：卡片 328.0×75.2 x16.0、描边 `#E1E1DF`、高 81.6/83.2、标题 x0 80.0、第二行绿 `#296118`；顶栏右是时钟；**有**设备块 + 添加设备胶囊（x22.0、`+` 31.6..44.0、文字 57.2 起 14sp、总宽 73.6、1dp 描边**无填充**）；新建会话胶囊左 16.0 宽 115.2、内部 15.6、图标 12.8。
- **主页 vs Code 是两个页面**：最近记录有搜索框/无设备块/平铺行；Code 无搜索框/有设备块/圆角卡片。
- **卡片边框 `#F8F8F6` vs 页面 `#F9F9F7` 只差 1 阶**（几乎不可见），曾用差 24 阶的 `#E1E1DF` 像描边盒子。**一个颜色决定观感**，要量「卡片内部/边框/页面」三者。卡片图标**没有方块底**。
- **抽屉**：宽 400.0dp、遮罩 `(169,169,168)`；标题 54.4/x24.0；四项 项目 115.2 / Code 172.8 / Artifacts 227.6 / 定时任务 283.6；最近使用 348.8/x24.8、**6 项** y 390.0/432.4/476.0/519.6/564.4/606.8、查看全部 654.4；底部胶囊 y832.8 x16.0..343.6 高 44.0。**没有「最近记录」**。左下角紫色 W 头像（未实现）、底部「设置」行参考件没有（保留作唯一入口，已知差异）。
- **行图标语义**：`</>` = 当前打开的会话（`s.id == current`，**不是** `directory.isNotBlank()`），其余全部气泡；气泡正圆 + 左下短尾。项目行高亮 `(240,239,236)` 是「当前页」标记。
- **输入框**：x 490.4..1256.4 宽 **766.4**、卡高 84.0 填充 `(254,254,254)`；内边距 **78.4/78**（不是 130.4/106.8，外层已有 52）。✕ 只在 Code 页。
- **右栏空态**：图标墨迹 41.2×40.8（y373.2）、文案 y432.0、间距 18.0、整块中心 **43.3%** 屏高 → `padding(bottom=147.dp)`，星芒 **39.5dp**。
- **会话页右栏顶栏 = 3 个元素**：`←` 400.8..414.8 / 标题居中 17sp / `⋯` 1290.4..1308.0（横排三点 Canvas 手绘），之后什么都没有（笔记本图标与 `⋮` 已删）。
- **会话右栏纵向**：顶栏 44.8..73.6 / 副标题 96..140.8 / 消息 161.6 / 回复 204.8 / 按钮 236.8 / **离线提示贴底 776..881.6** / 输入框 899.2。中间 251~775 是真空白（提示**不紧跟消息**）。
- **子页面右栏必须空白**：项目/定时任务/产物/插件四页 Claude 右栏纯空白（守卫 `leftMode != Projects && != Scheduled && != Artifacts && != Plugins`）。
- **定时任务页**：空态图标墨迹 23.6（盒 31.9）、圆盘下间距 **0**、整块 `padding(top=327.8.dp)`，落点 449.6/498.8/528.8（参考 449.6/497.2/526.4）；底部胶囊 x232.8..343.2 / y838.4..882.4（参考 220.8..343.6 / 832.8..876.4，**宽差 12.4 未解决**）。
- **项目页**：顶栏四元素（汉堡/项目/搜索/筛选）；空态图标**三段递增**——上线 41.2 / 下线 55.6 / 托盘 67.6×46.0（y 321.6/335.2/348.8），路径 `M4.7 1.6h14.6M2.2 6.4h19.7M2.3 12h19.4l-3.5 10.4H5.8z`，盒 67.6dp（**未验证**）；间距 图标→「暂无项目」25.6 →说明 16.4；「+ 新建项目」胶囊 **95.2×43.2、右边距 44**。页是**左栏内容**。
- **Artifacts 页**：顶栏 57.2..72.0 / 搜索框 **104.8..160.4（h55.6）** / 卡片 **180.8..279.2**，全部 x 16.0..343.6。已删掉我多做的「产物中心」大标题、说明、筛选行、视图切换。搜索框 328×56 胶囊、radius 28、占位 15sp。
- **Artifacts 卡片（横向）**：卡 327.6×98.4 **无填充（页面色 249,249,247）+1dp 描边**；缩略图井 **112.0×74.8** 色 `(237,237,235)`，距卡 12，井左上 x28.0/y192.8。文字三行 **197.6/221.6/252.0**（间距 24.0 然后 30.4），x 152.8。角落贴片 **23.6 见方**、`#DEDBFA` 底 `#5C50AC` **调色盘**，贴井左缘站井底边。
- **图标**：**声明尺寸 ≠ 墨迹尺寸**（24 网格里 Search 只画约 3/4：17dp 声明 → 12.0dp 墨迹；托盘占 20/24 → 40 只画 33.3）。筛选 = 三根全高竖轴 + 三个**空心圆**（左高/中低/右中）、轴在圆边断开；列表 = 三**对勾** + 三横线；**都不是漏斗/圆点**。顶栏图标数：会话页 1（时钟）、项目页 2（放大镜+筛选）、产物页 1（筛选）。空状态圆底只有定时任务页有（`#F0EFEC` 64dp + 时钟）。
- **正文排版已对齐**：正文列 **x 408.8..1341.6**（右栏 360..1363.2 → **左 48.8 / 右 21.6，不对称**；原用 Code 页的 40/40）；正文 **17.4sp / 30sp 行距**（墨迹 17.0，参考 16.8~17.2）。
- **列表缩进已验证**：一级 `•` 墨迹 **408.8..413.6**、符号后文字 **421.2**、嵌套 `○` **429.2**、嵌套文字 **441.6** —— 四数与参考全对齐。关键两处：`•` 在 16dp 盒内有 **6.0 左侧空白** → `offset(x=-6.dp)`；盒宽 16 → **11.2**（否则文字落 426.0）。**符号随层级降级 depth 0 `•` / 1 `○` / else `▪`**。
- **`input text` 在这个 App 不可靠**（漏字符、`%s` 被当分隔符）。要造测试内容，两条可靠路：**在会话里发一句话让助手生成**，或**用 ws 直接发 `session.prompt`**（`.workbuddy/prompt.mjs <sid> "<text>"`）。
- **uiautomator 抓不到 Compose 的 `text`，但抓得到 `clickable` 节点的 bounds** —— 按 bounds 定位，别按文字。`nav.py dump` 会返回缓存（据此点击会落旧坐标），用 `drive.py`（先 `rm` 远端 xml 再 dump）。
- **权限卡会挡住工具执行**：工具停在 `pending` 不是卡死，是在等批准。`clickable` 的 bounds 里找 x>2900 的「本次允许」，**按 bounds 中心点**，猜 y 必偏（裁到相邻卡或导航栏）。批准后会话才继续。
- **查网关真实返回用 ws 探测**（`.workbuddy/probe-get.mjs <sid>`）：返回条数 / 角色分布 / parts 类型。判断「渲染不出来」前先跑它，能立刻分清是数据没到还是没画。
- **同名会话是陷阱**：抽屉里有两条「来自手机 (分支)」（105 条 / 1 条，差一天）。**标题不标识行**——按 `updated` 排序、从顶部数、对上 session id 再下结论。我曾把行映射到错误 y，打开 1 条那个，把它的单条气泡当成「105 条只渲染 1 条」的数据缺陷，写进 PORT-STATUS 挂了一轮。
- **工具摘要行的口径来自桌面端三个文件**：`lib/tool-meta.ts` 的 `bucketOf`（read/edit/run/search/other 五桶）、`lib/step-rows.ts` 的 `groupSummary`（read/edit 按**去重路径**计数，其余按调用数）、`lib/i18n.ts` 的 `buildWorkDisplay.*`（「已读取 N 个文件 / 已编辑 / 已运行 / 已搜索 N 次 / 已执行 N 个操作」，`·` 分隔）。**glob/grep 属 search 不属于 read。** 桌面端失败用图标标记，不写进文字。
- **JVM 单测默认把 `org.json` 打成空壳**（调用即抛 "not mocked"）。`returnDefaultValues=true` 会让 `optString` 返回 ""、`optJSONObject` 返回 null——断言全在测桩子。要真解析就加 `testImplementation("org.json:json:20240303")`。
- **有 91 个单测**（selection 56 / MarkdownBlocks 9 / StepFold 13 / StepFoldRealThread 3 / RunSummary 10），`build.py` 连带跑；改解析、折叠或摘要必跑。
- **真实的折叠形状**：72 part / 33 调用，16 段调用的前驱**全是助手散文**，折出 16 个 Step。`rowsOf`→`stepsOf` 会把相邻调用折成 `ToolRun` 再折进上方 `Step`（裸 `is Item.Tool ->` 分支几乎到不了）。

### 已知未解决

- 定时任务底部胶囊宽 110.4 vs 122.8，来源未定位。
- Artifacts 横向卡片每张高 112.8（参考 98.4），内边距需从 8 改 6。
- 行内代码 chip 底色与页面色太接近，**像素无法分辨，未验证**（29.6 高保持原样）。代码块形状正确（语言标签/高亮/圆角/操作行），逐项位置未对照。
- **工具摘要行的文字已对齐桌面端口径，但它的缩进/图标/字号从未与参考件并排量过。**
- diff 卡片、交付卡片**未对照**。
- 设置页可进入（左导航 12 项 + 右内容面板），**无参考件、视觉未校准**。