# Provider breadth phase 1

基线：provider-breadth / 9bd56de。已阅读 TASK_PROV.md 指定源码及两份能力差异文档（CAPABILITY_DIFF 的 12 是末尾编号清单的历史媒体降级项）。无新依赖，不安装，不改 node_modules，不 push。

## 验证约定

每段提交前运行 typecheck → providercheck → sessioncheck → smoke，均使用指定 Python PATH。TMPDIR=$PWD/tmp-local/checks，GIT_CEILING_DIRECTORIES=$TMPDIR；tmp-local/package.json 临时声明 commonjs，隔离仓库 type:module 对测试生成的 require 脚本的影响。首轮 sessioncheck 因该继承问题失败，补齐临时环境后重跑；没有修改生产代码绕过检查。最终清理临时文件。

## Phase A

新增行为测试：四种 kind 选择；空 user→Continue.；assistant 结尾续写；未完成 tool_use 配对 interrupted tool_result；原历史不被修改；Anthropic 同模型签名思考回放与异模型签名丢弃。

变异证据（逐个变异、providercheck 非零、恢复源码）：
- adapter Anthropic 分支返回 OpenAICompatible：RED（all four kinds）。
- 空 user 替代值改为空串：RED（empty user）。
- 关闭尾部 assistant 续写：RED（assistant ending）。
- interrupted result 改为 lost：RED（unfinished tools）。
- 禁用 Anthropic signed thinking 回放：RED（signed thinking）。

Phase A：四项检查全绿（smoke 74/74）。临时目录另以 .ignore 的 !* 覆盖父级 *.log，保持 smoke 搜索日志 fixture 的原有语义；首次 smoke 因父级忽略规则找不到 fixture，环境隔离后通过。

## Phase B1 — native reasoning

AssistantPart 消息结构新增 native?: Record<string, unknown>；TurnEvent.reasoning.signature 携带 native，Anthropic signature 和 Responses encrypted_content/id 经事件、runner、session JSON 保存并在后续请求消费。旧 signature/itemID 仍可回放。

判据：产出 message.model 的 provider 与 model ID 必须同时等于目标；目标未提供也视为不可回放。history 请求副本移除所有跨模型 native，保留可读 reasoning（输出截断时仍用原 thoughtDigest）；adapter 仅消费各自认识的签名字段，跨模型不向线协议投递证明数据。未知 native 字段在存储与同模型请求副本中原样保留，不任意展开进 API 对象。

测试：同模型/异模型/异 provider/未知目标、空 summary 的 Responses 密文回放、旧签名兼容、原历史不变；通过真实 SSE parser 验证两个 producer；sessioncheck 注入推理事件后重新打开 SessionStore 验证 native 嵌套对象落盘。

变异：忽略 model ID 比较、禁用 Anthropic native signature、禁用 Responses native ciphertext、producer 改 native 字段名，各自 providercheck RED，恢复后 GREEN。runner.ts 必要修改 2 行：blocks map 类型携带 AssistantPart 的 native；收到 signature 事件时保存 native。未改权限文件或权限区块。

B1 最终四项检查全部 GREEN（含新增落盘测试，smoke 74/74）。

## Phase B2 — 消息不变量

新 transform.ts 是共享请求侧归一层，三个 adapter 均经 requestHistory → transformMessages；三条工具构造路径均调用 transformTool。

不变量：
- 清理空白 text/reasoning 块，保留 tool；Responses 无摘要但有密文的 reasoning 保留（旧 signature+itemID 同样保留）；Anthropic 被 prune 后只剩 signature 的空思考不回放。
- 空 user 补 Continue.；空 assistant 在任意位置移除；空 tool 结果不删，保证配对。
- 先清空内容，再处理尾部 prefill；保留 assistant 正文并补 user Continue.；尾部 tool turn 已由 adapter 产生结果，不额外补；保留旧的尾部无签名纯思考残留丢弃规则。
- 归一幂等，不修改 session 历史或原工具 schema。
- Responses 的工具显式 strict:false；不强制扩 required、不强制 additionalProperties:false。Anthropic/通用兼容接口不添无依据的 strict 字段，保持原有协议行为。工具类型目前没有显式 strict 配置，若二期开放该配置，应保留明确 opt-in。

去重决定：sendable、spoken、空 user、尾部 assistant 处理从 history 迁入 transform；history 仅委托，不再实现第二套。history 保留未完成工具结算、interrupted 输出、thoughtDigest、native 模型作用域和媒体降级；tool-schema.ts 保留 Gemini/Kimi 具体 schema 规则，transformTool 统一调用（Responses 此前直接使用原 schema，现也经过同一路径）。

变异：停用空块过滤、保留空 assistant、禁用补尾部 user、strict 改 true、禁用空摘要密文例外，五项均 providercheck RED，恢复源码。新增测试还验证幂等、原历史/schema 不变、空 tool 保留、真实出站 strict 字段和三种请求构造。

B2 变异恢复后的最终 typecheck/providercheck/sessioncheck/smoke 全部 GREEN，smoke 74/74。

## Phase B3 — Gemini 兼容层映射

新增 gemini.ts：能力标志 reasoningEfforts、canDisableThinking、nativeProtocol:false、thoughtSignatureReplay:false。按 provider/google 或模型 ID（含网关前缀，大小写不敏感）识别；默认菜单使用相同能力表，显式 entry.efforts 仍保持配置优先，出站再做能力校验。tool-schema 共用识别函数，保留既有 enum/required/items 归一及参数反向还原。

| 模型族 | 默认可选 effort | 兼容映射 |
| --- | --- | --- |
| Gemini 2.5 Pro | low/medium/high | minimal→low；不支持 none |
| Gemini 2.5 Flash / Flash-Lite | none/low/medium/high | minimal→low；thinkingOff→none |
| Gemini 3.0 Pro | low/high | minimal→low，medium→high；不支持关闭 |
| Gemini 3.1 Pro | low/medium/high | minimal→low；不支持关闭 |
| Gemini 3.x Flash / Flash-Lite | minimal/low/medium/high | 保留原级别；不支持关闭 |
| 旧版本、未知代际、image/live/tts/embedding | 不推测 reasoning effort | 省略并保留服务端默认 |

共同规则：xhigh/max 在已覆盖模型上降为 high；声明 variants 时先验证选中级别；不支持的 none/关闭请求不发送伪造参数。extra_body.google.thinking_config 带 thinking_budget/thinking_level 时不同时发 reasoning_effort；只有 include_thoughts 不造成冲突。Gemini extra 中旧 reasoning_effort 不得绕过能力检查；其余 extras 保留。非 Gemini 的出站字段与 extra 覆盖规则不变。仍使用 OpenAICompatible，没有新增 provider kind 或原生协议。

依据：[Google OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai#thinking)、[Google thinking](https://ai.google.dev/gemini-api/docs/thinking)。2.5 的预算映射由 Google 兼容端点执行；本实现不额外生成 thinking_budget。已知代际以保守列表为界，文档中新代际需要单独验证后扩展。

测试覆盖上述 10 种模型、能力与菜单一致、none/thinkingOff、minimal/medium/xhigh/max、variants 限制、网关与大小写、native thinking 配置冲突、extras 不变、非 Gemini 回归，并截获真实 OpenAICompatible 出站 JSON 验证接线。

变异证据：
- 将 high 钳制改为 xhigh：RED。
- 允许 2.5 Pro 关闭思考：RED。
- 移除 native thinking config 冲突保护：RED。
- 移除 variants 限制：RED。
- OpenAICompatible 不调用 compatibleOptions：RED。

均逐一恢复源码后重新执行完整检查。

### 覆盖缺口（二期输入）

- Gemini 工具调用 extra_content 中的 thought signature 尚未解析、落盘或回放；能力明确标 false，多轮强制签名的工具请求仍可能被服务端拒绝。B1 原生字段基础已就位，但 Gemini call-side 签名需要扩展 tool 事件契约及 runner 路径。
- 不做 Gemini 原生 generateContent/Interactions、原生缓存、grounding/搜索、实时音视频及 Vertex 身份认证；不把通用 top_k 字段塞进兼容协议。
- 未覆盖代际、别名模型与非文本生成模型不猜测 effort；显式原生 thinking_config 的含义交由端点校验。无真实 Google 账户联网验收，验证使用可复现 SSE fixture 与请求截获。

## Bedrock / Vertex 二期建议

本期未引入任何 npm 依赖。以下为架构建议，非已实现能力。

| 路径 | 建议依赖 | 认证方案 | 取舍 |
| --- | --- | --- | --- |
| Bedrock 原生 Converse/ConverseStream | @aws-sdk/client-bedrock-runtime；必要时显式使用 credential-providers | Node 默认凭证链（环境、共享配置/profile、SSO/角色与工作负载身份），region 独立配置 | SDK 负责签名、临时凭证及事件流；接入现有 TurnEvent 即可，需新增原生 adapter 与消息/usage 映射 |
| Vertex Gemini 原生 | @google/genai | ADC，project/location；本地 application-default login，部署采用服务账号或工作负载身份 | 与 Google API 保持一致，需明确流式事件、原生签名、媒体及错误映射 |
| REST 薄封装 | Vertex 用 fetch + google-auth-library；Bedrock 另需可靠 SigV4/凭证链/事件流实现 | 显式刷新 OAuth token / AWS 临时凭证 | 依赖表面较小，但认证、重试和流协议维护成本更高；不建议为零依赖自行重写全套云认证 |
| AI SDK 统一层（另开迁移） | ai + @ai-sdk/amazon-bedrock / @ai-sdk/google-vertex | 仍需各云凭证方案 | adapter 覆盖广，但会影响工具、推理、流与 usage 契约，应该独立迁移和做跨 provider 回归，不并入本期 |

认证应与 API key 分开建模，避免把短期云 token 存成永久 key；复用现有安全存储，按 provider 选择 profile/project/location，runner 不承担云凭证刷新。

参考：[AWS Converse SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/ConverseCommand/)、[AWS Node 凭证链](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)、[Google 官方 JS SDK 与 Vertex 设置](https://github.com/googleapis/js-genai)。

## 最终验证与 Git 记录

B3 恢复所有变异后：typecheck / providercheck / sessioncheck / smoke 全部 GREEN；smoke 74/74。各检查的非零退出码均阻止后续提交，最终提交对应的命令链退出码为 0。

- B1 最终日志：providercheck 85 项通过，sessioncheck 191 项通过，smoke 74/74。
- B2 最终日志：providercheck 101 项通过，sessioncheck 191 项通过，smoke 74/74。
- B3 最终日志：providercheck 150 项通过，sessioncheck 191 项通过，smoke 74/74。

代码提交完成后的 `git log --oneline 9bd56de..HEAD`：

```text
bbf710a feat(provider): map Gemini quirks on the compatible adapter
9da627b feat(provider): enforce cross-provider message invariants
3daaff2 feat(provider): preserve native reasoning metadata across turns
9971b21 test(provider): characterize adapter selection and history replay
```

`git diff --stat 9bd56de..HEAD`（截至 B3 实现提交，报告收尾前）：

```text
 PROV_REPORT.md                     |  49 ++++++++++
 scripts/provider-check.ts          | 183 +++++++++++++++++++++++++++++++++++++
 scripts/session-check.ts           |  25 +++++
 src/server/provider/anthropic.ts   |  19 ++--
 src/server/provider/chatgpt.ts     |  23 ++---
 src/server/provider/gemini.ts      |  64 +++++++++++++
 src/server/provider/history.ts     |  44 +++------
 src/server/provider/openai.ts      |  28 ++----
 src/server/provider/tool-schema.ts |   5 +-
 src/server/provider/transform.ts   |  64 +++++++++++++
 src/server/provider/types.ts       |   2 +-
 src/server/provider/variants.ts    |   4 +
 src/server/session/runner.ts       |   3 +-
 src/shared/protocol.ts             |   2 +-
 14 files changed, 435 insertions(+), 80 deletions(-)
```

收尾只补充本报告并清理 tmp-local，不改变通过检查的实现。TASK_PROV.md 与原有 node_modules 符号链接不纳入提交。runner.ts 相对基线共改 2 行（类型与 native 保存），未触碰 permission.ts、protocol 权限区块、依赖清单或锁文件；无 push。
