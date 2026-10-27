import re

p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 胶囊左起点 30 -> 16
old1 = "                                    .padding(start = 30.dp)\n                                    .height(31.6.dp)"
new1 = """                                    /*
                                     * 16 from the column edge, not 30.
                                     *
                                     * Photographed on Claude's Code page: the
                                     * capsule's left border sits at x 16.0 and
                                     * its plus mark at 31.6 - so 15.6 of padding
                                     * inside the pill, not 9. The 30 that was
                                     * here came from a pass that measured the
                                     * text's start and called it the pill's edge,
                                     * which made the whole capsule start where
                                     * its content should.
                                     */
                                    .padding(start = 16.dp)
                                    .height(31.6.dp)"""
assert old1 in s, "pill start"
s = s.replace(old1, new1, 1)

# 2) 内部边距 9 -> 15.6
old2 = "                                    .padding(horizontal = 9.dp),"
new2 = "                                    .padding(horizontal = 15.6.dp),"
assert old2 in s, "pill inner"
s = s.replace(old2, new2, 1)

# 3) 图标 13 -> 12.8
old3 = """                                    contentDescription = null,
                                    modifier = Modifier.size(13.dp),
                                    viewBox = 24f,
                                    strokeWidth = 2.2f,"""
new3 = """                                    contentDescription = null,
                                    modifier = Modifier.size(12.8.dp),
                                    viewBox = 24f,
                                    strokeWidth = 2.2f,"""
assert old3 in s, "plus icon"
s = s.replace(old3, new3, 1)

open(p, "w", encoding="utf-8").write(s)
print("pill: start 16 / inner 15.6 / icon 12.8")