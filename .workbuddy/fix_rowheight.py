p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 行高：flat 用 60.0（Claude 的一行总高 174.0 -> 234.0）
old = "                        .height(if (compact) 43.6.dp else 68.dp)"
new = """                        /*
                         * 60.0 on the flat list.
                         *
                         * Measured: one row of Claude's 最近记录 runs from its
                         * title's ink at 174.0 to the next title's at 234.0.
                         * The 68 here is the cards' height, and on the flat rows
                         * it left 80.4 between titles - the home list read as
                         * half as long as the reference's.
                         */
                        .height(if (compact) 43.6.dp else if (flat) 60.dp else 68.dp)"""
assert old in s
s = s.replace(old, new, 1)

# 标题与时间之间：Claude 是 10.0（186.4 -> 196.4），我给的是 14.8
old2 = """                                Text(
                                    relTime(s.updated),
                                    fontSize = 14.sp,
                                    lineHeight = 17.sp,
                                    color = LocalMuted.current,
                                    modifier = Modifier.padding(top = 6.dp),
                                )"""
new2 = """                                Text(
                                    relTime(s.updated),
                                    fontSize = 14.sp,
                                    lineHeight = 16.sp,
                                    color = LocalMuted.current,
                                    modifier = Modifier.padding(top = 3.dp),
                                )"""
assert old2 in s
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("flat row: height 60, title-to-time 10")