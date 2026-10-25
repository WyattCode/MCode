p = r"D:/Documents/Claude Code/MCode/.workbuddy/memory/MEMORY.md"
s = open(p, encoding="utf-8").read()
s = s.rstrip() + """
- **定位「子元素不渲染」最有效的手段：给容器涂红**。
  `Box(...background(Color(0xFFFF0000)))`。一次就能区分「盒子没尺寸」还是「子元素没画」。
  2026-10-25 靠这个发现项目页顶栏 Box 尺寸完全正确、只有汉堡画了出来。
- **子页面在 App 顶部必须有宽度守卫**：`if (leftMode == X)` 在 pad 上会画一份全屏副本
  （带自己的状态栏 Spacer，推下 32.8），宽屏分支再画一遍。
  统一写成 `if (leftMode == X && widthSize == WindowWidthSizeClass.Compact)`。
  「设置」和「项目」都栽在这上面。
- **`fillMaxSize().wrapContentHeight()` 在固定高 Box 里测得零高度**——标题整块不画。
  一律写成 `.fillMaxWidth().height(63.2.dp).wrapContentHeight(Alignment.CenterVertically)`。
  全库还有多处是这个写法，见到就改。
- **`Arrangement.SpaceBetween` 会把图标推到标题上**。头栏是 Box 层叠，标题居中，
  图标必须用 `Spacer(Modifier.weight(1f))` 推到右端。
"""
open(p, "w", encoding="utf-8").write(s)
print("ok")
