p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                Modifier.align(Alignment.Center).padding(bottom = 135.8.dp),"""
new = """                /*
                 * 147.0, not 135.8.
                 *
                 * Measured on the build: the mark's centre landed at 399.6 where
                 * the reference puts it at 393.5 - 6.1 low - so the bottom pad
                 * grows by twice that.
                 */
                Modifier.align(Alignment.Center).padding(bottom = 147.dp),"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("empty block: bottom pad 147")
