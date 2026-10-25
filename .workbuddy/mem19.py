p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **深色主题已验证通过**：页面 `#151515`、输入卡 `#202020`，所有 CompositionLocal 都有深色分支。
  切换命令 `adb shell cmd uimode night yes|no`。
- **换算比例前先确认基准测量有效**：我曾用「39.5 只画 32.6 墨迹」算出 49.9，
  实测 49.9 画 52.0、反推 39.5 → 41.2 正好对。**32.6 是在半绘制状态下量的。**
- **空态星芒 39.5 是正确的**，`padding(bottom = 147.dp)`，图标落 y373.2 / 宽 41.6。
- **定时任务页空态偏上 200dp 未解决**（图标 243.2 vs 参考 449.6）。
  `fillMaxWidth`/`fillMaxSize` 都试过，**两次完全相同**；`embedded` 分支涂绿**零像素**。
  说明那个分支没走到，问题在 `when (leftMode)` 的外层容器。**别在这上面继续瞎猜。**
- **定时任务页缺底部「+ 新建任务」按钮**（Claude 在 y832.8，x220.8..343.6）。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
