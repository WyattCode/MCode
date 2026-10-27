p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **标题宽度不能跨文字比较**：Claude「交换机固件」90.8 vs 我的「Greeting」80.8，
  我据此把 17sp 改成 19.1sp——**错了，两者文字不同**。可比的是**墨迹高度**
  （两行合计 31.2 vs 30.8，本来就一致）。**已改回 17sp。**
- **`padding` 会压缩子元素，`offset` 不会**：用 `padding(end=42.4)` 移 `⋯`，
  Canvas 从 12.4 宽被压成 3.6。移位置一律用 `offset`。
- **会话右栏顶栏 = 3 个元素**：`←` 400.8..414.8 / 标题居中 / `⋯` 1290.4..1308.0，**之后什么都没有**。
  我原有的笔记本图标（进设置）和 `⋮` 都删了。`⋮`→`⋯` 是横排三点，Canvas 手绘。
- **看右栏顶栏必须用「有消息的会话」**：Claude 抽屉点 Main。
  空态和单栏截图都给不了正确参照。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
