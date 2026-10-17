# MCode Remote — 产品与技术设计（v0.1 草案）

> 状态：**草案，待评审**。手机是驾驶舱，本机是引擎——移动端只做「观察 + 输入 + 批准」，代码、调试、执行、git 全部留在本机。
>
> 主要目标设备：**Xiaomi 18 Fold（Android 折叠屏）**，由本机 Windows 版 MCode 承担全部计算。

## 1. 定位与原则

- 本机 MCode 是会话的**唯一权威宿主**：状态、历史、权限决策以本机为准；移动端是「带凭据的窗口」。
- **手机断网/合上/没电，本机照跑不误**——重连后按游标补齐事件。这是产品的灵魂，一切设计优先服务它。
- 代码、密钥、会话内容**不出本机**：外网链路只走端到端加密的中继（中继只见密文），或用户自建隧道（Tailscale/Cloudflare Tunnel）。
- 不做云沙箱、不做多租户 SaaS、不在手机上编辑文件——那都是桌面的事。

### 与现有产品的分界

| 产品 | 引擎在哪 | 与 MCode Remote 的区别 |
|---|---|---|
| Codex cloud | 云端沙箱 | 我们不动用户的文件与环境 |
| Claude Code remote/网页 | 云端会话 | 同上；且我们保留本地 MCP/密钥 |
| happy / hapi / Termopus / cc-remote | 本机（Claude Code） | **同构**；但它们都要「包 TUI 抓屏幕」，MCode 的 server/renderer 分离 + 结构化会话落盘让事件导出是原生的 |

## 2. 竞品调研结论（2026-10-17）

| 项目 | 形态 | 许可证 | 可借鉴 |
|---|---|---|---|
| [slopus/happy](https://github.com/slopus/happy) | CLI wrapper + Relay + Expo 端 | MIT | E2E（TweetNaCl）、二维码配对、推送策略、多机多会话；最近支持 ACP runner |
| [tiann/hapi](https://github.com/tiann/hapi) | 单 hub 二进制 + 手机 Web | **AGPL-3.0** ⚠️ 只借鉴思路勿抄码 | hub 零落地、单文件二进制、本地/远程一键切换、`--workspace-root` 范围限制 |
| [Termopus](https://github.com/Termopus/termopus) | Flutter + Rust bridge + CF DO | MIT | 中继部署在用户自己的 Cloudflare；mTLS 设备证书；权限卡/diff 交互 |
| [zed ACP](https://github.com/zed-industries/agent-client-protocol) | 协议 | — | 事件流语义基线；opencode 也是实现方 |
| opencode `serve`/`attach` | headless + 多端 | — | headless server 的直接先例 |
| nexus4cc / cc-remote | tmux 流 / 自托管 | GPL / MIT | 反面参照：终端透传路线不做 |

## 3. 目标设备与平台策略（Xiaomi 18 Fold）

1. **Android 原生方向**：国内小米机上 FCM 不可用，PWA 的 Web Push 走不通——推送改走**前台服务长连接**（Android 合法且国内 IM 的标准做法）+ 引导用户把应用加入省电白名单。因此放弃「PWA 起步」的旧想法，**手机端做 Android 应用**；技术栈二选一：
   - **Expo/React Native**：可参考 happy 的 MIT 代码，Web 版顺带产出；折叠屏适配可用 react-native-fold-detector 等社区库。
   - **Kotlin/Compose**：对折叠屏（WindowSizeClass、hinge/fold state）支持最深，体积最小，无桥接层。
   - 倾向 **Expo**（复用 happy 经验 + 快出 Web 版）；spike 阶段做一个折叠屏双栏 PoC 后定。
2. **折叠屏是杀手场景**：展开态（内屏）做**双栏驾驶舱**——左栏会话时间线，右栏 diff 审查/文件预览/权限卡；收起态单栏自适应。MCode 的 diff 是结构化数据，不是终端镜像，在 8 英寸内屏上可以做到真正的逐 hunk 审查。
3. 小米 HyperOS 细节：自启动权限、省电策略白名单、锁屏通知权限在配对流程中做成**引导页**（一次性引导，不静默要求）。

## 4. 控制模型

- **权威**：本机。**多端**：一台机器可配对多端；同一会话同一时刻只有一个可写端——本机永远可写；远程端「接管」需显式切换（本机会收到提示并可一键收回）。
- **远程端保守一档**：本机已允许的动作，远程首次出现仍需确认（可勾选「记住此项目此动作」）。

## 5. 协议草案（三层：快照 / 事件 / 命令）

传输：局域网 `wss://`（自签 + 配对指纹校验）；外网走 Relay（E2E 密文）或用户自建隧道。所有消息 JSON，字段见下。

### 5.1 连接与认证

```
手机 → 本机  { type: "hello", device: { id, name, model }, auth: token }
本机 → 手机  { type: "welcome", cursor: <lastEventId>, sessionList: [...] }
```

- 配对：本机显示含 `otp://<fingerprint>?<one-time-code>` 的二维码 → 手机扫码换长期令牌；令牌在本机可吊销。
- 重连：手机发 `{ type: "resume", cursor }`，服务端补发缺失事件；游标前的事件已压缩进快照则重发快照。

### 5.2 事件（本机 → 手机，均带单调 `eventId`）

| type | 载荷要点 | 来源 |
|---|---|---|
| `turn.started` / `turn.completed` | sessionID、序号、状态 | session/runner |
| `message.appended` | role、文本、reasoning 摘要 | session 消息落盘 |
| `tool.started` / `tool.finished` | 工具名、输入摘要、状态、耗时 | session 工具记录 |
| `diff.proposed` / `diff.applied` | 文件、hunk 列表（结构化） | edit/写工具 |
| `permission.requested` / `resolved` | 卡片 ID、动作、参数摘要、默认建议 | permissions.ask |
| `session.list.changed` | 增删改、状态灯 | sessions |
| `presence` | 本机是否在跑、当前 model、CPU/内存粗粒度 | 主进程 |
| `error` | 分类、人类可读描述 | 各层 |

### 5.3 命令（手机 → 本机）

| type | 说明 |
|---|---|
| `prompt.send` / `prompt.append` | 新任务 / 给运行中的 turn 追加消息 |
| `permission.respond` | 卡片 ID + allow/deny（+ 记住选项） |
| `turn.interrupt` | 中断当前 turn |
| `session.select` / `session.create` | 切换/新建 |
| `device.takeover` | 请求成为可写端（需本机确认） |

幂等：命令带 `requestId`，服务端去重；事件带游标，服务端按会话缓冲最近 N 条 + 快照兜底。

## 6. MVP 范围冻结

**做**：本机 Remote Gateway（WSS + 配对 + 事件导出 + 权限卡投递）；Android 端三屏（会话列表 / 时间线+diff / 权限卡与输入）；局域网直连；断线重连与游标补齐；折叠屏双栏布局。

**明确不做**（v1+）：外网 Relay 服务（先支持自建隧道）、diff 的手机端编辑、语音、多机管理面板、iOS、本地/远程模式切换、图片/附件预览。

## 7. 三个先决 spike（动工前必须回答）

| # | 问题 | 验证法 | 失败后果 |
|---|---|---|---|
| S1 | server 能否**无窗口**完整跑（启动/会话/工具/MCP） | 仿 agent.cjs 但不 show window，跑一轮真实对话 | 需把 server 拆成纯 node 进程，工程量 +1 周 |
| S2 | 事件流能否覆盖手机所需全部信息且顺序可靠 | 现有 session 存储加 listener，真实对话核对事件表 | 补埋点或改快照轮询 |
| S3 | `permissions.ask` 能否旁路订阅而不破坏现有审批 | spike：注册监听者，验证本机 UI 与远程投递互不阻塞 | 权限层重构，需单独设计评审 |

## 8. 路线图

1. **M0**（本文档评审 + spike S1–S3）：1 周内出结论。
2. **M1 MVP**：局域网 + Android 端三屏 + 批准流；本机日常可用。
3. **M2**：自建隧道支持 + 折叠屏双栏打磨 + 多会话推送。
4. **M3**：Relay 服务（或指导用户自建）+ 多机管理 + iOS。

## 9. 参考实现清单

见 §2；实现期建议精读 happy 的 `packages/`（加密与配对）、opencode 的 serve/attach、Termopus 的 `bridge/` 与 wrangler 配置。
