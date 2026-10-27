p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """            Row(
                Modifier.fillMaxWidth().height(63.2.dp).padding(start = 1.6.dp, end = 4.4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {"""
new = """            Row(
                Modifier.fillMaxWidth().height(63.2.dp).padding(start = 1.6.dp, end = 4.4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {"""
assert old in s
s = s.replace(old, new, 1)

# SpaceBetween 把三个元素均匀铺开，两个图标跑到了中间盖住标题。
# 用 weight 把图标推到右端。
old2 = """                /*
                 * 搜索项目 and 筛选项目 are real: the page filters its rows by"""
new2 = """                /*
                 * A weight spacer pushes the two marks to the trailing edge.
                 *
                 * The header is a Box: the title is its own centred child, laid
                 * down first, and this Row goes over it. SpaceBetween spread the
                 * burger and the two marks evenly across the bar, which put the
                 * search glyph on top of the title's last character - visible in
                 * the build as 「项(搜索)目」. A weight before the marks keeps them
                 * at the right edge, where the reference puts them.
                 */
                Spacer(Modifier.weight(1f))
                /*
                 * 搜索项目 and 筛选项目 are real: the page filters its rows by"""
assert old2 in s
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("row: weight spacer restored before the marks")
