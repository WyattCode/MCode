p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **改 UI 尺寸前先确认「谁在撑满」**：往上找最近的 `fillMaxWidth`。输入框改错过一次——
  给 `Column` 加 padding 没用，真正的 fillMaxWidth 在 `Surface` 的 modifier 上。
- **顶栏两个图标要 5 倍放大才看得清**：
  筛选 = 三根全高竖轴 + 三个**空心圆**（左高/中低/右中），**轴在圆边断开**，色 `#383835`，
  墨迹 16.0×13.6；列表 = 三**对勾** + 三横线。**都不是漏斗/圆点。**
- **输入框 766.4 宽**（右栏 1003.2 内，左 130.4 / 右 106.8）。
- **adb 上常有三台设备**，务必先 `getprop ro.serialno` 确认
  `0A06049009983540` 才是目标平板；`5XOFPBYDVWWWGA49`（25079RPDCC）**别装**。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")