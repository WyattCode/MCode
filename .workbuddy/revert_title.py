p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                                    /*
                                     * 19.1, measured. The reference's title runs
                                     * 90.8 wide in its own header; this drew 80.8
                                     * at 17sp, and 90.8/80.8 scales it up.
                                     */
                                    fontSize = 19.1.sp,"""
new = """                                    /*
                                     * 17sp, and the width comparison was invalid.
                                     *
                                     * I raised this to 19.1 on the reference's title
                                     * measuring 90.8 against this app's 80.8. But the
                                     * two strings are different - the reference reads
                                     * 交换机固件, five Han characters, and this reads
                                     * Greeting - so their widths were never
                                     * comparable. The measure that is comparable is
                                     * the ink height: 31.2 for the two lines together
                                     * against 30.8 here.
                                     */
                                    fontSize = 17.sp,"""
assert old in s, "title size revert"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("title: back to 17sp")
