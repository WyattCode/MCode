p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 抽屉会话行左边距 10 -> 30（图标起点）
old1 = "                        .padding(start = if (compact) 10.dp else 18.dp, end = if (compact) 10.dp else 14.dp, top = 0.dp, bottom = 0.dp),"
new1 = """                        /*
                         * 30.0, photographed: the drawer's glyph starts at x
                         * 30.0 and its title at 61.2. The comment above already
                         * named 30.0 while the code passed 10, so every drawer
                         * row began 20 dp left of the reference and its titles
                         * landed at 16.4 against 61.2.
                         */
                        .padding(start = if (compact) 30.dp else 18.dp, end = if (compact) 10.dp else 14.dp, top = 0.dp, bottom = 0.dp),"""
assert old1 in s
s = s.replace(old1, new1, 1)

# 2) 图标列宽 31.2 -> 19.6（图标本身 11.6 + 8 间隙，使标题起点 = 30+31.2）
old2 = "                            .width(if (compact) 31.2.dp else 36.dp)"
new2 = "                            .width(if (compact) 31.2.dp else 36.dp)"
# 保持 31.2：30 + 31.2 = 61.2, 正好是参考件的标题起点
assert old2 in s

open(p, "w", encoding="utf-8").write(s)
print("drawer row: start 10 -> 30 (icon at 30, title at 61.2)")