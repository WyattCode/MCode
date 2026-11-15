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
