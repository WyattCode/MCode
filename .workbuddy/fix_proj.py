p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                Spacer(Modifier.height(14.dp))
                Text("暂无项目", fontSize = 17.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                Spacer(Modifier.height(8.dp))"""
new = """                /*
                 * 25.6 and 16.4, measured off the reference's own empty 项目 page:
                 * its mark ends at 394.8, 暂无项目 runs 420.4..435.6 and the line
                 * under it starts at 452.0. The 14 and 8 here pulled the three
                 * lines into a tight block that read as one paragraph.
                 */
                Spacer(Modifier.height(25.6.dp))
                Text("暂无项目", fontSize = 17.sp, fontWeight = FontWeight.Medium, color = LocalText.current)
                Spacer(Modifier.height(16.4.dp))"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("empty projects: 25.6 / 16.4")