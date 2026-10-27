p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **子页面右栏必须空白**：项目/定时任务/产物/插件 这四页，Claude 右栏是纯空白。
  已加守卫 `if (leftMode != Projects && != Scheduled && != Artifacts && != Plugins)`。
  之前右栏无条件画会话顶栏，导致子页面浮着一个返回箭头。
- **筛选图标的激活态是 `MaterialTheme.colorScheme.primary`（陶土色）**，未激活是
  `LocalText.current`。**这是设计，不是 bug。**
- **项目页空态图标是「三段递增」**：上线 41.2 / 下线 55.6 / 托盘 67.6×46.0（y 321.6/335.2/348.8）。
  路径 `M4.7 1.6h14.6M2.2 6.4h19.7M2.3 12h19.4l-3.5 10.4H5.8z`，盒 67.6dp。**未验证。**
- **`input text` 注入不进搜索框**，想测空态得另想办法。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
