p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 分隔点 · -> •（实心圆，参考件是 bullet 不是 middot）
old1 = '''                                Text(
                                    " · Remote control",'''
new1 = '''                                Text(
                                    /*
                                     * A bullet, not a middot.
                                     *
                                     * The reference's separator is a filled dot at
                                     * mid-height - U+2022 - where this used U+00B7,
                                     * which sits on the baseline of a Latin face
                                     * and reads as a full stop between two words.
                                     */
                                    " • Remote control",'''
assert old1 in s
s = s.replace(old1, new1, 1)

open(p, "w", encoding="utf-8").write(s)
print("separator: middot -> bullet")