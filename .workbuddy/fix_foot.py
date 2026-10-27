p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = "                        if (isListPage) FootCapsule("
new = """                        /*
                         * Code only. Photographed: Claude's 最近记录 has nothing
                         * at the foot of the column - the last conversation ends
                         * and the page ends. Its Code page carries this capsule.
                         *
                         * The isListPage change last pass widened this condition
                         * to both pages, and on the home list it measured 286.8
                         * wide by 56.8 tall instead of 123.2 by 44.0: the same
                         * composable in a different container, stretched by the
                         * list's own weight rather than sized by its content.
                         */
                        if (leftMode == LeftMode.Sessions) FootCapsule("""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("foot capsule: Code only")