p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **正文缩进是 40dp，不是 137.6**（2026-10-24）：`contentPadding` 曾按 Claude **chat 页**
  量（99.5dp），但双栏布局对应 **Code 页**。`A_claude.png` 实测正文和工具行
  **都从 40.0dp 起**、彼此对齐。**注释里写了「我读错了面板」却没改数值**——
  出现这种注释时必须连带改代码。
- 正文排版已验证正确：**17sp / 30sp 行高**（参考件墨迹 16.0dp、行距 29.5dp）。
- **目标平板连接状态**：USB 序号 `0A06049009983540`，无线 `.173`。
  2026-10-24 两者都断开，只剩 `.174`（1880×3008，未装 MCode，**不是目标机，不碰**）。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
