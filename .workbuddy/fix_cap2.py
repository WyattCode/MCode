p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 胶囊内文字 13sp -> 14sp，内边距 14 -> 9
old = """                                    .clickable { showConnect = true }
                                    .padding(horizontal = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MiIcon(
                                    "M12 5v14M5 12h14","""
new = """                                    .clickable { showConnect = true }
                                    /*
                                     * 9 in from the pill's edge, not 14.
                                     *
                                     * Measured: the reference's 添加设备 text
                                     * starts at x 31.6 with the capsule's own
                                     * edge at 22.0 - 9.6 in - and its ink is
                                     * 14.0 dp tall, which is 14sp in this face.
                                     * At 14 in and 13sp the label sat 15 dp too
                                     * far right and read a step small, so the
                                     * pill came out 101.6 wide against the
                                     * reference's 73.6.
                                     */
                                    .padding(horizontal = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MiIcon(
                                    "M12 5v14M5 12h14","""
assert old in s
s = s.replace(old, new, 1)

# 字号
old2 = """                                Spacer(Modifier.width(7.dp))
                                Text("添加设备", fontSize = 13.sp, color = LocalText.current)"""
new2 = """                                Spacer(Modifier.width(6.dp))
                                Text("添加设备", fontSize = 14.sp, color = LocalText.current)"""
assert old2 in s
s = s.replace(old2, new2, 1)

# 胶囊填充改为纯白
s = s.replace('.background(LocalCard.current)\n                                    .border(1.dp, LocalCardLine.current, RoundedCornerShape(15.8.dp))',
              '.background(if (androidx.compose.foundation.isSystemInDarkTheme()) LocalCard.current else Color.White)\n                                    .border(1.dp, LocalCardLine.current, RoundedCornerShape(15.8.dp))', 1)

open(p, "w", encoding="utf-8").write(s)
print("capsule: text 14sp, inset 9, fill white")