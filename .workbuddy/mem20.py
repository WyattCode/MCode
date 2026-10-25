p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **验证「某个分支是否执行」要用文字/内容标记，不要用背景色**。
  背景会被同层后续绘制的内容盖掉；文字不会。2026-10-25 涂绿误判「分支没走到」，
  用品红 `Text("EMB")` 才发现分支一直在跑。
- **`weight(1f)` 的子节点不能再只给 `fillMaxWidth()`**：没有高度约束时 Column
  按子元素测量，内部的 `weight(1f)` 分不到空间（定时任务页空态因此偏上 200dp）。
  要写 `fillMaxHeight()`。
- **主页右上方多了一个返回箭头 + 汉堡打不开抽屉**：待查，可能是同一个 bug。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
