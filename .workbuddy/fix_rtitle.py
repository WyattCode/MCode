p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                                    fontSize = 17.sp,"""
new = """                                    /*
                                     * 19.1, measured. The reference's title runs
                                     * 90.8 wide in its own header; this drew 80.8
                                     * at 17sp, and 90.8/80.8 scales it up.
                                     */
                                    fontSize = 19.1.sp,"""
assert old in s, "title size"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("conversation title: 17 -> 19.1sp")
