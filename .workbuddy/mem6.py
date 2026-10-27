p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **量参考件顶栏前必须排除系统层**（2026-10-24 连错多次）：参考截图里有
  ①系统状态栏（y 0..~100）②系统通知卡（会压在应用顶部）③应用自己的顶栏。
  我多次把 ①② 当 ③ 量，得出互矛的数字。
  **顶栏一律裁图人眼确认**，别硬扫像素。
- **并排图里的「竖线」是拼接间隔，不是界面差异**（踩过一次）。
- **顶栏差异（已确认）**：Claude 右侧是 ↻+⋮ 两个；我的是 🖥+◉+⋮ 三个。
  **但这是产品决定**（Claude 把设置放左栏底部），改要连带想清楚入口放哪。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")