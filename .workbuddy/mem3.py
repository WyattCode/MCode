p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **并排对照图是唯一可信的验证**（2026-10-24 用户批评后确立）：纯数值测量漏掉了
  4 处肉眼可见的差异（卡片边框色、分隔点字符、运行环尺寸、卡片边距）。
  脚本 `.workbuddy/side2.py`：同尺度裁剪拼接两张图。**每轮至少做一次。**
- **千万别只报百分比**。用户明确反感。只说「哪几项对齐了、哪几项没有、缺什么」。
- **卡片边框 #F8F8F6 vs 页面 #F9F9F7 只差 1 阶**（几乎不可见）。
  之前用 #E1E1DF（差 24 阶），卡片像描边盒子。**一个颜色就能决定观感。**
  量颜色要量「卡片内部 / 边框 / 页面」三者。
- **左栏精确值**：卡片 x 12.0..347.6、新建会话右边距 16.4、设备 x0 28.8、
  顶栏→设备 41.6、设备→胶囊 36.8、胶囊→会话 44.0、胶囊 x0 30.0。
- **截图的可靠方式**：`screencap -p /sdcard/s.png` 再 `pull`，
  且 bash 下要 `MSYS_NO_PATHCONV=1`（否则 /sdcard 被转成 Windows 路径）。
  `exec-out screencap` 更易拿到黑帧。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")