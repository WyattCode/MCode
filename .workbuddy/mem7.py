p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **平板上有 Claude，自己截**（2026-10-25）：`com.anthropic.claude/.mainactivity.MainActivity`，
  `am start` 或 `monkey -p com.anthropic.claude` 都能起。**别再向用户要截图。**
  已存参考集：`CLAUDE-1.png` 最近记录 / `CLAUDE-CODE.png` Code / `CLAUDE-DRAWER.png` 抽屉 /
  `CL-PROJ|ART|SCHED.png`。
- **主页(最近记录) 和 Code 是两个页面**，别混：
  | | 最近记录 | Code |
  |---|---|---|
  | 顶字幕 | 最近记录 | Code |
  | 右图标 | 筛选+列表 | 时钟 |
  | 搜索框 | **有**（白色圆角 336×40） | **无** |
  | 设备块 | **无** | **有** |
  | 列表 | 平铺行 | 圆角卡片 328×75.2 |
- **实测值**：搜索框 336.0×40.0 x12.0 描边 `(206,206,206)` 填充纯白；
  「最近记录」标题居中(179.8/180.0)；Code 卡片 328.0×75.2 x16.0 描边 `(225,225,223)` 无填充；
  主页会话标题 x0 26.0、条目间距 24.0。
- **卡片描边是 `#E1E1DF` 不是 `#F8F8F6`**（2026-10-25 Code 页实测）。之前改错了。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")