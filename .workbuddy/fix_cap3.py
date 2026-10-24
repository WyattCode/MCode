p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# + 图标 13 -> 12.8，间隙 6 -> 13.2
old = """                                Spacer(Modifier.width(6.dp))
                                Text("添加设备", fontSize = 14.sp, color = LocalText.current)"""
new = """                                /*
                                 * 13.2 between the plus and the words.
                                 *
                                 * Measured inside the reference's pill: the plus
                                 * runs 31.6..44.0, and 添加设备 starts at 57.2 -
                                 * so 13.2 of air, not the 6 this had. With 6 the
                                 * label crowded the mark and the whole pill came
                                 * out one third narrower than the reference's.
                                 */
                                Spacer(Modifier.width(13.2.dp))
                                Text("添加设备", fontSize = 14.sp, color = LocalText.current)"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("capsule: gap 6 -> 13.2")