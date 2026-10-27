p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = "                        if (isListPage && searching) Row("
new = """                        /*
                         * Always there on 最近记录, only on demand on Code.
                         *
                         * Photographed: Claude's home list carries a white search
                         * field under the header permanently - 336 by 40, edge at
                         * x 12.0 - while its Code page has no field at all. This
                         * showed the field only once `searching` was set, so the
                         * home page drew no search and its first row sat at 126.4
                         * where the reference's field runs 108.8..148.8.
                         */
                        if ((leftMode == LeftMode.Recent || searching) && isListPage) Row("""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("search field: permanent on Recent")