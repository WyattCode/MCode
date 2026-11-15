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
