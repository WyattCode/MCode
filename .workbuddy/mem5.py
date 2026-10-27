p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **卡片图标没有方块底**（2026-10-24）：一直是 36dp 浅灰圆角方块 + 符号，
  参考件同位采样 `(249,249,247)` = 页面色，**根本没有底**。已删。
- **对照前先确认两边状态相同**：参考件那张卡是「运行中」（旋转弧），我一度想把
  静止态的 `</>` 改成弧。状态差异不是样式差异。
- **commit message 里写 `</>` 会被 bash 当重定向**，必须 Write 到文件后 `git commit -F`。
- **左栏已确认一致**：卡片高 81.6/83.2、标题墨迹 11.2/11.2、标题 x0 80.0/80.0、
  胶囊内部与图标位均为页面色。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")