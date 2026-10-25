p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 字号 18 -> 16.6（在标题 Text 上）
old_size = """                            ) as String,
                            fontSize = 18.sp,"""
new_size = """                            ) as String,
                            /*
                             * 16.6, measured. The word runs 70.8 wide at 18sp
                             * where the reference's runs 65.2 - the same four
                             * characters, so the size is 18 x 65.2/70.8.
                             */
                            fontSize = 16.6.sp,"""
assert old_size in s, "font size"
s = s.replace(old_size, new_size, 1)

open(p, "w", encoding="utf-8").write(s)
print("title: 18sp -> 16.6sp")
