p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()
old = """        if (!embedded) Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Box(Modifier.fillMaxWidth().height(63.2.dp)) {
            Text("""
new = """        if (!embedded) Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        if (embedded) Text("EMB", fontSize = 40.sp, color = Color(0xFFFF00FF))
        Box(Modifier.fillMaxWidth().height(63.2.dp)) {
            Text("""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("marker added")
