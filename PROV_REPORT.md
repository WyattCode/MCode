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
