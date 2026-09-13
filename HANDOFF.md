# MCode 2.0 交接文档

给接手的人（或下一个会话）看的现状说明。每完成一轮就更新一次。

- 分支：`v2.0`（只在本地，从未推送）
- 目标：在界面和功能上 1:1 复刻 Xiaomi MiMo 桌面端，MCode 保留自己的名字、图标和字标
- 对照清单（逐项实测，含百分比）：https://claude.ai/code/artifact/f149a5d1-857e-4bae-80be-ca03265d9f83
- 最近更新：2026-09-13

## 现在到哪了

对照 MiMo 26.912.121036：清单里 69 项在范围内，**全部完成**（100%）。

用户决定不做（不要再主动提）：

| 项目 | 原因 |
| --- | --- |
| 帮助与反馈 | MiMo 提交到小米服务器，MCode 没有这类服务 |
| 回复下方赞 / 踩 | MiMo 把反馈发到自己的服务，MCode 没有接收方 |
| 精选插件目录 | MiMo 的一键安装目录；MCode 的插件是用户自己配的 MCP 服务器和技能 |
| 创建插件 | MiMo 的「创建插件 / 更多创建」 |
| 设置页：钩子、自定义插件（CLI）、连接（SSH） | 清单之外的新功能，用户选择改为打磨现有功能 |

## 与 MiMo 故意不同的地方（用户定的，不要改回去）

- 侧栏顶部一排按钮全部靠左（MiMo 从 x=65 开始、铃铛在最右）；macOS 仍留出红绿灯位置。
- 侧栏内容（字标以下）整体下移 4px。
- 首页保留 MCode 自己的静态字标，不做 MiMo 的可换图标按钮（做过后撤销，`18d888b` → `6c32812`）；点击字标会跳动一下（`ea62985`）。
- 「帮助与反馈」暂不做。

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
  - 项目 = 会话所在的目录（排除已归档、无项目任务、已关闭的项目），和侧栏同一套规则。
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
npm run smoke        # 当前 334 条
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
  - 不要 `moveTop()` 窗口；用 `setBackgroundThrottling(false)` + `showInactive()`。
  - 有活动终端时不要直接退出探针（会弹 conpty 断言对话框）。
  - 打开外部程序、剪贴板、选目录的 IPC（`mcode:open-file`、`mcode:reveal-file`、`mcode:clipboard-write`、`mcode:pick-directory`、`mcode:quit`）先 `removeHandler` 再换成记录器。
  - 背景窗口里 `animation.finished` 可能一直不结束——产品代码里等动画都要配一个超时。
  - 打开弹窗后第一次 `capturePage` 可能是旧画面，等约 2 秒并 `invalidate()` 再截。
  - ContextMenu 当前选中项是 `.item.ticked`；侧栏底部「设置」行现在先打开菜单，再点菜单里的「设置」。
- 开发版重启：先停旧的 `npm run dev` 任务，再结束残留 electron 进程，否则两个实例抢同一份配置（会报缓存无法创建）。
- 版本号只在打包时递增，不要手改。WSL 永久不在范围内。

## 下一步建议

1. 清单已全部完成，新页面（钩子、CLI 插件、SSH 连接）用户决定不做。接下来打磨现有功能的细节：逐页对照 MiMo 已有页面的行和行为（例如「常规」页的标题生成模型、默认打开目标、系统托盘、导入历史会话）。
