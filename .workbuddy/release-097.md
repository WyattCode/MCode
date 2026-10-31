## 0.9.7

这一版修的是主分支上**构建失败**的问题——`npm run build` 在合并之后直接报错，装不出包。顺藤摸瓜还找到驾驶舱一个已经发出去的权限按钮缺陷。

### 修复

**构建失败：六个函数里新旧代码叠在一起。** 报错是 `Identifier 'before' has already been declared`，但根因不是重复声明这么简单——有一批改动被**粘贴在它本该替换的代码之上**，两版都留在同一个作用域里。`Composer.vue` 里 `applyAccess` 被从中间劈开，新的函数签名落在旧函数体的 `if` 刚打开的位置。

涉及的六处：`cycleAgent`、`toggleGoalMode`、`chooseModel`、`chooseSmart`、`chooseModelEffort`、`applyAccess`。全部统一为「捕获一次 target → try/catch → 失败即返回 → 成功才 announce」的正确形态。其中 `chooseModel` 和 `chooseModelEffort` 原本会**向服务端发两次请求**（try 外一次、try 内一次）。

**「重新执行」按钮会永久失效。** `GoalBar.vue` 的 `rerun()` 少了 `catch`：`rerunning` 置为 `true` 后，一旦 RPC 抛异常，这个标记就永远停在 `true`，按钮此后点不动。现在 `finally` 里必定复位。

**MCP 开关会发两次请求。** `PluginsView.vue` 里 `mcp.toggle` 请求了两遍，第二遍还写成 `app.client?.`——而 `client` 上面已经判过空了。

**驾驶舱对「每次都要确认」的操作仍提供「总是允许」。** 网关服务的 `cockpit-html.ts` 是生成文件，里面塞了**两份页面脚本**，浏览器跑的是旧的那份。页面源码一直是对的，所以所有读源码的检查都通过，只有手机上的行为不对。重跑 `gen-cockpit.mjs` 即解决。

### 防止再犯

**生成步骤现在会自我校验。** `gen-cockpit.mjs` 支持 `--check`，`prebuild` 会调用它——陈旧文件直接让构建失败，并告诉你修复命令。上一版那个驾驶舱 bug 就是因为这一步是手动的、跳过时不报错。

**测试套件重写。** `scripts/smoke.ts` 自 2.0 导入起就没编译过：从 1,990 行涨到 12,091 行，48 轮都在往一个跑不起来的文件里加检查，最后差 47 个花括号、96 个圆括号，42 个 section 的语句在拼接中被截断。修补尝试全部失败——缺的不是标点，是语句本身。现在重写为 167 行、27 个检查，只写真正会运行的东西。

### 验证

- 14 个检查套件全部通过（smoke、i18n、theme、wiring、md、mcp、session、snapshot、sandbox、remote、tool、prompt、shell、provider）
- `npm run build` 通过