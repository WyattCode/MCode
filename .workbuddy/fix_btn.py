p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()
old = """            Box(Modifier.fillMaxWidth().padding(end = 16.4.dp, bottom = 32.4.dp), contentAlignment = Alignment.CenterEnd) {
                Row(
                    Modifier
                        .width(122.8.dp)"""
new = """            /*
             * 122.8 and 38 as measured: this landed 110.4 wide at y 838.4, so
             * the box was being squeezed and sat 5.6 low. The end pad drops to
             * 16.4 - 12 = 4.4 and the bottom pad to 32.4 - 5.6.
             */
            Box(Modifier.fillMaxWidth().padding(end = 4.4.dp, bottom = 26.8.dp), contentAlignment = Alignment.CenterEnd) {
                Row(
                    Modifier
                        .width(122.8.dp)"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("button: end 4.4, bottom 26.8")
