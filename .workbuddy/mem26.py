p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **对照前先确认参考件是「有内容」还是「空态」**：Artifacts 页我对着空态改了很久，
  有产物时结构完全不同（顶部只有标题+搜索框+卡片，中间无任何东西）。
  **Claude 抽屉里点进去、有数据的那一版才是真参照。**
- **Artifacts 页**：顶栏 57.2..72.0 / 搜索框 **104.8..160.4（h55.6）** / 卡片 **180.8..279.2**，
  全部 x 16.0..343.6。已删掉我多做的「产物中心」大标题、两行说明、筛选胶囊行、视图切换。
- **Artifacts 卡片形态待改**：参考是横向卡（缩略图 124.8 宽 + 紫色画笔徽标 + 三行文字：
  标题 / 🔒仅您可见 / 编辑于3天前），我做的是九宫格竖卡。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
