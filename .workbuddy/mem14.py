p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **`height` 必须写在 `padding` 之前**（2026-10-25）：`.padding(v=5).height(60)` 总量是 70，
  不是 60。这是行距错了 12dp 的原因。
- **LazyColumn 的 `spacedBy` 也算进行距**：flat 列表必须 `spacedBy(0)`，
  另用 `contentPadding(top = 6.8)` 定位首行。
- **主页已逐行对齐**：首行 174.0、第二行 234.0、行距 60.0，与参考完全一致；
  图标 x26.0 / y174.0（参考 26.0..37.6）。
- **顶栏图标要放大原图**：筛选是「三竖轴+三个空心圆（左高/中低/右中）」不是漏斗；
  列表是「三对勾+三横线」不是圆点。**缩略图完全看不出**。
- **无 surface 的 `clickable` Box 会把 ripple 画成整块灰矩形**：
  汉堡按钮实测 (224,224,222)，参考是页面色。必须
  `clickable(interactionSource = remember { MutableInteractionSource() }, indication = null)`。
- **搜索框 ✕ 只在 Code 页**，主页常驻搜索框右侧是空的。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")