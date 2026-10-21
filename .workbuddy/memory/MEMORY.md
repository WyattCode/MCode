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
