p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **`.workbuddy/PORT-STATUS.md` 是当前进度的唯一索引**：各页「参考值 vs 实现值」，
  标注已验证/未验证/未对照。**每轮结束更新它。**
- **padding 会叠加**：给 Surface 加 130.4 内边距，实际落在 182.4（外层还有 52）。
  改完必须复测，不能只算一次。
- **星形图标要按墨迹换算**：描边星形止于半径、无笔画沿轴，39.5 的盒子只画 32.6 墨迹。
  按盒子比例算会一直偏小。
- **右栏空态**：图标墨迹 41.2×40.8（y373.2）、文案 y432.0 墨迹 23.2、间距 **18.0**、
  整块中心 **43.3%** 屏高（`padding(bottom=135.8)`）。
- **输入框 766.4 宽**，右栏内左 130.4 / 右 106.8；卡高 84.0、填充 `(254,254,254)`。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")