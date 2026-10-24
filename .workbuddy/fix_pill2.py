p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 胶囊左边距 30 -> 16
old = """                                    /* Reference: the capsule starts at x 30.0. */
                                    .padding(start = 30.dp)"""
new = """                                    /*
                                     * 16 in from the column, not 30.
                                     *
                                     * The 30 was the *text*'s start within a
                                     * different measurement pass, not the pill's
                                     * own edge: photographed on Claude's Code
                                     * page, the capsule's left border sits at
                                     * x 16.0 and its plus mark starts at 31.6 -
                                     * 15.6 of padding inside it. At 30 the pill
                                     * began where the plus should have.
                                     */
                                    .padding(start = 16.dp)"""
assert old in s
s = s.replace(old, new, 1)

# 内部左右边距 9 -> 15.6
old2 = """                                    .padding(horizontal = 9.dp),"""
new2 = """                                    .padding(horizontal = 15.6.dp),"""
assert old2 in s
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("pill: start 16, inner 15.6")