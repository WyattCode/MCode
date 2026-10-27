p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **`.workbuddy/measure_all.py` 一次打印全部参考图的行表**（最近记录/Code/抽屉/项目）。
  以后别逐个元素重算。
- **项目页空态间距**：图标 349.2..394.8 → 「暂无项目」420.4 → 说明 452.0，
  即 **25.6 / 16.4**（原为 14 / 8）。
- **截图必须验证内容再按文件名归档**：`CL-ART.png` 实际是 Code 页（点击没生效），
  害我拿 Code 的数据当 Artifacts。
- **最近记录行距 60.0**、标题 174.0（墨迹 12.8）、时间 196.4（墨迹 13.6）。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")