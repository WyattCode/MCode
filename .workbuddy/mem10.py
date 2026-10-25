p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **新建会话按钮只属于 Code 页**（2026-10-25 我改坏过一次）：Claude 主页底部
  **完全是空的**，没有按钮。拆页时把条件从 Sessions 改成 isListPage，顺手带到主页，
  且被列表 weight 撑成 286.8×56.8（应 123.2×44.0）。已改回 Sessions-only。
- **按钮没有阴影**：边缘外 1dp 即页面色。缩略图看到的"阴影"是缩放柔化。
- **深色元素检测必须限尺寸**，否则会把粗体标题当成按钮（踩过两次）。
- **这台平板屏幕极易睡**，不插电时几十秒；无线端口会漂移（35909→43781）。
  一次验证常需唤醒 4 次。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")