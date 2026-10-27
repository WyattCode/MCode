p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **主页与 Code 已拆开**（2026-10-25）：`LeftMode.Recent`（默认）/ `LeftMode.Sessions`（Code），
  用 `isListPage` 共享 chrome。`SessionList(flat=)` 一组件两皮肤：
  flat=无卡片+时间在下+图标列 23.6；非 flat=卡片+时间在右+图标列 36。
- **抽屉「最近记录」用 `Icons.Outlined.Schedule`**（`Icons.Outlined.History` 不存在）。
- **主页实测**：顶栏 56.4；搜索框描边 108.8、12.0..347.6、336×40；首行标题 174.0/x26.0
  （图标 26.0..37.6，图标列 23.6）；时间 196.4/x48.8；行间距 24.0；行 padding 1.6；
  标题 18sp、时间 14sp。
- **注释比代码准，第三次**：`fontSize = 15.sp` 的注释写着 18sp。看到注释具体数字就核对。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")