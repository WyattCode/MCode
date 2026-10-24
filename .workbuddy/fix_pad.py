p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()
old = ".padding(horizontal = if (compact) 6.dp else 14.dp, vertical = if (compact) 0.dp else 5.dp)"
new = """/* 12 either side, not 14: the reference's card spans x 12.0..347.6. */
                        .padding(horizontal = if (compact) 6.dp else 12.dp, vertical = if (compact) 0.dp else 5.dp)"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("card horizontal 14 -> 12")
