p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **缩略图上的形状判断必须放大确认**：2026-10-26 把列表图标的「三个对勾」读成「返回箭头」，
  据此得出「主页多了个 bug」的错误结论。放大到原生分辨率后完全不存在。
- **改不动就换机制**：定时任务空态三次改 size modifier（fillMaxWidth/fillMaxHeight/fillMaxSize）
  结果完全相同 → 约束来自上游。**直接改成显式 `padding(top = 327.8.dp)` 一次就对。**
- **主页标题**：16.6sp（不是 18）、offset **-0.8**（不是 -5.2，注释方向反了）。
- **定时任务空态块**：图标盒子 31.9dp（20dp 只画 14.8 墨迹）、圆盘下间距 **0**、
  整块 `padding(top = 327.8.dp)`。落点 449.6 / 498.8 / 528.8（参考 449.6 / 497.2 / 526.4）。
- **adb 用 USB 直连**（`adb devices` 里无端口后缀的 `0A06049009983540`）。
  无线端口会反复掉线；**截图必须 `MSYS_NO_PATHCONV=1`**。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
